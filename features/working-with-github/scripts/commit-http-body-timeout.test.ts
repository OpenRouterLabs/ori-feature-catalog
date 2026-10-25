import { describe, expect, test } from "bun:test";
// commit-http-body-timeout.test.ts — `ghJson`'s BODY read must carry the
// same deadline its fetch half already does. #184 bounded the FETCH: a Git
// Data API call that never settles fails `commit-via-api` within 15s. But a
// server that answers the headers and then stalls the body leaves
// `response.json()` pending forever — the same wedge reopened through the
// body read, so the commit flow still hung AFTER side effects (a minted
// token, created blobs), and a sweep's PR-lookup page still wedged every
// later daily fire. The PR-lookup deadline (`PR_LOOKUP_TIMEOUT_MS`, 15s)
// sits on top of this one, so both callers stop waiting.
//
// The suite pins the honest wedge shape (a Response whose stream never
// completes) against a REAL clock, and pins that a settled-but-not-JSON
// body still takes the documented `parse` channel — the two failure modes a
// caller can tell apart.
import { Effect, Schema } from "effect";

import { ghJson } from "./commit-api-core.ts";

const Ping = Schema.Struct({ ok: Schema.Boolean });

/** A Response whose headers arrive but whose body NEVER completes. */
const stalledBody = (status: number): Promise<Response> => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"ok":tr'));
      // never close — the body read hangs
    },
  });
  return Promise.resolve(
    new Response(stream, {
      headers: { "content-type": "application/json" },
      status,
    })
  );
};

/** Wall-clock ms the effect took to settle, plus its outcome label. */
const timed = async <A, E>(
  effect: Effect.Effect<A, E>
): Promise<{ label: string; ms: number }> => {
  const startedAt = Date.now();
  const outcome = await Effect.runPromise(
    effect.pipe(
      Effect.match({
        onFailure: (error) =>
          `failed: ${error instanceof Error ? error.message : String(error)}`,
        onSuccess: () => "succeeded",
      })
    )
  );
  return { label: outcome, ms: Date.now() - startedAt };
};

const DEADLINE_MS = 15_000;
const WEDGE_MARGIN_MS = 5_000;

describe("ghJson bounds the BODY read too", () => {
  test(
    "a stalled 2xx body fails within the deadline, never hangs",
    async () => {
      const outcome = await timed(
        ghJson({
          fetchImpl: () => stalledBody(200),
          method: "GET",
          schema: Ping,
          url: "https://api.github.com/repos/o/r/git/ref/heads/main",
        })
      );
      expect(outcome.label).toContain("response body did not arrive within");
      expect(outcome.ms).toBeLessThan(DEADLINE_MS + WEDGE_MARGIN_MS);
    },
    (DEADLINE_MS + WEDGE_MARGIN_MS + 5_000) as never
  );

  test(
    "a stalled non-2xx body fails within the deadline too — the envelope never arrives",
    async () => {
      const outcome = await timed(
        ghJson({
          fetchImpl: () => stalledBody(500),
          method: "GET",
          schema: Ping,
          url: "https://api.github.com/repos/o/r/git/ref/heads/main",
        })
      );
      expect(outcome.label).toContain("response body did not arrive within");
      expect(outcome.ms).toBeLessThan(DEADLINE_MS + WEDGE_MARGIN_MS);
    },
    (DEADLINE_MS + WEDGE_MARGIN_MS + 5_000) as never
  );

  test("a settled body that is not JSON still takes the parse channel", async () => {
    const outcome = await timed(
      ghJson({
        fetchImpl: () =>
          Promise.resolve(
            new Response("not json at all", {
              headers: { "content-type": "text/plain" },
              status: 200,
            })
          ),
        method: "GET",
        schema: Ping,
        url: "https://api.github.com/repos/o/r",
      })
    );
    expect(outcome.label).toContain("response was not JSON");
    expect(outcome.ms).toBeLessThan(1_000);
  });
});
