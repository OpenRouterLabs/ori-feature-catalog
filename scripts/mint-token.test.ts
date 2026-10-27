import { describe, expect, test } from "bun:test";
// A throwaway RSA key generated at test time (never a real one), so the JWT
// signing path runs for real without embedding any secret.
import { generateKeyPairSync } from "node:crypto";

import { Effect } from "effect";

import type { InstallationToken } from "@ori-monorepo/working-with-github/gh-app-token.ts";

import { GhAppError } from "@ori-monorepo/working-with-github/gh-app-token.ts";

import { parseMintArgs, resolveMintDeps, runMint } from "./mint-token.ts";
import { mintInstallationToken } from "@ori-monorepo/working-with-github/gh-app-token-mint.ts";

interface Writers {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const TEST_PEM_B64 = Buffer.from(
  privateKey.export({
    format: "pem",
    type: "pkcs1",
  })
).toString("base64");

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

  test("an unknown --flag is a usage error; an empty --repo value is never a silent drop", () => {
    expect(
      parseMintArgs(["--verbose", "--repo", "", "--purpose", "maintainer"])
    ).toEqual({
      junkArgv: "--verbose",
    });
    expect(
      parseMintArgs(["--repo", "", "--purpose", "maintainer"])
    ).toEqual({
      missingRepoValue: true,
      purpose: "maintainer",
    });
  });

  test("treats a flag whose value was omitted as absent, not the next flag", () => {
    // `--repo --purpose reviewer` must NOT set targetRepo to "--purpose".
    expect(parseMintArgs(["--repo", "--purpose", "reviewer"])).toEqual({
      missingRepoValue: true,
      purpose: "reviewer",
    });
    // Trailing flag with no value at all → a usage error (see the
    // explicitly-passed-with-no-value test below).
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
    // All-whitespace value → absent, which for an explicitly-passed
    // --purpose is the missing-value usage error (see the dedicated test).
    expect(parseMintArgs(["--purpose", "   "])).toEqual({
      missingPurposeValue: true,
    });
  });

  test("an explicitly-passed --purpose with no value is a usage error, not a silent default mint", () => {
    // The same class #98 closed for --repo/--org, for the third value-taking
    // flag: `--purpose` with no usable value must never fall through to a
    // bare-default mint (a silent identity swap — the caller asked for a
    // role App's token). Both the trailing-flag shape and the
    // value-slot-eaten-by-the-next-flag shape (`--purpose --repo acme/x`)
    // land here.
    expect(parseMintArgs(["--purpose"])).toEqual({
      missingPurposeValue: true,
    });
    expect(parseMintArgs(["--purpose", "--repo", "acme/x"])).toEqual({
      missingPurposeValue: true,
    });
    // An all-whitespace value is absent, not a purpose — same usage error.
    expect(parseMintArgs(["--purpose", "   "])).toEqual({
      missingPurposeValue: true,
    });
  });

  test("an explicitly-passed --repo with no value is a usage error, not a silent default mint", () => {
    // `--repo` trailing with no value must not silently mint the default
    // App: the caller asked for a token routed to a target org, and the
    // default App's token cannot see that target's repos — every later call
    // 404s with no hint why. Same for `--org`, and for a value slot eaten by
    // the next flag.
    expect(parseMintArgs(["--repo"])).toEqual({ missingRepoValue: true });
    expect(parseMintArgs(["--org"])).toEqual({ missingRepoValue: true });
    expect(parseMintArgs(["--repo", "--purpose", "reviewer"])).toEqual({
      missingRepoValue: true,
      purpose: "reviewer",
    });
    // An all-whitespace value is the same usage error as no value.
    expect(parseMintArgs(["--repo", "   "])).toEqual({
      missingRepoValue: true,
    });
  });
});

describe("resolveMintDeps (the --purpose-without-a-repo case)", () => {
  test("a purpose with no --repo targets the GITHUB_REPO org", () => {
    // The "distinct role in your own org" case the feature prompt documents:
    // the org is implied by GITHUB_REPO when no --repo/--org is given, so the
    // registered (own-org, purpose) App is actually consulted.
    expect(
      resolveMintDeps({ purpose: "reviewer" }, { GITHUB_REPO: "acme/widgets" })
    ).toEqual({ purpose: "reviewer", targetRepo: "acme/widgets" });
  });

  test("an explicit --repo is passed through unchanged", () => {
    expect(
      resolveMintDeps(
        { purpose: "reviewer", targetRepo: "other-org/r" },
        { GITHUB_REPO: "acme/widgets" }
      )
    ).toEqual({ purpose: "reviewer", targetRepo: "other-org/r" });
  });

  test("a bare mint (no purpose) is passed through unchanged", () => {
    expect(resolveMintDeps({}, { GITHUB_REPO: "acme/widgets" })).toEqual({});
  });

  test("a purpose with no derivable org is null — the CLI must fail loudly", () => {
    // Without an org the registry can never be consulted, so minting the bare
    // default App would silently ignore the requested role App.
    expect(resolveMintDeps({ purpose: "reviewer" }, {})).toBeNull();
    expect(
      resolveMintDeps({ purpose: "reviewer" }, { GITHUB_REPO: "   " })
    ).toBeNull();
  });

  test("a --repo/--org with a missing value is null — the CLI must fail loudly", () => {
    expect(resolveMintDeps({ missingRepoValue: true }, {})).toBeNull();
    expect(
      resolveMintDeps(
        { missingRepoValue: true, purpose: "reviewer" },
        { GITHUB_REPO: "acme/widgets" }
      )
    ).toBeNull();
  });

  test("a --purpose with a missing value is null — the CLI must fail loudly", () => {
    // Both parse-time usage-error shapes are null (never a bare-default
    // mint): the valueless --purpose itself, and the valueless --repo case
    // carrying a purpose alongside it.
    expect(resolveMintDeps({ missingPurposeValue: true }, {})).toBeNull();
    expect(
      resolveMintDeps(
        { missingPurposeValue: true },
        { GITHUB_REPO: "acme/widgets" }
      )
    ).toBeNull();
  });

  test("end-to-end: the derived deps route through the registry", async () => {
    // resolveMintDeps' output feeds mintInstallationToken; with the derived
    // targetRepo the registry IS consulted — before the fix the purpose was
    // dropped and the default App minted silently.
    const lookups: Array<{ org: string; purpose: string }> = [];
    const deps = resolveMintDeps(
      { purpose: "reviewer" },
      { GITHUB_REPO: "acme/widgets" }
    );
    expect(deps).not.toBeNull();
    const outcome = await Effect.runPromise(
      mintInstallationToken({
        ...(deps ?? {}),
        cache: null,
        env: {
          GH_APP_ID: "111",
          GH_APP_PRIVATE_KEY: TEST_PEM_B64,
          GITHUB_REPO: "acme/widgets",
        },
        fetchImpl: async (url: string) =>
          url.includes("/app/installations?")
            ? // The mint discovers the installation first.
              Response.json([{ account: { login: "acme" }, id: 1 }])
            : Response.json(
                { token: "t", expires_at: "e" },
                { status: 201 }
              ),
        registry: (org, purpose) => {
          lookups.push({ org, purpose });
          return null;
        },
      }).pipe(
        Effect.match({
          onFailure: (error) => `failed: ${error.message}`,
          onSuccess: () => "minted",
        })
      )
    );
    expect(lookups).toEqual([{ org: "acme", purpose: "reviewer" }]);
    expect(outcome).toBe("minted");
  });
});
