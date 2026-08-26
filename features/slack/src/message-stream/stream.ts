/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively; the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */
/**
 * stream.ts — driving one turn's visible half.
 *
 * There is no progress message and no opening one either. A turn shows its work
 * in Slack's own status line, which costs no message and sits where a reader
 * already looks, and then posts its answer once.
 *
 * The `_On it…_` placeholder is gone because Slack was already saying it. The
 * native indicator reads "fix is starting up…" from the moment the turn is
 * admitted, so the placeholder was a second, worse copy of a signal we get for
 * free — and once messages stopped being edited it stayed in the thread for
 * good, sitting above the answer it was supposed to become.
 *
 * The progress message is gone rather than refactored. Every shape it took —
 * an edited Block Kit post, a native stream of `task_update` cards — spent a
 * message on saying "still going" and then had to be cleaned up afterwards,
 * and each one found new ways to be wrong: a card holding half a word marked
 * as an error, the same sentence rendered twice, an answer clipped into a
 * 256-character title, a card that could never be closed. What survives of it
 * is the work log, which now rides under the answer where it is a record
 * rather than a spinner.
 */

import { Context, Effect, Ref } from "effect";

import type { MessageReplyShape } from "../message-reply/reply.ts";
import type { RunState } from "./run-state.ts";

import { initialRunState, RunPhase } from "./run-state.ts";
import { settle } from "./settle.ts";

export interface RunOptions {
  /**
   * True when another turn is queued to answer in this one's place. Without
   * it a steer with no successor answered with nothing at all.
   */
  readonly superseded?: () => boolean;
  /** Who the answer is for. Kept for callers that name an asker. */
  readonly recipientUserId?: string;
}

interface MessageStreamShape {
  /**
   * Drive one turn. `advance` is called with each new state; the surface keeps
   * the latest and answers with it when the run ends.
   */
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
  run: (reply, turn, options) =>
    Effect.gen(function* () {
      const latest = yield* Ref.make(initialRunState());

      const ran = turn((next) => Ref.set(latest, next)).pipe(
        Effect.catchCause((cause) =>
          Ref.update(latest, (state) => ({
            ...state,
            phase: RunPhase.Failed,
          })).pipe(
            Effect.andThen(Effect.logError("[slack] turn failed", cause))
          )
        )
      );

      // The surface waits for the run, however long it takes. Deciding that
      // work should stop is not a view's call, and the watcher that used to
      // make it did not merely stop watching: `handleTurn` returning let the
      // `finally` in turn-routes abort the run, so a thinking model lost its
      // answer five minutes in.
      yield* ran;
      yield* settle({
        reply,
        state: yield* Ref.get(latest),
        superseded: options?.superseded?.() ?? false,
      });
    }),
});
