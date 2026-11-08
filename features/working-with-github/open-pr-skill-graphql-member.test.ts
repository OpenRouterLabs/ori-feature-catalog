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
