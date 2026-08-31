export const InterruptMode = {
  Queue: "queue",
  Steer: "steer",
} as const;

export type InterruptMode = (typeof InterruptMode)[keyof typeof InterruptMode];

export const DEFAULT_INTERRUPT_MODE: InterruptMode = InterruptMode.Steer;

export const interruptModeFrom = (raw: unknown): InterruptMode =>
  raw === InterruptMode.Queue || raw === InterruptMode.Steer
    ? raw
    : DEFAULT_INTERRUPT_MODE;
