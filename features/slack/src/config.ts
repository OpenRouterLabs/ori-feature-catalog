/**
 * config.ts — every knob this surface reads, decoded once.
 *
 * Env was being read wherever it was needed: a `Bun.env` lookup in the
 * renderer, another in the route factory, a bare `Number()` on a timeout that
 * silently became NaN. Nothing listed the options, and a typo surfaced as
 * behaviour rather than as an error.
 *
 * ONE PLACE, read at boot. A misconfigured value falls back to its default
 * rather than throwing — a surface that refuses to start because an optional
 * emoji is malformed is worse than one that renders the default emoji — but
 * the two secrets have no sensible default, so a missing one still fails loudly
 * and by name.
 */

import { Context } from "effect";

const DEFAULT_LOADING_EMOJI = ":braille-loader:";

/** Structural, so `Bun.env` passes straight through. */
export type Env = Readonly<Record<string, string | undefined>>;

export interface SlackConfig {
  /** Who may address the bot at all. Empty means anyone in the channel. */
  readonly allowedUserIds: ReadonlySet<string>;
  readonly botUserId: string | undefined;
  /** Absent means image generation is unavailable, not that boot fails. */
  readonly openRouterApiKey: string | undefined;
  /**
   * The model the chatter answers on, when it should not be the worker's.
   *
   * It is deciding whether a message is small talk and, when it is, saying one
   * sentence back — in front of EVERY turn. A big model spends the latency
   * budget of the thing it exists to make fast. Unset inherits the worker's.
   */
  readonly chatterModel: string | undefined;
  readonly imageModel: string | undefined;
  readonly loadingEmoji: string;
  readonly signingSecret: string;
  /** Prefixes that mark a message as not for the bot. */
  readonly skipPrefixes: readonly string[];
  readonly token: string;
}

const splitList = (raw: string | undefined): readonly string[] =>
  (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");

const nonEmpty = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
};

/**
 * Read the two secrets, or say which one is missing.
 *
 * These are the only values with no usable default: without them there is no
 * Slack connection to degrade to, so this is the one thing that stops a boot.
 */
const requireSecrets = (
  env: Env
): { readonly signingSecret: string; readonly token: string } => {
  const missing = ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"].filter(
    (name) => nonEmpty(env[name]) === undefined
  );
  if (missing.length > 0) {
    throw new Error(`Missing env var: ${missing.join(", ")}`);
  }
  return {
    signingSecret: env.SLACK_SIGNING_SECRET ?? "",
    token: env.SLACK_BOT_TOKEN ?? "",
  };
};

/**
 * The whole surface's configuration, from the environment.
 *
 * Throws only for a missing secret. Everything else degrades to its default,
 * because a chat surface that will not start over a malformed optional is a
 * worse failure than the malformed optional.
 */
export const readSlackConfig = (env: Env = Bun.env): SlackConfig => ({
  ...requireSecrets(env),
  allowedUserIds: new Set(splitList(env.SLACK_ALLOWED_USER_IDS)),
  botUserId: nonEmpty(env.SLACK_BOT_USER_ID),
  chatterModel: nonEmpty(env.SLACK_CHATTER_MODEL),
  imageModel: nonEmpty(env.SLACK_IMAGE_MODEL),
  loadingEmoji: nonEmpty(env.SLACK_LOADING_EMOJI) ?? DEFAULT_LOADING_EMOJI,
  openRouterApiKey: nonEmpty(env.OPENROUTER_API_KEY),
  skipPrefixes: splitList(env.SLACK_SKIP_PREFIXES),
});

/**
 * The bot token, or undefined when there is none.
 *
 * For callers outside the boot path — the `use("slack")` api can be reached
 * without the surface running, and must degrade to "not configured" rather
 * than throwing the way {@link readSlackConfig} deliberately does.
 */
export const readBotToken = (env: Env = Bun.env): string | undefined =>
  nonEmpty(env.SLACK_BOT_TOKEN);

/** Every name this surface reads, so the set is discoverable in one place. */
export const SLACK_ENV_VARS = [
  "OPENROUTER_API_KEY",
  "SLACK_ALLOWED_USER_IDS",
  "SLACK_BOT_TOKEN",
  "SLACK_BOT_USER_ID",
  "SLACK_CHATTER_MODEL",
  "SLACK_IMAGE_MODEL",
  "SLACK_LOADING_EMOJI",
  "SLACK_SIGNING_SECRET",
  "SLACK_SKIP_PREFIXES",
] as const;

/**
 * The configuration, as a service.
 *
 * Read once at boot and provided, so nothing downstream reaches for `Bun.env`
 * mid-turn — and so a test or a wrapping feature can supply a different one
 * without touching the process environment.
 */
class SlackConfigService extends Context.Service<
  SlackConfigService,
  SlackConfig
>()("ori/slack/SlackConfig") {}
