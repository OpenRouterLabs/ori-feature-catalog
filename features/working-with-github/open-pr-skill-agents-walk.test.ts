import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Regression: the open-pr skill's step 2 walks up from each directory the
// change touches to read every AGENTS.md on the way, stopping only at ".".
// `dirname` of an absolute path ends at "/", and `dirname /` is "/", so an
// absolute path ("$WT/features/x", the shape the change flow edits by) looped
// forever and the rules read hung the shell call until it was killed.

const skill = readFileSync(join(import.meta.dir, "skills/open-pr/SKILL.md"), "utf8");

const stepTwoScript = (dirs: string): string => {
  const section = skill.slice(skill.indexOf("## 2."), skill.indexOf("## 3."));
  const match = /```bash\n([\s\S]*?)\n```/u.exec(section);
  if (match?.[1] === undefined) throw new Error("step 2 has no bash block");
  return match[1].replaceAll("<dirs the change touches>", dirs);
};

const run = (wt: string, dirs: string) =>
  Bun.spawnSync(["bash", "-c", stepTwoScript(dirs)], {
    env: { ...process.env, WT: wt },
    stderr: "pipe",
    stdout: "pipe",
    timeout: 4_000,
  });

describe("open-pr step 2 reads the AGENTS.md of every touched directory's parents", () => {
  test("an absolute path under $WT ends and reads the same files as a relative one", () => {
    const wt = mkdtempSync(join(tmpdir(), "wwg-open-pr-walk-"));
    try {
      mkdirSync(join(wt, "features/x"), { recursive: true });
      writeFileSync(join(wt, "features/AGENTS.md"), "feature rules\n");
      writeFileSync(join(wt, "features/x/AGENTS.md"), "x rules\n");
      const relative = run(wt, "features/x");
      const absolute = run(wt, `"$WT/features/x"`);
      for (const proc of [relative, absolute]) {
        expect(proc.signalCode).toBeFalsy();
        const out = proc.stdout.toString();
        expect(out).toContain("===== features/x/AGENTS.md\nx rules");
        expect(out).toContain("===== features/AGENTS.md\nfeature rules");
      }
    } finally {
      rmSync(wt, { force: true, recursive: true });
    }
  });

  test("a CLAUDE.md in a touched directory or its parents is read like an AGENTS.md", () => {
    // formkit/formkit keeps each package's rules in packages/<pkg>/CLAUDE.md with
    // no AGENTS.md beside it, so a walk that looked only for AGENTS.md read none.
    const wt = mkdtempSync(join(tmpdir(), "wwg-open-pr-walk-"));
    try {
      mkdirSync(join(wt, "packages/core/src"), { recursive: true });
      writeFileSync(join(wt, "packages/core/CLAUDE.md"), "core rules\n");
      writeFileSync(join(wt, "packages/AGENTS.md"), "packages rules\n");
      writeFileSync(join(wt, "packages/CLAUDE.md"), "packages claude rules\n");
      for (const dirs of ["packages/core/src", `"$WT/packages/core/src"`]) {
        const proc = run(wt, dirs);
        expect(proc.signalCode).toBeFalsy();
        const out = proc.stdout.toString();
        expect(out).toContain("===== packages/core/CLAUDE.md\ncore rules");
        expect(out).toContain("===== packages/AGENTS.md\npackages rules");
        expect(out).toContain("===== packages/CLAUDE.md\npackages claude rules");
      }
    } finally {
      rmSync(wt, { force: true, recursive: true });
    }
  });

  test("an AGENTS.override.md or GEMINI.md in a touched directory or its parents is read too", () => {
    // Codex reads AGENTS.override.md before AGENTS.md in each directory, and
    // nafields/stratix keeps each package's rules only in one, so a walk for
    // AGENTS.md and CLAUDE.md read none of them.
    const wt = mkdtempSync(join(tmpdir(), "wwg-open-pr-walk-"));
    try {
      mkdirSync(join(wt, "Packages/Core/Sources"), { recursive: true });
      writeFileSync(join(wt, "Packages/Core/AGENTS.override.md"), "core override rules\n");
      writeFileSync(join(wt, "Packages/AGENTS.md"), "packages rules\n");
      // Gemini CLI reads GEMINI.md the same way.
      writeFileSync(join(wt, "Packages/GEMINI.md"), "packages gemini rules\n");
      for (const dirs of ["Packages/Core/Sources", `"$WT/Packages/Core/Sources"`]) {
        const proc = run(wt, dirs);
        expect(proc.signalCode).toBeFalsy();
        const out = proc.stdout.toString();
        expect(out).toContain("===== Packages/Core/AGENTS.override.md\ncore override rules");
        expect(out).toContain("===== Packages/AGENTS.md\npackages rules");
        expect(out).toContain("===== Packages/GEMINI.md\npackages gemini rules");
      }
    } finally {
      rmSync(wt, { force: true, recursive: true });
    }
  });

  test("an absolute path outside $WT still ends", () => {
    const wt = mkdtempSync(join(tmpdir(), "wwg-open-pr-walk-"));
    try {
      expect(run(wt, "/nonexistent/dir").signalCode).toBeFalsy();
    } finally {
      rmSync(wt, { force: true, recursive: true });
    }
  });
});
