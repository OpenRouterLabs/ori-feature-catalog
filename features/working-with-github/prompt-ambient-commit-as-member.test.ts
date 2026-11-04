import { describe, expect, test } from "bun:test";
// #377 made `commit-via-api.ts --as member` commit in ambient mode, but the
// ambient guidance still said the scripts are not needed there, and the
// open-pr skill still sent ambient commits to "the REST API": the hand-written
// blob/tree/commit/ref calls #377 exists to replace.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path: string) => readFileSync(join(import.meta.dir, path), "utf8");
const prompt = read("prompt.md");
const skill = read("skills/open-pr/SKILL.md");
const ambientIntro = prompt.slice(prompt.indexOf("In ambient mode"), prompt.indexOf("## Access mode 1"));

describe("ambient mode commits with commit-via-api --as member", () => {
  test("the prompt's ambient note names --as member, not 'the scripts are not needed'", () => {
    expect(ambientIntro).not.toContain("the scripts are not needed");
    expect(ambientIntro).toContain("`commit-via-api.ts` still works with `--as member`");
  });

  test("the open-pr skill never sends an ambient commit to hand-written REST calls", () => {
    expect(skill).not.toContain("or the REST API in ambient mode");
    expect(skill).toContain("adding `--as member` in ambient mode");
    expect(skill).toContain("(`commit-via-api.ts`, with `--as member` in ambient mode)");
  });
});
