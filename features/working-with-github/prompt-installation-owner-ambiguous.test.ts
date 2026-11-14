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

  // The recipes that read with curl -f print only "The requested URL returned
  // error: 403" (live 2026-11-14: expressjs/cors README.md through the
  // read-a-file recipe, with the anonymous limit spent), so neither the body
  // nor the x-ratelimit-limit header this rule tells a rate limit by ever
  // reached the agent, and the 403 read as no access. The rule now names a
  // one-call header check, run here against a server answering like GitHub.
  test("it names a header check that shows a rate limit a curl -f recipe hid", async () => {
    const after = denialRule.slice(denialRule.indexOf("A rate limit is not a denial"));
    expect(after).toContain("curl -f");
    const check = /`(curl -sS -o \/dev\/null -D - '<url>' \| grep [^`]+)`/u.exec(after)?.[1];
    expect(check).toBeDefined();
    const server = Bun.serve({
      port: 0,
      fetch: (req) =>
        new URL(req.url).pathname.startsWith("/repos/signed/")
          ? Response.json({ message: "Not Found" }, { headers: { "x-ratelimit-limit": "15000", "x-ratelimit-remaining": "14998" }, status: 404 })
          : Response.json(
              { message: "API rate limit exceeded for 203.0.113.7." },
              { headers: { "x-ratelimit-limit": "60", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1794615125", "x-other": "1" }, status: 403 },
            ),
    });
    try {
      const run = async (url: string): Promise<string> => {
        const proc = Bun.spawn(["bash", "-c", (check ?? "").replace("<url>", () => url)], { stdout: "pipe" });
        await proc.exited;
        return await new Response(proc.stdout).text();
      };
      const limited = await run(`http://127.0.0.1:${server.port}/repos/acme/widgets/contents/README.md`);
      expect(limited).toMatch(/^HTTP\/1\.1 403/mu);
      expect(limited).toContain("x-ratelimit-limit: 60");
      expect(limited).toContain("x-ratelimit-remaining: 0");
      expect(limited).not.toContain("x-other");
      const signed = await run(`http://127.0.0.1:${server.port}/repos/signed/repo/contents/x`);
      expect(signed).toContain("x-ratelimit-limit: 15000");
    } finally {
      await server.stop(true);
    }
  });
});
