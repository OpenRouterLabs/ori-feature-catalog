import { Context, Effect } from "effect";

interface OpenAsk {
  readonly answered: Promise<string>;
  readonly askId: string;
}

export interface BlockersShape {
  readonly abandon: (askId: string, reason: string) => Effect.Effect<void>;
  readonly answer: (askId: string, value: string) => Effect.Effect<boolean>;
  readonly count: () => Effect.Effect<number>;
  readonly abandonThread: (
    threadKey: string,
    reason: string
  ) => Effect.Effect<void>;
  readonly open: (threadKey: string) => Effect.Effect<OpenAsk>;
}

export class Blockers extends Context.Service<Blockers, BlockersShape>()(
  "ori/slack/Blockers"
) {}

const MAX_PENDING_ASKS = 200;

const BOOT_ID_CHARS = 8;

interface Pending {
  readonly resolve: (value: string) => void;
  readonly threadKey: string;
}

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
