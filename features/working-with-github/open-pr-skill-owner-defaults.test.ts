import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Regression: a repository with no PR template or CONTRIBUTING of its own gets
// the ones in its owner's public `.github` repository: GitHub fills the PR form
// from that default template. Step 2 read only the repository's own tree, so on
// expressjs/cors (no template; expressjs/.github ships a PULL_REQUEST_TEMPLATE.md
// and a CONTRIBUTING.md) it printed no template at all, and step 6 fell back to
// "## Summary / ## Why / ## Test plan" in place of the form the owner requires.

const skill = readFileSync(join(import.meta.dir, "skills/open-pr/SKILL.md"), "utf8");
const section = skill.slice(skill.indexOf("## 2."), skill.indexOf("## 3."));
const block = /```bash\n([\s\S]*?)\n```/u.exec(section)?.[1] ?? "";
const fallback = block.slice(block.indexOf("# No PR template"));

const git = (args: string[], cwd: string) => {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stderr: "pipe", stdout: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
};

const repo = (dir: string, files: Record<string, string>) => {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  git(["init", "-q", "-b", "main"], dir);
  git(["add", "-A"], dir);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], dir);
  git(["config", "uploadpack.allowFilter", "true"], dir);
};

// The owner's `.github` repository is served from a local bare path: git's
// url.<base>.insteadOf rewrites the https://github.com/<owner>/.github.git
// URL the block clones, and a local server answers the visibility read, so
// the test never touches the network.
const run = async (
  own: Record<string, string>,
  owner: Record<string, string> | undefined,
  visibility: string | number = "public",
  cloneFails = false,
) => {
  const root = mkdtempSync(join(tmpdir(), "wwg-open-pr-owner-"));
  const server = Bun.serve({
    port: 0,
    fetch: (req) => {
      if (new URL(req.url).pathname !== "/repos/acme/.github" || owner === undefined) return new Response("{}", { status: 404 });
      if (typeof visibility === "number") return new Response("{}", { status: visibility });
      return Response.json({ visibility });
    },
  });
  try {
    const wt = join(root, "wt");
    repo(wt, { "src/a.ts": "export {};\n", ...own });
    const gitConfig = join(root, "gitconfig");
    if (owner !== undefined && !cloneFails) {
      repo(join(root, "owner"), owner);
      writeFileSync(gitConfig, `[url "file://${join(root, "owner")}"]\n\tinsteadOf = https://github.com/acme/.github.git\n`);
    } else {
      writeFileSync(gitConfig, `[url "file://${join(root, "missing")}"]\n\tinsteadOf = https://github.com/acme/.github.git\n`);
    }
    const proc = Bun.spawn(["bash", "-c", fallback.replaceAll("https://api.github.com", `http://127.0.0.1:${server.port}`)], {
      cwd: wt,
      env: { ...process.env, GH_TOKEN: "", GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: "1", REPO: "acme/widgets", WT: wt },
      stderr: "pipe",
      stdout: "pipe",
      timeout: 20_000,
    });
    const out = await new Response(proc.stdout).text();
    return { code: await proc.exited, out };
  } finally {
    await server.stop(true);
    rmSync(root, { force: true, recursive: true });
  }
};

