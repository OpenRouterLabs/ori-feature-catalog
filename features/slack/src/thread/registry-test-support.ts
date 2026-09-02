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
