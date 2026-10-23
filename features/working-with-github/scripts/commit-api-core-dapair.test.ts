import { describe, expect, test } from "bun:test";

import { parseStatusZ } from "./commit-api-core.ts";

// `git rm --cached <path>` (or a staged `git rm` with the file re-created on
// disk — e.g. by a formatter running post-rm) emits TWO records for the same
// path: `D  <path>` (index deleted vs HEAD) and `?? <path>` (untracked
// worktree copy). `git add -A` stages exactly ONE entry — the new blob; the
// deletion and the re-add collapse in the index. parseStatusZ must match: the
// last record for a path wins, and the pair never reaches the Git-Data tree
// as a duplicate-path array (one entry per path is the tree contract; a
// duplicate-path array is 422-able undefined behavior).
//
// Porcelain record order is git's own: staged (index vs HEAD) records are
// enumerated before untracked ones, so the `??` re-add is always LAST.

describe("parseStatusZ — a staged delete + untracked re-create pair for one path", () => {
  test("collapses to ONE entry — the re-add — matching `git add -A`'s index", () => {
    // Real porcelain from `git rm --cached f2 && echo y > f2` (verified live):
    // "D  f2\0?? f2\0". git add -A stages exactly 100644 <new-blob> f2.
    const out = parseStatusZ("D  f2\0?? f2\0");
    expect(out.unmerged).toEqual([]);
    expect(out.changed).toEqual([{ path: "f2", deleted: false }]);
  });

  test("a staged rename keeps both of its real paths", () => {
    // `git mv f.ts old.ts`: porcelain "R  old.ts\0f.ts\0" — the destination
    // as the record, the source as the second field. git add -A stages
    // old.ts→blob (rename destination) and deletes f.ts (the source).
    const out = parseStatusZ("R  old.ts\0f.ts\0");
    expect(out.changed).toEqual([
      { path: "f.ts", deleted: true },
      { path: "old.ts", deleted: false },
    ]);
  });

  test("an unrelated path between the pair keeps every distinct path", () => {
    const out = parseStatusZ("D  f2\0 M other.ts\0?? f2\0");
    // Map insertion order: f2 keyed first (D), other.ts second; the ?? f2
    // record overwrites f2's value in place, keeping its original position.
    expect(out.changed).toEqual([
      { path: "f2", deleted: false },
      { path: "other.ts", deleted: false },
    ]);
  });

  test("a lone staged delete without a worktree re-add stays a delete", () => {
    // `git rm --cached f2` WITHOUT re-creating: single `D  f2` record —
    // the deletion must survive (the path is gone from both index and tree).
    const out = parseStatusZ("D  f2\0");
    expect(out.changed).toEqual([{ path: "f2", deleted: true }]);
  });

  test("an intent-to-add pair ( A + ?? for the same path cannot occur; single add stands", () => {
    // `git add -N f` emits ` A f` — one record. The collapse never
    // manufactures an entry that was not staged.
    const out = parseStatusZ("?? f.ts\0A  f.ts\0");
    // git cannot emit both for one path (add -N records ` A`, not `??`);
    // defensive: last record still wins.
    expect(out.changed).toEqual([{ path: "f.ts", deleted: false }]);
  });

  test("a deleted worktree pair ( D index-add + worktree-delete) is unaffected", () => {
    const out = parseStatusZ("AD f.ts\0");
    expect(out.changed).toEqual([]);
    expect(out.unmerged).toEqual([]);
  });
});
