import { describe, expect, test } from "bun:test";
// A raw.githubusercontent.com host (#288): the host this feature's own
// ambient-mode recipes teach the operator to read raw file content from,
// so pasting one back into GITHUB_REPO is a realistic spelling. Its
// documented path scheme is `/<owner>/<repo>/<ref>/<path>` — the first two
// segments name the repo the file belongs to, the same derivability
// `repos/<owner>/<repo>` has on the api host (maintainer ruling: Option A).
// Pre-fix the host is a DIFFERENT domain from github.com, so no generic
// strip fired and each resolver answered a different dead value from the
// one spelling — the schemed form whole (every `repos/{repo}` route 404s),
// the bare form's host word as the owner (`raw.githubusercontent.com`, a
// login no installation owner can ever carry, so every mint failed closed
// with no hint the env var's spelling was the cause), the scp form
// `git@raw.githubusercontent.com:acme`. One spelling, five surfaces,
// one contract.
import { orgOf, resolveConfigDirName } from "./gh-app-registry.ts";
import { resolveAllowedOrgs } from "./gh-app-github-api.ts";
import { resolveRepoFromEnv } from "./scripts/commit-api-core.ts";

/** Every path-bearing raw-host spelling — the Option A cases. */
const RAW_FILE_SPELLINGS: readonly string[] = [
  "https://raw.githubusercontent.com/acme/widgets/main/x.ts",
  "raw.githubusercontent.com/acme/widgets/main/x.ts",
  "git@raw.githubusercontent.com:acme/widgets/main/x.ts",
  "ssh://git@raw.githubusercontent.com/acme/widgets/main/x.ts",
  "https://RAW.GitHubusercontent.com/acme/widgets/main/x.ts",
  "//raw.githubusercontent.com/acme/widgets/main/x.ts",
  // A two-segment path with no file tail is the same repo reading.
  "raw.githubusercontent.com/acme/widgets",
  "https://raw.githubusercontent.com/acme/widgets",
];

/** The degenerate forms — a bare raw host or a sub-two-segment path. */
const RAW_HOST_ONLY_SPELLINGS: readonly string[] = [
  "https://raw.githubusercontent.com",
  "raw.githubusercontent.com",
  "git@raw.githubusercontent.com",
  "raw.githubusercontent.com:22",
  "https://raw.githubusercontent.com:443",
  // One path segment names a file-less path, never an owner/repo pair.
  "raw.githubusercontent.com/acme",
  "https://raw.githubusercontent.com/acme",
  "git@raw.githubusercontent.com:acme",
];

describe("a raw.githubusercontent.com paste resolves like the file's repo (Option A, #288)", () => {
  test("resolveRepoFromEnv answers the owner/repo the file belongs to", () => {
    for (const spelling of RAW_FILE_SPELLINGS) {
      expect(resolveRepoFromEnv({ GITHUB_REPO: spelling })).toBe(
        "acme/widgets"
      );
    }
  });

  test("orgOf answers the owner", () => {
    for (const spelling of RAW_FILE_SPELLINGS) {
      expect(orgOf(spelling)).toBe("acme");
    }
  });

  test("resolveAllowedOrgs keys on the owner", () => {
    for (const spelling of RAW_FILE_SPELLINGS) {
      expect(
        Array.from(resolveAllowedOrgs(undefined, { GITHUB_REPO: spelling }))
      ).toEqual(["acme"]);
    }
  });

  test("resolveConfigDirName keys on the repo segment", () => {
    for (const spelling of RAW_FILE_SPELLINGS) {
      expect(resolveConfigDirName({ GITHUB_REPO: spelling })).toBe("widgets");
    }
  });

  test("the degenerate forms answer the honest no-owner value", () => {
    for (const spelling of RAW_HOST_ONLY_SPELLINGS) {
      expect(resolveRepoFromEnv({ GITHUB_REPO: spelling })).toBe("");
      expect(orgOf(spelling)).toBe("");
      expect(
        Array.from(resolveAllowedOrgs(undefined, { GITHUB_REPO: spelling }))
      ).toEqual([]);
      expect(resolveConfigDirName({ GITHUB_REPO: spelling })).toBe("intern");
    }
  });

  // Guards: the github.com and codeload spellings keep their answers.
  test("the sibling content hosts are unchanged", () => {
    expect(
      resolveRepoFromEnv({
        GITHUB_REPO: "https://codeload.github.com/acme/widgets/tarball/main",
      })
    ).toBe("acme/widgets");
    expect(
      resolveRepoFromEnv({ GITHUB_REPO: "https://github.com/acme/widgets" })
    ).toBe("acme/widgets");
  });
});
