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

  const run = async (
    tree: Record<string, Record<string, string> | number>,
    visibility: Record<string, string> = {},
    unreadable: ReadonlyArray<string> = [],
    limits: { readonly limited?: boolean; readonly token?: string; readonly seen?: string[] } = {},
  ): Promise<string> => {
    const server = Bun.serve({
      port: 0,
      fetch: (req) => {
        const pathname = new URL(req.url).pathname;
        const member = req.headers.get("x-github-as") === "member";
        limits.seen?.push(`${member ? "member" : "bare"} ${pathname}`);
        if (limits.limited === true && !member) {
          return Response.json(
            { message: "API rate limit exceeded for 203.0.113.7." },
            { headers: { "x-ratelimit-limit": "60", "x-ratelimit-remaining": "0" }, status: 403 },
          );
        }
        const repo = /^\/repos\/([^/]+\/[^/]+)$/u.exec(pathname)?.[1];
        if (repo !== undefined) {
          const files = tree[repo];
          if (typeof files === "number") return new Response("{}", { status: files });
          if (files === undefined) return new Response("{}", { status: 404 });
          return Response.json({ visibility: visibility[repo] ?? "public" });
        }
        const m = /^\/repos\/([^/]+\/[^/]+)\/contents\/?(.*)$/u.exec(pathname);
        const files = m === null ? undefined : tree[m[1] ?? ""];
        if (typeof files === "number") return new Response("{}", { status: files });
        if (files === undefined || m === null) return new Response("{}", { status: 404 });
        const path = decodeURIComponent(m[2] ?? "");
        const content = files[path];
        if (content !== undefined && unreadable.includes(`${m?.[1] ?? ""}:${path}`)) {
          return Response.json({ message: "API rate limit exceeded" }, { status: 403 });
        }
        if (content !== undefined) return new Response(content);
        const prefix = path === "" ? "" : `${path}/`;
        const entries = new Map<string, string>();
        for (const key of Object.keys(files)) {
          if (!key.startsWith(prefix)) continue;
          const [name, ...rest] = key.slice(prefix.length).split("/");
          if (name !== undefined) entries.set(name, rest.length === 0 ? "file" : "dir");
        }
        if (entries.size === 0) return new Response("{}", { status: 404 });
        return Response.json([...entries].map(([name, type]) => ({ name, path: prefix + name, type })));
      },
    });
    try {
      const script = block()
        .replaceAll("https://api.github.com", `http://127.0.0.1:${server.port}`)
        .replaceAll("{owner}/{repo}", "acme/widgets")
        .replaceAll("{owner}/.github", "acme/.github");
      const proc = Bun.spawn(["bash", "-c", script], { env: { ...process.env, GH_TOKEN: limits.token ?? "" }, stderr: "pipe", stdout: "pipe" });
      await proc.exited;
      return await new Response(proc.stdout).text();
    } finally {
      await server.stop(true);
    }
  };

  test("a repository with no template folder reads its owner's", async () => {
    const out = await run({ "acme/.github": { ".github/ISSUE_TEMPLATE/bug.md": "---\nname: Bug\ntitle: '[bug] '\n---\n" } });
    expect(out).toContain("===== acme/.github: .github/ISSUE_TEMPLATE/bug.md\n---\nname: Bug");
  });

  test("a repository's own folder replaces the owner's defaults", async () => {
    const out = await run({
      "acme/.github": { ".github/ISSUE_TEMPLATE/bug.md": "owner bug form\n" },
      "acme/widgets": { ".github/ISSUE_TEMPLATE/feature.yml": "name: Feature\n" },
    });
    expect(out).toContain("===== acme/widgets: .github/ISSUE_TEMPLATE/feature.yml\nname: Feature");
    expect(out).not.toContain("owner bug form");
  });

  test("no folder anywhere says so, and an unreadable one never passes for none", async () => {
    expect(await run({})).toContain("no issue templates");
    const refused = await run({ "acme/widgets": 403, "acme/.github": { ".github/ISSUE_TEMPLATE/bug.md": "owner bug form\n" } });
    expect(refused).toContain("acme/widgets: issue templates could not be read (HTTP 403)");
    expect(refused).not.toContain("owner bug form");
    expect(refused).not.toContain("no issue templates");
  });

  // gomodule/redigo keeps a single .github/ISSUE_TEMPLATE.md and no folder, and
  // GitHub's community profile names it as the repository's issue template.
  // The read checked the folder only, so it printed "no issue templates".
  test("a single legacy ISSUE_TEMPLATE.md is a template of the repository's own", async () => {
    const out = await run({
      "acme/.github": { ".github/ISSUE_TEMPLATE/bug.md": "owner bug form\n" },
      "acme/widgets": { ".github/ISSUE_TEMPLATE.md": "Ask questions elsewhere\n", ".github/CONTRIBUTING.md": "rules\n" },
    });
    expect(out).toContain("===== acme/widgets: .github/ISSUE_TEMPLATE.md\nAsk questions elsewhere");
    expect(out).not.toContain("owner bug form");
    expect(out).not.toContain("no issue templates");
  });

  test("the legacy file is found at the root or in docs/, in any case", async () => {
    expect(await run({ "acme/widgets": { "issue_template.md": "root form\n", "README.md": "x\n" } })).toContain(
      "===== acme/widgets: issue_template.md\nroot form",
    );
    expect(await run({ "acme/widgets": { "docs/Issue_Template.md": "docs form\n" } })).toContain(
      "===== acme/widgets: docs/Issue_Template.md\ndocs form",
    );
  });

  test("an owner's legacy default file is read when the repository has none", async () => {
    const out = await run({ "acme/.github": { "ISSUE_TEMPLATE.md": "owner legacy\n" }, "acme/widgets": { "README.md": "x\n" } });
    expect(out).toContain("===== acme/.github: ISSUE_TEMPLATE.md\nowner legacy");
  });

  // expressjs/discussions keeps only a front-matter-less meeting.md in its
  // .github/ISSUE_TEMPLATE/, and GitHub offers it the expressjs/.github
  // templates (GraphQL issueTemplates lists those four). The read took any
  // file in the folder as the repository's own, printed meeting.md and never
  // read the templates GitHub really shows.
  test("a folder holding no template does not replace the owner's defaults", async () => {
    const out = await run({
      "acme/.github": { ".github/ISSUE_TEMPLATE/bug.md": "---\nname: Bug\nabout: x\n---\n" },
      "acme/widgets": { ".github/ISSUE_TEMPLATE/meeting.md": "## Agenda\n" },
    });
    expect(out).toContain("===== acme/.github: .github/ISSUE_TEMPLATE/bug.md\n---\nname: Bug");
    expect(out).not.toContain("meeting.md");
  });

  test("a folder template with front matter or an issue form is still the repository's own", async () => {
    const owner = { ".github/ISSUE_TEMPLATE/bug.md": "---\nname: Owner\nabout: x\n---\n" };
    const md = await run({
      "acme/.github": owner,
      "acme/widgets": { ".github/ISSUE_TEMPLATE/notes.md": "## no front matter\n", ".github/ISSUE_TEMPLATE/Bug.MD": "---\r\nname: Own\r\n---\r\n" },
    });
    expect(md).toContain("===== acme/widgets: .github/ISSUE_TEMPLATE/Bug.MD");
    expect(md).not.toContain("notes.md");
    expect(md).not.toContain("name: Owner");
    const form = await run({ "acme/.github": owner, "acme/widgets": { ".github/ISSUE_TEMPLATE/bug.yaml": "name: Form\n" } });
    expect(form).toContain("===== acme/widgets: .github/ISSUE_TEMPLATE/bug.yaml\nname: Form");
    expect(form).not.toContain("name: Owner");
  });

  test("a folder with no template still lets a legacy file of the repository's own win", async () => {
    const out = await run({
      "acme/.github": { ".github/ISSUE_TEMPLATE/bug.md": "---\nname: Owner\n---\n" },
      "acme/widgets": { ".github/ISSUE_TEMPLATE/meeting.md": "## Agenda\n", "docs/ISSUE_TEMPLATE.md": "legacy own\n" },
    });
    expect(out).toContain("===== acme/widgets: docs/ISSUE_TEMPLATE.md\nlegacy own");
    expect(out).not.toContain("name: Owner");
  });

  // GitHub offers an owner's .github defaults only while that repository is
  // public. A credential that reaches a private or internal one (an App
  // installation on the org, or the ambient proxy's per-owner credential)
  // reads its files just the same, so the read printed templates GitHub
  // shows on no issue form.
  test("a private or internal owner .github repository offers no defaults", async () => {
    const owner = { "acme/.github": { ".github/ISSUE_TEMPLATE/bug.md": "---\nname: Secret\n---\n" }, "acme/widgets": { "README.md": "x\n" } };
    for (const vis of ["private", "internal"]) {
      const out = await run(owner, { "acme/.github": vis });
      expect(out).not.toContain("name: Secret");
      expect(out).toContain(`acme/.github is ${vis}, and GitHub uses only a public one: no issue templates`);
    }
    expect(await run(owner)).toContain("===== acme/.github: .github/ISSUE_TEMPLATE/bug.md");
  });

  // SwanHubX/SwanLab-Dashboard names all four of its templates with a space
  // (`bug report.md`), and GitHub offers all four. curl refuses a URL with a
  // raw space (exit 3, "Malformed input to a URL function"), so the read
  // dropped every one and printed "no issue templates"; a raw # cut the path
  // at a fragment and printed the 404 body as the template.
  test("a template whose file name holds a space or a # is read", async () => {
    const out = await run({
      "acme/.github": { ".github/ISSUE_TEMPLATE/bug.md": "---\nname: Owner\n---\n" },
      "acme/widgets": {
        ".github/ISSUE_TEMPLATE/bug report.md": "---\nname: Spaced\n---\n",
        ".github/ISSUE_TEMPLATE/C# issue.yml": "name: Sharp\n",
      },
    });
    expect(out).toContain("===== acme/widgets: .github/ISSUE_TEMPLATE/bug report.md\n---\nname: Spaced");
    expect(out).toContain("===== acme/widgets: .github/ISSUE_TEMPLATE/C# issue.yml\nname: Sharp");
    expect(out).not.toContain("name: Owner");
    expect(out).not.toContain("no issue templates");
  });

  test("an owner .github repository that cannot be read says its defaults are unknown", async () => {
    const out = await run({ "acme/.github": 403, "acme/widgets": { "README.md": "x\n" } });
    expect(out).toContain("acme/.github: could not be read (HTTP 403), so the owner's defaults are unknown");
    expect(out).not.toContain("no issue templates");
  });

  // A file read that fails (a rate limit, a dropped connection) is not a file
  // without front matter. The read had no -f, so the 403 body's first line
  // "{" failed the front-matter test, the repository's own template was
  // dropped, and the owner's defaults were printed as the ones GitHub offers.
  test("a template that cannot be read is never dropped for the owner's defaults", async () => {
    const out = await run(
      {
        "acme/.github": { ".github/ISSUE_TEMPLATE/bug.md": "---\nname: Owner\n---\n" },
        "acme/widgets": { ".github/ISSUE_TEMPLATE/bug.md": "---\nname: Own\n---\n" },
      },
      {},
      ["acme/widgets:.github/ISSUE_TEMPLATE/bug.md"],
    );
    expect(out).not.toContain("name: Owner");
    expect(out).not.toContain("API rate limit exceeded");
    expect(out).toContain("acme/widgets: .github/ISSUE_TEMPLATE/bug.md could not be read, so its content is unknown");
  });

  // #486: in ambient mode another owner's repository is read with no
  // credential, on the shared limit of 60 an hour. Live 2026-11-14 with that
  // limit spent, expressjs/cors and expressjs/.github answered 403 bare and
  // 200 as the member, and the read printed "issue templates could not be
  // read (HTTP 403)". It now sends a read that limit refused again as the
  // person asking, and only that one: every read still goes bare first.
  test("a read the anonymous limit refused is read again as the person asking", async () => {
    const seen: string[] = [];
    const tree = { "acme/.github": { ".github/ISSUE_TEMPLATE/bug.md": "---\nname: Bug\n---\n" }, "acme/widgets": { "README.md": "x\n" } };
    const out = await run(tree, {}, [], { limited: true, seen });
    expect(out).toContain("===== acme/.github: .github/ISSUE_TEMPLATE/bug.md\n---\nname: Bug");
    expect(out).not.toContain("could not be read");
    expect(seen[0]).toBe("bare /repos/acme/widgets/contents/.github/ISSUE_TEMPLATE");
    expect(seen.filter((line) => line.startsWith("bare"))).toHaveLength(seen.filter((line) => line.startsWith("member")).length);
  });

  test("an answer that is not the anonymous limit, or a run with a token, is never retried as the member", async () => {
    const seen: string[] = [];
    const denied = await run({ "acme/widgets": 403 }, {}, [], { seen });
    expect(denied).toContain("acme/widgets: issue templates could not be read (HTTP 403)");
    expect(seen.some((line) => line.startsWith("member"))).toBe(false);
    const tokenSeen: string[] = [];
    const withToken = await run({ "acme/widgets": { ".github/ISSUE_TEMPLATE/bug.yml": "name: B\n" } }, {}, [], { limited: true, seen: tokenSeen, token: "t" });
    expect(withToken).toContain("could not be read (HTTP 403)");
    expect(tokenSeen.some((line) => line.startsWith("member"))).toBe(false);
  });
});
