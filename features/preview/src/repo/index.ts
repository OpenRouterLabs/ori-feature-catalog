import { Effect, FileSystem, Option, Schema, Stream } from "effect";
import { HttpClient } from "effect/http";

import type { PreviewPaths } from "../paths.ts";
import type { ProcessGroups } from "../process-groups/index.ts";

import { PreviewError } from "../errors.ts";
import {
  PREVIEW_UID,
  repoCheckout,
  repoSlug,
  syncMarkerPath,
} from "../paths.ts";
import { runToLog } from "../process/index.ts";
import { readInside } from "./read-inside.ts";
import { sandboxed, sandboxEnv } from "../sandbox/index.ts";
import { writeFileAtomic } from "../status/index.ts";
import { isOkStatus } from "../http.ts";

const RepoSchema = Schema.Struct({ default_branch: Schema.String });
const CommitSchema = Schema.Struct({
  sha: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u)),
});

const NO_CHANGED_FILES: readonly string[] = [];
const GITHUB_API = "https://api.github.com";
const GITHUB_ARCHIVE = "https://codeload.github.com";

const KEPT_ACROSS_SYNC: ReadonlySet<string> = new Set([
  "node_modules",
  ".next",
  ".turbo",
]);

export const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;

export const LOCKFILES = [
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
] as const;

const readLockfiles = Effect.fn("Preview.repo.readLockfiles")(function* (
  checkout: string
) {
  const contents = yield* Effect.forEach(LOCKFILES, (name) =>
    readInside(checkout, name).pipe(
      Effect.map((text) => [name, Option.getOrUndefined(text)] as const)
    )
  );
  return new Map(contents);
});

const changedLockfiles = (
  before: ReadonlyMap<string, string | undefined>,
  after: ReadonlyMap<string, string | undefined>
): readonly string[] =>
  LOCKFILES.filter((name) => before.get(name) !== after.get(name));

const notFound = (repo: string, detail: string): PreviewError =>
  new PreviewError({
    code: "repo_not_found",
    detail: `${repo}: ${detail}. Check that GitHub is connected for this intern and grants read access to the repository.`,
  });

const unavailable = (repo: string, detail: string): PreviewError =>
  new PreviewError({
    code: "github_unavailable",
    detail: `${repo}: ${detail}. This is usually a rate limit or a GitHub outage; it clears on its own.`,
  });

export const isTransientGithubFailure = (
  status: number,
  headers: Readonly<Record<string, string | undefined>>
): boolean =>
  status >= 500 ||
  status === 429 ||
  (status === 403 && headers["x-ratelimit-remaining"] === "0");

const getJson = Effect.fn("Preview.repo.getJson")(function* <A>(
  repo: string,
  url: string,
  schema: Schema.Codec<A, unknown>
) {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client
    .get(url, { headers: { accept: "application/vnd.github+json" } })
    .pipe(
      Effect.mapError(() => unavailable(repo, "GitHub could not be reached"))
    );
  if (isTransientGithubFailure(response.status, response.headers)) {
    return yield* unavailable(repo, `GitHub answered ${response.status}`);
  }
  if (!isOkStatus(response.status)) {
    return yield* notFound(repo, `GitHub answered ${response.status}`);
  }
  const body = yield* response.json.pipe(
    Effect.mapError(() => notFound(repo, "GitHub sent an unreadable reply"))
  );
  return yield* Schema.decodeEffect(schema)(body).pipe(
    Effect.mapError(() => notFound(repo, "GitHub sent an unexpected reply"))
  );
});

export const resolveHead = Effect.fn("Preview.repo.resolveHead")(function* (
  repo: string
) {
  const info = yield* getJson(repo, `${GITHUB_API}/repos/${repo}`, RepoSchema);
  const commit = yield* getJson(
    repo,
    `${GITHUB_API}/repos/${repo}/commits/${encodeURIComponent(info.default_branch)}`,
    CommitSchema
  );
  return { branch: info.default_branch, sha: commit.sha };
});

export const checkedOutSha = Effect.fn("Preview.repo.checkedOutSha")(function* (
  paths: PreviewPaths,
  repo: string
) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(syncMarkerPath(paths, repo)).pipe(
    Effect.map((raw) => raw.trim()),
    Effect.option
  );
});

export const hasCheckout = Effect.fn("Preview.repo.hasCheckout")(function* (
  checkout: string
) {
  const fs = yield* FileSystem.FileSystem;
  const entries = yield* fs
    .readDirectory(checkout)
    .pipe(Effect.orElseSucceed((): readonly string[] => []));
  return entries.length > 0;
});

const tooLarge = (repo: string): PreviewError =>
  notFound(
    repo,
    `the archive is over ${MAX_ARCHIVE_BYTES / 1024 / 1024} MB, too large to preview`
  );

const declaredLength = (headers: Readonly<Record<string, string>>): number =>
  Number(headers["content-length"] ?? "0");

