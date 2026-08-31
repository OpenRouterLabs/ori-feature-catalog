/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively; the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */

import { Context, Effect } from "effect";

import type { SlackServices } from "../layers.ts";
import type { PaneContext } from "../thread/assistant.ts";
import type { RawAssistantThreadStarted } from "./listeners.ts";

import { AssistantThreads, keyOf } from "../thread/assistant.ts";

interface Pane {
  readonly key: string;
  readonly paneContext: PaneContext;
  readonly ref: { readonly channelId: string; readonly threadTs: string };
}

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
        input.runWith(
          assistant
            .remember(pane.key, pane.paneContext)
            .pipe(Effect.withSpan("Slack.client.changeAssistantContext"))
        );
      }
    },

    openAssistantThread: (event: RawAssistantThreadStarted): void => {
      const pane = paneOf(event);
      if (pane !== undefined) {
        input.runWith(
          assistant
            .remember(pane.key, pane.paneContext)
            .pipe(Effect.withSpan("Slack.client.openAssistantThread"))
        );
      }
    },
  };
};
