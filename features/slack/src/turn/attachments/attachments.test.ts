/**
 * attachments.test.ts — what `withAttachments` promises the turn.
 *
 * This module had no test at all: 0% of its functions, on the path every turn
 * carrying a file takes. What is asserted here is the contract that is cheap
 * to break and expensive to notice — the callback runs, its failure reaches
 * the caller unchanged, and cleanup is decided by whether anything was
 * actually fetched.
 *
 * The download itself is not exercised. `gatherAttachments` reaches
 * `globalThis.fetch` directly, so covering a real download would mean a
 * network fake threaded through a module that does not take one. An event with
 * no files walks the same code with nothing to fetch, which is the honest
 * seam available today; `attachment-download.test.ts` covers the fetching.
 */

import { Effect, Exit } from "effect";

import { describe, expect, test } from "#src/test-support/effect-test.ts";

import { withAttachments } from "./attachments.ts";

/** The least a turn can arrive with: a message, no files. */
const eventWithNoFiles = {
  event: {
    channel: "C1",
    text: "no files here",
    thread_ts: "1700.1",
    ts: "1700.2",
    user: "U1",
  },
  token: "xoxb-test",
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

      // One call, and an EMPTY warning rather than an absent one: with no
      // files `untrustedFilesWarning` returns "", so the turn is handed a
      // string it will render as nothing. Worth pinning — a caller testing
      // `warning === undefined` would prepend an empty block to every turn.
      expect(seen).toHaveLength(1);
      expect(seen[0]).toBe("");
    })
  );

  test.effect("a failure in the work reaches the caller unchanged", () =>
    Effect.gen(function* () {
      // The turn's own failure is the interesting one: cleanup must not
      // swallow it, and `Effect.ensuring` must not replace it either.
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
      // The cleanup branch is chosen by `fetched > 0`. With no files there is
      // no directory to remove, and the turn must still run — an early return
      // here would silently skip every message that arrived without a file.
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
