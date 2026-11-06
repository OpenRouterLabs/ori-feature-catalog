import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Ambient mode does not require GITHUB_REPO: gh-auth-health probes the API
// root when it is unset and reports healthy. The daily worktree-cleanup fire
// on the same host died instead ("GITHUB_REPO is not set — cannot resolve
// which slug to sweep."), so every fire was recorded as an error although
// there is no repo slug, and so no worktree, to sweep. Reproduced by running
// the schedule's own `run` with GH_APP_ID and GITHUB_REPO unset.
//
// `ori` is a gitignored local SDK on a fresh checkout, so it is mocked here:
// the schedule only uses its `defineSchedule` identity.
mock.module("ori", () => ({
  defineSchedule: (definition: unknown) => definition,
}));

interface Logged {
  readonly level: string;
  readonly text: string;
}

const KEYS = ["GH_APP_ID", "GITHUB_REPO"] as const;

const fire = async (): Promise<{
  readonly logged: Logged[];
  readonly rejection: string | undefined;
}> => {
  const { schedule } = (await import("./schedule.ts")) as unknown as {
    schedule: { run: (ctx: { logger: unknown }) => Promise<void> };
  };
  const logged: Logged[] = [];
  const record = (level: string) => (text: string) => {
    logged.push({ level, text });
  };
  const logger = {
    debug: record("debug"),
    error: record("error"),
    info: record("info"),
    warn: record("warn"),
  };
  try {
    await schedule.run({ logger });
    return { logged, rejection: undefined };
  } catch (error) {
    return { logged, rejection: String(error) };
  }
};

describe("worktree-cleanup with no GITHUB_REPO", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  });

  test("ambient mode finishes the fire quietly, never an error", async () => {
    const { logged, rejection } = await fire();
    expect(rejection).toBeUndefined();
    expect(logged).toEqual([
      {
        level: "info",
        text: "worktree-cleanup: GITHUB_REPO is not set in ambient mode — no repo slug to sweep.",
      },
    ]);
  });

  test("ambient mode with a SET spelling that names no repo still fails loudly", async () => {
    process.env.GITHUB_REPO = "https://github.com/orgs";
    const { rejection } = await fire();
    expect(rejection).toContain("resolves to no owner/repo");
  });

  test("App mode still fails loudly: there GITHUB_REPO is required", async () => {
    process.env.GH_APP_ID = "123";
    const { rejection } = await fire();
    expect(rejection).toContain("GITHUB_REPO is not set");
  });
});

// Regression: a blank GH_APP_ID ("  ", a compose interpolation of an unset
// variable) names no App, and mint-token.ts already reads it as ambient. This
// schedule compared the raw value with "", took the App path, and died on
// "GITHUB_REPO is not set" (or, with a repo, on a mint that cannot succeed).
describe("worktree-cleanup with a blank GH_APP_ID", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  });

  test("a whitespace-only GH_APP_ID is ambient mode, so the fire finishes quietly", async () => {
    for (const blank of ["", "  ", "\t"]) {
      process.env.GH_APP_ID = blank;
      const { logged, rejection } = await fire();
      expect(rejection).toBeUndefined();
      expect(logged.map((entry) => entry.text)).toEqual([
        "worktree-cleanup: GITHUB_REPO is not set in ambient mode — no repo slug to sweep.",
      ]);
    }
  });
});
