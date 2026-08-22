/* oxlint-disable typescript/no-unsafe-type-assertion typescript/explicit-function-return-type eslint/max-lines-per-function eslint/require-await eslint/no-unsafe-optional-chaining typescript/no-invalid-void-type promise/avoid-new promise/param-names unicorn/consistent-function-scoping -- test doubles assert on recorded `unknown` args and stand in for Slack SDK shapes; cases read better whole than split */
/**
 * client-test-support.ts — a recording `SlackClient` for tests.
 *
 * The surface never talks to Slack in tests; it talks to this. Calls are
 * recorded so a case can assert what would have been sent, and `raw` is a
 * proxy so a case only stubs the methods it actually exercises — an unstubbed
 * call fails loudly at the point of use rather than as `undefined is not a
 * function` somewhere downstream.
 */

import type { WebClient } from "@slack/web-api";

import { Effect, Layer } from "effect";

import type { SlackClientShape } from "./client.ts";

import { SlackClient } from "./client.ts";

export interface RecordedCall {
  readonly args: unknown;
  readonly op: string;
}

export interface FakeSlackClient {
  readonly calls: RecordedCall[];
  readonly shape: SlackClientShape;
  readonly layer: Layer.Layer<SlackClient>;
}

/** Nested stubs for `raw`, e.g. `{ "chat.postMessage": async () => ({}) }`. */
export type RawStubs = Readonly<Record<string, (args: never) => unknown>>;

const makeRaw = (stubs: RawStubs, calls: RecordedCall[]): WebClient => {
  const namespace = (path: string): unknown =>
    new Proxy(
      {},
      {
        get: (_target, property) => {
          const key = `${path}.${String(property)}`;
          const stub = stubs[key];
          if (stub !== undefined) {
            return (args: never) => {
              calls.push({
                args,
                op: key,
              });
              return Promise.resolve(stub(args));
            };
          }
          // Not a leaf we know: assume another namespace level.
          return namespace(key);
        },
      }
    );

  return new Proxy(
    {},
    {
      get: (_target, property) => namespace(String(property)),
    }
  ) as WebClient;
};

export const makeFakeSlackClient = (
  overrides: Partial<SlackClientShape> = {},
  rawStubs: RawStubs = {}
): FakeSlackClient => {
  const calls: RecordedCall[] = [];

  const record =
    <A>(op: string, result?: A) =>
    (args: unknown): Effect.Effect<A> => {
      calls.push({
        args,
        op,
      });
      return Effect.succeed(result as A);
    };

  const shape: SlackClientShape = {
    deleteMessage: record("chat.delete"),
    getUserName: record("users.info", "tester"),
    openView: record("views.open"),
    setAssistantStatus: record("assistant.threads.setStatus"),
    setAssistantTitle: record("assistant.threads.setTitle"),
    postMessage: record("chat.postMessage", {
      channel: "C_FAKE",
      ts: "1700000000.000100",
    }),
    raw: makeRaw(rawStubs, calls),
    appendStream: record("chat.appendStream"),
    startStream: record("chat.startStream", {
      channel: "C_FAKE",
      ts: "1700000000.000100",
    }),
    stopStream: record("chat.stopStream"),
    updateMessage: record("chat.update"),
    ...overrides,
  };

  return {
    calls,
    layer: Layer.succeed(SlackClient)(SlackClient.of(shape)),
    shape,
  };
};

/** Ops recorded so far, in order — the usual assertion target. */
export const opsOf = (client: FakeSlackClient): readonly string[] =>
  client.calls.map((call) => call.op);
