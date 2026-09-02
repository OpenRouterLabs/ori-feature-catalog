import { Effect } from "effect";

export interface LiveTurn {
  readonly abort: (reason?: unknown) => void;
  readPartial: () => string;
  readAsk: () => string;
  readonly signal: AbortSignal;
  readonly turnId: string;
}

interface ThreadEntry {
  live: LiveTurn | undefined;
  pending: number;
  tail: Promise<void>;
}

const ignoreRejection = (): void => undefined;

const threads = new Map<string, ThreadEntry>();
const byTurnId = new Map<string, LiveTurn>();
const BOOT_ID_CHARS = 8;
const BOOT_ID = crypto.randomUUID().slice(0, BOOT_ID_CHARS);

let sequence = 0;
const nextTurnId = (): string => {
  sequence += 1;
  return `turn-${BOOT_ID}-${sequence}`;
};

export const threadCount = (): number => threads.size;

export const isBusy = (threadKey: string): boolean =>
  threads.get(threadKey)?.live !== undefined;

export const TURN_TIMEOUT_REASON = "ori:turn-timeout";

export const TURN_SHUTDOWN_REASON = "ori:turn-shutdown";

export const TURN_STEER_REASON = "ori:turn-steer";

interface SteeredWork {
  readonly ask: string;
  readonly partial: string;
}

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

interface ThreadClaim {
  readonly mustWait: boolean;
  readonly previous: Promise<void>;
  readonly release: () => void;
  readonly tail: Promise<void>;
  readonly turn: LiveTurn;
}

const claimThread = (threadKey: string): ThreadClaim => {
  const existing = threads.get(threadKey);
  const previous = existing?.tail ?? Promise.resolve();
  const mustWait = (existing?.pending ?? 0) > 0;

  let release!: () => void;
  const tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  threads.set(threadKey, {
    live: existing?.live,
    pending: (existing?.pending ?? 0) + 1,
    tail,
  });

  const controller = new AbortController();
  return {
    mustWait,
    previous,
    release,
    tail,
    turn: {
      abort: (reason?: unknown): void => {
        controller.abort(reason);
      },
      readPartial: (): string => "",
      readAsk: (): string => "",
      signal: controller.signal,
      turnId: nextTurnId(),
    },
  };
};

const takeThread = (threadKey: string, claim: ThreadClaim): void => {
  byTurnId.set(claim.turn.turnId, claim.turn);
  threads.set(threadKey, {
    live: claim.turn,
    pending: threads.get(threadKey)?.pending ?? 1,
    tail: claim.tail,
  });
};

const runClaimed = Effect.fn("Slack.registry.runTurn")(function* <A>(
  threadKey: string,
  claim: ThreadClaim,
  onQueued: () => Promise<void>,
  run: (turn: LiveTurn) => Promise<A>
): Effect.fn.Return<A, unknown> {
  if (claim.mustWait) {
    yield* Effect.promise(() => onQueued().catch(ignoreRejection));
  }

  yield* Effect.promise(() => claim.previous.catch(ignoreRejection));

  takeThread(threadKey, claim);

  return yield* Effect.tryPromise({
    try: () => run(claim.turn),
    catch: (error: unknown) => error,
  });
});

const enqueueTurn = Effect.fn("Slack.registry.enqueue")(function* <A>(
  threadKey: string,
  onQueued: () => Promise<void>,
  run: (turn: LiveTurn) => Promise<A>
): Effect.fn.Return<A, unknown> {
  const claim = claimThread(threadKey);

  return yield* runClaimed(threadKey, claim, onQueued, run).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        releaseThread(threadKey, claim.turn);
        claim.release();
      })
    )
  );
});

export const enqueue = <A>(
  threadKey: string,
  onQueued: () => Promise<void>,
  run: (turn: LiveTurn) => Promise<A>
): Promise<A> => Effect.runPromise(enqueueTurn(threadKey, onQueued, run));

export const cancelThread = (threadKey: string): boolean => {
  const live = threads.get(threadKey)?.live;
  if (live === undefined) {
    return false;
  }
  live.abort();
  return true;
};

export const hasSuccessor = (threadKey: string): boolean =>
  (threads.get(threadKey)?.pending ?? 0) > 1;

export const cancelTurn = (turnId: string): boolean => {
  const turn = byTurnId.get(turnId);
  if (turn === undefined) {
    return false;
  }
  turn.abort();
  return true;
};

export const cancelAll = (): number => {
  let told = 0;
  for (const entry of threads.values()) {
    if (entry.live !== undefined) {
      entry.live.abort(TURN_SHUTDOWN_REASON);
      told += 1;
    }
  }
  return told;
};

interface Deadline {
  readonly expired: Promise<void>;
  readonly timer: ReturnType<typeof setTimeout>;
}

const deadline = (timeoutMs: number): Effect.Effect<boolean> =>
  Effect.acquireUseRelease(
    Effect.sync((): Deadline => {
      let fire!: () => void;
      const expired = new Promise<void>((resolve) => {
        fire = resolve;
      });
      return {
        expired,
        timer: setTimeout(fire, timeoutMs),
      };
    }),
    (armed: Deadline) => Effect.promise(() => armed.expired),
    (armed: Deadline) =>
      Effect.sync(() => {
        clearTimeout(armed.timer);
      })
  ).pipe(Effect.as(false), Effect.withSpan("Slack.registry.deadline"));

const drainTurns = Effect.fn("Slack.registry.drain")(function* (
  timeoutMs: number
): Effect.fn.Return<boolean> {
  const inFlight = [...threads.values()].map((entry) => entry.tail);
  if (inFlight.length === 0) {
    return true;
  }
  const settled = Effect.promise(() =>
    Promise.allSettled(inFlight).then(() => true)
  );
  return yield* Effect.race(settled, deadline(timeoutMs));
});

export const drain = (timeoutMs: number): Promise<boolean> =>
  Effect.runPromise(drainTurns(timeoutMs));

export const resetRegistry = (): void => {
  threads.clear();
  byTurnId.clear();
  sequence = 0;
};
