import { describe, expect, test } from "bun:test";
// Regression: a WHITESPACE-only alert-channel env value
// (`GH_AUTH_HEALTH_ALERT_CHANNEL_ID="   "` — a compose interpolation of an
// unset variable, an env-file line that kept its padding) is the same unset
// shape as "", not a configured channel: pre-fix `firstNonEmpty` tested
// only `undefined`/`""`, so the raw whitespace flowed on as
// `alertChannelId`, the schedule's `alertChannelId === undefined` guard
// passed, and `postAlert` attempted chat.postMessage against a channel id
// Slack never answers (channel_not_found after the SDK retry ladder) — the
// health failure the schedule exists to surface was never delivered
// anywhere, while the same env var spelled "" already took the documented
// log-only fallback. The empty-string test existed (pinned in
// schedule.test.ts); the whitespace-only value fell through it.
import { readGhAuthHealthConfig } from "./config.ts";

describe("readGhAuthHealthConfig (whitespace-only alert channel)", () => {
  test("a whitespace-only channel env is unset, never a raw alert target", () => {
    expect(
      readGhAuthHealthConfig({
        GH_AUTH_HEALTH_ALERT_CHANNEL_ID: "   ",
      }).alertChannelId
    ).toBeUndefined();
    expect(
      readGhAuthHealthConfig({
        GH_AUTH_HEALTH_ALERT_CHANNEL_ID: "\t",
      }).alertChannelId
    ).toBeUndefined();
    expect(
      readGhAuthHealthConfig({
        GH_AUTH_HEALTH_ALERT_CHANNEL_ID: " \n ",
      }).alertChannelId
    ).toBeUndefined();
  });

  test("an empty-string channel env keeps its documented unset fallback", () => {
    expect(
      readGhAuthHealthConfig({ GH_AUTH_HEALTH_ALERT_CHANNEL_ID: "" })
        .alertChannelId
    ).toBeUndefined();
    expect(readGhAuthHealthConfig({}).alertChannelId).toBeUndefined();
  });

  test("a padded real channel id trims to its content", () => {
    expect(
      readGhAuthHealthConfig({
        GH_AUTH_HEALTH_ALERT_CHANNEL_ID: "  C123  ",
      }).alertChannelId
    ).toBe("C123");
  });
});