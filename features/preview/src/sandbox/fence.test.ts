import { layer as BunServicesLayer } from "@effect/platform-bun/BunServices";
import { Effect, FileSystem, Layer } from "effect";

import {
  emptyProcessGroupsRecording,
  recordingProcessGroupsLayer,
} from "#src/process-groups/test-support.ts";
import { PREVIEW_UID, previewPaths } from "#src/paths.ts";
import { assertFenced, chownTree, FENCE_MISSING } from "#src/sandbox/index.ts";
import { describe, expect, it } from "#src/effect-bun-test.ts";

const fixture = (exitCode: number, recording = emptyProcessGroupsRecording()) =>
  Layer.mergeAll(BunServicesLayer, recordingProcessGroupsLayer(recording, { ownPid: 1, exitCode }));

describe("assertFenced", () => {
  it.effect("passes when the sandboxed probe cannot reach the metadata server", () => {
    const recording = emptyProcessGroupsRecording();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = previewPaths(yield* fs.makeTempDirectoryScoped());
      yield* assertFenced(paths, { ORI_DAEMON_TOKEN: "secret" });
      expect(recording.ran[0]?.command.at(-1)).toContain("169.254.169.254");
      expect(recording.ran[0]?.env.ORI_DAEMON_TOKEN).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(fixture(0, recording)));
  });

  it.effect("refuses to run repository code when the probe reached the metadata server", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = previewPaths(yield* fs.makeTempDirectoryScoped());
      const error = yield* assertFenced(paths, {}).pipe(Effect.flip);
      expect(error.code).toBe("sandbox_unavailable");
      expect(error.detail).toBe(FENCE_MISSING);
    }).pipe(Effect.scoped, Effect.provide(fixture(1)))
  );
});

describe("chownTree", () => {
  it("hands the tree to the preview user without following links off the filesystem", () => {
    expect(chownTree("/preview/work/web")).toEqual([
      "find", "/preview/work/web", "-xdev", "-exec", "chown", "-h", `${PREVIEW_UID}:${PREVIEW_UID}`, "{}", "+",
    ]);
  });
});
