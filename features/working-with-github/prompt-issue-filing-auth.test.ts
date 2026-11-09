import { describe, expect, test } from "bun:test";

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The ambient-mode filing guidance claimed "anonymous filing works on public
// repos when the host attaches no write credential". GitHub never accepts an
// unauthenticated issue create: reproduced 2026-11-03 with a bare curl on the
// anonymous 60/h bucket (x-ratelimit-limit: 60), `POST
// /repos/octocat/Hello-World/issues` answered 401 `Requires authentication`
// on a public repo. Filing only ever worked where a host proxy attached a
// write credential, so an agent told otherwise reads the 401 as a fluke of
// the target repo instead of the missing credential it is.

const prompt = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "prompt.md"),
  "utf-8"
);

const filingSection = (): string => {
  const start = prompt.indexOf("## Filing issues");
  const end = prompt.indexOf("\n## ", start + 1);
  return prompt.slice(start, end === -1 ? undefined : end).replaceAll(/\s+/gu, " ");
};

describe("the issue-filing guidance matches what GitHub accepts", () => {
  test("it never claims an unauthenticated POST can file an issue", () => {
    expect(filingSection()).not.toContain("anonymous filing works");
  });

  test("it says filing needs a credential and names the 401 GitHub answers without one", () => {
    const section = filingSection();
    expect(section).toContain("Filing always needs a credential");
    expect(section).toContain("401 `Requires authentication`");
    expect(section).toContain("even on a public repo");
  });

  test("it still says to verify with one POST and report the blockage", () => {
    const section = filingSection();
    expect(section).toContain("Verify with one POST");
    expect(section).toContain("report the blockage");
  });
});

// Regression: the filing step said to check the repository's own
// `.github/ISSUE_TEMPLATE/` only. A repository without that folder uses the
// templates in its owner's public `.github` repository (expressjs/cors has none
// and GitHub offers it expressjs/.github's), so an agent read no template and
// filed a free-form issue the owner's forms would have shaped. A folder of the
// repository's own replaces the owner's defaults, so those are read only then.
describe("the issue-template read falls back to the owner's .github repository", () => {
  const block = (): string => {
    const start = prompt.indexOf("Before creating an issue");
    const match = /```bash\n([\s\S]*?)\n```/u.exec(prompt.slice(start));
    if (match?.[1] === undefined) throw new Error("the issue-template step has no bash block");
    return match[1];
  };

  const run = async (tree: Record<string, Record<string, string> | number>): Promise<string> => {
    const server = Bun.serve({
      port: 0,
      fetch: (req) => {
        const m = /^\/repos\/([^/]+\/[^/]+)\/contents\/(.+)$/u.exec(new URL(req.url).pathname);
        const files = m === null ? undefined : tree[m[1] ?? ""];
        if (typeof files === "number") return new Response("{}", { status: files });
        if (files === undefined || m === null) return new Response("{}", { status: 404 });
        const path = decodeURIComponent(m[2] ?? "");
        if (path === ".github/ISSUE_TEMPLATE") {
          return Response.json(Object.keys(files).map((name) => ({ path: `${path}/${name}`, type: "file" })));
        }
        const content = files[path.slice(".github/ISSUE_TEMPLATE/".length)];
        return content === undefined ? new Response("{}", { status: 404 }) : new Response(content);
      },
    });
    try {
      const script = block()
        .replaceAll("https://api.github.com", `http://127.0.0.1:${server.port}`)
        .replaceAll("{owner}/{repo}", "acme/widgets")
        .replaceAll("{owner}/.github", "acme/.github");
      const proc = Bun.spawn(["bash", "-c", script], { env: { ...process.env, GH_TOKEN: "" }, stderr: "pipe", stdout: "pipe" });
      await proc.exited;
      return await new Response(proc.stdout).text();
    } finally {
      await server.stop(true);
    }
  };

  test("a repository with no template folder reads its owner's", async () => {
    const out = await run({ "acme/.github": { "bug.md": "---\nname: Bug\ntitle: '[bug] '\n---\n" } });
    expect(out).toContain("===== acme/.github: .github/ISSUE_TEMPLATE/bug.md\n---\nname: Bug");
  });

  test("a repository's own folder replaces the owner's defaults", async () => {
    const out = await run({
      "acme/.github": { "bug.md": "owner bug form\n" },
      "acme/widgets": { "feature.yml": "name: Feature\n" },
    });
    expect(out).toContain("===== acme/widgets: .github/ISSUE_TEMPLATE/feature.yml\nname: Feature");
    expect(out).not.toContain("owner bug form");
  });

  test("no folder anywhere says so, and an unreadable one never passes for none", async () => {
    expect(await run({})).toContain("no issue templates");
    const refused = await run({ "acme/widgets": 403, "acme/.github": { "bug.md": "owner bug form\n" } });
    expect(refused).toContain("acme/widgets: issue templates could not be read (HTTP 403)");
    expect(refused).not.toContain("owner bug form");
    expect(refused).not.toContain("no issue templates");
  });
});
