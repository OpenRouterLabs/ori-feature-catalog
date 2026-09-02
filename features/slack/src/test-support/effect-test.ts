import type { TestOptions } from "bun:test";

import { Cause, Effect, Exit, type Schema, type Scope } from "effect";
import * as bt from "bun:test";

import { functionSchema } from "#src/schema-support.ts";

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

type EffectBody<Args extends readonly unknown[]> = (
  ...args: Args
) => Effect.Effect<unknown, unknown, Scope.Scope>;

const effectTestSchema = <Args extends readonly unknown[]>(): Schema.declare<
  (name: string, body: EffectBody<Args>, options?: number | TestOptions) => void,
  (name: string, body: EffectBody<Args>, options?: number | TestOptions) => void
> =>
  functionSchema<
    (
      name: string,
      body: EffectBody<Args>,
      options?: number | TestOptions
    ) => void
  >("EffectTest");

type EffectTest<Args extends readonly unknown[]> = ReturnType<
  typeof effectTestSchema<Args>
>["Type"];

const carriedValues = (cause: Cause.Cause<unknown>): readonly unknown[] =>
  cause.reasons.flatMap((reason) => {
    if (Cause.isFailReason(reason)) return [reason.error];
    if (Cause.isDieReason(reason)) return [reason.defect];
    return [];
  });

export const asThrowable = (cause: Cause.Cause<unknown>): unknown => {
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

const EffectEachSchema = functionSchema<{
  <const Row extends readonly unknown[]>(
    cases: readonly Row[]
  ): EffectTest<Row>;
  <const Case>(cases: readonly Case[]): EffectTest<[Case]>;
}>("EffectEach");

type EffectEach = typeof EffectEachSchema.Type;

const each: EffectEach = (cases: readonly unknown[]) =>
  register(bt.test.each(cases as unknown[]) as typeof bt.test);

const lazyRegister =
  <Args extends readonly unknown[]>(pick: () => typeof bt.test): EffectTest<Args> =>
  (name, body, options) =>
    register<Args>(pick())(name, body, options);

const effect = Object.assign(register(bt.test), {
  each,
  failing: lazyRegister(() => bt.test.failing),
  only: lazyRegister(() => bt.test.only),
  skip: lazyRegister(() => bt.test.skip),
  skipIf: (condition: boolean) => register(bt.test.skipIf(condition)),
  todo: lazyRegister(() => bt.test.todo),
});

export const it: typeof bt.it & { readonly effect: typeof effect } =
  Object.assign(bt.it, { effect });

export const test = it;
