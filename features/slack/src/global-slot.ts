export interface GlobalSlot<T> {
  readonly clear: () => void;
  readonly read: () => T | undefined;
  readonly install: (value: T) => () => void;
}

export const globalSlot = <T>(name: string): GlobalSlot<T> => {
  const key = Symbol.for(name);
  const held = (): Record<symbol, T | undefined> =>
    globalThis as unknown as Record<symbol, T | undefined>;

  return {
    clear: () => {
      held()[key] = undefined;
    },
    read: () => held()[key],
    install: (value) => {
      held()[key] = value;
      return () => {
        if (held()[key] === value) {
          held()[key] = undefined;
        }
      };
    },
  };
};
