import { describe, expect, test } from "bun:test";
// Each shell call an agent makes starts fresh, so the $WWG the feature prompt
// resolves is gone by the time a skill's command runs. The skills' commands
// used a bare "$WWG" and never said where it comes from, so copied as written
// they ran `bun /scripts/cleanup-worktrees.ts` and died on "Module not found".
// Every script call in a skill now stops with a pointer to the resolver.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SKILLS = ["skills/cleanup-worktrees/SKILL.md", "skills/register-gh-app/SKILL.md"];

const scriptCalls = (path: string): string[] => {
  const text = readFileSync(join(import.meta.dir, path), "utf8");
  return [...text.matchAll(/```bash\n([\s\S]*?)```/gu)]
    .flatMap((fence) => (fence[1] ?? "").split("\n"))
    .filter((line) => /bun "[^"]*WWG[^"]*"\/scripts\//u.test(line));
};

const expand = (line: string, env: Record<string, string>) => {
  const word = /bun ("[^"]*WWG[^"]*")\/scripts\//u.exec(line)?.[1] ?? "";
  const child = Bun.spawnSync(["bash", "-c", `printf '%s' ${word}/scripts`], {
    env: { PATH: process.env.PATH ?? "", ...env },
    stderr: "pipe",
    stdout: "pipe",
  });
  return { code: child.exitCode, err: child.stderr.toString(), out: child.stdout.toString() };
};

describe("a skill's script call never runs bun /scripts/… with $WWG unset", () => {
  for (const path of SKILLS) {
    test(path, () => {
      const calls = scriptCalls(path);
      expect(calls.length).toBeGreaterThan(0);
      for (const line of calls) {
        const unset = expand(line, {});
        expect(unset.code).not.toBe(0);
        expect(unset.out).toBe("");
        expect(unset.err).toContain("WWG resolver");
        expect(expand(line, { WWG: "/w/wwg" }).out).toBe("/w/wwg/scripts");
      }
    });
  }
});
