import { describe, expect, test } from "bun:test";
// Step 7's ready-for-review call is GraphQL keyed only by the PR's node id.
// In ambient mode the host's proxy credentials requests per repository owner,
// and a node id names none, so the bare call went out unauthenticated and
// GitHub refused it (403/429). Under `x-github-as: member` the same call
// answers. The recipe must send the member header when there is no GH_TOKEN.
import { readFileSync } from "node:fs";
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
