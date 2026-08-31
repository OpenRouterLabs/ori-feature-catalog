/* oxlint-disable import/no-relative-parent-imports typescript/no-unsafe-type-assertion typescript/explicit-function-return-type -- siblings are imported relatively, and the recorded blocks are read back as the JSON they are */
import { Effect } from "effect";

import type { BlockersShape } from "../interactions/blocker.ts";
import type { InteractionPayload } from "../interactions/interactions.ts";
import type { MessageReplyShape } from "../message-reply/reply.ts";
import type { ThreadRef } from "../thread/thread.ts";

import { BLOCKER_ACTION_ID } from "../helpers/blockers/blockers.ts";
import { registerBlockerHandlers } from "../interactions/blocker-handler.ts";
import { BlockersMemory } from "../interactions/blocker.ts";
import { makeInteractions } from "../interactions/interactions.ts";
import { makeBlockerRoute } from "./routes/blocker-route.ts";

const TEAM = "T1";
export const THREAD = "1700.1";
export const OTHER_THREAD = "1800.1";

export const QUESTION = "Rebase or close the 7 conflicting PRs?";
const CHOICES = [
  {
    id: "rebase",
    label: "Rebase them",
  },
  {
    id: "close",
    label: "Close them",
  },
] as const;

export interface RecordedBlocks {
  readonly blocks: readonly unknown[];
  readonly fallback: string;
}

export interface ThreadRecorder {
  readonly posted: RecordedBlocks[];
  readonly reply: MessageReplyShape;
  readonly updated: RecordedBlocks[];
}

interface RecordedButton {
  readonly label: string;
  readonly value: string;
}

export const buttonsOf = (
  blocks: readonly unknown[]
): readonly RecordedButton[] =>
  blocks.flatMap((block) => {
    const { elements } = block as { elements?: readonly unknown[] };
    return (elements ?? []).flatMap((element) => {
      const button = element as {
        text?: { text?: string };
        type?: string;
        value?: string;
      };
      return button.type === "button"
        ? [
            {
              label: button.text?.text ?? "",
              value: button.value ?? "",
            },
          ]
        : [];
    });
  });

export const rendered = (recorded: readonly RecordedBlocks[]): string =>
  JSON.stringify(recorded);

const makeRecorder = (options: {
  readonly failPost: boolean;
  readonly ts: string;
}): ThreadRecorder => {
  const posted: RecordedBlocks[] = [];
  const updated: RecordedBlocks[] = [];

  const reply = {
    ref: {
      channelId: "C1",
      teamId: TEAM,
      threadTs: THREAD,
    },
    replyBlocks: (blocks: readonly unknown[], fallback: string) => {
      posted.push({
        blocks,
        fallback,
      });
      return options.failPost
        ? Effect.fail(new Error("invalid_blocks") as never)
        : Effect.succeed({
            channel: "C1",
            ts: options.ts,
          });
    },
    updateBlocks: (
      _ts: string,
      blocks: readonly unknown[],
      fallback: string
    ) => {
      updated.push({
        blocks,
        fallback,
      });
      return Effect.void;
    },
  } as unknown as MessageReplyShape;

  return {
    posted,
    reply,
    updated,
  };
};

export interface Wired {
  readonly blockers: BlockersShape;
  readonly click: (value: string) => Promise<void>;
  readonly route: (request: Request) => Promise<Response>;
  readonly thread: (threadTs: string) => ThreadRecorder;
}

export const wired = (
  options: {
    readonly failPost?: boolean;
    readonly timeoutMs?: number;
  } = {}
): Wired => {
  const blockers = Effect.runSync(BlockersMemory);
  const interactions = makeInteractions();
  registerBlockerHandlers({
    blockers,
    interactions,
  });

  const recorders = new Map<string, ThreadRecorder>();
  const thread = (threadTs: string): ThreadRecorder => {
    const existing = recorders.get(threadTs);
    if (existing !== undefined) {
      return existing;
    }
    const made = makeRecorder({
      failPost: options.failPost === true,
      ts: `${threadTs}-posted`,
    });
    recorders.set(threadTs, made);
    return made;
  };

  const route = makeBlockerRoute({
    blockers,
    replyFor: (ref: ThreadRef) => Promise.resolve(thread(ref.threadTs).reply),
    threadKeyFor: () => "slack:T1:C1:1700.1",
    workspaceTeamId: TEAM,
    ...(options.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.timeoutMs }),
  });

  const payload = (value: string): InteractionPayload => ({
    actions: [
      {
        actionId: BLOCKER_ACTION_ID,
        value,
      },
    ],
    channelId: "C1",
    threadTs: THREAD,
    triggerId: "trigger.1",
    userId: "U1",
  });

  return {
    blockers,
    click: (value) => Effect.runPromise(interactions.dispatch(payload(value))),
    route,
    thread,
  };
};

export const ask = (
  input: {
    readonly choices?: readonly {
      readonly id: string;
      readonly label: string;
    }[];
    readonly question?: string;
    readonly threadTs?: string;
  } = {}
): Request =>
  new Request("http://127.0.0.1/slack/thread/ask", {
    body: JSON.stringify({
      channel: "C1",
      choices: input.choices ?? CHOICES,
      question: input.question ?? QUESTION,
      team: TEAM,
      thread_ts: input.threadTs ?? THREAD,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

const REGISTRATION_POLLS = 200;

export const asksRegistered = async (
  blockers: BlockersShape,
  expected: number
): Promise<void> => {
  for (let attempt = 0; attempt < REGISTRATION_POLLS; attempt += 1) {
    if (Effect.runSync(blockers.count()) >= expected) {
      return;
    }
    await Effect.runPromise(Effect.sleep(1));
  }
  throw new Error(`the route never opened ${expected} ask(s)`);
};

export const stillWaiting = async (
  pending: Promise<Response>
): Promise<string> =>
  await Promise.race([
    pending.then(() => "returned"),
    Promise.resolve("still waiting"),
  ]);
