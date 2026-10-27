import { describe, expect, test } from "bun:test";
// Regression: an UNKNOWN `--`-flag on the mint CLI silently vanished, and
// its value token vanished with it — `mint-token.ts --repo acme/x
// --porpose reviewer` (a typo of `--purpose`) parsed clean and minted for
// the org-level CATCH-ALL App instead of the `reviewer` App the caller
// asked for, with exit 0 and no diagnostic: the exact silent-identity-swap
// class the repeated-flag, missing-value and single-dash guards close for
// every OTHER argv shape (the #98/#117 class, reopened through the typo).
// The known flags are exactly `--repo`, `--org`, `--purpose`; any other
// `--`-prefixed token is a usage error, named, never silently dropped.
import { parseMintArgs } from "./scripts/mint-token.ts";

describe("the mint CLI rejects an unknown --flag", () => {
  test("a typo'd --porpose that eats its value is a usage error, not a silent default-purpose mint", () => {
    expect(
      parseMintArgs(["--repo", "acme/x", "--porpose", "reviewer"])
    ).toEqual({ junkArgv: "--porpose" });
  });

  test("an unknown flag without a value is refused too, and the real flags keep parsing when none is present", () => {
    expect(parseMintArgs(["--verbose"])).toEqual({ junkArgv: "--verbose" });
    expect(parseMintArgs(["--repo", "acme/x", "--purpose", "reviewer"])).toEqual(
      { targetRepo: "acme/x", purpose: "reviewer" }
    );
    expect(parseMintArgs([])).toEqual({});
  });
});
