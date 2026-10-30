import { describe, expect, test } from "bun:test";
// A LEADING slash in front of a github.com host — `//github.com/o/r`
// (a protocol-relative URL, the browser-address-bar form that lost its
// scheme) or `/github.com/o/r` (a shell-autocomplete paste) — is the same
// URL as `github.com/o/r`, and the interior-slash collapse already turns
// its leading `//` into the single slash the leading-slash strips remove.
// But every HOST-KEYED strip in the four resolvers is `^`-ANCHORED, so a
// leading slash DEFEATS each one exactly the way a rider or padding does:
//
//   - the SUBDOMAIN strip (`www.github.com`, `gist.github.com`) keys on
//     `^(scheme)?(user@)?sub.github.com` — a `//www.github.com` paste
//     falls it, the label survives, and `orgOf("//www.github.com")`
//     answers `www.github.com` (a registry key no mint can ever derive)
//     while the rider-less form answers the healthy `""`;
//   - the CASE-LOWER keys on the same `^` anchor, so `//GitHub.com/o/r`
//     keeps its case, falls every case-paired `github.com` branch, and
//     `resolveRepoFromEnv` answers `GitHub.com/acme` — a repo every
//     `repos/{repo}` route 404s on — while its slash-less form answers
//     the healthy pair (the one-spelling contract, reopened through the
//     leading slash);
//   - `resolveAllowedOrgs`'s api-host strip is anchored the same way, so a
//     leading-slash api.github.com paste misses the strip and the
//     UNANCHORED repo regex reads `repos` as the OWNER: the allowlist
//     carries `repos` (verified live: `orgs/repos` 404s), and every mint
//     fails closed with no hint the spelling was the cause — while
//     `orgOf`/`resolveRepoFromEnv` answer the healthy `acme` for the same
//     spelling, so the four resolvers silently disagree.
//
// The class is the exact mirror of the LEADING-slash fix the resolvers
// already applied to `/acme/widgets` (a hostless paste): there the fix
// strips the slash AFTER the collapse and BEFORE the anchored branches.
// Here the slash sits in front of the HOST word, so the fix is the same
// order — strip leading slashes-and-whitespace BEFORE any host-keyed
// strip fires. One spelling, four resolvers, one contract.

import { orgOf, resolveConfigDirName } from "./gh-app-registry.ts";
import { resolveAllowedOrgs } from "./gh-app-github-api.ts";
import { resolveRepoFromEnv } from "./scripts/commit-api-core.ts";

describe("a leading slash before the host word (protocol-relative / autocomplete paste)", () => {
  // Class A: case-variant host behind a leading slash — the case-lower is
  // ^-anchored, so the host keeps its case and every case-paired branch
  // falls. Its slash-less form answers the healthy pair.
  test("a case-variant host behind a leading slash resolves like its slash-less form", () => {
    expect(resolveRepoFromEnv({ GITHUB_REPO: "//GitHub.com/acme/widgets" })).toBe(
      resolveRepoFromEnv({ GITHUB_REPO: "GitHub.com/acme/widgets" })
    );
    expect(resolveRepoFromEnv({ GITHUB_REPO: "/GitHub.com/acme/widgets" })).toBe(
      "acme/widgets"
    );
    expect(orgOf("//GitHub.com/acme/widgets")).toBe("acme");
  });

  // Class A2: a bare SUBDOMAIN host behind a leading slash — the subdomain
  // strip is ^-anchored, so the label survives and the host word flows on
  // whole as the "org"/"repo". Its rider-less form answers ""/"".
  test("a bare subdomain host behind a leading slash answers the no-owner value", () => {
    expect(resolveRepoFromEnv({ GITHUB_REPO: "//www.github.com" })).toBe("");
    expect(orgOf("//www.github.com")).toBe("");
    expect(orgOf("/gist.github.com")).toBe("");
    expect(
      Array.from(resolveAllowedOrgs(undefined, { GITHUB_REPO: "//www.github.com" }))
    ).toEqual([]);
  });

  test("a subdomain host with a path behind a leading slash keeps its pair", () => {
    expect(resolveRepoFromEnv({ GITHUB_REPO: "//www.github.com/acme/widgets" })).toBe(
      "acme/widgets"
    );
    expect(orgOf("/gist.github.com/acme/widgets")).toBe("acme");
  });

  // Class B: the api host behind a leading slash — the api strip is
  // ^-anchored, the strip misses, and the allowlist's UNANCHORED repo regex
  // reads the REST host-path word `repos` as the owner. The healthy form
  // answers the real owner.
  test("an api.github.com paste behind a leading slash keys the allowlist on the owner", () => {
    expect(
      Array.from(
        resolveAllowedOrgs(undefined, {
          GITHUB_REPO: "//api.github.com/repos/acme/widgets",
        })
      )
    ).toEqual(
      Array.from(
        resolveAllowedOrgs(undefined, {
          GITHUB_REPO: "api.github.com/repos/acme/widgets",
        })
      )
    );
    expect(
      Array.from(
        resolveAllowedOrgs(undefined, {
          GITHUB_REPO: "/api.github.com/repos/acme/widgets/contents/x.ts",
        })
      )
    ).toEqual(["acme"]);
  });

  // Guards: the slash-less and lowercase forms stay byte-identical, and a
  // leading slash on a HOSTLESS pair keeps its fixed behavior.
  test("the slash-less forms are unchanged", () => {
    expect(resolveRepoFromEnv({ GITHUB_REPO: "www.github.com" })).toBe("");
    expect(orgOf("GitHub.com/acme/widgets")).toBe("acme");
    expect(orgOf("/acme/widgets")).toBe("acme");
    expect(resolveRepoFromEnv({ GITHUB_REPO: "/acme/widgets" })).toBe(
      "acme/widgets"
    );
  });
});
