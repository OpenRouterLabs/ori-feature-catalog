import { describe, expect, test } from "bun:test";
// Regression: a bare host+PORT spelling (`ssh://git@github.com:22`,
// `https://github.com:443` — a truncated `git remote -v` copy-paste) leaked
// its PORT DIGITS into `resolveConfigDirName`: the host-word strip's port
// group is optional with a REQUIRED `[/:]` after it, so a spelling that
// ENDS at the port made that `[/:]` consume the colon INSIDE the port, the
// strip removed everything up to it, and the surviving digits (`22`) became
// the config dir — while the same env var spelled without the port
// (`ssh://git@github.com`) resolved to the sanitized host word. One env var,
// two spellings, two config directories: the registry/cache DB silently
// migrated the moment the spelling changed, orphaning every row already
// written (#113's class, reopened through the bare ported spelling — the
// same #186/#190 port-digits class `orgOf`, `resolveRepoFromEnv` and
// `resolveAllowedOrgs` already close). This suite pins the parity the
// README promises ("every resolver in this feature tolerates the other
// spellings too") for the config-dir resolver.
import { orgOf, resolveConfigDirName } from "./gh-app-registry.ts";

const BARE_HOST_PORT: readonly string[] = [
  "ssh://git@github.com:22",
  "ssh://git@github.com:2222",
  "https://github.com:443",
];

describe("a bare host+port spelling never keys the config dir on the port digits", () => {
  test("the ported spelling resolves to the same dir as its portless sibling", () => {
    for (const raw of BARE_HOST_PORT) {
      const portless = raw.replace(/:\d+$/u, "");
      expect(resolveConfigDirName({ GITHUB_REPO: raw, INTERN_NAME: "" })).toBe(
        resolveConfigDirName({ GITHUB_REPO: portless, INTERN_NAME: "" })
      );
    }
  });

  test("no port digits ever reach the dir name", () => {
    for (const raw of BARE_HOST_PORT) {
      const digits = /:(\d+)$/u.exec(raw)?.[1] ?? "";
      expect(
        resolveConfigDirName({ GITHUB_REPO: raw, INTERN_NAME: "" })
      ).not.toContain(digits);
    }
  });

  test("orgOf already resolved the spelling to the host word (the parity anchor)", () => {
    for (const raw of BARE_HOST_PORT) {
      expect(orgOf(raw)).toBe(orgOf(raw.replace(/:\d+$/u, "")));
    }
  });

  test("a ported spelling WITH a path segment keeps resolving to its repo", () => {
    expect(
      resolveConfigDirName({
        GITHUB_REPO: "ssh://git@github.com:22/acme/widgets",
        INTERN_NAME: "",
      })
    ).toBe("widgets");
    expect(
      resolveConfigDirName({
        GITHUB_REPO: "https://github.com:443/acme/widgets",
        INTERN_NAME: "",
      })
    ).toBe("widgets");
  });
});
