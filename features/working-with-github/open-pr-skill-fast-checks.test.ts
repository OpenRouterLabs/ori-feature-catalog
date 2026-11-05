import { describe, expect, test } from "bun:test";
// Interns took 30+ minutes to open a PR. Two causes came from this skill:
// step 1 sent every change through a sparse partial clone, so an install or
// typecheck that needed the rest of the tree failed (missing patch files,
// hundreds of "Cannot find module" errors), and a flaky lazy fetch was retried
// instead of replaced; and step 5 let them rerun whole suites, widen test runs,
// and add baseline or "watch it fail" passes nobody asked for.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const skill = readFileSync(join(import.meta.dir, "skills/open-pr/SKILL.md"), "utf8");
const section = (from: string, to: string) => skill.slice(skill.indexOf(from), skill.indexOf(to));
const stepOne = section("## 1.", "## 2.");
const stepFive = section("## 5.", "## 6.");

describe("open-pr picks the clone by what the checks need", () => {
  test("partial for no-install changes, full shallow when an install is needed", () => {
    expect(stepOne).toContain("Pick the clone by what the checks will need, before you clone");
    expect(stepOne).toMatch(/\*\*No install needed\*\*.*Use the partial clone above/u);
    expect(stepOne).toMatch(/\*\*An install is needed\*\*.*Use a full shallow clone: the same command without `--filter=blob:none --sparse`/u);
  });

  test("a partial clone that needs more is widened once, never one directory per failure", () => {
    expect(stepOne).toContain("run `git sparse-checkout disable` once");
    expect(stepOne).toContain("Never add directories one failure at a time");
  });

  test("a failed partial fetch is replaced, not retried", () => {
    expect(stepOne).toContain("A partial fetch that fails is not retried");
    expect(stepOne).toMatch(/Switch once to a full shallow clone of the same commit, or to the tarball/u);
  });
});

describe("open-pr runs each check once, scoped to the change", () => {
  test("only the failed check reruns, and test runs stay on the related tests", () => {
    expect(stepFive).toContain("Run each check once, when the change is finished");
    expect(stepFive).toContain("After a fix, rerun only the check that failed");
    expect(stepFive).toContain("Never widen a test run past the related tests");
  });

  test("no baseline or watch-it-fail passes unless the rules ask or the failure is not in the diff", () => {
    expect(stepFive).toMatch(/No extra passes nobody asked for.*reverting the fix to watch a test fail, stashing the change to run a baseline/u);
    expect(stepFive).toContain("run that one check once on the base commit");
  });

  test("errors outside the diff send it back to the checkout, and prompt-only changes skip the build", () => {
    expect(stepFive).toContain("Errors in files you did not touch");
    expect(stepFive).toContain("A change only to prompts, docs, config or skill text needs no build");
    expect(stepFive).toContain("install only when they fail on a missing module");
  });

  test("the skill still names the time sink up top and stays generic", () => {
    expect(skill).toContain("**Running the same check again and again.**");
    expect(skill).not.toMatch(/openrouter|ORI-<n>|HIPAA/iu);
  });
});
