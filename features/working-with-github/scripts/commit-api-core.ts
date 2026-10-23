/**
 * commit-api-core.ts — shared error type, seams, and GitHub Git-Data-API JSON
 * helper for the commit-via-API flow.
 *
 * Split out of `commit-via-api.ts` (see that file for the full "why this
 * exists" / usage docs) purely to keep each module under the file-length lint
 * budget; there is no independent reuse story yet.
 */

import { spawnSync } from "node:child_process";

import { Data, Effect, Option, Schema } from "effect";

// #region Error

/** Single typed failure for every commit-via-API operation. */
export class CommitApiError extends Data.TaggedError("CommitApiError")<{
  /** The failing stage — "args" | "mint" | "git" | "http" | "parse" | "nothing-to-commit". */
  readonly stage: string;
  /** Human-readable message (never carries token material). */
  readonly message: string;
  /** HTTP status for "http" failures; absent otherwise. */
  readonly status?: number;
}> {}

// #endregion
// #region Types

/** The subset of `fetch` this module uses — narrow so tests inject a fake
 *  without satisfying Bun's full `typeof fetch` (which requires `preconnect`). */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** A run-git seam so tests drive the porcelain/cat-file parsing without a repo. */
export type RunGit = (
  args: readonly string[],
  cwd: string
) => { readonly ok: boolean; readonly stdout: string; readonly stderr: string };

/** A read-file seam (absolute path → bytes) so tests inject content with no disk. */
export type ReadFile = (absolutePath: string) => Promise<ArrayBuffer>;

/** One worktree change: a repo-relative path plus whether it was deleted. */
export interface ChangedFile {
  readonly path: string;
  readonly deleted: boolean;
}

export interface CommitArgs {
  readonly worktree: string;
  readonly branch: string;
  readonly message: string;
  readonly repo: string;
}

export interface CommitDeps {
  readonly fetchImpl?: FetchLike;
  readonly runGit?: RunGit;
  readonly readFile?: ReadFile;
  /** Pre-resolved token; when set, minting is skipped. */
  readonly token?: string;
}

export const GITHUB_API = "https://api.github.com";
/** GitHub's blob mode for a normal (non-executable, non-symlink) file. */
export const FILE_MODE = "100644";
export const EXEC_MODE = "100755";
/** `git status --porcelain=v1 -z` rename-source path index offset. */
const RENAME_FIELD_OFFSET = 2;
/** `git status --porcelain=v1 -z` status-code column width before the path. */
const STATUS_PATH_OFFSET = 3;

/**
 * Resolve `owner/repo` from `GITHUB_REPO`, tolerating a full https URL or a
 * trailing `.git`. Returns `""` when unset so the CLI can fail with a clear
 * message rather than committing to the wrong repo.
 */
export const resolveRepoFromEnv = (
  // oxlint-disable-next-line node/no-process-env -- default deps seam; callers pass a fake env in tests.
  env: Readonly<Record<string, string | undefined>> = process.env
): string => {
  const raw = (env.GITHUB_REPO ?? "").trim();
  const withoutSuffix = raw.replace(/\.git$/u, "");
  const match = /github\.com[/:]([^/]+\/[^/]+)$/u.exec(withoutSuffix);
  if (match?.[1] !== undefined) {
    return match[1];
  }
  return withoutSuffix;
};

// #endregion

// #region git seam

