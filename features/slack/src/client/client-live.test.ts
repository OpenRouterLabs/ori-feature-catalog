/* oxlint-disable typescript/no-unsafe-type-assertion typescript/explicit-function-return-type eslint/max-lines-per-function eslint/require-await eslint/no-unsafe-optional-chaining typescript/no-invalid-void-type promise/avoid-new promise/param-names unicorn/consistent-function-scoping -- test doubles assert on recorded `unknown` args and stand in for Slack SDK shapes; cases read better whole than split */
import type { WebClient } from "@slack/web-api";

import { describe, expect, test } from "#src/test-support/effect-test.ts";

import { retryPolicies } from "@slack/web-api";
import { Effect } from "effect";

import type { SlackClientShape } from "./client.ts";

import {
  SlackClientLive,
  makeConfiguredWebClient,
  readSlackBotToken,
} from "./client-live.ts";
import { SlackApiError, SlackClient } from "./client.ts";

const stubClient = (impl: Record<string, unknown>): WebClient =>
  impl as unknown as WebClient;

const withClient = <A>(
  client: WebClient,
  use: (slack: SlackClientShape) => Effect.Effect<A, SlackApiError>
): Effect.Effect<A, SlackApiError> =>
  SlackClient.pipe(Effect.flatMap(use), Effect.provide(SlackClientLive(client)));

const platformError = (code: string): Error =>
  Object.assign(new Error("slack said no"), { data: { error: code } });

describe("makeConfiguredWebClient", () => {
  test("bounds retries and arms a per-attempt timeout", () => {
    const client = makeConfiguredWebClient("xoxb-test") as unknown as {
      axios: { defaults: { timeout?: number } };
      retryConfig: unknown;
    };

    expect(client.retryConfig).toEqual(retryPolicies.fiveRetriesInFiveMinutes);
    expect(client.axios.defaults.timeout).toBeGreaterThan(0);
  });
});

describe("readSlackBotToken", () => {
  test.effect("returns the token when set", () =>
    Effect.gen(function* () {
      expect(yield* readSlackBotToken({ SLACK_BOT_TOKEN: "xoxb-1" })).toBe(
        "xoxb-1"
      );
    })
  );

  test.effect.each([{}, { SLACK_BOT_TOKEN: "" }])(
    "fails with a config error for %p",
    (env) =>
      Effect.gen(function* () {
        const failure = yield* readSlackBotToken(env).pipe(Effect.flip);

        expect(failure.message).toContain("SLACK_BOT_TOKEN");
        expect(failure.op).toBe("config");
      })
  );
});

describe("postMessage", () => {
  test.effect("projects the Slack response into channel and ts", () =>
    Effect.gen(function* () {
      const client = stubClient({
        chat: {
          postMessage: () =>
            Promise.resolve({
              channel: "C1",
              ok: true,
              ts: "1700.1",
            }),
        },
      });

      expect(
        yield* withClient(client, (slack) =>
          slack.postMessage({
            channel: "C1",
            text: "hi",
          })
        )
      ).toEqual({
        channel: "C1",
        ts: "1700.1",
      });
    })
  );

  test.effect("tolerates a response missing channel", () =>
    Effect.gen(function* () {
      const client = stubClient({
        chat: {
          postMessage: () =>
            Promise.resolve({
              ok: true,
              ts: "1700.1",
            }),
        },
      });

      expect(
        yield* withClient(client, (slack) =>
          slack.postMessage({
            channel: "C1",
            text: "hi",
          })
        )
      ).toEqual({
        channel: "",
        ts: "1700.1",
      });
    })
  );

  test.effect("fails rather than handing back a message with no ts", () =>
    Effect.gen(function* () {
      const client = stubClient({
        chat: { postMessage: () => Promise.resolve({ ok: true }) },
      });

      const failure = yield* withClient(client, (slack) =>
        slack.postMessage({
          channel: "C1",
          text: "hi",
        })
      ).pipe(Effect.flip);

      expect(failure).toBeInstanceOf(SlackApiError);
    })
  );
});

describe("error classification", () => {
  test.effect("reads the platform code out of data.error", () =>
    Effect.gen(function* () {
      const client = stubClient({
        chat: {
          postMessage: () => Promise.reject(platformError("missing_scope")),
        },
      });

      const failure = yield* SlackClient.pipe(
        Effect.flatMap((slack) =>
          slack.postMessage({
            channel: "C1",
            text: "hi",
          })
        ),
        Effect.flip,
        Effect.provide(SlackClientLive(client))
      );

      expect(failure).toBeInstanceOf(SlackApiError);
      expect(failure.code).toBe("missing_scope");
      expect(failure.op).toBe("chat.postMessage");
    })
  );

  test.effect("falls back to `code` when data.error is absent", () =>
    Effect.gen(function* () {
      const client = stubClient({
        chat: {
          postMessage: () =>
            Promise.reject(
              Object.assign(new Error("limited"), {
                code: "slack_webapi_rate_limited",
              })
            ),
        },
      });

      const failure = yield* SlackClient.pipe(
        Effect.flatMap((slack) =>
          slack.postMessage({
            channel: "C1",
            text: "hi",
          })
        ),
        Effect.flip,
        Effect.provide(SlackClientLive(client))
      );

      expect(failure.code).toBe("slack_webapi_rate_limited");
    })
  );

  test.effect("an unrecognisable failure still yields a typed error", () =>
    Effect.gen(function* () {
      const client = stubClient({
        chat: {
          postMessage: () => Promise.reject(new Error("socket hang up")),
        },
      });

      const failure = yield* SlackClient.pipe(
        Effect.flatMap((slack) =>
          slack.postMessage({
            channel: "C1",
            text: "hi",
          })
        ),
        Effect.flip,
        Effect.provide(SlackClientLive(client))
      );

      expect(failure.code).toBe("unknown");
      expect(failure.transient).toBe(false);
    })
  );

  test.each([
    "ratelimited",
    "service_unavailable",
    "internal_error",
    "request_timeout",
    "fatal_error",
  ])("%s is transient", (code) => {
    expect(
      new SlackApiError({
        cause: undefined,
        code,
        op: "x",
      }).transient
    ).toBe(true);
  });

  test.each(["missing_scope", "invalid_auth", "channel_not_found"])(
    "%s is terminal",
    (code) => {
      expect(
        new SlackApiError({
          cause: undefined,
          code,
          op: "x",
        }).transient
      ).toBe(false);
    }
  );
});
