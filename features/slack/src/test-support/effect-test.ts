/**
 * `it.effect` for bun:test, in the shape ori's suites use.
 *
 * A test body is an Effect, not a promise: the harness runs it and fails the
 * test on a typed failure, a defect or an interruption, with the cause
 * rendered. Tests that leave Effect by hand — `Effect.runPromise` inside the
 * test — report whatever the runtime happened to throw and lose the rest of
 * the cause; this keeps the one exit in one place.
 *
 * A test body must have no remaining requirements. A test that needs services
 * provides them itself (`Effect.provide`) before handing the Effect over. A
 * `Scope` is the exception: the harness closes one around every run, so
 * `Effect.acquireRelease` and friends work without `Effect.scoped`.
 */
import type { TestOptions } from "bun:test";

import { Cause, Effect, Exit, type Scope } from "effect";
import * as bt from "bun:test";

export {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  jest,
  mock,
  setSystemTime,
  spyOn,
} from "bun:test";

export type { TestOptions } from "bun:test";

/** A test body: takes the case arguments, returns the Effect to run. */
type EffectBody<Args extends readonly unknown[]> = (
  ...args: Args
) => Effect.Effect<unknown, unknown, Scope.Scope>;

/** Registers one Effect test, optionally against a table of cases. */
interface EffectTest<Args extends readonly unknown[]> {
  (name: string, body: EffectBody<Args>, options?: number | TestOptions): void;
}

/**
 * The values a cause carries, in reason order. An interrupt carries nothing,
 * so an interrupted run yields an empty list.
 */
const carriedValues = (cause: Cause.Cause<unknown>): readonly unknown[] =>
  cause.reasons.flatMap((reason) => {
    if (Cause.isFailReason(reason)) return [reason.error];
    if (Cause.isDieReason(reason)) return [reason.defect];
    return [];
  });

/**
 * What to throw so bun reports the failure well.
 *
 * A cause carrying exactly one `Error` is rethrown untouched: that keeps the
 * real stack, and keeps the `matcherResult` bun needs to print an `expect`
 * diff. Anything else — a non-`Error` failure, several reasons, a bare
 * interrupt — is wrapped around the rendered cause, which is then the only
 * place the whole story is written down.
 */
const asThrowable = (cause: Cause.Cause<unknown>): unknown => {
  const carried = carriedValues(cause);
  const [only] = carried;
  if (carried.length === 1 && only instanceof Error) return only;

  const rendered = Cause.pretty(cause);
  const failure = new Error(
    rendered === "" ? "the effect under test failed" : rendered
  );
  failure.name = "EffectTestFailure";
  return failure;
};

const runEffect = async (
  effect: Effect.Effect<unknown, unknown, Scope.Scope>
): Promise<void> => {
  const exit = await Effect.runPromiseExit(Effect.scoped(effect));
  if (Exit.isFailure(exit)) throw asThrowable(exit.cause);
};

/**
 * Wraps one of bun's registrars so it takes an Effect-returning body. Every
 * registrar — `test`, `test.skip`, the function `test.each` returns — has the
 * same shape, so one wrapper covers all of them.
 */
const register =
  <Args extends readonly unknown[]>(
    bunTest: typeof bt.test
  ): EffectTest<Args> =>
  (name, body, options) => {
    bunTest(
      name,
      async (...args: unknown[]) =>
        runEffect(body(...(args as unknown as Args))),
      options
    );
  };

/** bun spreads a tuple row into the body and passes a scalar row as one arg. */
interface EffectEach {
  <const Row extends readonly unknown[]>(
    cases: readonly Row[]
  ): EffectTest<Row>;
  <const Case>(cases: readonly Case[]): EffectTest<[Case]>;
}

const each: EffectEach = (cases: readonly unknown[]) =>
  register(bt.test.each(cases as unknown[]) as typeof bt.test);

const effect = Object.assign(register(bt.test), {
  each,
  failing: register(bt.test.failing),
  only: register(bt.test.only),
  skip: register(bt.test.skip),
  skipIf: (condition: boolean) => register(bt.test.skipIf(condition)),
  todo: register(bt.test.todo),
});

/**
 * bun's own `it`, with `.effect` added. Everything reached without `.effect`
 * is bun's function untouched, so converting a file changes one import line.
 *
 * This does add the property to the `it` bun:test itself exports — the two are
 * the same object, and bun's members are non-enumerable, so they cannot be
 * copied onto a fresh wrapper. Adding a name is harmless; nothing is replaced.
 */
export const it: typeof bt.it & { readonly effect: typeof effect } =
  Object.assign(bt.it, { effect });

/** `test` and `it` are one registrar in bun; both names keep working. */
export const test = it;
