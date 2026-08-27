/**
 * ori-exports.d.ts — what `use("slack")` hands a consumer.
 *
 * `FeatureApis.slack` is declared by the framework SDK, which ships the
 * BUILTIN slack surface's shape. This feature shadows that builtin at run
 * time, so it supplies the value while the SDK still owns the type — and
 * `ori init` deliberately skips generating an augmentation for a name the
 * builtin already claims. Without this file a consumer reaches `webClient`
 * at run time with no type for it.
 *
 * Augmenting `SlackFeatureApiExports` rather than `FeatureApis` on purpose:
 * re-declaring `slack` would collide, because merged declarations of the same
 * property must be identical. Adding a member to the interface merges.
 *
 * Delete this once the builtin declares the same surface upstream.
 */

import type { WebClient } from "@slack/web-api";

import type { SlackButtonHandler } from "./src/interactions/custom.ts";

declare module "ori" {
  interface SlackFeatureApiExports {
    readonly onButton: (
      actionId: string,
      handler: SlackButtonHandler
    ) => Promise<void>;
    readonly webClient: () => Promise<WebClient | undefined>;
  }
}
