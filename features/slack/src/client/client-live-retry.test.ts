/* oxlint-disable typescript/no-unsafe-type-assertion typescript/explicit-function-return-type eslint/max-lines-per-function eslint/require-await eslint/no-unsafe-optional-chaining typescript/no-invalid-void-type promise/avoid-new promise/param-names unicorn/consistent-function-scoping -- test doubles assert on recorded `unknown` args and stand in for Slack SDK shapes; cases read better whole than split */
import type { WebClient } from "@slack/web-api";

import { describe, expect, test } from "#src/test-support/effect-test.ts";

import { Effect } from "effect";

import type { SlackClientShape, SlackApiError } from "./client.ts";

import { SlackClientLive } from "./client-live.ts";
import { SlackClient } from "./client.ts";

const stubClient = (impl: Record<string, unknown>): WebClient =>
  impl as unknown as WebClient;

const withClient = <A>(
  client: WebClient,
  use: (slack: SlackClientShape) => Effect.Effect<A, SlackApiError>
): Effect.Effect<A, SlackApiError> =>
  SlackClient.pipe(Effect.flatMap(use), Effect.provide(SlackClientLive(client)));

const platformError = (code: string): Error =>
  Object.assign(new Error("slack said no"), { data: { error: code } });

describe("retry", () => {
  test.effect("retries a transient failure and can succeed", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const client = stubClient({
        chat: {
          postMessage: () => {
            attempts += 1;
            return attempts < 3
              ? Promise.reject(platformError("ratelimited"))
              : Promise.resolve({
                  channel: "C1",
                  ok: true,
                  ts: "1700.1",
                });
          },
        },
      });

      expect(
        yield* withClient(client, (slack) =>
          slack.postMessage({
            channel: "C1",
            text: "hi",
          })
        )
      ).toMatchObject({ ts: "1700.1" });
      expect(attempts).toBe(3);
    })
  );

  test.effect("does not retry a terminal failure", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const client = stubClient({
        chat: {
          postMessage: () => {
            attempts += 1;
            return Promise.reject(platformError("missing_scope"));
          },
        },
      });

      yield* SlackClient.pipe(
        Effect.flatMap((slack) =>
          slack.postMessage({
            channel: "C1",
            text: "hi",
          })
        ),
        Effect.flip,
        Effect.provide(SlackClientLive(client))
      );

      expect(attempts).toBe(1);
    })
  );

  test.effect(
    "gives up on a persistently transient failure rather than hanging",
    () =>
      Effect.gen(function* () {
        let attempts = 0;
        const client = stubClient({
          chat: {
            postMessage: () => {
              attempts += 1;
              return Promise.reject(platformError("ratelimited"));
            },
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

        expect(failure.code).toBe("ratelimited");
        expect(attempts).toBeGreaterThan(1);
        expect(attempts).toBeLessThanOrEqual(5);
      })
  );
});

describe("getUserName", () => {
  test.effect("prefers the display name", () =>
    Effect.gen(function* () {
      const client = stubClient({
        users: {
          info: () =>
            Promise.resolve({
              user: {
                profile: {
                  display_name: "ada",
                  real_name: "Ada L",
                },
              },
            }),
        },
      });

      expect(yield* withClient(client, (slack) => slack.getUserName("U1"))).toBe(
        "ada"
      );
    })
  );

  test.effect("falls back to the real name when no display name is set", () =>
    Effect.gen(function* () {
      const client = stubClient({
        users: {
          info: () =>
            Promise.resolve({
              user: {
                profile: {
                  display_name: "  ",
                  real_name: "Ada L",
                },
              },
            }),
        },
      });

      expect(yield* withClient(client, (slack) => slack.getUserName("U1"))).toBe(
        "Ada L"
      );
    })
  );

  test.effect("falls back to the raw id when the profile is empty", () =>
    Effect.gen(function* () {
      const client = stubClient({
        users: { info: () => Promise.resolve({ user: {} }) },
      });

      expect(yield* withClient(client, (slack) => slack.getUserName("U1"))).toBe(
        "U1"
      );
    })
  );
});

describe("raw", () => {
  test.effect("is the same instance the typed methods use", () =>
    Effect.gen(function* () {
      const client = stubClient({ chat: {} });

      expect(
        yield* SlackClient.pipe(
          Effect.map((slack) => slack.raw === client),
          Effect.provide(SlackClientLive(client))
        )
      ).toBe(true);
    })
  );
});

describe("void-returning writes", () => {
  test.effect.each<readonly ["openView" | "updateMessage", string, string]>([
    ["openView", "views", "open"],
    ["updateMessage", "chat", "update"],
  ])("%s resolves to void", (method, namespace, fn) =>
    Effect.gen(function* () {
      let called = false;
      const client = stubClient({
        [namespace]: {
          [fn]: () => {
            called = true;
            return Promise.resolve({ ok: true });
          },
        },
      });

      expect(
        yield* withClient(client, (slack) =>
          (
            slack[method] as (args: unknown) => Effect.Effect<void, SlackApiError>
          )({})
        )
      ).toBeUndefined();
      expect(called).toBe(true);
    })
  );
});
