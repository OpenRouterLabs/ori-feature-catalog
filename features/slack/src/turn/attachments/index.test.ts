import { Effect, Exit } from "effect";

import { describe, expect, test } from "#src/test-support/index.ts";

import { makeTurnAttachments } from "./index.ts";

const withAttachments = makeTurnAttachments({
  fetch: globalThis.fetch,
  token: "xoxb-test",
});

const eventWithNoFiles = {
  channel: "C1",
  text: "no files here",
  thread_ts: "1700.1",
  ts: "1700.2",
  user: "U1",
} as unknown as Parameters<typeof withAttachments>[0];

describe("withAttachments", () => {
  test.effect("runs the turn's work and hands it the warning", () =>
    Effect.gen(function* () {
      const seen: (string | undefined)[] = [];

      yield* withAttachments(eventWithNoFiles, (warning) =>
        Effect.sync(() => {
          seen.push(warning);
        })
      );

      expect(seen).toHaveLength(1);
      expect(seen[0]).toBe("");
    })
  );

  test.effect("a failure in the work reaches the caller unchanged", () =>
    Effect.gen(function* () {
      const boom = new Error("the turn failed");

      const exit = yield* withAttachments(eventWithNoFiles, () =>
        Effect.fail(boom)
      ).pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      const thrown = Exit.isFailure(exit)
        ? exit.cause.reasons.flatMap((reason) =>
            "error" in reason ? [reason.error] : []
          )
        : [];
      expect(thrown).toEqual([boom]);
    })
  );

  test.effect("the work runs even when nothing was fetched", () =>
    Effect.gen(function* () {
      let ran = false;

      yield* withAttachments(eventWithNoFiles, () =>
        Effect.sync(() => {
          ran = true;
        })
      );

      expect(ran).toBe(true);
    })
  );
});
