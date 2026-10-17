import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import type { InstallationToken } from "@ori-monorepo/working-with-github/gh-app-token.ts";

import { GhAppError } from "@ori-monorepo/working-with-github/gh-app-token.ts";

import { parseMintArgs, runMint } from "./mint-token.ts";

interface Writers {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

/** Collect writes to the two output channels so assertions can inspect them. */
const makeWriters = (): {
  readonly out: string[];
  readonly err: string[];
  readonly writers: Writers;
} => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    writers: {
      out: (t: string): void => {
        out.push(t);
      },
      err: (t: string): void => {
        err.push(t);
      },
    },
  };
};

describe("runMint", () => {
  test("prints ONLY the token (+ newline) to stdout and exits 0 on success", async () => {
    const token: InstallationToken = {
      token: "ghs_minted",
      expiresAt: "2026-01-01T00:00:00Z",
    };
    const { out, err, writers } = makeWriters();

    const code = await Effect.runPromise(
      runMint(Effect.succeed(token), writers)
    );

    expect(code).toBe(0);
    expect(out).toEqual(["ghs_minted\n"]);
    // Nothing on stderr, and the expiry never leaks to stdout.
    expect(err).toEqual([]);
    expect(out.join("")).not.toContain("2026-01-01");
  });

  test("writes a diagnostic to stderr and exits 1 on a mint failure — no token on stdout", async () => {
    const { out, err, writers } = makeWriters();
    const failure = new GhAppError({
      op: "http",
      status: 401,
      message: "GitHub installation-token mint failed: Bad credentials",
    });

    const code = await Effect.runPromise(
      runMint(Effect.fail(failure), writers)
    );

    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err).toHaveLength(1);
    expect(err[0]).toContain("mint-token:");
    expect(err[0]).toContain("Bad credentials");
  });
});

describe("parseMintArgs", () => {
  test("no flags → empty (routes to the default app)", () => {
    expect(parseMintArgs([])).toEqual({});
  });

  test("parses --repo and --purpose", () => {
    expect(
      parseMintArgs(["--repo", "acme-corp/web", "--purpose", "reviewer"])
    ).toEqual({
      purpose: "reviewer",
      targetRepo: "acme-corp/web",
    });
  });

  test("--org is an alias for --repo", () => {
    expect(parseMintArgs(["--org", "acme-corp"])).toEqual({
      targetRepo: "acme-corp",
    });
  });

  test("ignores unknown flags and drops empty flag values", () => {
    expect(
      parseMintArgs(["--verbose", "--repo", "", "--purpose", "maintainer"])
    ).toEqual({
      purpose: "maintainer",
    });
  });

  test("treats a flag whose value was omitted as absent, not the next flag", () => {
    // `--repo --purpose reviewer` must NOT set targetRepo to "--purpose".
    expect(parseMintArgs(["--repo", "--purpose", "reviewer"])).toEqual({
      purpose: "reviewer",
    });
    // Trailing flag with no value at all → absent.
    expect(parseMintArgs(["--repo"])).toEqual({});
  });

  test("trims flag values so whitespace still matches registry rows", () => {
    expect(
      parseMintArgs([
        "--repo",
        " acme-corp/web ",
        "--purpose",
        " reviewer ",
      ])
    ).toEqual({
      purpose: "reviewer",
      targetRepo: "acme-corp/web",
    });
    // All-whitespace value → absent.
    expect(parseMintArgs(["--purpose", "   "])).toEqual({});
  });
});
