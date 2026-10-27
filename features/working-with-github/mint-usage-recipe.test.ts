import { describe, expect, test } from "bun:test";
// mint-token.ts's own usage header carries copy-paste shell like prompt.md's
// fences, and it is App-mode documentation the feature prompt points every
// mint at — but its two examples interpolated the RAW `$GITHUB_REPO`:
//
//     gh pr list --repo "$GITHUB_REPO"     → gh rejects a URL spelling
//     api.github.com/repos/$GITHUB_REPO    → repos/https://… is not a route
//
// — the exact literals prompt-recipes.test.ts BANNED from prompt.md (gh
// `--repo` takes bare owner/repo; the `repos/{owner}/{repo}` routes 404 on a
// URL-shaped repo), left live in the one file whose whole job is the mint.
// The README documents that every resolver in this feature tolerates URL
// spellings of `GITHUB_REPO`, so a copy-paste of either example from this
// header breaks under exactly those spellings. This suite pins the same
// contract the prompt's recipe suite pins: the examples must interpolate a
// normalized `$REPO`, never the raw env var.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "scripts", "mint-token.ts"),
  "utf-8"
);

/** The spellings every sibling resolver tolerates for `GITHUB_REPO`. */
const URL_SPELLINGS: readonly string[] = [
  "https://github.com/acme/widgets",
  "ssh://git@github.com:22/acme/widgets",
  "git@github.com:acme/widgets.git",
  // A HOST-CASE spelling — `https://GitHub.com/acme/widgets`, a copy-paste
  // whose host kept the address bar's capitalization — is the same URL
  // (hosts are case-insensitive, RFC 3986 §3.2.2), and every code resolver
  // collapses it; the header's recipe must agree with them.
  "https://GitHub.com/acme/widgets",
  "git@GitHub.com:acme/widgets",
  // A HOSTLESS deep paste collapses to its `owner/repo` tail, matching
  // `resolveRepoFromEnv` (repo-string-hostless-deep.test.ts).
  "acme/widgets/tree/main",
  // An scp/ssh USER-INFO word other than the literal `git` — a deploy-key
  // or CI remote form `git remote -v` produces — is a spelling every code
  // resolver tolerates (repo-string-userinfo.test.ts); the header's recipe
  // must collapse it the same way, never leaving the user word in `$REPO`.
  "ssh://deploy@github.com/acme/widgets",
  "bob@github.com:22/acme/widgets",
  // A LEADING-slash paste — `/acme/widgets`, and the doubled `//acme/widgets`
  // a shell autocomplete or a `//` host typo produces — is a spelling every
  // code resolver strips (`resolveRepoFromEnv` strips `/+`, pinned by
  // repo-string-leading-slash.test.ts) and the prompt's own recipe has
  // collapsed since #217 (`s#^/+##`). Pre-fix this header's recipe kept the
  // trailing single-slash strip `s#^/##` AFTER the deep-collapse rule, so a
  // doubled leading slash fell every branch and interpolated as
  // `/acme/widgets` — `gh --repo /acme/widgets` and `repos//acme/widgets`,
  // the same silent-dead-value class, in the one file whose job is the mint.
  "/acme/widgets",
  "//acme/widgets",
  "//acme/widgets/tree/main",
];

// The ORGANIZATIONS-page INDEX spellings — `github.com/orgs` with NO org
// segment after it — normalize to NOTHING, exactly like the sibling code
// resolvers (#203): the reserved host-path word is never an owner login, so
// emitting it as $REPO made every example 404 a repo named after a host
// path. An empty $REPO fails loudly instead.
const INDEX_SPELLINGS: readonly string[] = [
  "https://github.com/orgs",
  "https://github.com/organizations",
  "github.com/orgs",
  "git@github.com:organizations",
  "ssh://git@github.com:22/orgs",
  "https://github.com:443/organizations",
  "https://github.com/orgs/",
];

