const DEFAULT_LOADING_EMOJI = ":braille-loader:";

export type Env = Readonly<Record<string, string | undefined>>;

export interface SlackConfig {
  readonly allowedUserIds: ReadonlySet<string>;
  readonly botUserId: string | undefined;
  readonly openRouterApiKey: string | undefined;
  readonly chatterModel: string | undefined;
  readonly imageModel: string | undefined;
  readonly loadingEmoji: string;
  readonly signingSecret: string;
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
  "SLACK_SIGNING_SECRET",
  "SLACK_SKIP_PREFIXES",
] as const;
