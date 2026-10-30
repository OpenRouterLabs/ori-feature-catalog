import { describe, expect, test } from "bun:test";
// A raw.githubusercontent.com paste carrying an EXPLICIT PORT —
// `https://raw.githubusercontent.com:443/acme/widgets/main/x.ts` (also the
// bare-host form, any port, and the case-variant/user-info/leading-slash
// spellings) — is the same file URL the unported form already resolves
// (#288, Option A), with the port the #186/#190/#276 class said must never
// become an owner segment. The port strip that closes that class for every
// OTHER host keys on the literal `github.com` host word — which
// raw.githubusercontent.com does not contain — so the raw host's own strip
// (whose test regex DOES accept the `:` separator) consumed the host and
// left the PORT DIGITS as the first path segment: pre-fix every code
// resolver keyed the port as the owner,
//
//   - `resolveRepoFromEnv` → "443/acme" (a fake owner/repo pair; `443` is a
//     port number, never a login — `repos/443/acme` 404s);
//   - `orgOf` → "443" (a registry key no mint can ever derive, silently
//     bypassing a registered App);
//   - `resolveAllowedOrgs` → {"443"} (a login no installation owner can ever
//     carry, so EVERY mint failed closed with no hint the env var's
//     spelling was the cause);
//   - `resolveConfigDirName` → "acme" (a fourth answer — the repo segment
//     past the fake owner, silently migrating the registry/cache DB),
//
// while the prompt's `REPO=` sed recipe — its raw-host rules carry
// `(:[0-9]+)?` on every branch — answered the healthy `acme/widgets`. One
// spelling, five surfaces, five answers: the one-spelling contract the
// README states, reopened through the raw host's port. The degenerate
// ported forms (a bare `raw.githubusercontent.com:443` with no path) were
// already pinned healthy; the PATH-bearing ported forms are the gap.
import { orgOf, resolveConfigDirName } from "./gh-app-registry.ts";
import { resolveAllowedOrgs } from "./gh-app-github-api.ts";
import { resolveRepoFromEnv } from "./scripts/commit-api-core.ts";

/** Every path-bearing raw-host spelling carrying an explicit port. */
const RAW_PORTED_FILE_SPELLINGS: readonly string[] = [
  "https://raw.githubusercontent.com:443/acme/widgets/main/x.ts",
  "raw.githubusercontent.com:443/acme/widgets/main/x.ts",
  "raw.githubusercontent.com:80/acme/widgets/main/x.ts",
  "https://raw.githubusercontent.com:22/acme/widgets",
  "raw.githubusercontent.com:22/acme/widgets",
  // The case-variant host with a port — the same combination the github.com
  // strips tolerate (#276's corpus).
  "https://RAW.githubusercontent.com:443/acme/widgets/main/x.ts",
  // The user-info and leading-slash spellings the raw strips tolerate.
  "ssh://git@raw.githubusercontent.com:443/acme/widgets/main/x.ts",
  "//raw.githubusercontent.com:443/acme/widgets/main/x.ts",
];

describe("a ported raw.githubusercontent.com file paste resolves like its unported form", () => {
  test("resolveRepoFromEnv answers the owner/repo the file belongs to", () => {
    for (const spelling of RAW_PORTED_FILE_SPELLINGS) {
      expect(resolveRepoFromEnv({ GITHUB_REPO: spelling })).toBe(
        "acme/widgets"
      );
    }
  });

  test("orgOf answers the owner, never the port digits", () => {
    for (const spelling of RAW_PORTED_FILE_SPELLINGS) {
      expect(orgOf(spelling)).toBe("acme");
    }
  });

  test("resolveAllowedOrgs keys the allowlist on the owner, so mints do not fail closed", () => {
    for (const spelling of RAW_PORTED_FILE_SPELLINGS) {
      expect(
        Array.from(resolveAllowedOrgs(undefined, { GITHUB_REPO: spelling }))
      ).toEqual(["acme"]);
    }
  });

  test("resolveConfigDirName keys the repo segment, like every other spelling", () => {
    for (const spelling of RAW_PORTED_FILE_SPELLINGS) {
      expect(resolveConfigDirName({ GITHUB_REPO: spelling })).toBe("widgets");
    }
  });

  test("the unported spellings keep their pinned healthy answers", () => {
    expect(
      resolveRepoFromEnv({
        GITHUB_REPO: "https://raw.githubusercontent.com/acme/widgets/main/x.ts",
      })
    ).toBe("acme/widgets");
    expect(orgOf("raw.githubusercontent.com/acme/widgets/main/x.ts")).toBe(
      "acme"
    );
    // The degenerate ported forms (no path) keep the honest no-owner answer.
    expect(
      resolveRepoFromEnv({ GITHUB_REPO: "raw.githubusercontent.com:443" })
    ).toBe("");
    expect(orgOf("https://raw.githubusercontent.com:443")).toBe("");
  });
});
