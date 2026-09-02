import { Context, Effect, Schema } from "effect";

import type { SlackApiError, SlackClientShape } from "#src/client/client.ts";

import { clampToWord } from "#src/clamp.ts";
import { SlackClient } from "#src/client/client.ts";

export const PaneContextSchema = Schema.Struct({
  channelId: Schema.UndefinedOr(Schema.String),
  teamId: Schema.UndefinedOr(Schema.String),
});

export type PaneContext = typeof PaneContextSchema.Type;

const MAX_TRACKED_PANES = 1000;

interface PaneRegistry {
  readonly contextFor: (key: string) => PaneContext | undefined;
  readonly has: (key: string) => boolean;
  readonly remember: (key: string, paneContext?: PaneContext) => void;
}

export const keyOf = (input: {
  readonly channelId: string;
  readonly threadTs: string;
}): string => `${input.channelId}:${input.threadTs}`;

const makePaneRegistry = (): PaneRegistry => {
  const panes = new Map<string, PaneContext | undefined>();

  return {
    contextFor: (key) => panes.get(key),

    has: (key) => panes.has(key),

    remember: (key, paneContext) => {
      panes.delete(key);
      panes.set(key, paneContext);
      while (panes.size > MAX_TRACKED_PANES) {
        const oldest = panes.keys().next().value;
        if (oldest === undefined) {
          break;
        }
        panes.delete(oldest);
      }
    },
  };
};

const MAX_TITLE_CHARS = 250;

const TITLE_WORD_BUDGET = 60;

export interface AssistantThreadsShape {
  readonly remember: (
    threadKey: string,
    paneContext?: PaneContext
  ) => Effect.Effect<void>;
  readonly isPane: (threadKey: string) => Effect.Effect<boolean>;
  readonly contextFor: (
    threadKey: string
  ) => Effect.Effect<PaneContext | undefined>;
  readonly setStatus: (
    input: { readonly channelId: string; readonly threadTs: string },
    status: string,
    loading?: readonly string[]
  ) => Effect.Effect<void>;
  readonly setTitle: (
    input: { readonly channelId: string; readonly threadTs: string },
    title: string
  ) => Effect.Effect<void>;
}

export class AssistantThreads extends Context.Service<
  AssistantThreads,
  AssistantThreadsShape
>()("ori/slack/AssistantThreads") {}

export const titleFromMessage = (text: string): string => {
  const collapsed = text.replaceAll(/\s+/gu, " ").trim();
  if (collapsed.length <= TITLE_WORD_BUDGET) {
    return collapsed.slice(0, MAX_TITLE_CHARS);
  }
  return clampToWord(collapsed, TITLE_WORD_BUDGET);
};

const gatedBy =
  (panes: PaneRegistry) =>
  (
    threadKey: string,
    op: string,
    run: () => Effect.Effect<void, unknown>
  ): Effect.Effect<void> =>
    (panes.has(threadKey)
      ? Effect.suspend(run).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning(`[slack] assistant ${op} failed`, cause)
          )
        )
      : Effect.void
    ).pipe(Effect.withSpan("Slack.thread.gated", { attributes: { op } }));

const bestEffort = (
  op: string,
  run: () => Effect.Effect<void, unknown>
): Effect.Effect<void> =>
  Effect.suspend(run).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning(`[slack] assistant ${op} failed`, cause)
    ),
    Effect.withSpan("Slack.thread.bestEffort", { attributes: { op } })
  );

const NO_LIST: readonly string[] | undefined = undefined;

const setStatusCall = Effect.fn("Slack.thread.sendStatus")(function* (input: {
  readonly loading: readonly string[] | undefined;
  readonly pane: { readonly channelId: string; readonly threadTs: string };
  readonly slack: SlackClientShape;
  readonly status: string;
}): Effect.fn.Return<void> {
  const { loading, slack, status } = input;
  const pane = {
    channel_id: input.pane.channelId,
    thread_ts: input.pane.threadTs,
  };
  const send = (
    messages: readonly string[] | undefined
  ): Effect.Effect<void, SlackApiError> =>
    slack.setAssistantStatus({
      ...pane,
      ...(messages === undefined ? {} : { loading_messages: [...messages] }),
      status,
    });

  if (loading === undefined || loading.length === 0) {
    return yield* bestEffort("setStatus", () => send(NO_LIST));
  }
  return yield* send(loading).pipe(
    Effect.catchCause((refused) =>
      Effect.logWarning(
        "[slack] the status loading list was refused; keeping the line",
        refused
      ).pipe(Effect.andThen(bestEffort("setStatus", () => send(NO_LIST))))
    )
  );
});

export const AssistantThreadsLive = (): Effect.Effect<
  AssistantThreadsShape,
  never,
  SlackClient
> =>
  Effect.gen(function* () {
    const slack = yield* SlackClient;
    const panes: PaneRegistry = makePaneRegistry();

    const inPane = gatedBy(panes);

    return AssistantThreads.of({
      contextFor: (threadKey) =>
        Effect.sync(() => panes.contextFor(threadKey)).pipe(
          Effect.withSpan("Slack.thread.contextFor")
        ),

      isPane: (threadKey) =>
        Effect.sync(() => panes.has(threadKey)).pipe(
          Effect.withSpan("Slack.thread.isPane")
        ),

      remember: (threadKey, paneContext) =>
        Effect.sync(() => {
          panes.remember(threadKey, paneContext);
        }).pipe(Effect.withSpan("Slack.thread.remember")),

      setStatus: (input, status, loading) =>
        setStatusCall({
          loading,
          pane: input,
          slack,
          status,
        }).pipe(Effect.withSpan("Slack.thread.setStatus")),

      setTitle: (input, title) =>
        inPane(keyOf(input), "setTitle", () =>
          slack.setAssistantTitle({
            channel_id: input.channelId,
            thread_ts: input.threadTs,
            title: title.slice(0, MAX_TITLE_CHARS),
          })
        ).pipe(Effect.withSpan("Slack.thread.setTitle")),
    });
  }).pipe(Effect.withSpan("Slack.thread.assistantThreadsLive"));
