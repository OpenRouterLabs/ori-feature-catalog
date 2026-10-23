import { describe, expect, test } from "bun:test";

import { parseStatusZ } from "./commit-api-core.ts";

// Git's conflicted (unmerged) statuses are EXACTLY the seven two-letter codes
// DD, AU, UD, UA, DU, AA, UU — per `git status --porcelain` docs. Only BOTH
// columns carrying a U-class letter marks a conflict; every other pair is a
// normal staged/worktree state git will happily commit. This pins that
// contract: no false-positive "unmerged" refusal for AD/DA.

describe("parseStatusZ — unmerged detection is exactly git's 7 codes", () => {
  test("AD (index-add + worktree-delete) is a committable change, not a conflict", () => {
    // `git add f && rm f` produces `AD f` — `git commit` stages it as a
    // deleted-in-worktree add (it lands as a new file that is already gone
    // from the worktree). Pre-fix: both letters are in the UNMERGED_STATUS
    // set {D, A, U}, so the flow refused with "unmerged" and the commit
    // could not proceed.
    const out = parseStatusZ("AD f.txt\0");
    expect(out.unmerged).toEqual([]);
    // The path is absent from HEAD and from the worktree: `git add -A`
    // drops it entirely — nothing to stage, nothing to remove.
    expect(out.changed).toEqual([]);
  });

  test("a worktree-space-only D (e.g. ' D') is a normal delete, never unmerged", () => {
    const out = parseStatusZ(" D f.txt\0");
    expect(out.unmerged).toEqual([]);
    expect(out.changed).toEqual([{ path: "f.txt", deleted: true }]);
  });

  test("DA (staged delete + file re-created on disk) is a worktree add, not a drop", () => {
    // `git rm --cached f && git add -N f` produces `DA f` — the worktree copy
    // is real, so `git add -A` re-adds it; the X column's staged delete must
    // not drop a file the user has on disk.
    const out = parseStatusZ("DA f.txt\0");
    expect(out.unmerged).toEqual([]);
    expect(out.changed).toEqual([{ path: "f.txt", deleted: false }]);
  });

  test("still reports every real conflict code", () => {
    for (const xy of ["DD", "AU", "UD", "UA", "DU", "AA", "UU"]) {
      const out = parseStatusZ(`${xy} f.ts\0`);
      expect(out.unmerged).toEqual(["f.ts"]);
      expect(out.changed).toEqual([]);
    }
  });
});

describe("parseStatusZ — directory records", () => {
  test("an untracked directory holding a nested git repo (?? dir/) is kept — as `git add -A` stages it — with the trailing slash stripped", () => {
    // `git status --porcelain=v1 -z --untracked-files=all` emits `?? tools/`
    // (trailing slash) for a directory containing a nested git repo — the one
    // shape git abbreviates even under `-uall`. `git add -A` stages exactly
    // that path as a `160000` gitlink entry (verified live), so the record
    // must keep flowing to the flow's directory→gitlink branch — never read
    // as a file (that fails the whole run) and never dropped (that diverges
    // from `git add -A`, leaving the nested repo untracked after commit).
    const { changed, unmerged } = parseStatusZ("?? tools/\0");
    expect(unmerged).toEqual([]);
    expect(changed).toEqual([{ deleted: false, path: "tools" }]);
  });

  test("a directory record does not swallow sibling file records", () => {
    const { changed, unmerged } = parseStatusZ(
      " M base.txt\0?? tools/\0?? new-file.ts\0"
    );
    expect(unmerged).toEqual([]);
    // The directory record keeps its place among the siblings — slash-stripped,
    // as `git add -A` stages it (a gitlink, built by the flow's directory
    // branch) — and swallows neither the preceding nor the following record.
    expect(changed).toEqual([
      { deleted: false, path: "base.txt" },
      { deleted: false, path: "tools" },
      { deleted: false, path: "new-file.ts" },
 ]);
  });

  test("a two-field rename whose source is directory-shaped stages the target only", () => {
    // Defensive: a rename source carrying a trailing slash (not a shape
    // porcelain produces) must not stage a bogus directory delete.
    const { changed } = parseStatusZ("R  new.ts\0old-dir/\0");
    expect(changed).toEqual([{ deleted: false, path: "new.ts" }]);
  });
});
