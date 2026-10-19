import { layer as BunServicesLayer } from "@effect/platform-bun/BunServices";
import type { FeatureLogger } from "ori";

import { Effect, FileSystem, Layer } from "effect";

import { scriptedPreviewHostLayer } from "./host-test-support.ts";
import { fetchHttpClientLayer } from "./http.ts";
import {
  makePreviewSchedule,
  PREVIEW_SCHEDULE_CRON,
  PREVIEW_SKIPPED_SUMMARY,
} from "./feature.ts";
import { describe, expect, it } from "./effect-bun-test.ts";

const ignore = (): void => undefined;

const recordingLogger = (errors: unknown[]): FeatureLogger => ({
  child: () => recordingLogger(errors),
  trace: ignore,
  debug: ignore,
  info: ignore,
  warn: ignore,
  error: (message, error) => {
    errors.push([message, error]);
  },
});

describe("makePreviewSchedule", () => {
  it.effect("skips the sweep when no repository was configured or used", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const schedule = yield* makePreviewSchedule({
        env: {},
        workspaceRoot: yield* fs.makeTempDirectoryScoped(),
      });
      expect(schedule.cron).toBe(PREVIEW_SCHEDULE_CRON);
      expect(schedule.overlap).toBe("skip");
      const errors: unknown[] = [];
      const summary = yield* Effect.promise(() =>
        schedule.run({ logger: recordingLogger(errors) })
      );
      expect(summary).toEqual(PREVIEW_SKIPPED_SUMMARY);
      expect(errors).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(
        Layer.mergeAll(scriptedPreviewHostLayer, BunServicesLayer, fetchHttpClientLayer)
      ))
  );
});
