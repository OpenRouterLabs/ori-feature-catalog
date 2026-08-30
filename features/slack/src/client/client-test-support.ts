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

/**
 * Slack refuses a message whose interactive elements share an `action_id`, and
 * the fake used to accept it — so `blockerBlocks` shipped giving every button
 * the same id, every blocker test passed, and the skill failed against the
 * real API the moment it offered a second choice.
 *
 * A double that accepts what the API rejects is not a double.
 */
const rejectDuplicateActionIds = (op: string, args: unknown): void => {
  const blocks = (args as { readonly blocks?: readonly unknown[] } | undefined)
    ?.blocks;
  if (blocks === undefined) {
    return;
  }
  const seen = new Set<string>();
  for (const block of blocks) {
    const elements =
      (block as { readonly elements?: readonly unknown[] }).elements ?? [];
    for (const element of elements) {
      const actionId = (element as { readonly action_id?: unknown }).action_id;
      if (typeof actionId !== "string") {
        continue;
      }
      if (seen.has(actionId)) {
        throw new Error(
          `${op}: \`action_id\` "${actionId}" already exists — Slack rejects a message whose elements share one`
        );
      }
      seen.add(actionId);
    }
  }
};

export const makeFakeSlackClient = (
  overrides: Partial<SlackClientShape> = {},
  rawStubs: RawStubs = {}
): FakeSlackClient => {
  const calls: RecordedCall[] = [];

  const record =
    <A>(op: string, result?: A) =>
    (args: unknown): Effect.Effect<A> => {
      rejectDuplicateActionIds(op, args);
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