const download = Effect.fn("Preview.repo.download")(function* (
  repo: string,
  sha: string,
  archivePath: string
) {
  const fs = yield* FileSystem.FileSystem;
  const client = yield* HttpClient.HttpClient;
  const response = yield* client
    .get(`${GITHUB_ARCHIVE}/${repo}/tar.gz/${sha}`)
    .pipe(Effect.mapError(() => notFound(repo, "the archive download failed")));
  if (!isOkStatus(response.status)) {
    return yield* notFound(
      repo,
      `the archive download answered ${response.status}`
    );
  }
  if (declaredLength(response.headers) > MAX_ARCHIVE_BYTES) {
    return yield* tooLarge(repo);
  }
  let received = 0;
  yield* response.stream.pipe(
    Stream.mapError(() => notFound(repo, "the archive download was cut short")),
    Stream.mapEffect((chunk) => {
      received += chunk.byteLength;
      return received > MAX_ARCHIVE_BYTES
        ? Effect.fail(tooLarge(repo))
        : Effect.succeed(chunk);
    }),
    Stream.run(fs.sink(archivePath))
  );
});

const REPLACE_TREE_SCRIPT = `set -e
kept() { case "$1" in ${[...KEPT_ACROSS_SYNC].join("|")}) return 0;; *) return 1;; esac; }
cd "$1"
for f in * .[!.]* ..?*; do { [ -e "$f" ] || [ -L "$f" ]; } || continue; kept "$f" || rm -rf -- "$f"; done
cd "$2"
for f in * .[!.]* ..?*; do { [ -e "$f" ] || [ -L "$f" ]; } || continue; kept "$f" || mv -- "$f" "$1/"; done`;

const replaceTree = Effect.fn("Preview.repo.replaceTree")(function* (input: {
  readonly paths: PreviewPaths;
  readonly repo: string;
  readonly checkout: string;
  readonly extracted: string;
  readonly logPath: string;
}) {
  const exitCode = yield* runToLog({
    command: sandboxed([
      "/bin/sh",
      "-c",
      REPLACE_TREE_SCRIPT,
      "replace-tree",
      input.checkout,
      input.extracted,
    ]),
    cwd: input.checkout,
    env: sandboxEnv({ host: {}, home: input.paths.home }),
    logPath: input.logPath,
  });
  if (exitCode !== 0) {
    return yield* notFound(
      input.repo,
      `the checkout could not be replaced (exited ${exitCode})`
    );
  }
});

const syncRepoUnmapped = Effect.fn("Preview.repo.sync")(function* (
  paths: PreviewPaths,
  repo: string,
  sha: string,
  beforeReplace: Effect.Effect<
    void,
    never,
    FileSystem.FileSystem | ProcessGroups
  >
) {
  const fs = yield* FileSystem.FileSystem;
  const checkout = repoCheckout(paths, repo);
  const current = yield* checkedOutSha(paths, repo);
  if (Option.contains(current, sha) && (yield* hasCheckout(checkout))) {
    return { checkout, changedFiles: NO_CHANGED_FILES, isFresh: false };
  }
  const isFresh = !(yield* hasCheckout(checkout));
  const before = yield* readLockfiles(checkout);
  const work = `${paths.scratch}/${repoSlug(repo)}-${sha.slice(0, 12)}`;
  yield* fs.remove(work, { recursive: true, force: true });
  yield* fs.makeDirectory(`${work}/tree`, { recursive: true });
  yield* download(repo, sha, `${work}/repo.tar.gz`);
  yield* fs.chown(work, PREVIEW_UID, PREVIEW_UID);
  yield* fs.chown(`${work}/tree`, PREVIEW_UID, PREVIEW_UID);
  const exitCode = yield* runToLog({
    command: sandboxed([
      "tar",
      "--extract",
      "--gzip",
      "--no-same-owner",
      "--strip-components=1",
      "--file",
      `${work}/repo.tar.gz`,
      "--directory",
      `${work}/tree`,
    ]),
    cwd: work,
    env: sandboxEnv({ host: {}, home: paths.home }),
    logPath: `${work}/tar.log`,
  });
  if (exitCode !== 0) {
    return yield* notFound(
      repo,
      `the archive did not extract (tar exited ${exitCode})`
    );
  }
  yield* fs.makeDirectory(checkout, { recursive: true });
  yield* fs.chown(checkout, PREVIEW_UID, PREVIEW_UID);
  yield* beforeReplace;
  yield* replaceTree({
    paths,
    repo,
    checkout,
    extracted: `${work}/tree`,
    logPath: `${work}/replace.log`,
  });
  yield* writeFileAtomic(paths.synced, syncMarkerPath(paths, repo), `${sha}\n`);
  yield* fs.remove(work, { recursive: true, force: true });
  const changedFiles = changedLockfiles(before, yield* readLockfiles(checkout));
  return { checkout, changedFiles, isFresh };
});

const syncFailure = (repo: string) => () =>
  notFound(repo, "the checkout could not be written to disk");

export const syncRepo = (
  paths: PreviewPaths,
  repo: string,
  sha: string,
  beforeReplace: Effect.Effect<
    void,
    never,
    FileSystem.FileSystem | ProcessGroups
  > = Effect.void
) =>
  syncRepoUnmapped(paths, repo, sha, beforeReplace).pipe(
    Effect.catchTag("PlatformError", syncFailure(repo))
  );
