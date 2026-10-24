import { describe, expect, test } from "bun:test";
// postAlert's WebClient must carry a request timeout. The vendored
// @slack/web-api (7.15.0) defaults `timeout` to 0 — "no timeout" — and hands
// it straight to axios, so a client built with only `retryConfig` (the
// pre-fix shape) leaves a wedged chat.postMessage pending FOREVER (verified
// live against the exact vendored SDK: still pending past 90s, while the
// same client with a timeout settles as a rejection).
//
// That is not hypothetical: both sibling network paths in the same
// gh-auth-health schedule bound their waits for exactly this reason (a hung
// `GET /` or `GET /repos/{repo}` left the fire pending, the runtime skipped
// every later fire, and the schedule whose job is to ALERT on broken GitHub
// access stayed silent — see AMBIENT_PROBE_TIMEOUT_MS and
// ROUND_TRIP_TIMEOUT_MS in gh-auth-health.ts). The alert post is the third
// network call of the same fire and the one that runs precisely when GitHub
// is broken: a dropped route or wedged proxy to slack.com leaves the fire
// pending forever, and the alert-escape fix's `Effect.catch` — which only
// runs when the postAlert promise SETTLES — never fires either.
//
// The suite pins the construction contract (a finite, positive, generous
// timeout option) and the live wedge shape (a server that accepts and never
// answers settles the post as a failure, instead of hanging past it). The
// settle time is the SDK's retry ladder — up to 4 attempts × the timeout
// plus its backoff delays — so the race window and the per-test timeout
// below both allow for the full ladder.
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { AddressInfo } from "node:net";

import { WebClient } from "@slack/web-api";

import { POST_ALERT_TIMEOUT_MS, postAlert } from "./post-alert.ts";

const neverAnsweringServer = async (): Promise<{
  readonly close: () => void;
  readonly url: string;
}> => {
  const server = createServer(() => {
    // Accept the connection, never answer — the wedged-connection shape.
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    close: () => {
      server.closeAllConnections?.();
      server.close();
    },
    url: `http://127.0.0.1:${port}/api/`,
  };
};

/** A `sleep` whose overloads satisfy the string|number union both accept. */
const waitFor = (ms: number): Promise<void> =>
  sleep(ms).then(() => undefined);

// The SDK walks up to 4 attempts (1 + retries: 3), each waiting the full
// request timeout before axios aborts, plus its backoff delays (200+400+800)
// — so a wedged post settles at roughly 4 x timeout + 1.4s, not at timeout.
const settleWindowMs = 4 * POST_ALERT_TIMEOUT_MS + 5_000;

describe("postAlert request deadline", () => {
  test("the timeout is bounded, finite, positive, and covers the retry ladder", () => {
    expect(Number.isFinite(POST_ALERT_TIMEOUT_MS)).toBe(true);
    expect(POST_ALERT_TIMEOUT_MS).toBeGreaterThan(0);
    // Bounded work, not a token deadline: the retry ladder the SDK walks
    // inside one postAlert call adds up to 1.4s of DELAYS (200+400+800),
    // so a bound that cannot cover a single retried attempt would turn a
    // transient Slack 5xx into a spurious alert-post failure.
    expect(POST_ALERT_TIMEOUT_MS).toBeGreaterThanOrEqual(15_000);
  });

  test(
    "a wedged chat.postMessage settles as a failure, never hangs past the ladder",
    async () => {
      const { close, url } = await neverAnsweringServer();
      try {
        // The exact construction postAlert performs, aimed at the wedged
        // server: the deadline must make the promise REJECT (settle as a
        // failure the schedule's alert-escape Effect.catch can swallow)
        // instead of pending forever, like the pre-fix shape did.
        const outcome = await Promise.race([
          postAlert({ channel: "C123", text: "alert" }, {
            slackApiUrl: url,
          }).then(
            () => "posted",
            (error: unknown) =>
              `failed: ${error instanceof Error ? error.message : String(error)}`
          ),
          waitFor(settleWindowMs).then(
            () => "STILL PENDING past the full ladder — the fire would hang forever"
          ),
        ]);
        expect(outcome).not.toBe("posted");
        expect(outcome).not.toContain("STILL PENDING");
      } finally {
        close();
      }
    },
    settleWindowMs + 5_000
  );

  test(
    "the SDK's own no-timeout default is what the fix guards against",
    async () => {
      // Pin the vendored SDK contract this fix compensates for: a WebClient
      // with NO timeout option never settles against the wedged server. If
      // the SDK ever ships a finite default timeout, this test documents
      // that the explicit option in postAlert.ts has become redundant (and
      // the guard can be relaxed).
      const { close, url } = await neverAnsweringServer();
      try {
        const bare = new WebClient("xoxb-test", {
          retryConfig: { retries: 3, minTimeout: 200, factor: 2 },
          slackApiUrl: url,
        });
        const outcome = await Promise.race([
          bare.chat
            .postMessage({ channel: "C123", text: "x" })
            .then(() => "settled", () => "settled"),
          waitFor(6_000).then(() => "no-timeout default still pending"),
        ]);
        expect(outcome).toBe("no-timeout default still pending");
      } finally {
        close();
      }
    },
    10_000
  );
});
