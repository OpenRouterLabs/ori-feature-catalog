import { describe, expect, test } from "bun:test";
// Regression (#317): a deep github.com URL whose repo path itself contains a
// `github.com` segment-word — `https://github.com/acme/github.com/tree/main`,
// `github.com/x/github.com/y/z`, `github.com/github.com/o/r` (a repo whose
// owner or name is literally `github.com`; GitHub repo names may carry dots) —
// made the org-side resolvers and the repo-side resolvers read DIFFERENT host
// words of one spelling, the one-spelling contract the corpus pins (README:
// "every resolver in this feature tolerates the other spellings too").
//
// Measured pre-fix (all surfaces, one spelling):
//   "https://github.com/acme/github.com/tree/main"
//     orgOf = "acme"                    (FIRST host — the anchored branches)
//     resolveAllowedOrgs = {acme}       (same)
//     resolveRepoFromEnv = "tree/main"  (LAST host — the unanchored branches)
//     resolveConfigDirName = "main"     (LAST host)
//     REPO= recipe = "tree/main"        (LAST host)
//   "github.com/x/github.com/y/z"  orgOf = "x"  vs  repo = "y/z"
//   "github.com/github.com/o/r"    orgOf = "github.com"  vs  repo = "o/r"
//
// Which is right: the spelling genuinely STARTS with a scheme+host, so its
// real host is the FIRST, anchored word — the pair past it (`acme/github.com`,
// `x/github.com`, `github.com/o`) is the repo, exactly the reading the
// org-side resolvers already apply. The LAST-host reading belongs to the
// HOSTLESS class #314 pinned (`acme/github.com/widgets` → `widgets`) and must
// keep serving it. The fix anchors the repo-side pair matches to the FIRST
// host word whenever one genuinely leads the string; hostless paths keep the
// greedy LAST-host strip. This test pins BOTH sides of the split so neither
// reading can leak into the other's class.
import { orgOf, resolveConfigDirName } from "./gh-app-registry.ts";
import { resolveAllowedOrgs } from "./gh-app-github-api.ts";
import { resolveRepoFromEnv } from "./scripts/commit-api-core.ts";

/** Hosted deep pastes whose repo path carries a `github.com` segment — the
 *  pair past the FIRST, anchored host word is the repo. */
const HOSTED_MIDSTRING: readonly {
  readonly dir: string;
  readonly org: string;
  readonly raw: string;
  readonly repo: string;
}[] = [
  {
    dir: "github.com",
    org: "acme",
    raw: "https://github.com/acme/github.com/tree/main",
    repo: "acme/github.com",
  },
  {
    dir: "github.com",
    org: "x",
    raw: "github.com/x/github.com/y/z",
    repo: "x/github.com",
  },
  {
    dir: "o",
    org: "github.com",
    raw: "github.com/github.com/o/r",
    repo: "github.com/o",
  },
];

/** The HOSTLESS class #314 pinned — the LAST-host reading must survive the
 *  anchored fix unchanged, or the fix re-breaks the class it exists beside. */
const HOSTLESS_MIDSTRING: readonly {
  readonly dir: string;
  readonly org: string;
  readonly raw: string;
  readonly repo: string;
}[] = [
  { dir: "widgets", org: "widgets", raw: "acme/github.com/widgets", repo: "widgets" },
  { dir: "z", org: "y", raw: "x/github.com/y/z", repo: "y/z" },
  { dir: "tail", org: "tail", raw: "owner/repo/github.com/tail", repo: "tail" },
  { dir: "widgets", org: "widgets", raw: "acme/api.github.com/widgets", repo: "widgets" },
];

describe("a hosted github.com URL with a github.com path segment resolves on one spelling contract in every resolver", () => {
  test("resolveRepoFromEnv answers the pair past the FIRST, anchored host word", () => {
    for (const { raw, repo } of HOSTED_MIDSTRING) {
      expect(resolveRepoFromEnv({ GITHUB_REPO: raw })).toBe(repo);
    }
  });

  test("orgOf and resolveAllowedOrgs key on the owner of that same pair", () => {
    for (const { org, raw } of HOSTED_MIDSTRING) {
      expect(orgOf(raw)).toBe(org);
      expect(
        Array.from(resolveAllowedOrgs(undefined, { GITHUB_REPO: raw }))
      ).toEqual([org]);
    }
  });

  test("resolveConfigDirName keys on the repo segment of that same pair", () => {
    for (const { dir, raw } of HOSTED_MIDSTRING) {
      expect(resolveConfigDirName({ GITHUB_REPO: raw })).toBe(dir);
    }
  });

  test("the hostless mid-string class keeps its pinned LAST-host answers", () => {
    for (const { dir, org, raw, repo } of HOSTLESS_MIDSTRING) {
      expect(resolveRepoFromEnv({ GITHUB_REPO: raw })).toBe(repo);
      expect(orgOf(raw)).toBe(org);
      expect(
        Array.from(resolveAllowedOrgs(undefined, { GITHUB_REPO: raw }))
      ).toEqual([org]);
      expect(resolveConfigDirName({ GITHUB_REPO: raw })).toBe(dir);
    }
  });

  test("every previously-healthy spelling keeps its pinned answer (corpus guard)", () => {
    for (const [spelling, repo, cfg] of [
      ["acme/widgets", "acme/widgets", "widgets"],
      ["https://github.com/acme/widgets", "acme/widgets", "widgets"],
      ["github.com/acme/widgets", "acme/widgets", "widgets"],
      ["git@github.com:acme/widgets", "acme/widgets", "widgets"],
      ["https://github.com/o/r/tree/main", "o/r", "r"],
      ["https://github.com/orgs/acme", "acme", "acme"],
      ["https://github.com/orgs", "", "intern"],
      ["https://github.com", "", "intern"],
      ["github.com:22", "", "intern"],
      ["ssh://git@github.com:22/o/r/tree/main", "o/r", "r"],
      ["https://www.github.com/acme/widgets", "acme/widgets", "widgets"],
    ] as const) {
      expect(resolveRepoFromEnv({ GITHUB_REPO: spelling })).toBe(repo);
      expect(resolveConfigDirName({ GITHUB_REPO: spelling })).toBe(cfg);
    }
  });
});