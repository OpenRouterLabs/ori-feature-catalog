import { Context, Effect, Schema } from "effect";

import { functionSchema, opaqueSchema } from "#src/schema-support.ts";

const OpenAskSchema = Schema.Struct({
  answered: opaqueSchema<Promise<string>>("OpenAsk.answered"),
  askId: Schema.String,
});

type OpenAsk = typeof OpenAskSchema.Type;

const BlockersShapeSchema = Schema.Struct({
  abandon:
    functionSchema<(askId: string, reason: string) => Effect.Effect<void>>(
      "BlockersShape.abandon"
    ),
  answer:
    functionSchema<(askId: string, value: string) => Effect.Effect<boolean>>(
      "BlockersShape.answer"
    ),
  count: functionSchema<() => Effect.Effect<number>>("BlockersShape.count"),
  abandonThread:
    functionSchema<(threadKey: string, reason: string) => Effect.Effect<void>>(
      "BlockersShape.abandonThread"
    ),
  open:
    functionSchema<(threadKey: string) => Effect.Effect<OpenAsk>>(
      "BlockersShape.open"
    ),
});

export type BlockersShape = typeof BlockersShapeSchema.Type;

export class Blockers extends Context.Service<Blockers, BlockersShape>()(
  "ori/slack/Blockers"
) {}

const MAX_PENDING_ASKS = 200;

const BOOT_ID_CHARS = 8;

const PendingSchema = Schema.Struct({
  resolve: functionSchema<(value: string) => void>("Pending.resolve"),
  threadKey: Schema.String,
});

type Pending = typeof PendingSchema.Type;

const settle = (
  pending: Map<string, Pending>,
  askId: string,
  value: string
): boolean => {
  const waiting = pending.get(askId);
  if (waiting === undefined) {
    return false;
  }
  pending.delete(askId);
  waiting.resolve(value);
  return true;
};

const forgetOldest = (pending: Map<string, Pending>): void => {
  while (pending.size > MAX_PENDING_ASKS) {
    const oldest = pending.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    settle(
      pending,
      oldest,
      "the question was open too long to still be waiting on"
    );
  }
};

export const BlockersMemory = Effect.sync(() => {
  const pending = new Map<string, Pending>();

  const bootId = crypto.randomUUID().slice(0, BOOT_ID_CHARS);
  let sequence = 0;

  return Blockers.of({
    abandon: (askId, reason) =>
      Effect.sync(() => {
        settle(pending, askId, reason);
      }).pipe(Effect.withSpan("Slack.interactions.abandon")),

    abandonThread: (threadKey, reason) =>
      Effect.sync(() => {
        const mine: { askId: string; resolve: (value: string) => void }[] = [];
        for (const [askId, entry] of pending) {
          if (entry.threadKey === threadKey) {
            mine.push({
              askId,
              resolve: entry.resolve,
            });
          }
        }
        for (const entry of mine) {
          settle(pending, entry.askId, reason);
        }
      }).pipe(Effect.withSpan("Slack.interactions.abandonThread")),

    answer: (askId, value) =>
      Effect.sync(() => settle(pending, askId, value)).pipe(
        Effect.withSpan("Slack.interactions.answer")
      ),

    count: () =>
      Effect.sync(() => pending.size).pipe(
        Effect.withSpan("Slack.interactions.count")
      ),

    open: (threadKey) =>
      Effect.sync(() => {
        sequence += 1;
        const askId = `ask-${bootId}-${sequence}`;
        let resolve!: (value: string) => void;
        // oxlint-disable-next-line promise/avoid-new -- a manually settled barrier is the point: the turn waits here until someone clicks
        const answered = new Promise<string>((_resolve) => {
          resolve = _resolve;
        });
        pending.set(askId, {
          resolve,
          threadKey,
        });
        forgetOldest(pending);
        return {
          answered,
          askId,
        };
      }).pipe(Effect.withSpan("Slack.interactions.open")),
  });
});
