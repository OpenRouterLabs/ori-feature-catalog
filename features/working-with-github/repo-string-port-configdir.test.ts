import { describe, expect, test } from "bun:test";
// Regression: an ssh URL with an explicit port — `ssh://git@github.com:22/acme/widgets`
// (a `git remote -v` copy-paste) — is a spelling every sibling resolver in this
// feature normalizes since #186 consumed the port in the host separator
// (`orgOf`, `resolveRepoFromEnv`, `resolveAllowedOrgs` all yield `acme` /
// `acme/widgets` for it). `resolveConfigDirName` — the fourth resolver, which
// keys the registry/cache DB's directory — was never given the port group, so
// its repo regexes never matched: the raw URL fell through to the bare
// pass-through and sanitized the WHOLE string into the config dir name:
//
//   GITHUB_REPO=ssh://git@github.com:22/acme/widgets → `acme`   (the OWNER!)
//   GITHUB_REPO=https://github.com/acme/widgets     → `widgets` (the repo)
//
// One repo, two documented spellings, two different config directories: the
// registry and installation-cache DB silently MIGRATES the moment the env
// var's spelling changes, orphaning every row already written — the exact
// #113 config-dir-migration class, reopened through the port spelling. The
// colon-host suite (repo-string-colonhost.test.ts) pins the same contract for
// the non-ported colon forms; this suite pins the ported corpus.
import { orgOf, resolveConfigDirName } from "./gh-app-registry.ts";

const PORTED_REPO = "ssh://git@github.com:22/acme/widgets";
const PORTED_REPO_DOT_GIT = "ssh://git@github.com:2222/acme/widgets.git";

describe("an ssh URL with an explicit port keys the config dir like every other spelling", () => {
  test("the ported ssh spelling resolves to the repo segment, not the owner or the raw URL", () => {
    expect(
      resolveConfigDirName({ GITHUB_REPO: PORTED_REPO, INTERN_NAME: "" })
    ).toBe("widgets");
    expect(
      resolveConfigDirName({
        GITHUB_REPO: PORTED_REPO_DOT_GIT,
        INTERN_NAME: "",
      })
    ).toBe("widgets");
  });

  test("every other documented spelling of the same repo resolves identically", () => {
    const dir = resolveConfigDirName({
      GITHUB_REPO: PORTED_REPO,
      INTERN_NAME: "",
    });
    for (const raw of [
      "acme/widgets",
      "acme/widgets/",
      "https://github.com/acme/widgets",
      "https://github.com/acme/widgets.git",
      "git@github.com:acme/widgets",
      "git@github.com:22:acme/widgets",
      "github.com:29418/acme/widgets",
      "https://github.com:443/acme/widgets",
    ]) {
      expect(
        resolveConfigDirName({ GITHUB_REPO: raw, INTERN_NAME: "" })
      ).toBe(dir);
    }
  });

  test("a ported ORG spelling still resolves to the org, matching orgOf", () => {
    for (const raw of [
      "ssh://git@github.com:22/acme",
      "github.com:29418/acme",
    ]) {
      expect(
        resolveConfigDirName({ GITHUB_REPO: raw, INTERN_NAME: "" })
      ).toBe("acme");
      expect(orgOf(raw)).toBe("acme");
    }
  });
});
