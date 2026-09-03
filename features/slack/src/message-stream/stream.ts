import { Context, Effect, Ref, Schema } from "effect";

import { functionSchema } from "#src/schema-support.ts";

import type { MessageReplyShape } from "#src/message-reply/reply.ts";
import type { RunState } from "./run-state.ts";

import { initialRunState, RunPhase } from "./run-state.ts";
import { settle } from "./settle.ts";

const RunOptionsSchema = Schema.Struct({
  superseded: Schema.optionalKey(
    functionSchema<() => boolean>("RunOptions.superseded")
  ),
  recipientUserId: Schema.optionalKey(Schema.String),
});

export type RunOptions = typeof RunOptionsSchema.Type;

const MessageStreamShapeSchema = Schema.Struct({
  run:
    functionSchema<
      (
        reply: MessageReplyShape,
        turn: (
          advance: (next: RunState) => Effect.Effect<void>
        ) => Effect.Effect<void>,
        options?: RunOptions
      ) => Effect.Effect<void>
    >("MessageStreamShape.run"),
});

type MessageStreamShape = typeof MessageStreamShapeSchema.Type;

export class MessageStream extends Context.Service<
  MessageStream,
  MessageStreamShape
>()("ori/slack/MessageStream") {}

export const MessageStreamLive = MessageStream.of({
  run: Effect.fn("Slack.stream.run")(function* (
    reply: MessageReplyShape,
    turn: (
      advance: (next: RunState) => Effect.Effect<void>
    ) => Effect.Effect<void>,
    options?: RunOptions
  ): Effect.fn.Return<void> {
    const latest = yield* Ref.make(initialRunState());

    const ran = turn((next) =>
      Ref.set(latest, next).pipe(Effect.withSpan("Slack.stream.advance"))
    ).pipe(
      Effect.catchCause((cause) =>
        Ref.update(latest, (state) => ({
          ...state,
          phase: RunPhase.Failed,
        })).pipe(
          Effect.andThen(Effect.logError("[slack] turn failed", cause)),
          Effect.withSpan("Slack.stream.turnFailed")
        )
      )
    );

    yield* ran;
    yield* settle({
      reply,
      state: yield* Ref.get(latest),
      superseded: options?.superseded?.() ?? false,
    });
  }),
});
