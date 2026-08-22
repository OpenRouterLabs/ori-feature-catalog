/**
 * client.ts — the Slack Web API as a replaceable capability.
 *
 * This is the PORT: the service tag, its shape, and the typed errors. The
 * adapter that builds it from a concrete `WebClient` lives in `client-live.ts`.
 *
 * Two properties matter downstream:
 *
 *   - It is a `Context.Service`, so a feature can supply its own layer and
 *     wrap ours (see `index.ts` for where it is provided — once, at the root).
 *   - It exposes `raw`, so reaching past the typed methods does not mean
 *     building an unconfigured client.
 */

import type {
  AssistantThreadsSetStatusArguments,
  AssistantThreadsSetTitleArguments,
  ChatAppendStreamArguments,
  ChatPostMessageArguments,
  ChatStartStreamArguments,
  ChatStopStreamArguments,
  ChatUpdateArguments,
  ViewsOpenArguments,
  WebClient,
} from "@slack/web-api";
import type { Effect } from "effect";

import { Context, Schema } from "effect";

/**
 * Slack error codes worth retrying. Everything else — auth, scope,
 * bad-argument, not-found — is terminal, and retrying only burns rate limit.
 */
const TRANSIENT_SLACK_CODES: ReadonlySet<string> = new Set([
  "fatal_error",
  "internal_error",
  "ratelimited",
  "request_timeout",
  "service_unavailable",
]);

/** Single typed failure for every Slack Web API call. */
export class SlackApiError extends Schema.TaggedErrorClass<SlackApiError>()(
  "SlackApiError",
  {
    op: Schema.String,
    code: Schema.String,
    cause: Schema.Defect(),
  }
) {
  get transient(): boolean {
    return TRANSIENT_SLACK_CODES.has(this.code);
  }
}

/** Failure reading configuration. The message names the var, never its value. */
export class SlackConfigError extends Schema.TaggedErrorClass<SlackConfigError>()(
  "SlackConfigError",
  {
    op: Schema.String,
    message: Schema.String,
  }
) {}

/** One message posted by this surface. */
export interface PostedMessage {
  readonly channel: string;
  readonly ts: string;
}

export interface SlackClientShape {
  readonly postMessage: (
    args: ChatPostMessageArguments
  ) => Effect.Effect<PostedMessage, SlackApiError>;

  /** Remove a message entirely. Used to retire an affordance without residue. */
  readonly deleteMessage: (args: {
    readonly channel: string;
    readonly ts: string;
  }) => Effect.Effect<void, SlackApiError>;

  readonly updateMessage: (
    args: ChatUpdateArguments
  ) => Effect.Effect<void, SlackApiError>;

  /**
   * Open a streaming reply. Slack owns the rendering from here: chunks are
   * appended rather than the whole message re-sent, so nothing here has to
   * budget lines against the "Show more" fold.
   *
   * `recipient_user_id` and `recipient_team_id` are required in a channel.
   */
  readonly startStream: (
    args: ChatStartStreamArguments
  ) => Effect.Effect<PostedMessage, SlackApiError>;

  readonly appendStream: (
    args: ChatAppendStreamArguments
  ) => Effect.Effect<void, SlackApiError>;

  /** Close the stream. The message becomes an ordinary one at this point. */
  readonly stopStream: (
    args: ChatStopStreamArguments
  ) => Effect.Effect<void, SlackApiError>;

  readonly openView: (
    args: ViewsOpenArguments
  ) => Effect.Effect<void, SlackApiError>;

  /**
   * The assistant pane's own "is thinking…" indicator.
   *
   * NOT gated on the pane, unlike the title: Slack documents this in assistant
   * terms, but a bot replying in a channel thread renders it the same way, and
   * that is the only working indicator a channel agent gets. Attempted
   * everywhere, and a rejection is logged rather than raised.
   */
  readonly setAssistantStatus: (
    args: AssistantThreadsSetStatusArguments
  ) => Effect.Effect<void, SlackApiError>;

  readonly setAssistantTitle: (
    args: AssistantThreadsSetTitleArguments
  ) => Effect.Effect<void, SlackApiError>;

  readonly getUserName: (
    userId: string
  ) => Effect.Effect<string, SlackApiError>;

  /**
   * Escape hatch: the WebClient this service was built from, for any Slack
   * method the typed surface does not model (`pins.add`, `files.*`, whatever
   * Slack ships next).
   *
   * The point is not convenience. A caller reaching past the typed methods
   * gets the client we configured — bounded retry policy, request timeout —
   * instead of writing `new WebClient(token)` and silently inheriting the SDK
   * defaults, where one rate-limited call blocks for ~30 minutes and raises
   * nothing.
   *
   * Prefer the typed methods: they carry retry classification and a typed
   * `SlackApiError`. `raw` throws Slack's own `WebAPIPlatformError` instead.
   */
  readonly raw: WebClient;
}

export class SlackClient extends Context.Service<
  SlackClient,
  SlackClientShape
>()("ori/slack/SlackClient") {}
