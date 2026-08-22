/**
 * blocker.ts — asking the person who asked.
 *
 * A status is a heartbeat: it edits one message in place, notifies nobody, and
 * is overwritten by the next one. That is right for progress and wrong for a
 * blocker — a failed assumption or a decision only the reader can make has to
 * reach them, and has to survive the next update.
 *
 * So a blocker is a real message with buttons, and the turn waits on it.
 *
 * BUTTONS AND NOTHING ELSE. There was a "Something else…" modal; it needed a
 * `trigger_id` that only a click mints and that expires three seconds later,
 * and it is gone. A reader who wants to answer off the list @-mentions the
 * bot, which steers the run — so the ask is abandoned rather than answered.
 *
 * A SERVICE, not a module global, for the same reason as `ThreadContext`: a
 * downstream feature can then wrap it — answer a blocker from a web UI, escalate
 * an unanswered one, mirror it into Linear — the way it can wrap `ThreadContext`.
 */

import { Context, Effect } from "effect";

export interface OpenAsk {
  /** The chosen `id`, or the reason it was abandoned. */
  readonly answered: Promise<string>;
  readonly askId: string;
}

export interface BlockersShape {
  /** Give up on an ask. Settles the promise so the turn is never left hanging. */
  readonly abandon: (askId: string, reason: string) => Effect.Effect<void>;
  /** True when an ask was waiting; false when already answered or gone. */
  readonly answer: (askId: string, value: string) => Effect.Effect<boolean>;
  /** Asks still waiting. Pins that turns clean up after themselves. */
  readonly count: () => Effect.Effect<number>;
  /**
   * Settle every ask open in a thread, because the turn that raised them is
   * over.
   *
   * A blocker outlives its turn otherwise: the ask lives in this service, not
   * on the turn, so a cancelled or steered run left a live button pointing at
   * a promise nobody was awaiting — and a reader who clicked it was told their
   * answer had been accepted by a run that died fifteen minutes earlier. The
   * same reason `handler.ts` retires pending approvals.
   */
  readonly abandonThread: (
    threadKey: string,
    reason: string
  ) => Effect.Effect<void>;
  /** Register an ask against the thread whose turn is waiting on it. */
  readonly open: (threadKey: string) => Effect.Effect<OpenAsk>;
}

export class Blockers extends Context.Service<Blockers, BlockersShape>()(
  "ori/slack/Blockers"
) {}

/**
 * The default: an in-process map.
 *
 * Held per built graph rather than per module, so two runtimes in one process —
 * a test suite, a stop/start reload — cannot see each other's asks.
 */
/** Asks retained before the oldest unanswered one is forgotten. */
const MAX_PENDING_ASKS = 200;

/** Enough of a uuid that two boots colliding is not worth thinking about. */
const BOOT_ID_CHARS = 8;

/** One pending ask: who settles it, and which thread's turn is waiting. */
interface Pending {
  readonly resolve: (value: string) => void;
  readonly threadKey: string;
}

/**
 * Settle an ask and forget it. Returns false when nothing was waiting, which
 * is how a second click on an answered question is refused.
 */
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

/**
 * An ask nobody ever clicks is never resolved and never removed, so a busy
 * workspace accumulated one per abandoned question. Turn end settles the asks
 * it knows about; this catches whatever outlives that.
 *
 * The evicted ask is SETTLED, not just dropped. Deleting the resolve without
 * calling it left the route waiting out its whole timeout on a button that had
 * already gone dead — the reader clicks, and nothing happens for fifteen
 * minutes.
 */
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

  /**
   * Unique per PROCESS. A bare `ask-${n}` restarts at 1 on every boot, and a
   * stale button in an old thread encodes `ask-1` — clicked after a restart it
   * answered whatever question happened to be `ask-1` now, in a different
   * thread, for a different run. `registry.ts` learned this for turn ids.
   */
  const bootId = crypto.randomUUID().slice(0, BOOT_ID_CHARS);
  let sequence = 0;

  return Blockers.of({
    abandon: (askId, reason) =>
      Effect.sync(() => {
        settle(pending, askId, reason);
      }),

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
      }),

    answer: (askId, value) => Effect.sync(() => settle(pending, askId, value)),

    count: () => Effect.sync(() => pending.size),

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
      }),
  });
});
