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
import { COMMIT_HTTP_TIMEOUT_MS, commitHttpDeadlineMs, ghJson } from "./scripts/commit-api-core.ts";

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
const stalledBodyFetch = (status = 200) => {
  const signals: (AbortSignal | undefined)[] = [];
  const fetchImpl = (_url: string, init?: RequestInit): Promise<Response> => {
    signals.push(init?.signal ?? undefined);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"));
        init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
      },
    });
    return Promise.resolve(new Response(body, { status }));
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
    "ghJson gives a large body the time to upload, and a bodyless call keeps 15s",
    async () => {
      // A fetch settles once the whole body is up. Pre-fix a 12 MB file going
      // up at a steady 256 KB/s was cut off at 15s as "did not answer".
      const bytesPerSecond = 128 * 1024;
      const fetchImpl = (_url: string, init?: RequestInit): Promise<Response> =>
        new Promise<Response>((resolve) => {
          const sent = Buffer.byteLength(String(init?.body ?? ""));
          setTimeout(() => resolve(Response.json({ sha: "a".repeat(40) }, { status: 201 })), (sent / bytesPerSecond) * 1000);
        });
      const content = "x".repeat(2_300_000);
      const blob = await Effect.runPromise(
        ghJson({ body: { content, encoding: "utf-8" }, fetchImpl, method: "POST", schema: Schema.Struct({ sha: Schema.String }), url: "https://api.github.com/repos/o/r/git/blobs" })
      );
      expect(blob.sha).toBe("a".repeat(40));
      expect(commitHttpDeadlineMs(0)).toBe(COMMIT_HTTP_TIMEOUT_MS);
      expect(commitHttpDeadlineMs(60_000)).toBe(COMMIT_HTTP_TIMEOUT_MS);
    },
    DEADLINE_TEST_MS + 30_000
  );

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

  test(
    "the mint and both gh-auth-health probes abort a response whose body never finishes",
    async () => {
      // Pre-fix only ghJson linked its body read to the abort: these handed the
      // fetch its own signal, which is never aborted once the headers are in,
      // so each body deadline failed the call and left the socket open.
      const mint = { badPage: stalledBodyFetch(404), page: stalledBodyFetch(), token: stalledBodyFetch(201) };
      const probe = { ambient401: stalledBodyFetch(401), ambient403: stalledBodyFetch(403), app: stalledBodyFetch(), appBad: stalledBodyFetch(404) };
      const mintFor = (fetchImpl: typeof probe.app.fetchImpl) =>
        ghAuthHealthCheck({
          fetchImpl,
          mint: Effect.succeed({ expiresAt: "2026-01-01T00:00:00Z", token: "not-a-real-token" }),
          repo: "acme/widgets",
        });
      await Promise.all([
        Effect.runPromise(Effect.flip(discoverInstallationId(mint.page.fetchImpl, "jwt", "acme", new Set(["acme"])))),
        Effect.runPromise(Effect.flip(discoverInstallationId(mint.badPage.fetchImpl, "jwt", "acme", new Set(["acme"])))),
        Effect.runPromise(Effect.flip(requestInstallationToken(mint.token.fetchImpl, "jwt", "42"))),
        Effect.runPromise(Effect.exit(ambientGitHubReachable({ fetchImpl: probe.ambient401.fetchImpl, repo: "acme/widgets" }))),
        Effect.runPromise(Effect.exit(ambientGitHubReachable({ fetchImpl: probe.ambient403.fetchImpl, repo: "acme/widgets" }))),
        Effect.runPromise(Effect.exit(mintFor(probe.app.fetchImpl))),
        Effect.runPromise(Effect.exit(mintFor(probe.appBad.fetchImpl))),
      ]);
      for (const { signals } of [...Object.values(mint), ...Object.values(probe)]) {
        expectAborted(signals);
      }
    },
    DEADLINE_TEST_MS
  );
});
