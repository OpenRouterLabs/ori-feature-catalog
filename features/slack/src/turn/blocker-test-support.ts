/* oxlint-disable typescript/no-unsafe-type-assertion typescript/explicit-function-return-type -- the recorded blocks are read back as the JSON they are */
import { Effect, Schema } from "effect";

import type { BlockersShape } from "#src/interactions/blocker.ts";
import type { InteractionPayload } from "#src/interactions/interactions.ts";
import type { MessageReplyShape } from "#src/message-reply/reply.ts";
import type { ThreadRef } from "#src/thread/thread.ts";

import { BLOCKER_ACTION_ID } from "#src/helpers/blockers/index.ts";
import { registerBlockerHandlers } from "#src/interactions/blocker-handler.ts";
import { BlockersMemory } from "#src/interactions/blocker.ts";
import { makeInteractions } from "#src/interactions/interactions.ts";
import { functionSchema, opaqueSchema } from "#src/schema-support.ts";
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

const RecordedBlocksSchema = Schema.Struct({
  blocks: Schema.Array(Schema.Unknown),
  fallback: Schema.String,
});

export type RecordedBlocks = typeof RecordedBlocksSchema.Type;

const ThreadRecorderSchema = Schema.Struct({
  posted: Schema.mutable(Schema.Array(RecordedBlocksSchema)),
  reply: opaqueSchema<MessageReplyShape>("ThreadRecorder.reply"),
  updated: Schema.mutable(Schema.Array(RecordedBlocksSchema)),
});

export type ThreadRecorder = typeof ThreadRecorderSchema.Type;

const RecordedButtonSchema = Schema.Struct({
  label: Schema.String,
  value: Schema.String,
});

type RecordedButton = typeof RecordedButtonSchema.Type;

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

const WiredSchema = Schema.Struct({
  blockers: opaqueSchema<BlockersShape>("Wired.blockers"),
  click: functionSchema<(value: string) => Promise<void>>("Wired.click"),
  route: functionSchema<(request: Request) => Promise<Response>>("Wired.route"),
  thread: functionSchema<(threadTs: string) => ThreadRecorder>("Wired.thread"),
});

export type Wired = typeof WiredSchema.Type;

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
