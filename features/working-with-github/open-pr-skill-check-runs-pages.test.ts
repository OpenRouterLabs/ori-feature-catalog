import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Regression: step 8 read one page of check runs (per_page=100) and called
// that the head's CI. A large repository's head carries hundreds of runs (a
// pytorch head: 631, its two failures on pages 4 and 5), so page one showed
// no failure at all and the agent reported CI clean while it was red.

const skill = readFileSync(join(import.meta.dir, "skills/open-pr/SKILL.md"), "utf8");
const stepEight = skill.slice(skill.indexOf("## 8."), skill.indexOf("## 9."));
const block = /```bash\n([\s\S]*?)\n```/u.exec(stepEight)?.[1] ?? "";
const checkRuns = block.slice(block.indexOf("# Every page"), block.indexOf("# Commit statuses"));

const run = (pages: readonly unknown[][], failPage?: number) => {
  const dir = mkdtempSync(join(tmpdir(), "wwg-open-pr-pages-"));
  try {
    pages.forEach((runs, index) => writeFileSync(join(dir, `page-${index + 1}.json`), JSON.stringify({ check_runs: runs, total_count: 0 })));
    writeFileSync(
      join(dir, "curl"),
      `#!/bin/bash\nfor a in "$@"; do case "$a" in *check-runs*) url="$a";; esac; done\np=$(printf '%s' "$url" | sed -E 's/.*[?&]page=([0-9]+).*/\\1/')\nprintf '%s\\n' "$p" >> "${dir}/asked"\n[ "$p" = "${failPage ?? 0}" ] && exit 22\nf="${dir}/page-$p.json"; [ -f "$f" ] && cat "$f" || echo '{"check_runs":[]}'\n`
    );
    chmodSync(join(dir, "curl"), 0o755);
    const proc = Bun.spawnSync(["bash", "-c", checkRuns], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, REPO: "o/r", SHA: "abc" },
      stderr: "pipe",
      stdout: "pipe",
      timeout: 20_000,
    });
    let asked = "";
    try { asked = readFileSync(join(dir, "asked"), "utf8"); } catch { asked = ""; }
    return { asked: asked.trim().split("\n").filter(Boolean), out: proc.stdout.toString() };
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
};

const runs = (n: number, from: number, conclusion = "success") =>
  Array.from({ length: n }, (_, i) => ({ conclusion, details_url: "u", id: from + i, name: `job-${from + i}` }));

describe("open-pr step 8 reads every page of check runs", () => {
  test("a failure past the first 100 runs is printed", () => {
    expect(checkRuns).toContain("check-runs?per_page=100");
    const { asked, out } = run([runs(100, 1), runs(100, 101), runs(30, 201).concat(runs(1, 999, "failure"))]);
    expect(asked).toEqual(["1", "2", "3"]);
    expect(out).toContain("failure 999 job-999 u");
    expect(out.trim().split("\n")).toHaveLength(231);
  });

  test("a short first page is the whole list and asks nothing more", () => {
    const { asked, out } = run([runs(3, 1)]);
    expect(asked).toEqual(["1"]);
    expect(out.trim().split("\n")).toHaveLength(3);
  });

  test("exactly 100 runs asks one more page and stops on the empty one", () => {
    const { asked, out } = run([runs(100, 1)]);
    expect(asked).toEqual(["1", "2"]);
    expect(out.trim().split("\n")).toHaveLength(100);
  });

  test("a page that cannot be read says the list is incomplete", () => {
    const { out } = run([runs(100, 1), runs(100, 101)], 2);
    expect(out).toContain("check-runs page 2 could not be read: the list above is incomplete");
  });
});
