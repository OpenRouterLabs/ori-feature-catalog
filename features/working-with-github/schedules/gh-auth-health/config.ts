/**
 * config.ts — tunable knobs for the gh-auth-health schedule.
 *
 * The schedule verifies the intern's mint-on-demand GitHub auth still works. The
 * only thing worth tuning at deploy time is where a failure alert is posted; the
 * cadence lives in the cron expression on the schedule itself.
 */

export interface GhAuthHealthConfig {
  /** Channel id a failed health check alerts into, or undefined when unset. */
  readonly alertChannelId: string | undefined;
}

/** First non-empty value, treating "" (and undefined) as unset. Used instead of
 *  a `||` chain so an empty-string env var falls back rather than posting to an
 *  empty channel id — without tripping prefer-nullish-coalescing. */
const firstNonEmpty = (
  ...values: readonly (string | undefined)[]
): string | undefined => {
  for (const value of values) {
    // Trim before the emptiness test: a WHITESPACE-only env value
    // (`GH_AUTH_HEALTH_ALERT_CHANNEL_ID="   "` — a compose interpolation
    // of an unset variable, an env-file line that kept its padding) is the
    // same unset shape as "" — a channel id Slack never answers — not a
    // configured one. Pre-fix it flowed on raw: the schedule's
    // `alertChannelId === undefined` guard passed, postAlert attempted
    // chat.postMessage against a whitespace channel (channel_not_found
    // after the retry ladder), and the health failure the schedule exists
    // to surface was never delivered anywhere — while the same env var
    // spelled "" already took the documented log-only fallback. A padded
    // value with real content trims to that content, the same
    // normalization repo-dir.ts applies to its env seam.
    const trimmed = value?.trim();
    if (trimmed !== undefined && trimmed !== "") {
      return trimmed;
    }
  }
  return undefined;
};

/**
 * Resolve the effective gh-auth-health config from the environment. The alert
 * channel is `GH_AUTH_HEALTH_ALERT_CHANNEL_ID`. When it is unset, `alertChannelId` is
 * undefined and the schedule logs the failure instead of posting.
 */
export const readGhAuthHealthConfig = (
  // oxlint-disable-next-line node/no-process-env -- default deps seam; callers pass a fake env in tests.
  env: Readonly<Record<string, string | undefined>> = process.env
): GhAuthHealthConfig => {
  const alertChannelId = firstNonEmpty(env.GH_AUTH_HEALTH_ALERT_CHANNEL_ID);
  return { alertChannelId };
};
