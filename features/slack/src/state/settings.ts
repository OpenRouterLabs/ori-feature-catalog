/**
 * settings.ts — what an operator can change without a restart.
 *
 * Everything else this surface reads is decoded once at boot from the
 * environment, which is right for a token and wrong for a preference: changing
 * how the bot behaves in a thread should not mean restarting the daemon that
 * is currently answering in it.
 *
 * One setting so far, and it is the one that was never a choice.
 */

/**
 * What a second message does to a thread that is already running a turn.
 *
 * `steer` interrupts the live turn and hands its partial work to the new one.
 * `queue` lets the running turn finish and starts the new one after it.
 *
 * Both are right, for different rooms. A correction is worth nothing after the
 * run it was correcting has finished, which is why steering became the
 * behaviour. But a thread where several people talk at once reads every aside
 * as a correction, and cancels work nobody asked to stop.
 */
export const InterruptMode = {
  Queue: "queue",
  Steer: "steer",
} as const;

export type InterruptMode = (typeof InterruptMode)[keyof typeof InterruptMode];

/**
 * Steering, because that is what the surface did before this was settable.
 *
 * A default that changes behaviour on upgrade is a worse default than a
 * debatable one.
 */
export const DEFAULT_INTERRUPT_MODE: InterruptMode = InterruptMode.Steer;

/**
 * A stored or submitted value, or the default.
 *
 * Takes `unknown` because that is honestly what it gets: a row written by an
 * older shape, or a form field from a browser. Total for the same reason —
 * neither is worth failing a turn over.
 */
export const interruptModeFrom = (raw: unknown): InterruptMode =>
  raw === InterruptMode.Queue || raw === InterruptMode.Steer
    ? raw
    : DEFAULT_INTERRUPT_MODE;
