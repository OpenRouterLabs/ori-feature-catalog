/**
 * registry.ts — the turns currently running, and the queue behind them.
 *
 * Two jobs that are really one: knowing what is in flight.
 *
 * CANCELLATION needs a handle on the running turn so a button click can abort
 * it. `ChatTurnInput` accepts an `AbortSignal`, so cancelling is a matter of
 * holding the controller somewhere the interaction handler can reach.
 *
 * QUEUEING needs the same knowledge from the other side: a second message in a
 * thread while a turn is running must not start a concurrent run against the
 * same session. Two turns sharing a session interleave their prompts and the
 * agent sees a conversation that never happened.
 *
 * Both are keyed by thread, because a thread is what maps to a session. Two
 * different threads run concurrently and should.
 */

export interface LiveTurn {
  readonly abort: (reason?: unknown) => void;
  /**
   * What this turn has produced so far, read at the moment it is interrupted.
   *
   * A steer hands it to the replacement turn as `priorPartial`, so the
   * redirected run sees the work rather than starting from nothing. Set by the
   * turn once it is streaming; empty before that.
   */
  readPartial: () => string;
  /**
   * What this turn was ASKED, which is a different thing from what it produced.
   *
   * A steer used to hand the replacement only `readPartial`, so the correction
   * arrived with no trace of the original request and the model read it as the
   * whole assignment: "find p0 issues" then "investigate the repo" dropped the
   * p0 half entirely. Set by the turn alongside `readPartial`; empty before
   * that.
   */
  readAsk: () => string;
  /** Passed to `chat.sendMessage` so a cancel actually interrupts the run. */
  readonly signal: AbortSignal;
  readonly turnId: string;
}

interface ThreadEntry {
  /** The turn currently running in this thread, if any. */
  live: LiveTurn | undefined;
  /**
   * Arrivals that have claimed the thread but may not have started yet.
   * Counted SYNCHRONOUSLY on arrival: `live` is only assigned after awaiting
   * the predecessor, so a second message arriving in the same tick would
   * otherwise see an idle thread and skip its "queued" notice — while still
   * being serialised, which is the confusing half.
   */
  pending: number;
  /** Resolves when this arrival is done. Awaited by the next one. */
  tail: Promise<void>;
}

/**
 * Swallow a rejection deliberately. Named rather than an empty arrow so the
 * intent is legible at the call site and to the linter.
 */
const ignoreRejection = (): void => undefined;

const threads = new Map<string, ThreadEntry>();
const byTurnId = new Map<string, LiveTurn>();
/**
 * Unique per PROCESS, not just per counter.
 *
 * A bare `turn-${n}` restarts at 1 on every boot, so anything keying durable
 * state on a turn id reads a fresh turn as one it has already seen — which is
 * how the first turns after every deploy silently lost their opening update
 * back when the status skill kept a marker file per turn.
 *
 * Nothing keys off it that way today, and two daemons on one host would
 * collide the same way regardless, which the counter alone cannot fix at any
 * width.
 */
/** Enough of a uuid to make a collision between two boots not worth thinking about. */
const BOOT_ID_CHARS = 8;
const BOOT_ID = crypto.randomUUID().slice(0, BOOT_ID_CHARS);

let sequence = 0;
const nextTurnId = (): string => {
  sequence += 1;
  return `turn-${BOOT_ID}-${sequence}`;
};

/** How many threads the registry is tracking. Exposed to pin that it drains. */
export const threadCount = (): number => threads.size;

/** True when a turn is already running in this thread. */
export const isBusy = (threadKey: string): boolean =>
  threads.get(threadKey)?.live !== undefined;

/**
 * Shared token so a caller-armed deadline is distinguishable from a person
 * clicking Cancel. The deadline itself is policy and lives at the composition
 * root; this module only carries the reason through.
 */
export const TURN_TIMEOUT_REASON = "ori:turn-timeout";

/**
 * A turn interrupted because the person said something else.
 *
 * Distinct from a cancel: nobody asked for the work to stop, they asked for it
 * to go somewhere else, and the thread should say so.
 */
export const TURN_STEER_REASON = "ori:turn-steer";

/** What an interrupted turn hands to the turn replacing it. */
export interface SteeredWork {
  /** What the interrupted turn was asked, so the correction can amend it. */
  readonly ask: string;
  /** What it had produced by the time it was interrupted. */
  readonly partial: string;
}

/**
 * Interrupt the turn running in a thread so a new one can take its place.
 *
 * Returns what it was asked and what it had produced, for the replacement to
 * carry — undefined when nothing was running, which is the caller's signal to
 * start a turn normally instead.
 */
export const steerThread = (threadKey: string): SteeredWork | undefined => {
  const live = threads.get(threadKey)?.live;
  if (live === undefined) {
    return undefined;
  }
  const work: SteeredWork = {
    ask: live.readAsk(),
    partial: live.readPartial(),
  };
  live.abort(TURN_STEER_REASON);
  return work;
};

/**
 * Give the thread back once a turn is done with it.
 *
 * Deletes rather than storing an idle entry: `pending` is incremented
 * synchronously on arrival, so reaching zero here means nothing is queued
 * behind this turn and no later arrival is waiting on `tail` — one that
 * arrives afterwards simply starts a fresh chain. Keeping the entry instead
 * left one row per thread the process had ever seen, which for a busy
 * workspace grows without limit.
 */
