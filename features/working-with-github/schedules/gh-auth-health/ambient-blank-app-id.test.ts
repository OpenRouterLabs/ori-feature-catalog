import { afterEach, describe, expect, mock, test } from "bun:test";
// A blank GH_APP_ID ("  ", a compose interpolation of an unset variable)
// names no App: mint-token.ts, commit-via-api.ts and register-gh-app.ts read
// it as ambient mode. This schedule compared the raw value with "", so the
// same env took the App branch. The fire read the rotated GH_TOKEN, found
// none, and logged (and paged)
//   gh-auth-health: FAILED at mint for acme/widgets — GH_TOKEN is not set
// every 30 minutes, while mint-token told the agent nothing was broken. The
// ambient probe that does apply never ran.
//
// `ori` is a gitignored local SDK on a fresh checkout, so it is mocked here:
// the schedule only uses its `defineSchedule` identity.
mock.module("ori", () => ({
  defineSchedule: (definition: unknown) => definition,
}));

import { isAmbientMode } from "../../scripts/commit-api-core.ts";

const KEYS = ["GH_APP_ID", "GH_TOKEN", "GITHUB_REPO", "GH_AUTH_HEALTH_ALERT_CHANNEL_ID"] as const;
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const key of KEYS) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
});

describe("gh-auth-health with a blank GH_APP_ID", () => {
  test("isAmbientMode reads unset, empty and whitespace-only as ambient", () => {
    expect(isAmbientMode({})).toBe(true);
    expect(isAmbientMode({ GH_APP_ID: "" })).toBe(true);
    expect(isAmbientMode({ GH_APP_ID: " \t " })).toBe(true);
    expect(isAmbientMode({ GH_APP_ID: "123" })).toBe(false);
  });

  test("the fire runs the ambient probe, not a mint", async () => {
    for (const key of KEYS) {
      delete process.env[key];
    }
    process.env.GH_APP_ID = "  ";
    process.env.GITHUB_REPO = "acme/widgets";
    const calls: string[] = [];
    globalThis.fetch = ((url: string) => {
      calls.push(String(url));
      return Promise.resolve(Response.json({ full_name: "acme/widgets" }));
    }) as typeof fetch;
    const { schedule } = (await import("./schedule.ts")) as unknown as {
      schedule: { run: (ctx: { logger: unknown }) => Promise<void> };
    };
    const logged: string[] = [];
    const record = (level: string) => (text: string) => {
      logged.push(`${level}: ${text}`);
    };
    await schedule.run({
      logger: { debug: record("debug"), error: record("error"), info: record("info"), warn: record("warn") },
    });
    expect(calls).toEqual(["https://api.github.com/repos/acme/widgets"]);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toStartWith("info: gh-auth-health: ok — GitHub API reachable with no App configured");
  });
});
