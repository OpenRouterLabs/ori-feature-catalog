/* oxlint-disable unicorn/consistent-function-scoping promise/avoid-new promise/param-names -- a deferred is a promise with its resolver exposed, which is exactly what these rules forbid; holding a turn open mid-flight needs it */

export const deferred = <A>(): {
  promise: Promise<A>;
  resolve: (value: A) => void;
} => {
  let resolve = (_value: A): void => undefined;
  const promise = new Promise<A>((r) => {
    resolve = r;
  });
  return {
    promise,
    resolve,
  };
};