describe("open-pr step 2 reads the owner's default PR template and CONTRIBUTING", () => {
  test("a repo with neither prints both from the owner's .github repository", async () => {
    const { out } = await run({}, {
      ".github/PULL_REQUEST_TEMPLATE.md": "## Certificate of Origin",
      "CONTRIBUTING.md": "sign off every commit",
      "profile/README.md": "not a rules file\n",
    });
    expect(out).toContain("===== acme/.github: .github/PULL_REQUEST_TEMPLATE.md\n## Certificate of Origin\n");
    expect(out).toContain("===== acme/.github: CONTRIBUTING.md\nsign off every commit\n");
    expect(out).not.toContain("not a rules file");
  });

  test("a repo's own template wins and the default one is never printed", async () => {
    const { out } = await run({ "docs/pull_request_template.md": "## Own\n" }, {
      ".github/pull_request_template.md": "## Default\n",
      "CONTRIBUTING.md": "default contributing\n",
    });
    expect(out).not.toContain("## Default");
    expect(out).toContain("===== acme/.github: CONTRIBUTING.md\ndefault contributing");
  });

  test("a repo with both of its own never clones the owner's repository", async () => {
    const { out } = await run({ ".github/pull_request_template.md": "## Own\n", "CONTRIBUTING.md": "own\n" }, {
      ".github/pull_request_template.md": "## Default\n",
    });
    expect(out).toBe("");
  });

  test("a template directory in the owner's repository is printed file by file", async () => {
    const { out } = await run({}, {
      ".github/PULL_REQUEST_TEMPLATE/bug.md": "## Bug\n",
      ".github/PULL_REQUEST_TEMPLATE/feature.md": "## Feature\n",
    });
    expect(out).toContain("===== acme/.github: .github/PULL_REQUEST_TEMPLATE/bug.md\n## Bug");
    expect(out).toContain("===== acme/.github: .github/PULL_REQUEST_TEMPLATE/feature.md\n## Feature");
  });

  test("an owner with no .github repository prints nothing and the block still succeeds", async () => {
    const { code, out } = await run({}, undefined);
    expect(out).toBe("");
    expect(code).toBe(0);
  });

  // GitHub fills the PR form from an owner's .github defaults only while that
  // repository is public. The block cloned it with no visibility check, and a
  // clone through a credential that reaches a private or internal one (an App
  // installation, or a proxy that signs git for the owner) printed a template
  // GitHub shows on no PR form.
  test("a private or internal owner repository offers no defaults", async () => {
    const owner = { ".github/pull_request_template.md": "## Secret\n" };
    for (const vis of ["private", "internal"]) {
      const { code, out } = await run({}, owner, vis);
      expect(out).not.toContain("## Secret");
      expect(out).toContain(`acme/.github is ${vis}, and GitHub uses only a public one`);
      expect(code).toBe(0);
    }
  });

  test("a visibility read that fails says the defaults are unknown", async () => {
    const { out } = await run({}, { "CONTRIBUTING.md": "default\n" }, 403);
    expect(out).toContain("acme/.github could not be read (HTTP 403): its default PR template and CONTRIBUTING are unknown");
    expect(out).not.toContain("default\n");
  });

  // The API said public, then the clone failed (an HTTP 429 or a dropped
  // connection, common on a git clone from this host). Pre-fix the block broke
  // out silently, printing nothing, the same output as an owner with no
  // defaults, so step 6 fell back to its own headings over the owner's form.
  test("a clone that fails after the visibility read says the defaults are unknown", async () => {
    const { code, out } = await run({}, { ".github/pull_request_template.md": "## Default\n" }, "public", true);
    expect(out).toContain("acme/.github could not be cloned: its default PR template and CONTRIBUTING are unknown");
    expect(code).toBe(0);
  });
});

describe("open-pr step 2 reads the owner's visibility as the member in ambient mode", () => {
  const runAs = async (token: string) => {
    const root = mkdtempSync(join(tmpdir(), "wwg-open-pr-owner-as-"));
    const seen: { auth: string | null; member: string | null }[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: (req) => {
        seen.push({ auth: req.headers.get("authorization"), member: req.headers.get("x-github-as") });
        if (req.headers.get("x-github-as") !== "member" && req.headers.get("authorization") === null) {
          return Response.json({ message: "API rate limit exceeded" }, { status: 403 });
        }
        return Response.json({ visibility: "public" });
      },
    });
    try {
      const wt = join(root, "wt");
      repo(wt, { "src/a.ts": "export {};\n" });
      repo(join(root, "owner"), { ".github/pull_request_template.md": "## Owner template\n" });
      const gitConfig = join(root, "gitconfig");
      writeFileSync(gitConfig, `[url "file://${join(root, "owner")}"]\n\tinsteadOf = https://github.com/acme/.github.git\n`);
      const proc = Bun.spawn(["bash", "-c", fallback.replaceAll("https://api.github.com", `http://127.0.0.1:${server.port}`)], {
        cwd: wt,
        env: { ...process.env, GH_TOKEN: token, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: "1", REPO: "acme/widgets", WT: wt },
        stderr: "pipe",
        stdout: "pipe",
        timeout: 20_000,
      });
      const out = await new Response(proc.stdout).text();
      return { code: await proc.exited, out, seen };
    } finally {
      await server.stop(true);
      rmSync(root, { force: true, recursive: true });
    }
  };

  test("with no GH_TOKEN the read carries x-github-as: member and the default template prints", async () => {
    const { code, out, seen } = await runAs("");
    expect(code).toBe(0);
    expect(seen).toEqual([{ auth: null, member: "member" }]);
    expect(out).toContain("## Owner template");
    expect(out).not.toContain("could not be read");
  });

  test("with GH_TOKEN the read sends only the bearer token", async () => {
    const { out, seen } = await runAs("ghs_test");
    expect(seen).toEqual([{ auth: "Bearer ghs_test", member: null }]);
    expect(out).toContain("## Owner template");
  });
});
