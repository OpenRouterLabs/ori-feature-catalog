import { Effect, FileSystem, Layer, Option } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import {
  emptyProcessGroupsRecording,
  recordingProcessGroupsLayer,
} from "../process-groups/test-support.ts";
import { PREVIEW_UID, previewPaths, repoCheckout } from "../paths.ts";
import { checkedOutSha, MAX_ARCHIVE_BYTES, syncRepo } from "./index.ts";
import {
  chownRecordingServicesLayer,
  chownRefusedServicesLayer,
} from "../sandbox/test-support.ts";
import { describe, expect, it } from "../effect-bun-test.ts";

const REPO = "acme/web";
const SHA = "0123456789abcdef0123456789abcdef01234567";

const archive = (): Response => new Response("tarball");

const fixture = (input: {
  readonly answer?: () => Response;
  readonly requested?: string[];
  readonly recording?: ReturnType<typeof emptyProcessGroupsRecording>;
  readonly exitCode?: number;
  readonly chowned?: string[];
  readonly services?: typeof chownRefusedServicesLayer;
}) =>
  Layer.mergeAll(
    input.services ?? chownRecordingServicesLayer(input.chowned),
    recordingProcessGroupsLayer(input.recording, {
      ownPid: 1,
      exitCode: input.exitCode ?? 0,
    }),
    Layer.succeed(HttpClient.HttpClient)(
      HttpClient.make((request) =>
        Effect.sync(() => {
          input.requested?.push(request.url);
          return HttpClientResponse.fromWeb(request, (input.answer ?? archive)());
        })
      )
    )
  );

const workspace = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "ori-preview-" });
  return { fs, paths: previewPaths(`${root}/workspace`, `${root}/sandbox`) };
});

describe("syncRepo", () => {
  it.effect("downloads the commit's archive and extracts it as the preview user", () => {
    const requested: string[] = [];
    const recording = emptyProcessGroupsRecording();
    return Effect.gen(function* () {
      const { paths } = yield* workspace;
      yield* syncRepo(paths, REPO, SHA);
      expect(requested).toEqual([`https://codeload.github.com/${REPO}/tar.gz/${SHA}`]);
      expect(recording.ran[0]?.command).toContain("tar");
      expect(recording.ran[0]?.command).toContain(`--reuid=${PREVIEW_UID}`);
    }).pipe(Effect.scoped, Effect.provide(fixture({ requested, recording })));
  });

  it.effect("swaps the tree as the preview user, so root never writes inside a checkout", () => {
    const recording = emptyProcessGroupsRecording();
    return Effect.gen(function* () {
      const { paths } = yield* workspace;
      yield* syncRepo(paths, REPO, SHA);
      expect(recording.ran[1]?.command.slice(0, 2)).toEqual(["setpriv", `--reuid=${PREVIEW_UID}`]);
      expect(recording.ran[1]?.command).toContain("replace-tree");
      expect(recording.ran[1]?.cwd).toBe(repoCheckout(paths, REPO));
    }).pipe(Effect.scoped, Effect.provide(fixture({ recording })));
  });

  it.effect("hands the scratch tree and the checkout to the preview user", () => {
    const chowned: string[] = [];
    return Effect.gen(function* () {
      const { paths } = yield* workspace;
      yield* syncRepo(paths, REPO, SHA);
      expect(chowned).toEqual([
        `${paths.scratch}/acme__web-0123456789ab`,
        `${paths.scratch}/acme__web-0123456789ab/tree`,
        repoCheckout(paths, REPO),
      ]);
    }).pipe(Effect.scoped, Effect.provide(fixture({ chowned })));
  });

  it.effect("records the synced commit and clears the scratch directory", () =>
    Effect.gen(function* () {
      const { fs, paths } = yield* workspace;
      const synced = yield* syncRepo(paths, REPO, SHA);
      expect(synced).toEqual({ checkout: repoCheckout(paths, REPO), changedFiles: [], isFresh: true });
      expect(yield* checkedOutSha(paths, REPO)).toEqual(Option.some(SHA));
      expect(yield* fs.exists(`${paths.scratch}/acme__web-0123456789ab`)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(fixture({})))
  );

  it.effect("names the lockfiles the new tree changed, so only those syncs reinstall", () =>
    Effect.gen(function* () {
      const { fs, paths } = yield* workspace;
      const checkout = repoCheckout(paths, REPO);
      yield* fs.makeDirectory(checkout, { recursive: true });
      yield* fs.writeFileString(`${checkout}/bun.lock`, "old");
      yield* fs.writeFileString(`${checkout}/yarn.lock`, "same");
      const synced = yield* syncRepo(paths, REPO, SHA, fs.writeFileString(`${checkout}/bun.lock`, "new").pipe(Effect.orDie));
      expect(synced).toEqual({ checkout, changedFiles: ["bun.lock"], isFresh: false });
    }).pipe(Effect.scoped, Effect.provide(fixture({})))
  );

  it.effect("skips the download when the checkout is already at the commit", () => {
    const requested: string[] = [];
    return Effect.gen(function* () {
      const { fs, paths } = yield* workspace;
      const checkout = repoCheckout(paths, REPO);
      yield* fs.makeDirectory(checkout, { recursive: true });
      yield* fs.writeFileString(`${checkout}/package.json`, "{}");
      yield* fs.makeDirectory(paths.synced, { recursive: true });
      yield* fs.writeFileString(`${paths.synced}/acme__web`, `${SHA}\n`);
      const synced = yield* syncRepo(paths, REPO, SHA);
      expect(synced).toEqual({ checkout, changedFiles: [], isFresh: false });
      expect(requested).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(fixture({ requested })));
  });

  it.effect("refuses an archive GitHub would not serve", () =>
    Effect.gen(function* () {
      const { paths } = yield* workspace;
      const error = yield* syncRepo(paths, REPO, SHA).pipe(Effect.flip);
      expect(error.code).toBe("repo_not_found");
      expect(error.detail).toContain("the archive download answered 404");
    }).pipe(Effect.scoped, Effect.provide(fixture({ answer: () => new Response("", { status: 404 }) })))
  );

  it.effect("refuses an archive declared over the size limit before reading it", () => {
    const recording = emptyProcessGroupsRecording();
    return Effect.gen(function* () {
      const { paths } = yield* workspace;
      const error = yield* syncRepo(paths, REPO, SHA).pipe(Effect.flip);
      expect(error.detail).toContain("too large to preview");
      expect(recording.ran).toEqual([]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        fixture({
          recording,
          answer: () => new Response("", { headers: { "content-length": String(MAX_ARCHIVE_BYTES + 1) } }),
        })
      )
    );
  });

  it.effect("names tar's exit code when the archive does not extract, and records no commit", () =>
    Effect.gen(function* () {
      const { paths } = yield* workspace;
      const error = yield* syncRepo(paths, REPO, SHA).pipe(Effect.flip);
      expect(error.detail).toContain("the archive did not extract (tar exited 2)");
      expect(Option.isNone(yield* checkedOutSha(paths, REPO))).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(fixture({ exitCode: 2 })))
  );

  it.effect("reports a disk failure as an unwritable checkout", () =>
    Effect.gen(function* () {
      const { paths } = yield* workspace;
      const error = yield* syncRepo(paths, REPO, SHA).pipe(Effect.flip);
      expect(error.code).toBe("repo_not_found");
      expect(error.detail).toContain("the checkout could not be written to disk");
    }).pipe(Effect.scoped, Effect.provide(fixture({ services: chownRefusedServicesLayer })))
  );
});
