/* oxlint-disable typescript/no-unsafe-type-assertion typescript/explicit-function-return-type eslint/max-lines-per-function eslint/require-await eslint/no-unsafe-optional-chaining typescript/no-invalid-void-type promise/avoid-new promise/param-names unicorn/consistent-function-scoping -- test doubles assert on recorded `unknown` args and stand in for Slack SDK shapes; cases read better whole than split */
import type { WebClient } from "@slack/web-api";

import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import type { SlackClientShape, SlackApiError } from "./client.ts";

import { SlackClientLive } from "./client-live.ts";
import { SlackClient } from "./client.ts";

/** A WebClient stub whose named methods can fail on demand. */
const stubClient = (impl: Record<string, unknown>): WebClient =>
  impl as unknown as WebClient;

const withClient = <A>(
  client: WebClient,
  use: (slack: SlackClientShape) => Effect.Effect<A, SlackApiError>
): Promise<A> =>
  Effect.runPromise(
    SlackClient.pipe(
      Effect.flatMap(use),
      Effect.provide(SlackClientLive(client))
    )
  );

const platformError = (code: string): Error =>
  Object.assign(new Error("slack said no"), { data: { error: code } });

describe("retry", () => {
  test("retries a transient failure and can succeed", async () => {
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

    await expect(
      withClient(client, (slack) =>
        slack.postMessage({
          channel: "C1",
          text: "hi",
        })
      )
    ).resolves.toMatchObject({ ts: "1700.1" });
    expect(attempts).toBe(3);
  });

  test("does not retry a terminal failure", async () => {
    let attempts = 0;
    const client = stubClient({
      chat: {
        postMessage: () => {
          attempts += 1;
          return Promise.reject(platformError("missing_scope"));
        },
      },
    });

    await Effect.runPromise(
      SlackClient.pipe(
        Effect.flatMap((slack) =>
          slack.postMessage({
            channel: "C1",
            text: "hi",
          })
        ),
        Effect.flip,
        Effect.provide(SlackClientLive(client))
      )
    );

    expect(attempts).toBe(1);
  });

  test("gives up on a persistently transient failure rather than hanging", async () => {
    let attempts = 0;
    const client = stubClient({
      chat: {
        postMessage: () => {
          attempts += 1;
          return Promise.reject(platformError("ratelimited"));
        },
      },
    });

    const failure = await Effect.runPromise(
      SlackClient.pipe(
        Effect.flatMap((slack) =>
          slack.postMessage({
            channel: "C1",
            text: "hi",
          })
        ),
        Effect.flip,
        Effect.provide(SlackClientLive(client))
      )
    );

    expect(failure.code).toBe("ratelimited");
    expect(attempts).toBeGreaterThan(1);
    expect(attempts).toBeLessThanOrEqual(5);
  });
});

describe("getUserName", () => {
  test("prefers the display name", async () => {
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

    await expect(
      withClient(client, (slack) => slack.getUserName("U1"))
    ).resolves.toBe("ada");
  });

  test("falls back to the real name when no display name is set", async () => {
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

    await expect(
      withClient(client, (slack) => slack.getUserName("U1"))
    ).resolves.toBe("Ada L");
  });

  test("falls back to the raw id when the profile is empty", async () => {
    const client = stubClient({
      users: { info: () => Promise.resolve({ user: {} }) },
    });

    await expect(
      withClient(client, (slack) => slack.getUserName("U1"))
    ).resolves.toBe("U1");
  });
});

describe("raw", () => {
  test("is the same instance the typed methods use", async () => {
    // The whole point of the escape hatch: a caller reaching past the typed
    // surface still gets our configured client, not a bare one.
    const client = stubClient({ chat: {} });

    await expect(
      Effect.runPromise(
        SlackClient.pipe(
          Effect.map((slack) => slack.raw === client),
          Effect.provide(SlackClientLive(client))
        )
      )
    ).resolves.toBe(true);
  });
});

describe("void-returning writes", () => {
  test.each([
    ["openView", "views", "open"],
    ["updateMessage", "chat", "update"],
  ] as const)("%s resolves to void", async (method, namespace, fn) => {
    let called = false;
    const client = stubClient({
      [namespace]: {
        [fn]: () => {
          called = true;
          return Promise.resolve({ ok: true });
        },
      },
    });

    await expect(
      withClient(client, (slack) =>
        (
          slack[method] as (args: unknown) => Effect.Effect<void, SlackApiError>
        )({})
      )
    ).resolves.toBeUndefined();
    expect(called).toBe(true);
  });
});
