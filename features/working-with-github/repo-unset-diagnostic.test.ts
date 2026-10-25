import { describe, expect, test } from "bun:test";
// Regression: after the orgs-page INDEX fix (#203) — and for any spelling
// that resolves to no owner/repo — the empty-`repo` guards in the CLI and
// the two schedules all printed "GITHUB_REPO is not set" / "unset", even
// when the env var WAS set (e.g. to `https://github.com/orgs`). The message
// is factually wrong for exactly the input that most needs it: it sends the
// operator to inspect systemd env config that is present and populated,
// instead of naming the spelling that produced no owner/repo.
//
// The schedules and the cleanup CLI all read `process.env`/`env` directly
// beside the resolver call, so they CAN tell the two cases apart; this
// suite pins the shared predicate and the per-site wording.

import {
  isRepoUnset,
  resolveRepoFromEnv,
} from "./scripts/commit-api-core.ts";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

describe("isRepoUnset distinguishes unset from set-but-unresolvable", () => {
  test("unset, absent, and whitespace-only are unset", () => {
    expect(isRepoUnset({})).toBe(true);
    expect(isRepoUnset({ GITHUB_REPO: undefined })).toBe(true);
    expect(isRepoUnset({ GITHUB_REPO: "" })).toBe(true);
    expect(isRepoUnset({ GITHUB_REPO: "   " })).toBe(true);
  });

  test("a set spelling that resolves to nothing is NOT unset", () => {
    // The orgs-page INDEX spelling (#203's corpus): the env var is set, so
    // "not set" would be a lie — the site must name the spelling instead.
    expect(isRepoUnset({ GITHUB_REPO: "https://github.com/orgs" })).toBe(
      false
    );
    expect(
      isRepoUnset({ GITHUB_REPO: "git@github.com:organizations" })
    ).toBe(false);
    expect(isRepoUnset({ GITHUB_REPO: "ssh://git@github.com:22/orgs" })).toBe(
      false
    );
  });

  test("a set spelling that resolves keeps resolving", () => {
    expect(isRepoUnset({ GITHUB_REPO: "acme/widgets" })).toBe(false);
    expect(resolveRepoFromEnv({ GITHUB_REPO: "acme/widgets" })).toBe(
      "acme/widgets"
    );
  });
});

describe("the empty-repo guards name the actual cause", () => {
  const cleanup = readFileSync(
    join(here, "scripts/cleanup-worktrees.ts"),
    "utf-8"
  );
  const healthSchedule = readFileSync(
    join(here, "schedules/gh-auth-health/schedule.ts"),
    "utf-8"
  );
  const cleanupSchedule = readFileSync(
    join(here, "schedules/worktree-cleanup/schedule.ts"),
    "utf-8"
  );

  test("cleanup-worktrees.ts distinguishes the two cases", () => {
    // The unconditional "GITHUB_REPO is unset" line is gone; the guard now
    // words the message by the actual cause, and the set-but-unresolvable
    // case names the spelling that produced no owner/repo.
    expect(cleanup).not.toContain("no --repo given and GITHUB_REPO is unset");
    expect(cleanup).toContain("isRepoUnset");
    expect(cleanup).toContain("resolves to no owner/repo");
    // The unconditional message is now the UNSET branch only — the
    // set-but-unresolvable case has its own message naming the spelling.
    expect(cleanup).toContain(
      "no --repo given and GITHUB_REPO is not set"
    );
  });

  test("gh-auth-health's schedule distinguishes the two cases", () => {
    expect(healthSchedule).toContain("isRepoUnset");
    expect(healthSchedule).toContain("resolves to no owner/repo");
    // The "not set" wording survives ONLY as the unset branch; the guard
    // splits on the shared predicate.
    expect(healthSchedule).toMatch(
      /isRepoUnset\(process\.env\)\s*\?\s*"gh-auth-health: GITHUB_REPO is not set/
    );
  });

  test("worktree-cleanup's schedule distinguishes the two cases", () => {
    expect(cleanupSchedule).toContain("isRepoUnset");
    expect(cleanupSchedule).toContain("resolves to no owner/repo");
    expect(cleanupSchedule).toMatch(
      /isRepoUnset\(process\.env\)\s*\?\s*"worktree-cleanup: GITHUB_REPO is not set/
    );
  });
});
