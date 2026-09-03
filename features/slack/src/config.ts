import { Schema } from "effect";

const DEFAULT_LOADING_EMOJI = ":braille-loader:";
const DEFAULT_ON_IT_AFTER_MS = 20_000;

export type Env = Readonly<Record<string, string | undefined>>;

const SlackConfigSchema = Schema.Struct({
  allowedUserIds: Schema.ReadonlySet(Schema.String),
  botUserId: Schema.UndefinedOr(Schema.String),
  openRouterApiKey: Schema.UndefinedOr(Schema.String),
  chatterModel: Schema.UndefinedOr(Schema.String),
  imageModel: Schema.UndefinedOr(Schema.String),
  loadingEmoji: Schema.String,
  onItAfterMs: Schema.Number,
  signingSecret: Schema.String,
  skipPrefixes: Schema.Array(Schema.String),
  token: Schema.String,
});

export type SlackConfig = typeof SlackConfigSchema.Type;

const splitList = (raw: string | undefined): readonly string[] =>
  (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");

const nonEmpty = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
};

const positiveInt = (
  value: string | undefined,
  fallback: number
): number => {
  const parsed = Number(nonEmpty(value));
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

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

export const readSlackConfig = (env: Env = Bun.env): SlackConfig => ({
  ...requireSecrets(env),
  allowedUserIds: new Set(splitList(env.SLACK_ALLOWED_USER_IDS)),
  botUserId: nonEmpty(env.SLACK_BOT_USER_ID),
  chatterModel: nonEmpty(env.SLACK_CHATTER_MODEL),
  imageModel: nonEmpty(env.SLACK_IMAGE_MODEL),
  loadingEmoji: nonEmpty(env.SLACK_LOADING_EMOJI) ?? DEFAULT_LOADING_EMOJI,
  onItAfterMs: positiveInt(env.SLACK_ON_IT_AFTER_MS, DEFAULT_ON_IT_AFTER_MS),
  openRouterApiKey: nonEmpty(env.OPENROUTER_API_KEY),
  skipPrefixes: splitList(env.SLACK_SKIP_PREFIXES),
});

export const readBotToken = (env: Env = Bun.env): string | undefined =>
  nonEmpty(env.SLACK_BOT_TOKEN);

export const SLACK_ENV_VARS = [
  "OPENROUTER_API_KEY",
  "SLACK_ALLOWED_USER_IDS",
  "SLACK_BOT_TOKEN",
  "SLACK_BOT_USER_ID",
  "SLACK_CHATTER_MODEL",
  "SLACK_IMAGE_MODEL",
  "SLACK_LOADING_EMOJI",
  "SLACK_ON_IT_AFTER_MS",
  "SLACK_SIGNING_SECRET",
  "SLACK_SKIP_PREFIXES",
] as const;
