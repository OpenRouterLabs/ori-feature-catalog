/**
 * extend.ts — how another feature changes this one without forking it.
 *
 * The problem this exists to solve is the one that produced this rebuild in
 * the first place: someone needed to change one file, there was no seam, so
 * they copied 52 modules and the fix stranded in the fork.
 *
 * Usage from a sibling feature, at module scope so it runs before the Slack
 * surface starts:
 *
 *   import { extendSlack } from "@ori-monorepo/slack/extend.ts";
 *   import { ThreadContext } from "@ori-monorepo/slack/thread/thread.ts";
 *
 *   extendSlack(
 *     Layer.effect(ThreadContext)(
 *       Effect.gen(function* () {
 *         const parent = yield* ThreadContext;          // ours
 *         return ThreadContext.of({
 *           ...parent,
 *           build: (input) =>
 *             parent.build(input).pipe(Effect.map(trimToLastFive)),
 *         });
 *       })
 *     )
 *   );
 *
 * The override both REQUIRES and PROVIDES `ThreadContext`. `provideMerge`
 * hands it the default graph as its parent and keeps the rest of the graph
 * intact, so overriding one capability leaves routing, streaming, interactions
 * and skills untouched.
 *
 * Registrations live on `globalThis` for the same reason the runtime handle
 * does: `feature.ts` is imported eagerly and the Slack runtime is reached
 * through a dynamic `import()`, which resolves as a separate module graph. A
 * module-local array would be written by one copy and read by another.
 */

import { Layer } from "effect";

import type { SlackServices } from "./layers.ts";

/**
 * A registered override, stored as the transformation it performs on the
 * graph. Storing the function rather than the raw layer is what lets an
 * extension provide ONE tag while the graph as a whole stays complete — the
 * subset relationship is resolved at registration, where the concrete types
 * are still known.
 */
export type SlackExtension = (
  base: Layer.Layer<SlackServices>
) => Layer.Layer<SlackServices>;

declare global {
  // oxlint-disable-next-line no-var -- required for global augmentation
  var __oriSlackExtensions: SlackExtension[] | undefined;
}

/**
 * Register an override. Must be called before the Slack surface starts; the
 * graph is built once at boot, so a later registration is ignored rather than
 * silently applying to some turns and not others.
 */
export const extendSlack = <Provides extends SlackServices>(
  layer: Layer.Layer<Provides, never, SlackServices>
): void => {
  globalThis.__oriSlackExtensions ??= [];
  globalThis.__oriSlackExtensions.push((base) =>
    // The override receives the graph beneath it as its parent, and its own
    // outputs replace the corresponding entries. Everything it does not
    // provide passes through from `base`.
    Layer.provideMerge(layer, base)
  );
};

/**
 * Fold every registration over the default graph, in registration order — so a
 * later extension wraps an earlier one and both see the default underneath.
 */
export const applyExtensions = (
  base: Layer.Layer<SlackServices>
): Layer.Layer<SlackServices> => {
  let composed = base;
  for (const extend of globalThis.__oriSlackExtensions ?? []) {
    composed = extend(composed);
  }
  return composed;
};
