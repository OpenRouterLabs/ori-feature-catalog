import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// A `git://` scheme spelling — `git://github.com/o/r`, `git://github.com`
// (a git-native clone URL; the bare-host form is a truncated `git clone
// --bare` paste or a docs example) — is a real git remote scheme every git
// client accepts, and the prompt's own `REPO=` recipe documents the guard
// list as `https?|ssh|git+ssh|ftp` — `git+ssh` is listed, the plain `git`
// scheme is NOT, so the interior-slash collapse's lookbehind guard treats
// a `git://` scheme's own `://` as an INTERIOR doubled slash and collapses
// it to `:` (`git:github.com`):
//
//   - `orgOf` and `resolveRepoFromEnv` returned the collapsed junk
//     (`git:github.com`) — a "repo"/"org" no `repos/{repo}` route answers,
//     a registry key and allowlist entry no mint can ever derive;
//   - `resolveAllowedOrgs` keyed the allowlist on `git:github.com` — a
//     login no installation owner can ever carry, so EVERY mint failed
//     closed with no hint the env var's spelling was the cause;
//   - `resolveConfigDirName` keyed the registry/cache DB dir on the
//     sanitized junk (`git-github.com`) — silently migrating the DB the
//     moment the env var's spelling carried a `git://` scheme (#113's
//     class);
//   - the prompt's `REPO=` recipe (which the suite pins to agree with the
//     resolvers) carried the raw URL whole, so the recipe and all four
//     code resolvers silently disagreed — the one-spelling contract.
//
// Every SIBLING scheme in the guard list (`ssh`, `git+ssh`, `ftp`, `http`)
// already collapses its own `://` correctly and answers the bare-host
// `""`/`intern` values; `git` is the one missing from the list. The fix
// adds `git` to the lookbehind, so a `git://` spelling resolves exactly
// like its `ssh://` sibling — byte-for-byte the same answers.

import { orgOf, resolveConfigDirName } from "./gh-app-registry.ts";
import { resolveAllowedOrgs } from "./gh-app-github-api.ts";
import { resolveRepoFromEnv } from "./scripts/commit-api-core.ts";

const GIT_SCHEME_REPO: readonly string[] = [
  "git://github.com/o/r",
  "git://github.com/o/r/",
  "git://github.com/o/r.git",
  "git://github.com/o/r/tree/main",
  "git://github.com:22/o/r",
];

const GIT_SCHEME_BARE_HOST: readonly string[] = [
  "git://github.com",
  "git://github.com/",
  "git://github.com:22",
];

describe("a git:// scheme spelling resolves like its ssh:// sibling in all four resolvers", () => {
  test("orgOf extracts the owner, never the collapsed scheme junk", () => {
    for (const raw of GIT_SCHEME_REPO) {
      expect(orgOf(raw)).toBe("o");
    }
    for (const raw of GIT_SCHEME_BARE_HOST) {
      expect(orgOf(raw)).toBe("");
      expect(orgOf(raw)).not.toContain(":");
    }
  });

  test("resolveRepoFromEnv answers owner/repo, never the raw URL", () => {
    for (const raw of GIT_SCHEME_REPO) {
      expect(resolveRepoFromEnv({ GITHUB_REPO: raw })).toBe("o/r");
    }
    for (const raw of GIT_SCHEME_BARE_HOST) {
      expect(resolveRepoFromEnv({ GITHUB_REPO: raw })).toBe("");
    }
  });

  test("resolveAllowedOrgs allows the owner, not the collapsed scheme junk", () => {
    for (const raw of GIT_SCHEME_REPO) {
      expect([...resolveAllowedOrgs(undefined, { GITHUB_REPO: raw })]).toEqual(
        ["o"]
      );
    }
    for (const raw of GIT_SCHEME_BARE_HOST) {
      expect([...resolveAllowedOrgs(undefined, { GITHUB_REPO: raw })]).toEqual(
        []
      );
    }
  });

  test("resolveConfigDirName keys on the repo name, never a sanitized URL", () => {
    for (const raw of GIT_SCHEME_REPO) {
      expect(resolveConfigDirName({ GITHUB_REPO: raw })).toBe("r");
    }
    for (const raw of GIT_SCHEME_BARE_HOST) {
      expect(resolveConfigDirName({ GITHUB_REPO: raw })).toBe("intern");
    }
  });

  test("a git:// interior doubled slash still collapses like every scheme's", () => {
    // The collapse itself must keep working UNDER a git:// scheme: an empty
    // path segment in the path portion collapses, while the scheme's own
    // separator survives.
    expect(orgOf("git://github.com//o/r")).toBe("o");
    expect(resolveRepoFromEnv({ GITHUB_REPO: "git://github.com//o/r" })).toBe(
      "o/r"
    );
    expect([...resolveAllowedOrgs(undefined, { GITHUB_REPO: "o//r" })]).toEqual(
      ["o"]
    );
  });

  test("the prompt REPO= recipe normalizes a git:// spelling like the resolvers", async () => {
    // One spelling contract: the recipe the prompt teaches must agree with
    // the four resolvers for the same `git://` pastes (prompt-recipes.test.ts
    // pins the recipe side of the same corpus). Read it from prompt.md —
    // the recipe the prompt actually teaches — never a copied literal.
    const prompt = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "prompt.md"),
      "utf-8"
    );
    const recipe = prompt
      .split("\n")
      .find((line) => line.trimStart().startsWith(`REPO=$(printf`))
      ?.trim();
    expect(recipe).toBeDefined();
    if (recipe === undefined) {
      return;
    }
    for (const [raw, want] of [
      ["git://github.com/o/r", "o/r"],
      ["git://github.com", ""],
      ["git://github.com:22", ""],
    ] as const) {
      const out = execFileSync("bash", ["-c", `${recipe}\nprintf '%s' "$REPO"`], {
        encoding: "utf-8",
        env: { ...process.env, GITHUB_REPO: raw },
      });
      expect(out).toBe(want);
    }
  });
});