const releaseThread = (threadKey: string, turn: LiveTurn): void => {
  byTurnId.delete(turn.turnId);
  const current = threads.get(threadKey);
  if (current === undefined) {
    return;
  }

  const live = current.live?.turnId === turn.turnId ? undefined : current.live;
  const pending = Math.max(0, current.pending - 1);
  if (pending === 0 && live === undefined) {
    threads.delete(threadKey);
    return;
  }

  threads.set(threadKey, {
    live,
    pending,
    tail: current.tail,
  });
};

/**
 * Serialise `run` behind any turn already active in the same thread.
 *
 * `onQueued` fires only when the caller actually has to wait, so the surface
 * can say so rather than looking hung. The chain is rebuilt from the previous
 * tail on every arrival, which is what makes arrivals FIFO.
 */
export const enqueue = async <A>(
  threadKey: string,
  onQueued: () => Promise<void>,
  run: (turn: LiveTurn) => Promise<A>
): Promise<A> => {
  const existing = threads.get(threadKey);
  const previous = existing?.tail ?? Promise.resolve();
  const mustWait = (existing?.pending ?? 0) > 0;

  // The Promise executor runs synchronously, so `release` is assigned before
  // this returns — but TypeScript cannot see that, hence the definite form.
  let release!: () => void;
  // oxlint-disable-next-line promise/avoid-new -- a manually released barrier is the point: the next arrival awaits this until the current turn finishes
  const tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  threads.set(threadKey, {
    live: existing?.live,
    pending: (existing?.pending ?? 0) + 1,
    tail,
  });

  // From here on the thread is claimed, so every exit has to release it. An
  // `onQueued` that throws used to escape before the try below, leaving
  // `pending` incremented and `tail` unresolved — every later turn in that
  // thread then waited on a promise that would never settle.
  const controller = new AbortController();
  const turn: LiveTurn = {
    abort: (reason?: unknown): void => {
      controller.abort(reason);
    },
    readPartial: (): string => "",
    readAsk: (): string => "",
    signal: controller.signal,
    turnId: nextTurnId(),
  };

  try {
    if (mustWait) {
      // Best effort: failing to say "queued" must not cost the turn.
      await onQueued().catch(ignoreRejection);
    }

    // Wait for the thread to drain. Failures upstream must not wedge the
    // queue, so a rejected predecessor still lets this turn proceed.
    await previous.catch(ignoreRejection);

    byTurnId.set(turn.turnId, turn);
    threads.set(threadKey, {
      live: turn,
      pending: threads.get(threadKey)?.pending ?? 1,
      tail,
    });

    return await run(turn);
  } finally {
    releaseThread(threadKey, turn);
    release();
  }
};

/**
 * Abort whatever is running in a thread. False when nothing is.
 *
 * Keyed by thread rather than turn id because the caller is a person saying
 * "stop" in the thread: they know which conversation they mean, not which
 * turn id is behind it.
 */
export const cancelThread = (threadKey: string): boolean => {
  const live = threads.get(threadKey)?.live;
  if (live === undefined) {
    return false;
  }
  live.abort();
  return true;
};

/**
 * True when another turn for this thread is already waiting behind this one.
 *
 * A steered turn posts nothing, on the reading that its replacement carries
 * the work and will answer. That is only true if a replacement exists — with
 * none, the reader gets silence and no way to tell it from a crash.
 */
export const hasSuccessor = (threadKey: string): boolean =>
  (threads.get(threadKey)?.pending ?? 0) > 1;

/** Abort a running turn by id. False when it already finished. */
export const cancelTurn = (turnId: string): boolean => {
  const turn = byTurnId.get(turnId);
  if (turn === undefined) {
    return false;
  }
  turn.abort();
  return true;
};

/**
 * Tell every running turn to stop, and say how many were told.
 *
 * Shutdown used to WAIT for turns and then walk away from the ones still
 * going. Walking away leaves the message they own mid-flight forever: no
 * answer, no error, a card still spinning, and a reader who never finds out
 * the process went away. Aborting gives each turn the chance to settle its
 * own message on the way out.
 */
export const cancelAll = (): number => {
  let told = 0;
  for (const entry of threads.values()) {
    if (entry.live !== undefined) {
      entry.live.abort(TURN_TIMEOUT_REASON);
      told += 1;
    }
  }
  return told;
};

/**
 * Wait for in-flight turns to finish, up to `timeoutMs`.
 *
 * Without this, shutdown tears down the Slack client while turns are still
 * running: their next post fails, and the agent run behind them is orphaned
 * with nobody left to render its answer. A bounded wait is the compromise —
 * a wedged turn must not hold the process open forever.
 */
export const drain = async (timeoutMs: number): Promise<boolean> => {
  const inFlight = [...threads.values()].map((entry) => entry.tail);
  if (inFlight.length === 0) {
    return true;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  // oxlint-disable-next-line promise/avoid-new -- racing a timer against the in-flight tails is exactly what a bounded drain is
  const expired = new Promise<false>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.allSettled(inFlight).then(() => true),
      expired,
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
};

/**
 * Forget everything.
 *
 * Called on shutdown as well as in tests: the maps are module-global, so a
 * stop/start cycle (`ori dev` reload) would otherwise leave a stopped run's
 * threads marked busy, and the next turn would queue behind a tail nobody is
 * left to release.
 */
export const resetRegistry = (): void => {
  threads.clear();
  byTurnId.clear();
  sequence = 0;
};
