import { describe, expect, test } from "bun:test";
// Regression: a MIXED-CASE HOST (an address-bar capitalization —
// `https://GitHub.com/…`, `git@GitHub.com:…`, `GitHub.com:22/…`; hosts are
// case-insensitive by RFC 3986 §3.2.2 and every real client accepts them)
// whose spelling carries a QUERY/FRAGMENT rider or a `.git` suffix PAST the
// host word — `GitHub.com#frag`, `https://GitHub.com?x=1`,
// `GitHub.com.git`, `git@GitHub.com.git` — never reached the case-lowering
// strip in any of the four resolvers: the strip keyed on a
// `github.com`-anchored lookahead that a rider or suffix past the host word
// fails, so the host kept its case and the raw string flowed on whole —
//
//   orgOf("GitHub.com#frag")                  → "GitHub.com" (a dead registry key)
//   resolveRepoFromEnv("https://GitHub.com.git") → "https://GitHub.com" (404s every route)
//   resolveAllowedOrgs(GITHUB_REPO: "…")      → {} or a padded raw host (every mint fails closed)
//   resolveConfigDirName(…#frag)              → "github.com" (a silent DB migration)
//
// while the prompt's REPO= recipe answered "" (its `s#[Gg][Ii][Tt]…` classes
// are case-insensitive and its rider strips run on the whole string) and
// every sibling resolver that DID see the lowered host answered the same.
// One spelling, five disagreeing answers — the README's one-spelling
// contract. The fix: apply the rider/suffix strips (which no anchored
// branch depends on) BEFORE the case-lowering strip keys on the host word.
import { orgOf, resolveConfigDirName } from "./gh-app-registry.ts";
import { resolveAllowedOrgs } from "./gh-app-github-api.ts";
import { resolveRepoFromEnv } from "./scripts/commit-api-core.ts";

/** A case-variant host whose rider/.git defeats the anchored case-lower. */
const HOSTCASE_RIDER: readonly string[] = [
  "GitHub.com#frag",
  "GitHub.com?tab=x",
  "https://GitHub.com#frag",
  "https://GitHub.com?x=1",
  "git@GitHub.com?x=1",
  "GITHUB.COM#frag",
  "GitHub.com.git",
  "https://GitHub.com.git",
  "git@GitHub.com.git",
];

describe("a case-variant host with a rider keeps the one-spelling contract", () => {
  test("orgOf answers no org for a bare case-variant host + rider", () => {
    // A bare host names no owner; the rider is not part of one either.
    expect(orgOf("GitHub.com#frag")).toBe("");
    expect(orgOf("GitHub.com?tab=x")).toBe("");
    expect(orgOf("https://GitHub.com#frag")).toBe("");
    expect(orgOf("git@GitHub.com?x=1")).toBe("");
    expect(orgOf("GITHUB.COM#frag")).toBe("");
    // The `.git`-suffixed bare host is the same bare-host shape.
    expect(orgOf("GitHub.com.git")).toBe("");
    expect(orgOf("https://GitHub.com.git")).toBe("");
    expect(orgOf("git@GitHub.com.git")).toBe("");
  });

  test("resolveRepoFromEnv answers the honest empty value", () => {
    for (const raw of HOSTCASE_RIDER) {
      expect(resolveRepoFromEnv({ GITHUB_REPO: raw })).toBe("");
    }
  });

  test("the allowlist derives no login", () => {
    for (const raw of HOSTCASE_RIDER) {
      expect([
        ...resolveAllowedOrgs(undefined, { GITHUB_REPO: raw }),
      ]).toEqual([]);
    }
  });

  test("the config dir keeps its documented no-repo fallback", () => {
    for (const raw of HOSTCASE_RIDER) {
      expect(
        resolveConfigDirName({ GITHUB_REPO: raw, INTERN_NAME: "" })
      ).toBe("intern");
    }
  });

  test("a case-variant host WITH a path still resolves (corpus guard)", () => {
    expect(orgOf("https://GitHub.com/acme/widgets?tab=readme")).toBe("acme");
    expect(resolveRepoFromEnv({ GITHUB_REPO: "https://GitHub.com/acme/widgets.git" })).toBe(
      "acme/widgets"
    );
    expect([
      ...resolveAllowedOrgs(undefined, {
        GITHUB_REPO: "https://GitHub.com/acme/widgets",
      }),
    ]).toEqual(["acme"]);
    expect(
      resolveConfigDirName({
        GITHUB_REPO: "https://GitHub.com/acme/widgets",
        INTERN_NAME: "",
      })
    ).toBe("widgets");
  });
});