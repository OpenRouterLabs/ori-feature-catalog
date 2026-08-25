/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively — the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */
/**
 * assistant.ts — the assistant pane's own affordances.
 *
 * Slack's assistant container is not just a DM with a different frame: it has
 * two capabilities no other conversation has, and both answer `not_allowed`
 * anywhere else. So the surface has to KNOW it is in one, which
 * is what this service tracks — `assistant_thread_started` is the only event
 * that says so, and it arrives once, before the first message.
 *
 * What the two buy:
 *
 *   - `setStatus` drives the pane's NATIVE "is thinking…" indicator. The
 *     surface sets it before the agent can speak for itself and clears it when
 *     the turn ends; in between the agent says its own piece through the
 *     `slack-status` skill.
 *   - `setTitle` names the thread in the reader's assistant history. Left
 *     unset every past conversation is listed as "New chat".
 *
 * A SERVICE for the same reason as `ThreadContext`: a downstream feature can wrap
 * it to suppress the title or wrap the indicator without forking the surface.
 *
 * The pane bookkeeping lives here rather than beside it. It was its own file
 * while there were three Slack calls to keep it away from; there are two now,
 * and a directory holding one module and its notebook is a directory that
 * earns nothing.
 */

import { Context, Effect } from "effect";

import type { SlackApiError, SlackClientShape } from "../client/client.ts";

import { clampToWord } from "../clamp.ts";
import { SlackClient } from "../client/client.ts";

// ── which threads are panes, and what is behind each ────────────────────────

/**
 * The conversation the reader was looking at when they opened the pane.
 *
 * This is the assistant view's whole reason for existing over a plain DM: the
 * pane is its own conversation, so without this the agent cannot tell whether
 * "summarise this" means the channel behind the pane or nothing at all. Slack
 * sends it on `assistant_thread_started` and again on every
 * `assistant_thread_context_changed` as the reader navigates.
 */
export interface PaneContext {
  readonly channelId: string | undefined;
  readonly teamId: string | undefined;
}

/**
 * Threads remembered as assistant panes before the oldest is forgotten.
 *
 * Bounded for the reason `StateStore` is: nothing removes an entry in the
 * normal course of things, so a long-lived daemon would hold one per pane it
 * has ever seen. Forgetting one costs the native status on a very old thread,
 * not correctness — every call it gates is best-effort anyway.
 */
const MAX_TRACKED_PANES = 1000;

interface PaneRegistry {
  readonly contextFor: (key: string) => PaneContext | undefined;
  readonly has: (key: string) => boolean;
  readonly remember: (key: string, paneContext?: PaneContext) => void;
}

/**
 * The pane key.
 *
 * Deliberately NOT `threadInstanceId`: that carries a team id, and the callers
 * here have a channel and a thread but not always a team. Panes only ever exist
 * in the installed workspace, so channel + thread already identifies one.
 */
export const keyOf = (input: {
  readonly channelId: string;
  readonly threadTs: string;
}): string => `${input.channelId}:${input.threadTs}`;