describe("mint-token.ts usage examples never interpolate the raw $GITHUB_REPO", () => {
  test("no example line routes the raw env var into gh --repo or a repos/ URL", () => {
    const offenders: readonly string[] = source
      .split("\n")
      .map((line) => line.trim())
      // Comments are prose, not commands — the invariant is what runs.
      .filter((line) => line.includes("$GITHUB_REPO"))
      // The one line allowed to read the raw env var is the normalization
      // definition itself, whose output every example interpolates.
      .filter((line) => !line.includes("printf '%s'"))
      .filter((line) => /--repo "|\$\{?GITHUB_REPO\}?["/]|\$\{?GITHUB_REPO\}?\}/.test(line));
    expect(offenders).toEqual([]);
  });

  test("the header's normalization recipe collapses every tolerated URL spelling", () => {
    const line = source
      .split("\n")
      .find((candidate) => candidate.includes("REPO=$(printf '%s' \"$GITHUB_REPO\""))
      // The header comment indents its examples; strip the doc margin.
      ?.replace(/^\s*\*\s?/u, "")
      ?.trim();
    expect(line).toBeDefined();
    if (line === undefined) {
      return;
    }
    for (const raw of URL_SPELLINGS) {
      const output = execFileSync(
        "bash",
        ["-c", `${line}\nprintf '%s' "$REPO"`],
        {
          encoding: "utf-8",
          env: { ...process.env, GITHUB_REPO: raw },
        }
      );
      expect(output).toBe("acme/widgets");
    }
  });

  test("the header's normalization recipe empties the orgs-page INDEX spellings", () => {
    // `github.com/orgs` with no org after it (the page that LISTS your
    // organizations) carries no owner/repo at all, and the recipe must say
    // so the same way the code resolvers do (#203): an empty $REPO, never
    // the reserved host-path word as a fake owner.
    const line = source
      .split("\n")
      .find((candidate) => candidate.includes("REPO=$(printf '%s' \"$GITHUB_REPO\""))
      // The header comment indents its examples; strip the doc margin.
      ?.replace(/^\s*\*\s?/u, "")
      ?.trim();
    expect(line).toBeDefined();
    if (line === undefined) {
      return;
    }
    for (const raw of INDEX_SPELLINGS) {
      const output = execFileSync(
        "bash",
        ["-c", `${line}\nprintf '%s' "$REPO"`],
        {
          encoding: "utf-8",
          env: { ...process.env, GITHUB_REPO: raw },
        }
      );
      expect(output).toBe("");
    }
  });

  test("the recipe empties a bare host+port spelling like the code resolvers", () => {
    // The same #190 corpus: a truncated `git remote -v` copy-paste
    // (`github.com:22`) is a BARE-HOST spelling (no owner and no repo
    // segment after the port), and the code resolvers answer "" for every
    // one of those — `orgOf`, `resolveRepoFromEnv`, `resolveAllowedOrgs`
    // and `resolveConfigDirName` all resolve `github.com:22` to no owner
    // at all (repo-string-port-barehost.test.ts pins the config-dir side,
    // repo-string-colonhost.test.ts the orgOf side), and prompt.md's own
    // recipe empties the same spelling through its final bare-host rule.
    // Pre-fix this pin carried the pre-#190 answer (`github.com`), a
    // `gh --repo` value and `repos/{repo}` route no resolver agrees with —
    // the header's recipe answered "" while the pin demanded the host
    // word, so any recipe that satisfied the pin FAILED every code
    // resolver's contract. A bare host is never an owner/repo pair.
    const line = source
      .split("\n")
      .find((candidate) => candidate.includes("REPO=$(printf '%s' \"$GITHUB_REPO\""))
      // The header comment indents its examples; strip the doc margin.
      ?.replace(/^\s*\*\s?/u, "")
      ?.trim();
    expect(line).toBeDefined();
    if (line === undefined) {
      return;
    }
    const hostPortSpellings: readonly {
      readonly normalized: string;
      readonly raw: string;
    }[] = [
      { normalized: "", raw: "github.com:22" },
      { normalized: "", raw: "git@github.com:22" },
      { normalized: "", raw: "ssh://git@github.com:22" },
      { normalized: "", raw: "https://github.com:443" },
      { normalized: "", raw: "HTTPS://GitHub.com:443" },
      { normalized: "", raw: "ssh://git@GitHub.com:22" },
    ];
    for (const { normalized, raw } of hostPortSpellings) {
      const output = execFileSync(
        "bash",
        ["-c", `${line}\nprintf '%s' "$REPO"`],
        {
          encoding: "utf-8",
          env: { ...process.env, GITHUB_REPO: raw },
        }
      );
      expect(output).toBe(normalized);
    }
  });

  test("the two examples interpolate $REPO, not the raw env var", () => {
    expect(source).toContain('gh pr list --repo "$REPO"');
    expect(source).toContain('"https://api.github.com/repos/$REPO"');
    expect(source).not.toContain('gh pr list --repo "$GITHUB_REPO"');
    expect(source).not.toContain("repos/$GITHUB_REPO");
  });
});
