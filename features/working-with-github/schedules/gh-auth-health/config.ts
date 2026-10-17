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
    if (value !== undefined && value !== "") {
      return value;
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
