/* oxlint-disable typescript/no-unsafe-type-assertion typescript/explicit-function-return-type eslint/max-lines-per-function eslint/require-await eslint/no-unsafe-optional-chaining typescript/no-invalid-void-type promise/avoid-new promise/param-names unicorn/consistent-function-scoping -- test doubles assert on recorded `unknown` args and stand in for Slack SDK shapes; cases read better whole than split */
import type { AgentRuntimeEvent, Chat, ChatTurnInput } from "ori";

import { describe, expect, test } from "#src/test-support/effect-test.ts";

import { Effect, Layer } from "effect";

import { makeFakeSlackClient } from "../../client/client-test-support.ts";
import { Blockers, BlockersMemory } from "../../interactions/blocker.ts";
import {
  Interactions,
  makeInteractions,
} from "../../interactions/interactions.ts";
import {
  MessageStream,
  MessageStreamLive,
} from "../../message-stream/stream.ts";
import { StateStore, StateStoreMemory } from "../../state/index.ts";
import {
  AssistantThreads,
  AssistantThreadsLive,
} from "../../thread/index.ts";
import { ThreadContext, ThreadContextLive } from "../../thread/index.ts";
import { handleTurn } from "./handler.ts";

const ref = {
  channelId: "C1",
  teamId: "T1",
  threadTs: "1700.0001",
};

const event = (type: string, payload: unknown): AgentRuntimeEvent =>
  ({
    payload,
    type,
  }) as unknown as AgentRuntimeEvent;

interface Harness {
  readonly sent: ChatTurnInput[];
  readonly bridge: Chat;
}

const bridgeOf = (
  events: readonly AgentRuntimeEvent[],
  options: {
    readonly holdMs?: number | undefined;
    readonly onRunning?: (() => void) | undefined;
    readonly throwAfter?: boolean | undefined;
  } = {}
): Harness => {
  const { holdMs, onRunning, throwAfter } = options;
  const sent: ChatTurnInput[] = [];
  const bridge = {
    sendMessage: (input: ChatTurnInput): AsyncIterable<AgentRuntimeEvent> => {
      sent.push(input);
      return (async function* () {
        // Fires once the turn is live, which is when a status could arrive.
        onRunning?.();
        if (holdMs !== undefined) {
          await new Promise((resolve) => {
            setTimeout(resolve, holdMs);
          });
        }
        for (const item of events) {
          yield item;
        }
        if (throwAfter === true) {
          throw new Error("stream died");
        }
      })();
    },
  } as unknown as Chat;
  return {
    bridge,
    sent,
  };
};

const liveTurn = () => {
  const controller = new AbortController();
  return {
    abort: () => {
      controller.abort();
    },
    readPartial: (): string => "",
    readAsk: (): string => "",
    signal: controller.signal,
    turnId: "turn-1",
  };
};

/**
 * Drives one turn and hands back what it left behind.
 *
 * An Effect rather than a promise: the turn is the Effect under test, so the
 * case yields it and the harness owns the one exit — a defect inside the turn
 * arrives as a rendered cause instead of whatever the runtime threw.
 */
const run = (input: {
  readonly events: readonly AgentRuntimeEvent[];
  readonly holdMs?: number;
  readonly failBlockPosts?: boolean;
  readonly live?: ReturnType<typeof liveTurn>;
  readonly replies?: readonly unknown[];
  readonly spawnDepth?: number;
  readonly text?: string;
  readonly throwAfter?: boolean;
}) =>
  Effect.gen(function* () {
    const overrides =
      input.failBlockPosts === true
        ? {
            postMessage: (args: { blocks?: unknown }) =>
              args.blocks === undefined
                ? Effect.succeed({
                    channel: "C1",
                    ts: "1.1",
                  })
                : Effect.fail(new Error("ratelimited")),
          }
        : {};
    const fake = makeFakeSlackClient(overrides as never, {
      "conversations.replies": () => ({ messages: input.replies ?? [] }),
    });
    const harness = bridgeOf(input.events, {
      holdMs: input.holdMs,
      throwAfter: input.throwAfter,
    });
    const live = input.live ?? liveTurn();

    const services = Layer.mergeAll(
      Layer.effect(ThreadContext)(ThreadContextLive),
      Layer.effect(StateStore)(StateStoreMemory),
      Layer.effect(Blockers)(BlockersMemory),
      Layer.succeed(MessageStream)(MessageStreamLive),
      Layer.sync(Interactions)(makeInteractions),
      Layer.effect(AssistantThreads)(AssistantThreadsLive())
    ).pipe(Layer.provideMerge(fake.layer));

    yield* handleTurn({
      bridge: harness.bridge,
      live,
      turn: {
        ref,
        spawnDepth: input.spawnDepth,
        text: input.text ?? "do the thing",
        userId: "U1",
      },
    }).pipe(Effect.provide(services));

    return {
      fake,
      live,
      sent: harness.sent,
    };
  });

