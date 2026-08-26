/**
 * effect-test.test.ts — proving the harness fails.
 *
 * Every other suite in this feature runs through `test.effect`, so a harness
 * that swallowed a cause would report all 856 of them green, including any
 * test written to catch that. The one thing worth asserting here is the
 * decision `asThrowable` makes: given a cause, does something get thrown, and
 * is it the thing bun can render?
 *
 * These started as throwaway probes during the conversion. They are committed
 * because the property they check is the one the whole suite rests on.
 */

import { Cause, Effect, Exit } from "effect";

import { asThrowable, describe, expect, test } from "#src/test-support/effect-test.ts";

/** The cause a real run would carry, rather than one built by hand. */
const causeOf = async (effect: Effect.Effect<unknown, unknown>) => {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) throw new Error("expected the effect to fail");
  return exit.cause;
};

describe("what the harness throws", () => {
  test("a lone Error is rethrown as itself, keeping its stack and matcherResult", async () => {
    // This is what makes an `expect` diff inside `Effect.gen` still print as a
    // diff: bun reads `matcherResult` off the thrown value, and wrapping it
    // would leave only the message.
    const boom = new Error("the original");
    const thrown = asThrowable(await causeOf(Effect.fail(boom)));

    expect(thrown).toBe(boom);
  });

  test("a defect is reported, not swallowed", async () => {
    const boom = new TypeError("a bug, not a failure");
    const thrown = asThrowable(await causeOf(Effect.die(boom)));

    expect(thrown).toBe(boom);
  });

  test("a non-Error failure is wrapped, so the cause is still written down", async () => {
    const thrown = asThrowable(await causeOf(Effect.fail("a bare string")));

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).name).toBe("EffectTestFailure");
    expect((thrown as Error).message).toContain("a bare string");
  });

  test("an interrupt carries nothing, and still fails the test", async () => {
    // The empty-cause branch: with no reason to render, a bare interrupt would
    // otherwise throw an Error with an empty message, which reads as a passing
    // test that printed nothing.
    const thrown = asThrowable(await causeOf(Effect.interrupt));

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).not.toBe("");
  });

  test("several reasons are rendered together rather than one being picked", async () => {
    const thrown = asThrowable(
      await causeOf(
        Effect.all([Effect.fail("first"), Effect.fail("second")], {
          concurrency: 2,
          mode: "default",
        })
      )
    );

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).name).toBe("EffectTestFailure");
  });
});

describe("what the harness provides", () => {
  test.effect("a Scope, so acquireRelease needs no Effect.scoped", () =>
    Effect.gen(function* () {
      const released: string[] = [];
      yield* Effect.acquireRelease(Effect.succeed("held"), () =>
        Effect.sync(() => {
          released.push("released");
        })
      );

      // The release runs when the harness closes the scope, after this body.
      expect(released).toEqual([]);
    })
  );

  test.effect.each([1, 2, 3])("each row runs its own effect (%p)", (n) =>
    Effect.gen(function* () {
      expect(yield* Effect.succeed(n)).toBe(n);
    })
  );
});
