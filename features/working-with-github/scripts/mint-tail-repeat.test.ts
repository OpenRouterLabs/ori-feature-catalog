import { describe, expect, test } from "bun:test";

import { parseMintArgs } from "./mint-token.ts";

// A TRUNCATED-PASTE repeat — the SAME flag spelling passed more than once
// with its LAST occurrence carrying no usable value (`--repo acme/a
// --repo` — a paste the shell cut mid-flag) — is the same usage error the
// repeated-flag guard closes for a double-valued repeat, in every CLI.
// Pre-fix the usable-value count saw ONE usable value, so the shape sailed
// through as a single-target parse and the tail occurrence silently
// vanished: the CLI minted for the FIRST `--repo` with exit 0 while
// cleanup-worktrees, register-gh-app and commit-via-api all refused the
// same pasted shape — the four-CLI uniformity contract the repeated-flag
// suite pins ("a repeated value-taking flag is a usage error in every
// CLI, naming the flag — never a silent winner").
describe("a truncated-paste repeat whose tail occurrence lost its value", () => {
  test("mint-token: a valueless tail --repo repeat is refused, never a silent first-wins", () => {
    // Pre-fix: {"targetRepo":"acme/a"} — the truncated tail silently
    // dropped, the CLI minted for the first repo with exit 0.
    expect(parseMintArgs(["--repo", "acme/a", "--repo"])).toEqual({
      repeatedFlag: "--repo",
    });
    // A following flag does not rescue the truncated tail.
    expect(
      parseMintArgs(["--repo", "acme/a", "--repo", "--purpose", "reviewer"])
    ).toEqual({
      repeatedFlag: "--repo",
    });
  });

  test("mint-token: a valueless tail --org repeat (the alias) is refused under the canonical name", () => {
    expect(parseMintArgs(["--org", "acme-a", "--org"])).toEqual({
      repeatedFlag: "--repo",
    });
  });

  test("mint-token: a valueless tail --purpose repeat is refused", () => {
    expect(
      parseMintArgs(["--repo", "acme/a", "--purpose", "reviewer", "--purpose"])
    ).toEqual({
      repeatedFlag: "--purpose",
    });
  });

  test("mint-token: the single-target shapes keep their pinned diagnoses", () => {
    // The #221 shapes: a FIRST occurrence whose slot was eaten and a usable
    // value at the tail stays the missing-value error, never a false repeat.
    expect(parseMintArgs(["--repo", "--repo", "acme/a"])).toEqual({
      missingRepoValue: true,
    });
    // The alias pair, each spelling passed exactly once, stays one target.
    expect(parseMintArgs(["--repo", "--org", "acme/x"])).toEqual({
      targetRepo: "acme/x",
    });
    // The trailing valueless --org after a usable --repo, once each.
    expect(parseMintArgs(["--repo", "acme/a", "--org"])).toEqual({
      targetRepo: "acme/a",
    });
    // An unrepeated parse is unchanged.
    expect(
      parseMintArgs(["--repo", "acme/a", "--purpose", "reviewer"])
    ).toEqual({
      purpose: "reviewer",
      targetRepo: "acme/a",
    });
  });
});