const makePaneRegistry = (): PaneRegistry => {
  /**
   * Known panes, mapped to the conversation behind each. A pane with no context
   * is present with `undefined` — membership is what makes the pane-only calls
   * legal, and that is independent of having a context.
   */
  const panes = new Map<string, PaneContext | undefined>();

  return {
    contextFor: (key) => panes.get(key),

    has: (key) => panes.has(key),

    remember: (key, paneContext) => {
      // Re-inserted rather than updated in place, so a pane the reader is
      // actively navigating counts as recently used and is not the one eviction
      // picks off.
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

/** Slack caps a title; over-long is rejected rather than trimmed. */
const MAX_TITLE_CHARS = 250;

/**
 * How much of the first message becomes the thread title.
 *
 * Short enough to read in the assistant history's narrow list, where a long
 * title is ellipsised into uselessness anyway.
 */
const TITLE_WORD_BUDGET = 60;

export interface AssistantThreadsShape {
  /**
   * Note a thread as an assistant pane, with the conversation behind it.
   * Called from `assistant_thread_started` and on every context change.
   */
  readonly remember: (
    threadKey: string,
    paneContext?: PaneContext
  ) => Effect.Effect<void>;
  /** True when this thread is an assistant pane, so pane-only calls are legal. */
  readonly isPane: (threadKey: string) => Effect.Effect<boolean>;
  /**
   * What the reader was looking at, or undefined for a thread that is not a
   * pane or a pane opened from nowhere in particular.
   */
  readonly contextFor: (
    threadKey: string
  ) => Effect.Effect<PaneContext | undefined>;
  /**
   * Set the native status line, or clear it with "".
   *
   * The line under the composer, and nothing else. The greyed rotating list
   * Slack shows inside the thread is set by the agent through `slack-status`,
   * which owns everything said after the run starts.
   *
   * NOT gated on the pane. Slack's reference describes this method in DM and
   * assistant terms, but an agent replying in a channel thread renders it the
   * same way — "Devin is working…" under the composer, with no message posted
   * for it. That is the only working indicator a channel agent gets, so it is
   * attempted everywhere and a rejection is logged rather than raised.
   */
  readonly setStatus: (
    input: { readonly channelId: string; readonly threadTs: string },
    status: string,
    loading?: readonly string[]
  ) => Effect.Effect<void>;
  /** Name the thread in the reader's assistant history. No-op outside a pane. */
  readonly setTitle: (
    input: { readonly channelId: string; readonly threadTs: string },
    title: string
  ) => Effect.Effect<void>;
}

export class AssistantThreads extends Context.Service<
  AssistantThreads,
  AssistantThreadsShape
>()("ori/slack/AssistantThreads") {}

/** A title from the reader's own words, cut on a word boundary. */
export const titleFromMessage = (text: string): string => {
  const collapsed = text.replaceAll(/\s+/gu, " ").trim();
  if (collapsed.length <= TITLE_WORD_BUDGET) {
    return collapsed.slice(0, MAX_TITLE_CHARS);
  }
  return clampToWord(collapsed, TITLE_WORD_BUDGET);
};

/**
 * Run a pane-only call, or nothing. `op` names it in the failure log.
 *
 * `run` is a THUNK, not a built effect: an argument expression is evaluated
 * whether or not the gate lets it through, so passing the call directly would
 * construct it every time — harmless for a lazy Effect, but it makes the gate
 * impossible to assert on and quietly depends on every client implementation
 * staying lazy.
 *
 * Failures are warned about, never raised: these are decoration around a turn
 * running regardless, and failing a run because its thread could not be
 * re-titled would trade the answer for a label.
 */
const gatedBy =
  (panes: PaneRegistry) =>
  (
    threadKey: string,
    op: string,
    run: () => Effect.Effect<void, unknown>
  ): Effect.Effect<void> =>
    panes.has(threadKey)
      ? Effect.suspend(run).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning(`[slack] assistant ${op} failed`, cause)
          )
        )
      : Effect.void;

/** Decoration around a turn that runs regardless: never raise, always log. */
const bestEffort = (
  op: string,
  run: () => Effect.Effect<void, unknown>
): Effect.Effect<void> =>
  Effect.suspend(run).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning(`[slack] assistant ${op} failed`, cause)
    )
  );

/** Named so the autofixer cannot strip a bare `undefined` argument. */
const NO_LIST: readonly string[] | undefined = undefined;

/**
 * Send the line AND the rotating list, and never let the list take the line
 * down with it.
 *
 * Two failures, one call. Omitting `loading_messages` does not leave the slot
 * empty — Slack fills it with its own filler, "Gathering information…", which
 * is true of every run and about none, and it appears in the THREAD where a
 * reader is actually looking. And the list rides in the same payload as the
 * line, so a rejected list used to swallow the whole call and take the
 * indicator with it, on every beat.
 *
 * So: attempt both, and on rejection retry with the line alone.
 */
const setStatusCall = (input: {
  readonly loading: readonly string[] | undefined;
  readonly pane: { readonly channelId: string; readonly threadTs: string };
  readonly slack: SlackClientShape;
  readonly status: string;
}): Effect.Effect<void> => {
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
    return bestEffort("setStatus", () => send(NO_LIST));
  }
  return send(loading).pipe(
    Effect.catchCause((refused) =>
      Effect.logWarning(
        "[slack] the status loading list was refused; keeping the line",
        refused
      ).pipe(Effect.andThen(bestEffort("setStatus", () => send(NO_LIST))))
    )
  );
};

/**
 * The default: an in-process set of known panes.
 *
 * Every Slack call here is best-effort and logged rather than raised. These are
 * decoration around a turn that is running regardless — failing a run because
 * its thread could not be re-titled would trade the answer for a label.
 */
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
      contextFor: (threadKey) => Effect.sync(() => panes.contextFor(threadKey)),

      isPane: (threadKey) => Effect.sync(() => panes.has(threadKey)),

      remember: (threadKey, paneContext) =>
        Effect.sync(() => {
          panes.remember(threadKey, paneContext);
        }),

      setStatus: (input, status, loading) =>
        setStatusCall({
          loading,
          pane: input,
          slack,
          status,
        }),

      setTitle: (input, title) =>
        inPane(keyOf(input), "setTitle", () =>
          slack.setAssistantTitle({
            channel_id: input.channelId,
            thread_ts: input.threadTs,
            title: title.slice(0, MAX_TITLE_CHARS),
          })
        ),
    });
  });