/**
 * The answer is an EDIT now: the opening "On it…" is posted first and then
 * rewritten into the reply, so reading only posts finds the placeholder.
 */
const ANSWER_OPS: ReadonlySet<string> = new Set([
  "chat.update",
  "chat.postMessage",
]);

const answered = (fake: ReturnType<typeof makeFakeSlackClient>): string =>
  fake.calls
    .filter((call) => ANSWER_OPS.has(call.op))
    .map((call) => {
      // Blocks now, with the answer as the fallback text; markdown_text is
      // still how the edited path carries it.
      const args = call.args as {
        markdown_text?: string;
        text?: string;
      };
      return args.markdown_text ?? args.text ?? "";
    })
    .join("\n");

/** Everything the run put on screen, whichever transport carried it. */
const PROGRESS_OPS: ReadonlySet<string> = new Set([
  "chat.postMessage",
  "chat.update",
]);

const progress = (fake: ReturnType<typeof makeFakeSlackClient>): string =>
  JSON.stringify(fake.calls.filter((call) => PROGRESS_OPS.has(call.op)));

/** Kept for assertions that do not care which message the text landed on. */
const updated = (fake: ReturnType<typeof makeFakeSlackClient>): string[] => [
  answered(fake),
  progress(fake),
];

describe("handleTurn rendering", () => {
  test.effect("streams assistant text into the reply", () =>
    Effect.gen(function* () {
      const { fake } = yield* run({
        events: [
          event("assistant.text.delta", { delta: "Hello " }),
          event("assistant.text.delta", { delta: "world" }),
          event("turn.succeeded", {}),
        ],
      });

      // Not `.at(-1)`: the last edit is the cancel affordance being retired.
      expect(updated(fake).join("\n")).toContain("Hello world");
    }));

  test.effect("answers with what it SAID, never with its tool calls", () =>
    Effect.gen(function* () {
      // A feed of bash, read, bash is spam that says nothing a person wants.
      // The narration goes to the status line while the work happens; the
      // answer is the answer.
      const { fake } = yield* run({
        events: [
          event("assistant.text.delta", {
            delta: "Checking CI on the red PRs.",
          }),
          event("tool.started", { name: "bash" }),
          event("assistant.text.delta", { delta: "the answer" }),
          event("turn.succeeded", {}),
        ],
      });

      // `bash` appears in the footer's tool counts, never inside the prose.
      expect(answered(fake)).not.toContain("bash gh");
      // And the narration never leaks into the answer, which is the last block.
      expect(answered(fake)).toContain("the answer");
      expect(answered(fake)).not.toContain("Checking CI");
    }));

  test.effect("renders a failed turn as failed", () =>
    Effect.gen(function* () {
      // `AgentFailure.message` is the contract's display-safe summary; the
      // payload carries a structured failure, not a bare error string.
      const { fake } = yield* run({
        events: [
          event("turn.failed", {
            failure: {
              code: "runtime.unknown",
              kind: "unknown",
              message: "provider exploded",
              stage: "provider",
            },
          }),
        ],
      });

      expect(updated(fake).join("\n")).toContain("provider exploded");
    }));

  test.effect("a failure that names a next action surfaces it", () =>
    Effect.gen(function* () {
      const { fake } = yield* run({
        events: [
          event("turn.failed", {
            failure: {
              code: "runtime.unknown",
              kind: "unknown",
              message: "rate limited",
              remediation: "try again in a minute",
              stage: "provider",
            },
          }),
        ],
      });

      expect(updated(fake).join("\n")).toContain("try again in a minute");
    }));

  test.effect(
    "the agent's reading of the ask leads, work follows under it",
    () =>
      Effect.gen(function* () {
        // Devin's shape: the acknowledgement lands on arrival, then the agent's
        // own words, then the work as cards under them.
        const { fake } = yield* run({
          events: [
            event("assistant.text.delta", {
              delta: "Checking why the chart 422s.",
            }),
            event("tool.started", { name: "bash" }),
            event("turn.succeeded", {}),
          ],
        });
        const streamed = fake.calls.filter((call) =>
          call.op.startsWith("chat.")
        );

        expect(JSON.stringify(streamed)).toContain("Checking why the chart");
      })
  );

  test.effect("never reacts to the ask", () =>
    Effect.gen(function* () {
      // The eye was the only sign of life before the first card, and it was only
      // ever taken off at the end — so it accumulated against every message
      // anyone had asked the bot anything in. The cards are the signal now.
      const { fake } = yield* run({ events: [event("turn.succeeded", {})] });
      const ops = fake.calls.map((call) => call.op);

      expect(ops).not.toContain("reactions.add");
    }));

  describe("permission round-trip", () => {
    test.effect("posts option buttons when the agent asks", () =>
      Effect.gen(function* () {
        const { fake } = yield* run({
          events: [
            event("permission.requested", {
              correlationId: "corr-1",
              operation: "bash: rm -rf /",
              options: ["allow_once", "reject_once"],
              sessionId: "sess-1",
            }),
            event("turn.succeeded", {}),
          ],
        });

        const rendered = JSON.stringify(fake.calls);
        expect(rendered).toContain("ori_permission_select");
        expect(rendered).toContain("rm -rf /");
        expect(rendered).toContain("corr-1");
      }));

    test.effect("retires the buttons once resolved", () =>
      Effect.gen(function* () {
        const { fake } = yield* run({
          events: [
            event("permission.requested", {
              correlationId: "corr-1",
              operation: "bash: ls",
              options: ["allow_once"],
              sessionId: "sess-1",
            }),
            event("permission.resolved", {
              correlationId: "corr-1",
              optionId: "allow_once",
              outcome: "selected",
            }),
            event("turn.succeeded", {}),
          ],
        });

        const resolvedEdit = fake.calls.find(
          (call) =>
            call.op === "chat.update" &&
            JSON.stringify(call.args).includes("bash: ls")
        );
        expect(resolvedEdit).toBeDefined();
        expect(JSON.stringify(resolvedEdit?.args)).not.toContain(
          "ori_permission_select"
        );
      }));

    test.effect("ignores a resolution for a request it never posted", () =>
      Effect.gen(function* () {
        expect(
          yield* run({
            events: [
              event("permission.resolved", { correlationId: "unknown" }),
              event("turn.succeeded", {}),
            ],
          })
        ).toBeDefined();
      }));

    test.effect("posts the elicitation ask with unblocking options", () =>
      Effect.gen(function* () {
        const { fake } = yield* run({
          events: [
            event("elicitation.requested", {
              correlationId: "corr-2",
              message: "Which branch?",
              sessionId: "sess-1",
            }),
            event("turn.succeeded", {}),
          ],
        });

        const rendered = JSON.stringify(fake.calls);
        expect(rendered).toContain("ori_elicitation_select");
        expect(rendered).toContain("Which branch?");
      }));
  });

  test.effect("a malformed permission payload is skipped, not crashed on", () =>
    Effect.gen(function* () {
      expect(
        yield* run({
          events: [
            event("permission.requested", { correlationId: "only-this" }),
            event("turn.succeeded", {}),
          ],
        })
      ).toBeDefined();
    }));
});
