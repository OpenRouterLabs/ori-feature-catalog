/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively; the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */
/**
 * surface-events.ts — the Slack events that are not turns.
 *
 * A mention starts an agent run; opening the App Home tab or an assistant pane
 * does not. Split from `index.ts` so the composition root stays about building
 * the graph, and because these three share one rule:
 *
 *   NOTHING here is awaited by its listener.
 *
 * Bolt answers Slack only once every listener has returned, and Slack gives
 * that request three seconds before it calls the delivery failed — see
 * `listeners.ts` for the full contract. Each handler therefore starts its work
 * and returns.
 */

import type { Effect } from "effect";

import { Context } from "effect";

import type { SlackServices } from "../layers.ts";
import type { PaneContext } from "../thread/assistant.ts";
import type { RawAssistantThreadStarted } from "./listeners.ts";

import { AssistantThreads, keyOf } from "../thread/assistant.ts";

/**
 * be published to.
 */

interface Pane {
  readonly key: string;
  readonly paneContext: PaneContext;
  readonly ref: { readonly channelId: string; readonly threadTs: string };
}

/**
 * The pane an assistant event names, or nothing if it named none.
 *
 * `assistant_thread_started` and `assistant_thread_context_changed` carry the
 * same object, so one reader serves both.
 */
const paneOf = (event: RawAssistantThreadStarted): Pane | undefined => {
  const channelId = event.assistant_thread?.channel_id;
  const threadTs = event.assistant_thread?.thread_ts;
  if (channelId === undefined || threadTs === undefined) {
    return undefined;
  }
  const ref = {
    channelId,
    threadTs,
  };
  return {
    key: keyOf(ref),
    paneContext: {
      channelId: event.assistant_thread?.context?.channel_id,
      teamId: event.assistant_thread?.context?.team_id,
    },
    ref,
  };
};

interface SurfaceEventHandlers {
  readonly changeAssistantContext: (event: RawAssistantThreadStarted) => void;
  readonly openAssistantThread: (event: RawAssistantThreadStarted) => void;
}

export const makeSurfaceEventHandlers = (input: {
  readonly context: Context.Context<SlackServices>;
  readonly runWith: (effect: Effect.Effect<void, never, SlackServices>) => void;
}): SurfaceEventHandlers => {
  const assistant = Context.get(input.context, AssistantThreads);

  return {
    changeAssistantContext: (event: RawAssistantThreadStarted): void => {
      const pane = paneOf(event);
      if (pane !== undefined) {
        // Re-remembering IS the update: the reader navigated, so the pane now
        // stands in front of a different conversation. Ignoring this leaves the
        // agent answering about the channel they left.
        input.runWith(assistant.remember(pane.key, pane.paneContext));
      }
    },

    openAssistantThread: (event: RawAssistantThreadStarted): void => {
      const pane = paneOf(event);
      if (pane !== undefined) {
        // Order matters: nothing may be offered before the pane is known to BE
        // a pane, because every pane-only call is a no-op until `remember`
        // lands.
        input.runWith(assistant.remember(pane.key, pane.paneContext));
      }
    },
  };
};
