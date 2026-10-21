import { layer as BunServicesLayer } from "@effect/platform-bun/BunServices";
import { Effect, FileSystem, Option } from "effect";

import { alternatePath, previewPaths, statusPath } from "#src/paths.ts";
import {
  claimedPorts,
  clearAlternate,
  readAllPreviewStatuses,
  readAlternate,
  readPreviewStatus,
  touchPreview,
  writeAlternate,
  writePreviewStatus,
} from "#src/status/index.ts";
import { describe, expect, it } from "#src/effect-bun-test.ts";

const alternate = {
  repo: "acme/web",
  directory: "/preview/work/web",
  port: 41_002,
  process: { pid: 77 },
  url: "http://127.0.0.1:41002/",
};

describe("preview status files", () => {
  it.effect("round-trips a status and stamps when it was written and last used", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = previewPaths(yield* fs.makeTempDirectoryScoped());
      yield* writePreviewStatus(paths, { repo: "acme/web", phase: "warm", port: 41_000 });
      const written = yield* readPreviewStatus(paths, "acme/web");
      assertSome(written);
      expect(written.value.phase).toBe("warm");
      expect(written.value.updatedAt).not.toBe("");
      yield* touchPreview(paths, written.value);
      const touched = yield* readPreviewStatus(paths, "acme/web");
      expect(Option.getOrUndefined(touched)?.lastUsedAt).toBeDefined();
    }).pipe(Effect.scoped, Effect.provide(BunServicesLayer))
  );

  it.effect("reads nothing for a missing or unreadable status rather than guessing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = previewPaths(yield* fs.makeTempDirectoryScoped());
      expect(yield* readPreviewStatus(paths, "acme/web")).toEqual(Option.none());
      yield* fs.makeDirectory(paths.status, { recursive: true });
      yield* fs.writeFileString(statusPath(paths, "acme/web"), "{not json");
      expect(yield* readPreviewStatus(paths, "acme/web")).toEqual(Option.none());
    }).pipe(Effect.scoped, Effect.provide(BunServicesLayer))
  );

  it.effect("lists every readable status in name order and skips other files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = previewPaths(yield* fs.makeTempDirectoryScoped());
      expect(yield* readAllPreviewStatuses(paths)).toEqual([]);
      yield* writePreviewStatus(paths, { repo: "acme/web", phase: "parked" });
      yield* writePreviewStatus(paths, { repo: "acme/api", phase: "warm" });
      yield* fs.writeFileString(`${paths.status}/notes.txt`, "ignored");
      const repos = (yield* readAllPreviewStatuses(paths)).map((status) => status.repo);
      expect(repos).toEqual(["acme/api", "acme/web"]);
    }).pipe(Effect.scoped, Effect.provide(BunServicesLayer))
  );

  it.effect("writes, reads and clears a changed copy's server", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = previewPaths(yield* fs.makeTempDirectoryScoped());
      yield* writeAlternate(paths, alternate);
      expect(yield* readAlternate(paths, "acme/web")).toEqual(Option.some(alternate));
      yield* clearAlternate(paths, "acme/web");
      expect(yield* fs.exists(alternatePath(paths, "acme/web"))).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(BunServicesLayer))
  );

  it.effect("claims the ports of other repos' previews and of every changed copy", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = previewPaths(yield* fs.makeTempDirectoryScoped());
      expect(yield* claimedPorts(paths)).toEqual(new Set());
      yield* writePreviewStatus(paths, { repo: "acme/web", phase: "warm", port: 41_000 });
      yield* writePreviewStatus(paths, { repo: "acme/api", phase: "warm", port: 41_001 });
      yield* writePreviewStatus(paths, { repo: "acme/docs", phase: "not_runnable" });
      yield* writeAlternate(paths, alternate);
      expect(yield* claimedPorts(paths, "acme/web")).toEqual(new Set([41_001, 41_002]));
    }).pipe(Effect.scoped, Effect.provide(BunServicesLayer))
  );
});

function assertSome<A>(option: Option.Option<A>): asserts option is Option.Some<A> {
  expect(Option.isSome(option)).toBe(true);
}
