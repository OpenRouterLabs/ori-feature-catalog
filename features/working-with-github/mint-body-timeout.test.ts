import { describe, expect, test } from "bun:test";
// mint-body-timeout.test.ts — the mint path's TWO body reads (the
// installations page walk and the access-token POST) must carry the same
// deadline their fetches already do. #183 bounded the FETCH half: a fetch
// that never settles fails the mint within 15s. But a server that answers
// the HEADERS and then stalls the BODY leaves `response.json()` pending
// forever — the same wedge reopened through the body read, so
// `GH_TOKEN=$(bun mint-token.ts)` still blocked the caller's whole shell and
// `commit-via-api.ts` (which mints internally) still never returned, in
// exactly the "wedged api.github.com" state the deadline exists to close.
//
// The suite pins the honest wedge shape (a Response whose stream never
// completes) against a REAL clock: the effect must FAIL within the
// deadline, not merely be cancellable. The non-2xx and non-JSON channels
// stay pinned by the sibling suites (mint-http-timeout.test.ts,
// gh-app-github-api.test.ts), so only the body-half is covered here.
import { Effect } from "effect";

import {
  discoverInstallationId,
  requestInstallationToken,
} from "./gh-app-github-api.ts";

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

describe("the mint path bounds every BODY read too", () => {
  test(
    "a stalled installations page body fails within the deadline, never hangs",
    async () => {
      const outcome = await timed(
        discoverInstallationId(
          () => stalledBody(200),
          "jwt",
          "acme",
          new Set(["acme"])
        )
      );
      expect(outcome.label).toContain("response body did not arrive within");
      expect(outcome.ms).toBeLessThan(DEADLINE_MS + WEDGE_MARGIN_MS);
    },
    (DEADLINE_MS + WEDGE_MARGIN_MS + 5_000) as never
  );

  test(
    "a stalled access-token body fails within the deadline, never hangs",
    async () => {
      const outcome = await timed(
        requestInstallationToken(() => stalledBody(201), "jwt", "42")
      );
      expect(outcome.label).toContain("response body did not arrive within");
      expect(outcome.ms).toBeLessThan(DEADLINE_MS + WEDGE_MARGIN_MS);
    },
    (DEADLINE_MS + WEDGE_MARGIN_MS + 5_000) as never
  );
});
