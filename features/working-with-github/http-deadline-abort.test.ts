import { describe, expect, test } from "bun:test";
// Every HTTP deadline in this feature must also CANCEL the request it gave up
// on. Pre-fix each one only stopped waiting (`Effect.timeoutOrElse` around a
// fetch that was never handed an AbortSignal), so the connection stayed open:
// against a server that never answers, five timed-out `ghJson` calls held five
// sockets for 361s, until the server side gave up. A wedged proxy or a slow
// uplink then kept a commit's blob uploads running after the CLI had already
// reported them failed, and each fire of a schedule left one more connection
// behind. Each case below drives one fetch site against a fetch that never
// settles and records the signal it was handed; the deadline must abort it.
import { Effect, Schema } from "effect";

import { discoverInstallationId, requestInstallationToken } from "./gh-app-github-api.ts";
import { ambientGitHubReachable, ghAuthHealthCheck } from "./schedules/gh-auth-health/gh-auth-health.ts";
import { ghJson } from "./scripts/commit-api-core.ts";

/** A never-settling fetch that records the signal of each request. */
const recordingNeverFetch = () => {
  const signals: (AbortSignal | undefined)[] = [];
  const fetchImpl = (_url: string, init?: RequestInit): Promise<Response> => {
    signals.push(init?.signal ?? undefined);
    return new Promise<Response>(() => {});
  };
  return { fetchImpl, signals };
};

/** A fetch whose headers arrive at once and whose JSON body never finishes. */
const stalledBodyFetch = () => {
  const signals: (AbortSignal | undefined)[] = [];
  const fetchImpl = (_url: string, init?: RequestInit): Promise<Response> => {
    signals.push(init?.signal ?? undefined);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"));
        init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
      },
    });
    return Promise.resolve(new Response(body, { status: 200 }));
  };
  return { fetchImpl, signals };
};

const DEADLINE_TEST_MS = 25_000;

const expectAborted = (signals: readonly (AbortSignal | undefined)[]) => {
  expect(signals.length).toBeGreaterThan(0);
  for (const signal of signals) {
    expect(signal?.aborted).toBe(true);
  }
};

describe("an HTTP deadline cancels the request it gave up on", () => {
  test(
    "ghJson (every commit-flow and sweep call) aborts a request that never answers",
    async () => {
      const { fetchImpl, signals } = recordingNeverFetch();
      await Effect.runPromise(
        Effect.flip(ghJson({ fetchImpl, method: "GET", schema: Schema.Unknown, url: "https://api.github.com/x" }))
      );
      expectAborted(signals);
    },
    DEADLINE_TEST_MS
  );

  test(
    "ghJson aborts a response whose body never finishes",
    async () => {
      const { fetchImpl, signals } = stalledBodyFetch();
      const error = await Effect.runPromise(
        Effect.flip(ghJson({ fetchImpl, method: "GET", schema: Schema.Unknown, url: "https://api.github.com/x" }))
      );
      expect(error.message).toContain("response body did not arrive");
      expectAborted(signals);
    },
    DEADLINE_TEST_MS
  );

  test(
    "the installations walk and the token POST abort a request that never answers",
    async () => {
      const discover = recordingNeverFetch();
      const token = recordingNeverFetch();
      await Promise.all([
        Effect.runPromise(Effect.flip(discoverInstallationId(discover.fetchImpl, "jwt", "acme", new Set(["acme"])))),
        Effect.runPromise(Effect.flip(requestInstallationToken(token.fetchImpl, "jwt", "42"))),
      ]);
      expectAborted(discover.signals);
      expectAborted(token.signals);
    },
    DEADLINE_TEST_MS
  );

  test(
    "both gh-auth-health probes abort a request that never answers",
    async () => {
      const ambient = recordingNeverFetch();
      const app = recordingNeverFetch();
      await Promise.all([
        Effect.runPromise(Effect.flip(ambientGitHubReachable({ fetchImpl: ambient.fetchImpl, repo: "acme/widgets" }))),
        Effect.runPromise(
          Effect.flip(
            ghAuthHealthCheck({
              fetchImpl: app.fetchImpl,
              mint: Effect.succeed({ expiresAt: "2026-01-01T00:00:00Z", token: "not-a-real-token" }),
              repo: "acme/widgets",
            })
          )
        ),
      ]);
      expectAborted(ambient.signals);
      expectAborted(app.signals);
    },
    DEADLINE_TEST_MS
  );
});
