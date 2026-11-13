import { describe, expect, test } from "bun:test";

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The ambient-mode repo-discovery bullet sends the agent to
 * `/installation/repositories` first and to `/orgs/{org}/repos` "for each org
 * the connection can read" — with no way to learn that org list other than
 * the installation listing itself. On a host whose credential reaches several
 * GitHub accounts that listing cannot speak for all of them, and answers
 * (reproduced live, 2026-11-01):
 *
 *   401 {"error":"VAULT_GITHUB_OWNER_AMBIGUOUS",
 *        "github_owners":"openrouterincubator, openrouterinterns, ..."}
 *
 * while `/orgs/<each owner>/repos` answers 200. Pre-fix the prompt's own rule
 * ("If ambient requests are denied (401/403/404 …), that is the answer: this
 * workspace's credential does not reach that repo") read that 401 as "no
 * access", so "which repos can you see?" was answered "none". The bullet now
 * names the 401 and turns its `github_owners` into the per-owner crawl.
 */
const prompt = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "prompt.md"),
  "utf-8"
);

const discoveryBullet =
  prompt
    .split("\n")
    .find((line) => line.includes("To find every repository this connection can read")) ?? "";

describe("the repo-discovery bullet handles a multi-owner installation 401", () => {
  test("the bullet exists", () => {
    expect(discoveryBullet).not.toBe("");
  });

  test("it names the owner-ambiguous 401 and where the owners are listed", () => {
    expect(discoveryBullet).toContain("VAULT_GITHUB_OWNER_AMBIGUOUS");
    expect(discoveryBullet).toContain("github_owners");
    expect(discoveryBullet).toContain("not a denial");
  });

  // The Link header of an org (or user) repo listing names the account by id
  // (`/organizations/139423088/repos?page=2`), which carries no owner, so a
  // per-owner proxy sends it out bare and GitHub lists only public repos.
  // Reproduced 2026-11-12 on OpenRouterTeam: page 2 through the Link URL came
  // back empty, and 70 repositories (63 private) on the `/orgs/{org}` path.
  test("it pages on the owner path, never through the Link header's id URL", () => {
    expect(discoveryBullet).not.toContain("(follow `Link` headers on pagination)");
    expect(discoveryBullet).toContain("/orgs/{org}/repos?type=all&per_page=100&page=N");
    expect(discoveryBullet).toContain("never by opening the `Link` header");
  });

  test("it turns that list into the per-owner crawl", () => {
    const after = discoveryBullet.slice(discoveryBullet.indexOf("github_owners"));
    expect(after).toContain("/orgs/{owner}/repos?type=all");
    expect(after).toContain("/users/{owner}/repos");
  });
});

// The same rule read a rate limit as a denial. For an owner the proxy holds no
// credential for, a read goes out anonymously on the shared 60/h limit, and
// with that spent GitHub answers 403 "API rate limit exceeded" (expressjs/.github,
// live 2026-11-13), while the same read under x-github-as: member answers 200.
// Pre-fix the agent told the person the repository was out of reach.
const denialRule =
  prompt.split("\n").find((line) => line.startsWith("If ambient requests are denied")) ?? "";

describe("the ambient denial rule never reads a rate limit as no access", () => {
  test("it names the rate-limit answer and how to recognize it", () => {
    expect(denialRule).toContain("A rate limit is not a denial");
    expect(denialRule).toContain("API rate limit exceeded");
    expect(denialRule).toContain("x-ratelimit-limit");
  });

  test("it retries as the member and otherwise reports the reset time", () => {
    const after = denialRule.slice(denialRule.indexOf("A rate limit is not a denial"));
    expect(after).toContain("x-github-as: member");
    expect(after).toContain("x-ratelimit-reset");
    expect(after).toContain("never that the repository is out of reach");
  });
});
