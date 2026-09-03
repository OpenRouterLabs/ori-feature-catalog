import { Effect, Schema } from "effect";

import type { PostedMessage, SlackClient } from "#src/client/client.ts";
import type { SlackConfig } from "#src/config.ts";
import type { SlackBlock } from "#src/helpers/block-kit/index.ts";
import type { BlockersShape } from "#src/interactions/blocker.ts";
import type { QuestionnairesShape } from "#src/interactions/questionnaires.ts";
import type { SlackServices } from "#src/layers.ts";
import type { ThreadRef } from "#src/thread/thread.ts";

import { makeMessageReply } from "#src/message-reply/index.ts";
import { functionSchema, opaqueSchema } from "#src/schema-support.ts";
import { isBusy } from "#src/thread/registry.ts";
import { ThreadRefSchema, threadInstanceId } from "#src/thread/thread.ts";
import { carrySession } from "#src/turn/carry.ts";
import { makeAttachRoute } from "./attach-route.ts";
import { makeBlockerRoute } from "./blocker-route.ts";
import { makeCarryRoute } from "./carry-route.ts";
import { makeChartRoute } from "./chart-route.ts";
import { makeDispatchRoute } from "./dispatch-route.ts";
import { makeImageRoute } from "./image-route.ts";
import { makeQuestionsRoute } from "./questions-route.ts";

type RouteHandler = (request: Request) => Promise<Response>;

const DispatchedTurnSchema = Schema.Struct({
  ref: ThreadRefSchema,
  spawnDepth: Schema.optionalKey(Schema.UndefinedOr(Schema.Number)),
  text: Schema.String,
  userId: Schema.String,
});

export type DispatchedTurn = typeof DispatchedTurnSchema.Type;

const TurnRouteHandlerDepsSchema = Schema.Struct({
  blockers: opaqueSchema<BlockersShape>("TurnRouteHandlerDeps.blockers"),
  config: opaqueSchema<SlackConfig>("TurnRouteHandlerDeps.config"),
  forms: opaqueSchema<QuestionnairesShape>("TurnRouteHandlerDeps.forms"),
  isStopping: functionSchema<() => boolean>("TurnRouteHandlerDeps.isStopping"),
  runWith: functionSchema<
    <A>(effect: Effect.Effect<A, never, SlackServices>) => Promise<A>
  >("TurnRouteHandlerDeps.runWith"),
  workspaceTeamId: Schema.String,
});

export type TurnRouteHandlerDeps = typeof TurnRouteHandlerDepsSchema.Type;

export type TurnRouteHandlers = {
  readonly handleAsk: RouteHandler;
  readonly handleAttach: RouteHandler;
  readonly handleCarry: RouteHandler;
  readonly handleChart: RouteHandler;
  readonly handleDispatch: RouteHandler;
  readonly handleImage: RouteHandler;
  readonly handleQuestions: RouteHandler;
};

const postForm = Effect.fn("Slack.turn.postForm")(function* (input: {
  readonly blocks: readonly SlackBlock[];
  readonly fallback: string;
  readonly ref: ThreadRef;
}): Effect.fn.Return<PostedMessage | void, never, SlackClient> {
  const reply = yield* makeMessageReply(input.ref);
  return yield* reply
    .replyBlocks(input.blocks, input.fallback)
    .pipe(Effect.orElseSucceed(() => {}));
});

export const makeTurnRouteHandlers = (input: {
  readonly deps: TurnRouteHandlerDeps;
  readonly runTurnSafely: (turn: DispatchedTurn) => void;
}): TurnRouteHandlers => {
  const { deps } = input;
  return {
    handleAsk: makeBlockerRoute({
      blockers: deps.blockers,
      threadKeyFor: threadInstanceId,
      replyFor: (ref) => deps.runWith(makeMessageReply(ref)),
      workspaceTeamId: deps.workspaceTeamId,
    }),
    handleCarry: makeCarryRoute({
      carry: ({ from, to }) => deps.runWith(carrySession({ from, to })),
      isBusy: (ref) => isBusy(threadInstanceId(ref)),
      isStopping: deps.isStopping,
      workspaceTeamId: deps.workspaceTeamId,
    }),
    handleAttach: makeAttachRoute({
      readFile: async (path) => new Blob([await Bun.file(path).arrayBuffer()]),
      replyFor: (ref) => deps.runWith(makeMessageReply(ref)),
      workspaceTeamId: deps.workspaceTeamId,
    }),
    handleChart: makeChartRoute({
      replyFor: (ref) => deps.runWith(makeMessageReply(ref)),
      workspaceTeamId: deps.workspaceTeamId,
    }),
    handleImage: makeImageRoute({
      apiKey: () => deps.config.openRouterApiKey ?? "",
      model: deps.config.imageModel,
      replyFor: (ref) => deps.runWith(makeMessageReply(ref)),
      workspaceTeamId: deps.workspaceTeamId,
    }),
    handleDispatch: makeDispatchRoute({
      isStopping: deps.isStopping,
      runTurnSafely: input.runTurnSafely,
      workspaceTeamId: deps.workspaceTeamId,
    }),
    handleQuestions: makeQuestionsRoute({
      forms: deps.forms,
      isLive: (ref) => Promise.resolve(isBusy(threadInstanceId(ref))),
      newAskId: () => crypto.randomUUID(),
      post: async (ref, blocks, fallback) => {
        const posted = await deps.runWith(
          postForm({
            blocks: blocks as readonly SlackBlock[],
            fallback,
            ref,
          })
        );
        return posted?.ts;
      },
      workspaceTeamId: deps.workspaceTeamId,
    }),
  };
};
