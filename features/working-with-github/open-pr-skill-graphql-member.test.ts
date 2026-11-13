import { describe, expect, test } from "bun:test";
// Step 7's ready-for-review call is GraphQL keyed only by the PR's node id.
// In ambient mode the host's proxy credentials requests per repository owner,
// and a node id names none, so the bare call went out unauthenticated and
// GitHub refused it (403/429). Under `x-github-as: member` the same call
// answers. The recipe must send the member header when there is no GH_TOKEN.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const skill = readFileSync(join(import.meta.dir, "skills/open-pr/SKILL.md"), "utf8");
const stepSeven = skill.slice(skill.indexOf("## 7."), skill.indexOf("## 8."));
const recipe = stepSeven.slice(stepSeven.indexOf("```bash"), stepSeven.indexOf("```\n", stepSeven.indexOf("```bash") + 7));

describe("open-pr step 7 marks a draft ready in ambient mode too", () => {
  test("the GraphQL call carries x-github-as: member when GH_TOKEN is unset", () => {
    expect(recipe).toContain('[ -n "$GH_TOKEN" ] || AS=(-H "x-github-as: member")');
    expect(recipe).toMatch(/curl [^\n]*"\$\{AS\[@\]\}" https:\/\/api\.github\.com\/graphql/u);
  });

  test("App mode still sends only the bearer token", () => {
    expect(recipe).toContain('${GH_TOKEN:+-H "Authorization: Bearer $GH_TOKEN"}');
  });

  test("the skill says why and what a 401 means", () => {
    expect(stepSeven).toContain("has no owner in its URL");
    expect(stepSeven).toContain("A 401 on it means the person's linked identity could not make the call");
  });
});

// Copied as written, the recipe sent `pullRequestId: ""`: `$NODE_ID` was set
// nowhere in the skill or the prompt (the create recipe keeps only html_url).
// GitHub answered NOT_FOUND inside an HTTP 200, which `curl -f` passes, so the
// call exited 0 and a draft that stayed a draft read as marked ready.
describe("open-pr step 7 runs as written", () => {
  const body = recipe.slice(recipe.indexOf("\n") + 1);
  const run = (graphqlAnswer: string) => {
    const dir = mkdtempSync(join(tmpdir(), "open-pr-step7-"));
    const sent = join(dir, "sent");
    writeFileSync(
      join(dir, "curl"),
      [
        "#!/bin/bash",
        'for a in "$@"; do case "$a" in */pulls/42) echo \'{"node_id":"PR_kwTEST"}\'; exit 0;; esac; done',
        'while [ $# -gt 0 ]; do [ "$1" = -d ] && printf \'%s\' "$2" > "$SENT"; shift; done',
        "printf '%s' \"$ANSWER\"",
      ].join("\n"),
      { mode: 0o755 }
    );
    const child = Bun.spawnSync(["bash", "-c", body], {
      env: {
        ANSWER: graphqlAnswer,
        PATH: `${dir}:${process.env.PATH ?? ""}`,
        PR: "42",
        REPO: "acme/widgets",
        SENT: sent,
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    const result = {
      code: child.exitCode,
      err: child.stderr.toString(),
      out: child.stdout.toString(),
      sent: readFileSync(sent, "utf8"),
    };
    rmSync(dir, { force: true, recursive: true });
    return result;
  };

  test("the mutation carries the PR's own node id, with no NODE_ID set beforehand", () => {
    const result = run('{"data":{"markPullRequestReadyForReview":{"pullRequest":{"isDraft":false}}}}');
    expect(result.sent).toContain('pullRequestId: \\"PR_kwTEST\\"');
    expect(result.code).toBe(0);
    expect(result.out).toContain("isDraft: false");
  });

  test("a GraphQL error in a 200 answer fails the recipe and prints the message", () => {
    const result = run(
      '{"data":{"markPullRequestReadyForReview":null},"errors":[{"type":"NOT_FOUND","message":"Could not resolve to a node"}]}'
    );
    expect(result.code).toBe(1);
    expect(result.err).toContain("Could not resolve to a node");
  });
});

// Steps 7 and 8 read the PR, its check runs, its statuses and a job log over
// REST with no member header. The proxy credentials only the owners it signs
// for, so in ambient mode a read of any other repository went out anonymously
// on the shared 60-an-hour limit: with it spent (expressjs/cors PR 433, live)
// the head read answered 403, the check-runs read 422 on an empty sha, and CI
// could not be read at all, while the same reads as the member answered.
describe("open-pr steps 7 and 8 read as the member in ambient mode", () => {
  const stepEight = skill.slice(skill.indexOf("## 8."), skill.indexOf("## 9."));
  const fence = (step: string) => /```bash\n([\s\S]*?)\n```/u.exec(step)?.[1] ?? "";

  const calls = (block: string, env: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), "open-pr-reads-"));
    writeFileSync(
      join(dir, "curl"),
      [
        "#!/bin/bash",
        'printf \'%s\\n\' "$*" >> "$LOG"',
        'case "$*" in',
        '  *graphql*) echo \'{"data":{"markPullRequestReadyForReview":{"pullRequest":{"isDraft":false}}}}\' ;;',
        '  */check-runs*) echo \'{"check_runs":[]}\' ;;',
        '  */status*) echo \'{"total_count":0,"statuses":[]}\' ;;',
        '  */pulls/*) echo \'{"node_id":"PR_x","head":{"sha":"abc"}}\' ;;',
        "esac",
      ].join("\n"),
      { mode: 0o755 }
    );
    const log = join(dir, "log");
    Bun.spawnSync(["bash", "-c", block], {
      env: { ...env, JOB_ID: "7", LOG: log, PATH: `${dir}:${process.env.PATH ?? ""}`, PR: "42", REPO: "expressjs/cors" },
    });
    const lines = readFileSync(log, "utf8").trim().split("\n");
    rmSync(dir, { force: true, recursive: true });
    return lines;
  };

  test.each([
    ["step 7", stepSeven, 2],
    ["step 8", stepEight, 4],
  ] as const)("every %s call carries the member header with no GH_TOKEN", (_step, step, count) => {
    const lines = calls(fence(step), {});
    expect(lines).toHaveLength(count);
    for (const line of lines) {
      expect(line).toContain("x-github-as: member");
    }
  });

  test.each([
    ["step 7", stepSeven],
    ["step 8", stepEight],
  ] as const)("in App mode every %s call sends only the bearer token", (_step, step) => {
    for (const line of calls(fence(step), { GH_TOKEN: "ghs_test" })) {
      expect(line).toContain("Authorization: Bearer ghs_test");
      expect(line).not.toContain("x-github-as");
    }
  });
});
