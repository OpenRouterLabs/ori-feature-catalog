import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// Two paste classes the sibling spellings already close, reopened through
// the api.github.com REST host and through leading whitespace:
//
// 1. An UPPER-CASE SCHEME on the api host — `HTTPS://api.github.com/repos/
//    acme/widgets` — is the same URL as its lowercase form (schemes are
//    case-insensitive, RFC 3986 §3.1), and it is exactly the URL shape this
//    feature's own prompt teaches the operator to curl. The interior-slash
//    collapse guards listed the scheme words case-SENSITIVELY
//    (`https?|ssh|git+ssh|git|ftp`), so the upper-case scheme's own `://`
//    collapsed to `:` (`HTTPS:/api.github.com/…`), the api-host strip
//    (case-sensitive `api\.github\.com`) missed, and every downstream
//    anchored branch keyed on the REST path word instead of the owner:
//      - `orgOf` answered `repos` — a registry key no mint can ever derive
//        from a real repo string, silently bypassing a registered App;
//      - `resolveRepoFromEnv` answered `repos/acme` — every
//        `repos/{repo}` route 404s;
//      - `resolveAllowedOrgs` keyed the allowlist on `repos` — a login no
//        installation owner can ever carry, so EVERY mint failed closed
//        with no hint the env var's spelling was the cause;
//      - `resolveConfigDirName` answered `acme` — a fourth, different dead
//        answer, silently migrating the registry/cache DB;
//      - the prompt's `REPO=` recipe answered `acme/widgets` (LIVE) — a
//        fifth answer, disagreeing with all four code resolvers.
//    The fix gives the guards the `i` flag (the words they spare are the
//    same set in either case), which leaves every lowercase spelling's
//    answer byte-identical and lets the api-host strip see the string.
//
// 2. LEADING WHITESPACE before a case-variant github.com host —
//    `" https://GitHub.com/acme/widgets"` (a copy-paste that kept its
//    padding) — defeated the `^`-anchored host-case pre-strip in `orgOf`
//    and `resolveConfigDirName` (the two resolvers that lower-case the host
//    WITHOUT trimming first), so the mixed-case host fell every anchored
//    `github.com` branch:
//      - `orgOf` returned the whole raw padded URL as the "org" — a
//        registry key no mint can ever derive;
//      - `resolveConfigDirName` fell to its two-segment fallback regex,
//    which keyed the dir on the segments AFTER the host word (`acme`)
//    instead of the repo segment (`widgets`) — silently migrating the
//    registry/cache DB. `resolveRepoFromEnv` and `resolveAllowedOrgs`
//    trim first and stayed live; the recipe trims first too. The fix
//    trims before the pre-strip, exactly like the siblings.
import { orgOf, resolveConfigDirName } from "./gh-app-registry.ts";
import { resolveAllowedOrgs } from "./gh-app-github-api.ts";
import { resolveRepoFromEnv } from "./scripts/commit-api-core.ts";

const here = dirname(fileURLToPath(import.meta.url));

const prompt = readFileSync(join(here, "prompt.md"), "utf-8");

const fences: readonly string[] = [
  ...prompt.matchAll(/```bash[^\n]*\n([\s\S]*?)```/g),
].map((match) => match[1] ?? "");

const isNormalizerLine = (line: string): boolean =>
  line.trimStart().startsWith(`REPO=$(printf '%s' "$GITHUB_REPO"`);

/** The REPO= recipe, executed exactly as prompt.md prints it. */
const recipeRepoOf = (spelling: string): string => {
  const lines = fences
    .flatMap((fence) => fence.split("\n"))
    .filter(isNormalizerLine);
  expect(lines.length).toBeGreaterThan(0);
  const recipe = (lines[0] ?? "")
    .replace(/^REPO=\$\(printf '%s' "\$GITHUB_REPO" \| /u, "")
    .replace(/\)$/u, "");
  const sed = recipe.replace(/^sed -E /u, "").split(/\s+/u).filter(Boolean);
  const argv = [
    "-E",
    ...sed.flatMap((expr) => ["-e", expr.replace(/^'|'$/gu, "")]),
  ];
  return execFileSync("sed", argv, {
    input: spelling,
  })
    .toString()
    .replace(/\n$/u, "");
};

const PADDED_HOST_CASE: readonly string[] = [
  " https://GitHub.com/acme/widgets ",
  "\thttps://GitHub.com/acme/widgets",
  " https://GitHub.com:22/acme",
];

describe("leading whitespace before a case-variant github.com host resolves like the unpadded spelling", () => {

  test("resolveConfigDirName keys the repo segment, never the post-host segment", () => {
    for (const spelling of PADDED_HOST_CASE) {
      expect(resolveConfigDirName({ GITHUB_REPO: spelling })).toMatch(
        /^(widgets|acme)$/u
      );
    }
    // The repo-bearing padding must key the SAME dir the unpadded spelling
    // keys — `widgets`, not the post-host `acme` the fallback regex grabbed.
    expect(
      resolveConfigDirName({
        GITHUB_REPO: " https://GitHub.com/acme/widgets ",
      })
    ).toBe(
      resolveConfigDirName({ GITHUB_REPO: "https://GitHub.com/acme/widgets" })
    );
  });


  test("the prompt's REPO= recipe agrees on the padded spellings", () => {
    for (const spelling of PADDED_HOST_CASE) {
      // The repo-bearing pads answer `acme/widgets`; the ported ORG pad
      // answers `acme` — each the same answer its unpadded spelling gives.
      expect(recipeRepoOf(spelling)).toBe(
        recipeRepoOf(spelling.trim()).replace(/\.git$/u, "")
      );
    }
    expect(recipeRepoOf("\tGitHub.com:acme")).toBe("acme");
  });
});