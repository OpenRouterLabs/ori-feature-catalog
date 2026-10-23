import { describe, expect, test } from "bun:test";

import { parseStatusZ } from "./commit-api-core.ts";

// The `-z` records below are the exact byte shapes `git status
// --porcelain=v1 -z --untracked-files=all` emits (NUL-delimited, no quoting) —
// produced live with git 2.47 to pin the real contract, not a guess.

describe("parseStatusZ — two-field records", () => {
  test("a rename stages old-path delete + new-path add (unchanged)", () => {
    const out = parseStatusZ("R  new.ts\0old.ts\0");
    expect(out.changed).toEqual([
      { path: "old.ts", deleted: true },
      { path: "new.ts", deleted: false },
    ]);
    expect(out.unmerged).toEqual([]);
  });

  test("a COPY consumes its source field — the source is intact, so nothing is staged for it", () => {
    // Pre-fix: `C  dst.ts\0src.ts\0` staged a bogus add at path ".ts" (the
    // `src.ts` field misparsed as a `XY␠path` record) and the commit then failed
    // reading `<worktree>/.ts`, or committed a garbage entry.
    const out = parseStatusZ("C  dst.ts\0src.ts\0");
    expect(out.changed).toEqual([{ path: "dst.ts", deleted: false }]);
    expect(out.unmerged).toEqual([]);
  });

  test("a mixed rename + copy + modify status parses every record correctly", () => {
    const out = parseStatusZ(
      "R  new-name.ts\0old-name.ts\0C  dst.ts\0src.ts\0M  mod.ts\0"
    );
    expect(out.changed).toEqual([
      { path: "old-name.ts", deleted: true },
      { path: "new-name.ts", deleted: false },
      { path: "dst.ts", deleted: false },
      { path: "mod.ts", deleted: false },
    ]);
    expect(out.unmerged).toEqual([]);
  });

  test("back-to-back renames keep their field pairing", () => {
    const out = parseStatusZ("R  a\0b\0R  c\0d\0");
    expect(out.changed).toEqual([
      { path: "b", deleted: true },
      { path: "a", deleted: false },
      { path: "d", deleted: true },
      { path: "c", deleted: false },
    ]);
  });

  test("a rename whose source field is empty/absent stages only the new path", () => {
    expect(parseStatusZ("R  new.ts\0").changed).toEqual([
      { path: "new.ts", deleted: false },
    ]);
  });

  test("an RD record (renamed in the index, deleted from the worktree) stages destination delete + source delete", () => {
    // Live shape (git 2.47): `git mv a.txt b.txt && rm b.txt` emits
    // `RD b.txt\0a.txt\0`. Pre-fix: the destination was staged as an ADD, so
    // the blob read failed on the deleted file and the whole run died;
    // `git add -A` stages both deletions.
    const out = parseStatusZ("RD b.txt\0a.txt\0");
    expect(out.unmerged).toEqual([]);
    expect(out.changed).toEqual([
      { path: "a.txt", deleted: true },
      { path: "b.txt", deleted: true },
    ]);
  });
});

describe("parseStatusZ — unmerged (conflicted) records", () => {
  test("a UU record is reported as unmerged, never staged", () => {
    // `git commit` refuses a conflicted path; the Git-Data flow must refuse the
    // same way rather than silently committing the conflict markers.
    const out = parseStatusZ("UU conflict.ts\0");
    expect(out.changed).toEqual([]);
    expect(out.unmerged).toEqual(["conflict.ts"]);
  });

  test("every U-class pair (DD/AU/UD/UA/DU/AA/UU) is unmerged", () => {
    for (const xy of ["DD", "AU", "UD", "UA", "DU", "AA", "UU"]) {
      const out = parseStatusZ(`${xy} f.ts\0`);
      expect(out.unmerged).toEqual(["f.ts"]);
      expect(out.changed).toEqual([]);
    }
  });

  test("a plain add is neither unmerged nor misrouted", () => {
    const out = parseStatusZ("A  f.ts\0");
    expect(out.changed).toEqual([{ path: "f.ts", deleted: false }]);
    expect(out.unmerged).toEqual([]);
  });

  test("a modify whose x is 'A' (index-add + worktree-mod) is a normal change, not a conflict", () => {
    // `AM` — added to the index, then modified again. Only BOTH-columns U-class
    // letters mark a conflict; a single 'A'/'M' pair is a normal record.
    const out = parseStatusZ("AM f.ts\0");
    expect(out.changed).toEqual([{ path: "f.ts", deleted: false }]);
    expect(out.unmerged).toEqual([]);
  });

  test("unmerged and normal records are partitioned, not interleaved", () => {
    const out = parseStatusZ("UU bad.ts\0M  good.ts\0");
    expect(out.unmerged).toEqual(["bad.ts"]);
    expect(out.changed).toEqual([{ path: "good.ts", deleted: false }]);
  });
});