/** Default `runGit`: a synchronous git invocation in `cwd`. */
export const defaultRunGit = (
  args: readonly string[],
  cwd: string
): { ok: boolean; stdout: string; stderr: string } => {
  const result = spawnSync("git", [...args], {
    cwd,
    encoding: "utf-8",
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
};

/** Parse one non-rename porcelain-z record into a `ChangedFile`. */
const parseStatusEntry = (entry: string): ChangedFile => {
  const x = entry[0] ?? " ";
  const y = entry[1] ?? " ";
  const path = entry.slice(STATUS_PATH_OFFSET);
  const isDeleted = x === "D" || y === "D";
  return {
    path,
    deleted: isDeleted,
  };
};

/**
 * Parse `git status --porcelain=v1 -z --untracked-files=all` output into the
 * changed-file list. The `-z` form is NUL-delimited and quoting-free, so paths
 * with spaces / unicode / renames are handled without unescaping. Renames (`R`)
 * emit two NUL fields (new\0old); we treat the new path as added and the old as
 * deleted.
 */
export const parseStatusZ = (output: string): ChangedFile[] => {
  const files: ChangedFile[] = [];
  // Records are `XY␠path` joined by NUL; a rename adds a trailing NUL + oldpath.
  const fields = output.split("\0");
  let i = 0;
  while (i < fields.length) {
    const entry = fields[i];
    if (entry === undefined || entry === "") {
      i += 1;
      continue;
    }
    const x = entry[0] ?? " ";
    const y = entry[1] ?? " ";
    const isRename = x === "R" || y === "R";
    if (isRename) {
      const path = entry.slice(STATUS_PATH_OFFSET);
      // Next field is the old path (rename source) → a deletion.
      const oldPath = fields[i + 1];
      if (oldPath !== undefined && oldPath !== "") {
        files.push({
          path: oldPath,
          deleted: true,
        });
      }
      files.push({
        path,
        deleted: false,
      });
      i += RENAME_FIELD_OFFSET;
      continue;
    }
    files.push(parseStatusEntry(entry));
    i += 1;
  }
  return files;
};

// #endregion

// #region GitHub API helpers

export interface GhJsonInput {
  readonly fetchImpl: FetchLike;
  readonly token: string;
  readonly method: "GET" | "POST" | "PATCH";
  readonly url: string;
  readonly body?: unknown;
}

/**
 * GitHub's error envelope, returned on every non-2xx REST response. `message`
 * is `optional` so a body that lacks it (or is not an object at all) degrades
 * to the HTTP status rather than failing: the call has already failed, and a
 * schema complaint here would replace GitHub's own explanation of why.
 */
const GitHubErrorBody = Schema.Struct({
  message: Schema.optional(Schema.String),
});

/** GitHub's non-2xx `message`, falling back to the status when the body is not the envelope. */
const githubErrorDetail = (payload: unknown, status: number): string => {
  const decoded = Schema.decodeUnknownOption(GitHubErrorBody)(payload);
  const message = Option.isSome(decoded) ? decoded.value.message : undefined;
  return message ?? `HTTP ${status}`;
};

/**
 * One JSON GitHub API call as an Effect, decoded against `schema`. Non-2xx →
 * typed `http` CommitApiError carrying GitHub's own message (or the status
 * when the body is not GitHub's envelope — an HTML proxy page); a 2xx body
 * that is not JSON at all, or does not match `schema` → typed `parse`
 * CommitApiError.
 *
 * The schema is per call site rather than a shared `Record<string, unknown>`,
 * so each response is checked once here instead of being re-inspected key by
 * key by whoever consumes it.
 */
export const ghJson = <S extends Schema.Top>(
  input: GhJsonInput & { readonly schema: S }
): Effect.Effect<S["Type"], CommitApiError, S["DecodingServices"]> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        input.fetchImpl(input.url, {
          method: input.method,
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${input.token}`,
            "X-GitHub-Api-Version": "2022-11-28",
            ...(input.body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
          },
          ...(input.body === undefined
            ? {}
            : { body: JSON.stringify(input.body) }),
        }),
      catch: (cause) =>
        new CommitApiError({
          stage: "http",
          message: `${input.method} ${input.url} request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
    });

    // Read the body as JSON up front, degrading to `null` when it is not JSON
    // at all (an HTML error page, a 0-byte body). A non-2xx must be explained
    // by its own envelope or degrade to the HTTP status — never fail as a
    // "response was not JSON" complaint, which both mislabels the failure and
    // drops the status a caller may match on (and hides the actual 502/404).
    const parsed: unknown = yield* Effect.promise(() =>
      response.json().catch(() => null)
    );

    if (!response.ok) {
      return yield* new CommitApiError({
        stage: "http",
        status: response.status,
        message: `${input.method} ${input.url}: ${githubErrorDetail(parsed, response.status)}`,
      });
    }

    if (parsed === null) {
      return yield* new CommitApiError({
        stage: "parse",
        message: `${input.method} ${input.url}: response was not JSON`,
      });
    }

    return yield* Schema.decodeUnknownEffect(input.schema, { errors: "all" })(
      parsed
    ).pipe(
      Effect.mapError(
        (error) =>
          new CommitApiError({
            stage: "parse",
            message: `${input.method} ${input.url}: response did not match the expected shape: ${error.message}`,
          })
      )
    );
  });

// #endregion
