/* oxlint-disable typescript/no-unsafe-type-assertion typescript/explicit-function-return-type eslint/max-lines-per-function eslint/require-await eslint/no-unsafe-optional-chaining typescript/no-invalid-void-type promise/avoid-new promise/param-names unicorn/consistent-function-scoping -- test doubles assert on recorded `unknown` args and stand in for Slack SDK shapes; cases read better whole than split */
import { describe, expect, test } from "bun:test";

import { Context, Effect, Layer, Scope } from "effect";

import type { SlackServices } from "./layers.ts";

import { applyExtensions, extendSlack } from "./extend.ts";
import { SlackDefaultLayers } from "./layers.ts";
import { ThreadContext } from "./thread/thread.ts";

const buildWith = async (): Promise<Context.Context<SlackServices>> =>
  await Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      return yield* Layer.build(
        applyExtensions(
          SlackDefaultLayers({
            token: "xoxb-test",
          })
        )
      ).pipe(Effect.provideService(Scope.Scope, scope));
    })
  );

describe("extendSlack", () => {
  test("an override wraps the default and can delegate to it", async () => {
    globalThis.__oriSlackExtensions = undefined;

    extendSlack(
      Layer.effect(ThreadContext)(
        Effect.gen(function* () {
          const parent = yield* ThreadContext;
          return ThreadContext.of({
            ...parent,
            // Delegates to the default, then transforms — the `super` shape.
            build: (input) =>
              parent
                .build(input)
                .pipe(Effect.map((base) => `[wrapped]${base}`)),
          });
        })
      )
    );

    const context = await buildWith();
    const threads = Context.get(context, ThreadContext);

    // hasSession: true short-circuits the default to "", so the result proves
    // the override ran AND that the parent was actually called.
    const built = await Effect.runPromise(
      threads.build({
        channelId: "C1",
        hasSession: true,
        teamId: "T1",
        threadTs: "1.1",
      })
    );

    expect(built).toBe("[wrapped]");
  });

  test("instanceId passes through untouched from the parent", async () => {
    globalThis.__oriSlackExtensions = undefined;
    const context = await buildWith();
    const threads = Context.get(context, ThreadContext);

    expect(
      threads.instanceId({
        channelId: "C1",
        teamId: "T1",
        threadTs: "1.1",
      })
    ).toBe("slack:T1:C1:1.1");
  });

  test("no registrations leaves the default graph unchanged", async () => {
    globalThis.__oriSlackExtensions = undefined;
    const context = await buildWith();
    const threads = Context.get(context, ThreadContext);

    const built = await Effect.runPromise(
      threads.build({
        channelId: "C1",
        hasSession: true,
        teamId: "T1",
        threadTs: "1.1",
      })
    );

    expect(built).toBe("");
  });
});
