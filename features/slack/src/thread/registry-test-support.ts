/* oxlint-disable unicorn/consistent-function-scoping promise/avoid-new promise/param-names -- a deferred is a promise with its resolver exposed, which is exactly what these rules forbid; holding a turn open mid-flight needs it */
/**
 * registry-test-support.ts — helpers shared by the registry test files.
 *
 * `registry.test.ts` and `live-turns.test.ts` both drive the same queue, so
 * the promise plumbing they need lives here rather than being duplicated into
 * each. Extracted when the two split apart, not written speculatively.
 */

/**
 * A promise with its resolver exposed, to hold a turn open.
 *
 * A queue test has to observe a turn WHILE it runs — mid-flight is the only
 * point where "is this thread busy" means anything — so the body has to be a
 * promise the test resolves when it is done looking.
 */
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
