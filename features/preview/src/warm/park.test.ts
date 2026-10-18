import { layer as BunServicesLayer } from "@effect/platform-bun/BunServices";
import { Effect, FileSystem, Layer, Option } from "effect";

import { previewPaths } from "#src/paths.ts";
import {
  emptyProcessGroupsRecording,
  recordingProcessGroupsLayer,
} from "#src/process-groups/test-support.ts";
import {
  readAlternate,
  readPreviewStatus,
  writeAlternate,
  writePreviewStatus,
} from "#src/status/index.ts";
import { makeRoom, park, stopAlternate } from "#src/warm/index.ts";
import { describe, expect, it } from "#src/effect-bun-test.ts";

const fixture = (recording = emptyProcessGroupsRecording()) =>
  Layer.merge(BunServicesLayer, recordingProcessGroupsLayer(recording));

const alternate = {
  repo: "acme/web",
  directory: "/preview/work/web",
  port: 41_002,
  process: { pid: 78 },
  url: "http://127.0.0.1:41002/",
};

const phaseOf = (root: string, repo: string) =>
  readPreviewStatus(previewPaths(root), repo).pipe(
    Effect.map((status) => Option.getOrUndefined(status)?.phase)
  );

describe("park", () => {
  it.effect("stops a warm preview and its changed copy and keeps what it knew about the repo", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const paths = previewPaths(root);
      yield* writePreviewStatus(paths, {
        repo: "acme/web",
        phase: "warm",
        port: 41_000,
        process: { pid: 77 },
        headSha: "abc",
        lastUsedAt: "2026-01-01T00:00:00.000Z",
      });
      yield* writeAlternate(paths, alternate);
      yield* park(paths, "acme/web");
      const parked = Option.getOrUndefined(yield* readPreviewStatus(paths, "acme/web"));
      expect(parked?.phase).toBe("parked");
      expect(parked?.port).toBeUndefined();
      expect(parked?.headSha).toBe("abc");
      expect(parked?.lastUsedAt).toBe("2026-01-01T00:00:00.000Z");
      expect(yield* readAlternate(paths, "acme/web")).toEqual(Option.none());
    }).pipe(Effect.scoped, Effect.provide(fixture()))
  );

  it.effect("leaves a preview that holds nothing alone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const paths = previewPaths(root);
      yield* park(paths, "acme/web");
      expect(yield* phaseOf(root, "acme/web")).toBeUndefined();
      yield* writePreviewStatus(paths, { repo: "acme/web", phase: "not_runnable", reason: "no recipe" });
      yield* park(paths, "acme/web");
      expect(yield* phaseOf(root, "acme/web")).toBe("not_runnable");
    }).pipe(Effect.scoped, Effect.provide(fixture()))
  );
});

describe("stopAlternate", () => {
  it.effect("clears a changed copy's record even when nothing is running", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = previewPaths(yield* fs.makeTempDirectoryScoped());
      yield* stopAlternate(paths, "acme/web");
      yield* writeAlternate(paths, alternate);
      yield* stopAlternate(paths, "acme/web");
      expect(yield* readAlternate(paths, "acme/web")).toEqual(Option.none());
    }).pipe(Effect.scoped, Effect.provide(fixture()))
  );
});

describe("makeRoom", () => {
  it.effect("parks the least recently used preview to free a slot for another repo", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const paths = previewPaths(root);
      yield* writePreviewStatus(paths, {
        repo: "acme/old",
        phase: "warm",
        lastUsedAt: "2026-01-01T00:00:00.000Z",
      });
      yield* writePreviewStatus(paths, {
        repo: "acme/new",
        phase: "warm",
        lastUsedAt: "2026-02-01T00:00:00.000Z",
      });
      yield* makeRoom(paths, "acme/web", 2);
      expect(yield* phaseOf(root, "acme/old")).toBe("parked");
      expect(yield* phaseOf(root, "acme/new")).toBe("warm");
    }).pipe(Effect.scoped, Effect.provide(fixture()))
  );

  it.effect("keeps every preview when the incoming repo already has a slot", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const paths = previewPaths(root);
      yield* writePreviewStatus(paths, { repo: "acme/web", phase: "warm" });
      yield* makeRoom(paths, "acme/web");
      expect(yield* phaseOf(root, "acme/web")).toBe("warm");
    }).pipe(Effect.scoped, Effect.provide(fixture()))
  );
});
