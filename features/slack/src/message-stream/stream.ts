/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively; the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */

import { Context, Effect, Ref } from "effect";

import type { MessageReplyShape } from "../message-reply/reply.ts";
import type { RunState } from "./run-state.ts";

import { initialRunState, RunPhase } from "./run-state.ts";
import { settle } from "./settle.ts";

export interface RunOptions {
  readonly superseded?: () => boolean;
  readonly recipientUserId?: string;
}

interface MessageStreamShape {
  readonly run: (
    reply: MessageReplyShape,
    turn: (
      advance: (next: RunState) => Effect.Effect<void>
    ) => Effect.Effect<void>,
    options?: RunOptions
  ) => Effect.Effect<void>;
}

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
