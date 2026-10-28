import { describe, expect, test } from "bun:test";
import { resolveConfigDirName } from "./gh-app-registry.ts";

describe("resolveConfigDirName keys the users-page index like the orgs index", () => {
  test("hosted users index falls to the documented intern fallback", () => {
    expect(resolveConfigDirName({ GITHUB_REPO: "https://github.com/users" })).toBe("intern");
  });
  test("bare-host users index (no scheme) matches", () => {
    expect(resolveConfigDirName({ GITHUB_REPO: "github.com/users" })).toBe("intern");
  });
  test("scp host-word users index matches", () => {
    expect(resolveConfigDirName({ GITHUB_REPO: "git@github.com:users" })).toBe("intern");
  });
  test("colon host-word users index matches", () => {
    expect(resolveConfigDirName({ GITHUB_REPO: "github.com:users" })).toBe("intern");
  });
  test("ported users index matches", () => {
    expect(resolveConfigDirName({ GITHUB_REPO: "ssh://git@github.com:22/users" })).toBe("intern");
  });
  test("a real user page still resolves its owner", () => {
    expect(resolveConfigDirName({ GITHUB_REPO: "https://github.com/users/acme" })).toBe("acme");
  });
  test("the orgs index spellings keep their documented answer", () => {
    expect(resolveConfigDirName({ GITHUB_REPO: "https://github.com/orgs" })).toBe("intern");
    expect(resolveConfigDirName({ GITHUB_REPO: "https://github.com/organizations" })).toBe("intern");
  });
});
