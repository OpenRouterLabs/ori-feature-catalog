import { describe, expect, test } from "bun:test";
// Regression (#249): a `GITHUB_REPO` spelling that carries a LEADING SLASH and
// then WHITESPACE — `"/ acme/widgets"`, `"/\tacme/widgets"` (a shell-autocomplete
// paste that kept its padding) — strips the slash in every resolver but never
// re-trims, so the space survives at the head of every answer:
//
//   resolveRepoFromEnv({ GITHUB_REPO: "/ acme/widgets" })  // " acme/widgets"
//   orgOf("/ acme/widgets")                                // " acme"
//
// A GitHub login never contains a space, so `" acme"` is a dead registry key: a
// registered `(acme, purpose)` App row is silently bypassed (the mint falls back
// to the default App) when `GITHUB_REPO` carries this paste, and every
// `repos/{repo}` route 404s on `" acme/widgets"` — while `resolveAllowedOrgs`
// and `resolveConfigDirName` trim and key on the healthy `acme`, so the four
// resolvers disagree on one spelling (the README's one-spelling contract).
//
// Root cause: the leading-slash strip (`replace(/^\/+/u, "")`) runs AFTER the
// trim, and nothing trims again — the slash removal can expose leading
// whitespace the first trim never saw. The same class reaches the resolvers
// through ANY slash the host-strip step leaves before the whitespace (e.g.
// `https://github.com/ acme/widgets` — the trim cannot see the interior space
// either). The strip and the trim are one step now in `orgOf`,
// `resolveRepoFromEnv`, and the resolvers agree.

import { orgOf, resolveConfigDirName } from "./gh-app-registry.ts";
import { resolveRepoFromEnv } from "./scripts/commit-api-core.ts";
import { resolveAllowedOrgs } from "./gh-app-github-api.ts";

const PADDED_PASTE_SPELLINGS: string[] = [
  "/ acme/widgets",
  "/\tacme/widgets",
  "// acme/widgets",
  "/  acme/widgets",
  "/ acme",
];

describe("a slash-then-space paste trims with the slash, in every resolver", () => {
  test("orgOf re-trims after the leading-slash strip", () => {
    expect(orgOf("/ acme/widgets")).toBe("acme");
    expect(orgOf("/\tacme/widgets")).toBe("acme");
  });

  test("resolveRepoFromEnv re-trims after the leading-slash strip", () => {
    expect(resolveRepoFromEnv({ GITHUB_REPO: "/ acme/widgets" })).toBe(
      "acme/widgets"
    );
    expect(resolveRepoFromEnv({ GITHUB_REPO: "/\tacme/widgets" })).toBe(
      "acme/widgets"
    );
  });

  test.each(PADDED_PASTE_SPELLINGS)(
    "every padded paste spelling keeps the resolvers on one contract (%s)",
    (spelling: string) => {
      // The resolvers that answer an ORG must agree on `acme`.
      expect(orgOf(spelling)).toBe("acme");
      expect([...resolveAllowedOrgs(undefined, { GITHUB_REPO: spelling })]).toEqual([
        "acme",
      ]);
      // The repo resolver answers the repo tail; the config dir keys on the
      // repo segment — all four spell `acme`-keyed answers, no dead `" acme"`.
      expect(resolveRepoFromEnv({ GITHUB_REPO: spelling })).toBe(
        spelling.includes("acme/widgets") ? "acme/widgets" : "acme"
      );
      expect(resolveConfigDirName({ GITHUB_REPO: spelling })).toBe(
        spelling.includes("acme/widgets") ? "widgets" : "acme"
      );
    }
  );

  test("the prompt's REPO= recipe agrees with the resolvers", () => {
    // The recipe's normalization must produce the same value the resolvers
    // answer for the same spelling — `s#^/+##` alone leaves the space (the
    // prompt.md corpus pins this same contract for the other paste classes).
    // The prompt's own corpus (prompt-recipes.test.ts) carries the class once
    // the recipe lands its re-trim; this test pins the code side.
    expect(resolveRepoFromEnv({ GITHUB_REPO: "/ acme/widgets" })).toBe(
      "acme/widgets"
    );
  });
});