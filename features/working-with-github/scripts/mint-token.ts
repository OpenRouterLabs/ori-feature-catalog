#!/usr/bin/env bun
/**
 * mint-token.ts — print a fresh, short-lived GitHub App installation token to
 * stdout. This is the intern's primary GitHub auth path.
 *
 * # When to use this
 *
 * `gh` and `git` are NOT pre-authenticated on the VM — there is no
 * `/usr/local/bin/gh` wrapper, no git credential helper, and no
 * `~/.config/gh/hosts.yml`. A bare `gh ...` / `git fetch` fails with an auth
 * error. So for ANY GitHub call (gh, git, or a raw curl) you mint a token here
 * and inject it ephemerally as `GH_TOKEN` (or a per-command remote URL).
 * Mint right before you need it and
 * let it die with the process; re-mint freely.
 *
 * `commit-via-api.ts` is the one exception: it mints internally via
 * `mintInstallationToken()`, so you do not feed it a token.
 *
 * # Usage
 *
 *   # Inject into one gh call:
 *   GH_TOKEN=$(bun features/working-with-github/scripts/mint-token.ts) \
 *     gh pr list --repo "$GITHUB_REPO"
 *
 *   # Capture once, reuse across several calls in the same shell:
 *   TOKEN=$(bun features/working-with-github/scripts/mint-token.ts)
 *   curl -s -H "Authorization: Bearer $TOKEN" \
 *     -H "Accept: application/vnd.github+json" \
 *     "https://api.github.com/repos/$GITHUB_REPO"
 *
 * The ~1-hour installation token is derived on demand from the App credentials
 * in the service env (`GH_APP_ID`, `GH_APP_PRIVATE_KEY`) — nothing at rest. The
 * App's installation is discovered at mint time (matching the `GITHUB_REPO` org,
 * or the App's sole installation), so no installation id is configured. On
 * success it prints ONLY the token followed by a newline (so `$(...)` capture is
 * clean) and exits 0. On a mint failure it prints a diagnostic to stderr and
 * exits non-zero — never a partial or empty token to stdout.
 *
 * Treat the output as a secret: assign it to a variable, never echo it, never
 * write it to a file, never run `gh auth login`, and never embed it in a
 * persisted git remote URL.
 */

import { Effect } from "effect";

import type {
  GhAppError,
  InstallationToken,
} from "@ori-monorepo/working-with-github/gh-app-token.ts";

import { mintInstallationToken } from "@ori-monorepo/working-with-github/gh-app-token-mint.ts";

/** Output seam so a test can capture stdout/stderr without touching the process. */
export interface MintWriters {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

/**
 * The CLI core as an Effect: mint a token, write ONLY the token (+ newline) to
 * `out` on success, or a diagnostic to `err` on failure. Resolves to the
 * intended process exit code (0 success, 1 failure) — never throws. The `mint`
 * Effect is injected so a test drives both channels with a fake; the entrypoint
 * passes the real `mintInstallationToken()`.
 */
export const runMint = (
  mint: Effect.Effect<InstallationToken, GhAppError>,
  writers: MintWriters
): Effect.Effect<number> =>
  mint.pipe(
    Effect.map((token) => {
      // stdout carries ONLY the token (+ newline) so `$(...)` capture is clean;
      // all diagnostics go to stderr.
      writers.out(`${token.token}\n`);
      return 0;
    }),
    Effect.catch((error) =>
      Effect.sync(() => {
        writers.err(`mint-token: ${error.message}\n`);
        return 1;
      })
    )
  );

/** The token-routing args parsed from argv. Empty = the bare default app. */
export interface MintArgs {
  readonly targetRepo?: string;
  readonly purpose?: string;
}

/**
 * Parse `--repo <owner/repo>` (alias `--org <org>`) and `--purpose <label>` out
 * of argv. Both optional; with neither, mint the default app. Unknown flags are
 * ignored so the bare `mint-token.ts` invocation keeps working unchanged.
 */
export const parseMintArgs = (argv: readonly string[]): MintArgs => {
  const read = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    if (i === -1 || i + 1 >= argv.length) {
      return undefined;
    }
    const value = argv[i + 1];
    // A following token that is itself a flag means the value was omitted
    // (e.g. `--repo --purpose reviewer`) — treat it as absent, not the value.
    if (value === undefined || value.startsWith("--")) {
      return undefined;
    }
    // Trim so whitespace (e.g. `--purpose "reviewer "`) still matches registry
    // rows — the register CLI trims too. All-whitespace → absent.
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
  };
  const targetRepo = read("--repo") ?? read("--org");
  const purpose = read("--purpose");
  return {
    ...(targetRepo === undefined ? {} : { targetRepo }),
    ...(purpose === undefined ? {} : { purpose }),
  };
};

// Only run the CLI when invoked directly (not when imported by a test).
if (import.meta.main) {
  const args = parseMintArgs(process.argv.slice(2));
  const code = await Effect.runPromise(
    runMint(mintInstallationToken(args), {
      out: (text) => {
        process.stdout.write(text);
      },
      err: (text) => {
        process.stderr.write(text);
      },
    })
  );
  process.exit(code);
}
