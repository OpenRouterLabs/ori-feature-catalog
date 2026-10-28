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
 *   # Normalize GITHUB_REPO once per shell, exactly like the feature prompt's
 *   # REPO= recipe — gh --repo and the repos/{owner}/{repo} API routes take
 *   # bare owner/repo only, and the raw env var breaks both under a URL
 *   # spelling (gh rejects it; repos/https://… is not a route and 404s):
 *   REPO=$(printf '%s' "$GITHUB_REPO" | sed -E 's#[?][^/]*$##; s#[#][^/]*$##; s#[/[:space:]]+$##; s#\.git$##; s#[/[:space:]]+$##; s#\.git$##; s#[/[:space:]]+$##; s#^[[:space:]]+##; s#^[/[:space:]]+##; s#([^:])//+#\1/#g; s#([/:])[[:space:]]+#\1#g; s#[[:space:]]+([/:])#\1#g; s#^[a-zA-Z][a-zA-Z0-9+.-]*://[Aa][Pp][Ii]\.[Gg][Ii][Tt][Hh][Uu][Bb]\.[Cc][Oo][Mm](:[0-9]+)?/repos/##; s#^[a-zA-Z][a-zA-Z0-9+.-]*://[Aa][Pp][Ii]\.[Gg][Ii][Tt][Hh][Uu][Bb]\.[Cc][Oo][Mm](:[0-9]+)?/users/([^/]+)(/.*)?$#\2#; s#^[a-zA-Z][a-zA-Z0-9+.-]*://[Aa][Pp][Ii]\.[Gg][Ii][Tt][Hh][Uu][Bb]\.[Cc][Oo][Mm](:[0-9]+)?/?$##; s#^[Aa][Pp][Ii]\.[Gg][Ii][Tt][Hh][Uu][Bb]\.[Cc][Oo][Mm](:[0-9]+)?/repos/##; s#^[Aa][Pp][Ii]\.[Gg][Ii][Tt][Hh][Uu][Bb]\.[Cc][Oo][Mm](:[0-9]+)?/users/([^/]+)(/.*)?$#\2#; s#^[a-zA-Z][a-zA-Z0-9+.-]*://[Aa][Pp][Ii]\.[Gg][Ii][Tt][Hh][Uu][Bb]\.[Cc][Oo][Mm](:[0-9]+)?/##; s#^[Aa][Pp][Ii]\.[Gg][Ii][Tt][Hh][Uu][Bb]\.[Cc][Oo][Mm](:[0-9]+)?/##; s#^[Aa][Pp][Ii]\.[Gg][Ii][Tt][Hh][Uu][Bb]\.[Cc][Oo][Mm](:[0-9]+)?/?$##; s#([a-zA-Z][a-zA-Z0-9+.-]*://)?([^@[:space:]]+@)?([Aa][Pp][Ii]\.)?([Gg][Ii][Tt][Hh][Uu][Bb]\.[Cc][Oo][Mm]):[0-9]+([/:]|$)#\1\2\3\4\5#; s#([a-zA-Z][a-zA-Z0-9+.-]*://)?([^@[:space:]]+@)?[Gg][Ii][Tt][Hh][Uu][Bb]\.[Cc][Oo][Mm][/:]+(orgs|organizations|users)/([^/]+)(/.*)?$#\4#; s#([a-zA-Z][a-zA-Z0-9+.-]*://)?([^@[:space:]]+@)?[Gg][Ii][Tt][Hh][Uu][Bb]\.[Cc][Oo][Mm][/:]*(orgs|organizations|users)$##; s#([a-zA-Z][a-zA-Z0-9+.-]*://)?([^@[:space:]]+@)?[Gg][Ii][Tt][Hh][Uu][Bb]\.[Cc][Oo][Mm][/:]##; s#^(orgs|organizations|users)/([^/]+)(/.*)?$#\2#; s#^(organizations|users)$##; s#^/*([^/]+/[^/]+)(/.*)?$#\1#; s#^[/[:space:]]+##; s#^(([Hh][Tt][Tt][Pp][Ss]?|[Ss][Ss][Hh]|[Gg][Ii][Tt]\+[Ss][Ss][Hh]|[Gg][Ii][Tt]|[Ff][Tt][Pp])://)?(([^@[:space:]]+)@)?[Gg][Ii][Tt][Hh][Uu][Bb]\.[Cc][Oo][Mm]$##')
 *
 *   # Inject into one gh call:
 *   GH_TOKEN=$(bun features/working-with-github/scripts/mint-token.ts) \
 *     gh pr list --repo "$REPO"
 *
 *   # Capture once, reuse across several calls in the same shell:
 *   TOKEN=$(bun features/working-with-github/scripts/mint-token.ts)
 *   curl -s -H "Authorization: Bearer $TOKEN" \
 *     -H "Accept: application/vnd.github+json" \
 *     "https://api.github.com/repos/$REPO"
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

import {
  findJunkArgv,
  isRepoUnset,
} from "@ori-monorepo/working-with-github/commit-api-core.ts";
import { orgOf } from "@ori-monorepo/working-with-github/gh-app-registry.ts";

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
  /** Parse-time usage error: a single-dash argv token (`-repo`, the near-universal
   *  typo for `--repo`) that no CLI accepts. Carried so the CLI entrypoint fails
   *  loudly; never reaches `mintInstallationToken`. */
  readonly junkArgv?: string;
  /** Parse-time usage error: an explicitly-passed --repo/--org/--purpose had
   *  no usable value. Carried so the CLI entrypoint can fail loudly; never
   *  reaches `mintInstallationToken`. */
  readonly missingRepoValue?: boolean;
  /** Parse-time usage error: an explicitly-passed `--purpose` had no usable
   *  value (the same class as {@link missingRepoValue}, for the third
   *  value-taking flag). Never reaches `mintInstallationToken`. */
  readonly missingPurposeValue?: boolean;
  /** Parse-time usage error: a value-taking flag appeared more than once
   *  (`--repo acme/a --repo acme/b` — a paste error). The four CLIs each
   *  silently picked a winner before, and NOT the same one (this CLI and the
   *  two `readFlag` CLIs took the FIRST occurrence, `commit-via-api.ts`'s
   *  Map the LAST) — so one pasted command block could mint a token for the
   *  first `--repo` and land the commit on the second. A repeat is refused
   *  outright, exactly like the single-dash and equals-form shapes. */
  readonly repeatedFlag?: string;
  /**
   * Parse-time usage error: an explicitly-passed `--repo`/`--org` spelled a
   * string that names NO target org at all (e.g. the organizations-page
   * INDEX URL `https://github.com/orgs`, or a bare `organizations` word —
   * `orgOf` collapses both to `""`, the documented no-owner answer). Never
   * reaches `mintInstallationToken`: the caller asked for a token routed to
   * a target, and the token they would silently get instead is the DEFAULT
   * App's minted for the `GITHUB_REPO` org — the target the spelling names
   * is unreachable, and every later call 404s with no hint why. The exact
   * class the sibling CLIs already close loudly (commit-via-api's
   * `--repo "…" resolves to no owner/repo`, cleanup-worktrees' #219), and
   * the registry CLI's normalized-org guard — the mint CLI is the one
   * left silently swapping the identity.
   */
  readonly unresolvableRepoValue?: string;
  /**
   * Parse-time usage error: a POSITIONAL token in argv (one with no `--`
   * prefix — `mint-token.ts acme/widgets`, the natural "drop the flag"
   * typo). Pre-fix every flag-shape guard (single-dash, equals-form,
   * unknown flag, repeated flag, missing value, unresolvable value) left
   * the bare token alone, so the parse silently swallowed it and minted
   * the DEFAULT App's token — exit 0, the exact silent-identity-swap class
   * those guards exist to close (#98/#107/#117). No documented invocation
   * carries a positional; refuse it like the other junk shapes.
   */
  readonly positionalArgv?: string;
}

/** True when `flag` appears in `argv` at all — used to distinguish an
 *  explicitly-requested-but-valueless flag (a usage error) from an absent one
 *  (the legitimate bare-default path). `--purpose` is deliberately NOT a
 *  member of this list: a purposeless bare-default mint stays legitimate
 *  (the registered (org, default) row is the fallback), so its usage error
 *  is keyed on its own `missingPurposeValue` field instead. */
const flagPresent = (argv: readonly string[], flag: string): boolean =>
  argv.includes(flag);

/** Every flag the mint CLI accepts — anything else `--`-prefixed is a usage
 *  error, never a silently-dropped token that eats its value. */
const KNOWN_FLAGS = ["--repo", "--org", "--purpose"] as const;

/** An unknown `--`-flag in argv: `findJunkArgv` already rejects single-dash and
 *  `--flag=value` shapes, but an unknown well-formed flag
 *  (`--porpose reviewer` — a typo of `--purpose`) was silently IGNORED, and its
 *  value token vanished with it: the parse dropped the caller's purpose and
 *  minted for the org-level CATCH-ALL App instead of the role App they named,
 *  with exit 0 — the exact silent-identity-swap class the repeated-flag,
 *  missing-value and single-dash guards close for every other argv shape
 *  (#98/#117, reopened through the typo). Name it like those guards do. */
const findUnknownFlag = (argv: readonly string[]): string | undefined =>
  argv.find(
    (token) => token.startsWith("--") && !KNOWN_FLAGS.includes(token as never)
  );

/** A POSITIONAL token in argv: one with no `--` prefix that does NOT
 *  immediately follow a known flag (the token after a flag occurrence is
 *  that flag's value slot — usable, flag-shaped, padded, or blank — and the
 *  existing guards are the ones that judge it). None of this CLI's
 *  documented invocations carries a positional, and pre-fix every parse
 *  silently swallowed one and minted the DEFAULT App's token — exit 0, the
 *  #98/#107/#117 silent-identity-swap class reopened through the dropped
 *  flag. This runs AFTER those guards, so the shapes they own (a flag-shaped
 *  slot, a blank slot, a repeat, an unresolvable value) keep their existing
 *  diagnostics; only an orphaned token remains. */
const findPositionalArgv = (argv: readonly string[]): string | undefined =>
  argv.find(
    (token, i) =>
      !(i > 0 && KNOWN_FLAGS.includes(argv[i - 1] as never)) &&
      !token.startsWith("--")
  );

/**
 * Parse `--repo <owner/repo>` (alias `--org <org>`) and `--purpose <label>` out
 * of argv. Both optional; with neither, mint the default app. Any other
 * `--`-prefixed token is a usage error (see {@link findUnknownFlag}) — never a
 * silently-dropped flag that eats its value.
 */
export const parseMintArgs = (argv: readonly string[]): MintArgs => {
  const junkArgv = findJunkArgv(argv);
  if (junkArgv !== undefined) {
    return { junkArgv };
  }
  const unknownFlag = findUnknownFlag(argv);
  if (unknownFlag !== undefined) {
    return { junkArgv: unknownFlag };
  }
  // A value-taking flag repeated in argv is a usage error, never a silent
  // winner: `indexOf` takes the first occurrence, so pre-fix
  // `--repo acme/a --repo acme/b` silently minted for `acme/a`. `--repo` and
  // `--org` are aliases for the SAME target, so both present is a repeat too
  // (reported under the canonical `--repo` name).
  const read = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    if (i === -1 || i + 1 >= argv.length) {
      return undefined;
    }
    const value = argv[i + 1];
    // Trim BEFORE the flag-shape check: a value that is a flag modulo
    // surrounding whitespace (`--repo " --purpose "`) is the same omitted
    // value, and checking the raw token first let it trim to "--purpose" and
    // flow on as a real target — a silent identity swap in the making.
    const trimmedValue = value === undefined ? undefined : value.trim();
    if (trimmedValue === undefined || trimmedValue.startsWith("--")) {
      return undefined;
    }
    // All-whitespace → absent.
    return trimmedValue === "" ? undefined : trimmedValue;
  };
  // A repeated value-taking flag is a usage error, never a silent first-wins —
  // but a repeat exists only when BOTH spellings NAME the target: `--repo`
  // and `--org` are aliases, and pre-fix the alias-merged TOKEN count reported
  // `--repo --org acme/x` (each flag passed exactly ONCE, `--repo`'s value
  // slot eaten by `--org`) as "--repo was passed more than once" — a FALSE
  // diagnosis (neither flag was repeated) that sent the operator to delete a
  // flag when the actionable problem is that `--repo` has no value. Count a
  // repeat only from occurrences that CARRY a usable value (the token after
  // each occurrence, judged by the same shape `read` judges — a flag-shaped
  // or blank slot is the missing-value shape, not a second spelling): an
  // alias pair with one value between them counts ONE usable spelling and
  // falls through to `read`'s first-value contract, while a genuine
  // `--repo a --repo b` / `--repo a --org b` still counts two.
  const usableValueCount = (flags: readonly string[]): number => {
    let usable = 0;
    for (let i = 0; i < argv.length; i += 1) {
      if (!flags.includes(argv[i] ?? "")) {
        continue;
      }
      const value = argv[i + 1];
      const trimmed = value === undefined ? undefined : value.trim();
      if (
        trimmed !== undefined &&
        trimmed !== "" &&
        !trimmed.startsWith("--")
      ) {
        usable += 1;
      }
    }
    return usable;
  };
  if (usableValueCount(["--repo", "--org"]) > 1) {
    return { repeatedFlag: "--repo" };
  }
  if (usableValueCount(["--purpose"]) > 1) {
    return { repeatedFlag: "--purpose" };
  }
  const targetRepo = read("--repo") ?? read("--org");
  const purpose = read("--purpose");
  // An explicitly-passed `--purpose` whose value is missing must fail the
  // parse, exactly like `--repo`/`--org`: the caller asked for a role App's
  // token, and silently minting the default App's instead is the same
  // silent-identity-swap #98 closed for the repo flags. A flag with no value
  // at all (`--purpose` trailing argv) and a flag whose slot was eaten by the
  // next flag (`--purpose --repo acme/x`) both land here — `read` returns
  // undefined for exactly those two shapes.
  if (purpose === undefined && flagPresent(argv, "--purpose")) {
    return { missingPurposeValue: true };
  }
  // An explicitly-passed --repo/--org whose value is missing must fail the
  // parse, not silently mint the default App: the caller asked for a token
  // routed to a target org, and the token they would silently get instead
  // (the default App's) cannot see that target's repos — every later call
  // 404s with no hint why. `--purpose`-without-an-org already fails loudly
  // via resolveMintDeps; this closes the matching --repo gap.
  if (
    targetRepo === undefined &&
    (flagPresent(argv, "--repo") || flagPresent(argv, "--org"))
  ) {
    return {
      ...(purpose === undefined ? {} : { purpose }),
      missingRepoValue: true,
    };
  }
  // An explicitly-passed --repo/--org that RESOLVES to no org at all is the
  // same usage error as a missing value — never a silent default-App mint.
  // `orgOf` is the sibling normalizer every registry key and allowlist entry
  // already derive through; its documented no-owner spellings (the orgs-page
  // INDEX URL, a bare `organizations`) must fail the parse here, naming the
  // spelling, instead of flowing to `mintInstallationToken({ targetRepo })`
  // where `readGhAppCredentials` treats an orgless target as the bare
  // default-app request and mints for the GITHUB_REPO org.
  if (targetRepo !== undefined && orgOf(targetRepo) === "") {
    return {
      ...(purpose === undefined ? {} : { purpose }),
      unresolvableRepoValue: targetRepo,
    };
  }
  // A POSITIONAL token — one that is a usable value for NO flag — is the
  // last silent-swallow shape left. The guards above (junk, unknown,
  // repeated, missing-value, unresolvable-value) have claimed every token
  // that belongs to a flag, so anything still bare here was silently
  // dropped pre-fix while the parse minted the DEFAULT App's token.
  const positional = findPositionalArgv(argv);
  if (positional !== undefined) {
    return { positionalArgv: positional };
  }
  return {
    ...(targetRepo === undefined ? {} : { targetRepo }),
    ...(purpose === undefined ? {} : { purpose }),
  };
};

/** The mint deps the CLI passes to `mintInstallationToken`, after resolving the
 *  own-org default for a purpose-only invocation. `--purpose` selects a role
 *  App for the target org; without `--repo`/`--org` the target is the intern's
 *  own repo (`GITHUB_REPO`) — the "distinct role in your own org" case the
 *  feature prompt documents. Without this, the purpose was silently dropped:
 *  `mintInstallationToken` only routes through the registry when a target
 *  repo/org is given, so a registered (own-org, purpose) App was never
 *  consulted and the bare default App was minted instead — a silent identity
 *  swap (e.g. a reviewer-only request minting the maintainer App's token).
 *  Returns null when a purpose is given but no org is derivable at all — the
 *  purpose can never route then, so the CLI must fail loudly rather than mint
 *  the default. */
export const resolveMintDeps = (
  args: MintArgs,
  env: Readonly<Record<string, string | undefined>> = process.env
): MintArgs | null => {
  if (
    args.missingRepoValue === true ||
    args.missingPurposeValue === true ||
    args.repeatedFlag !== undefined ||
    args.unresolvableRepoValue !== undefined ||
    args.positionalArgv !== undefined
  ) {
    return null;
  }
  // A target repo that names no org at all can never route to a registered
  // App either — the same refusal for callers that build MintArgs directly
  // (the parse-time marker above only fires for argv-driven invocations):
  // `mintInstallationToken` would treat the orgless target as the bare
  // default-app request and mint for the GITHUB_REPO org, silently dropping
  // the caller's target.
  if (args.targetRepo !== undefined && orgOf(args.targetRepo) === "") {
    return null;
  }
  if (args.purpose === undefined || args.targetRepo !== undefined) {
    return args;
  }
  const ownOrg = (env.GITHUB_REPO ?? "").trim();
  // An own-repo spelling that names NO org at all — the organizations-page
  // INDEX URL (`https://github.com/orgs`), a bare `organizations` word, the
  // ported index spellings; `orgOf` collapses all of them to `""`, the
  // documented no-owner answer — can never route a --purpose to a
  // registered App either, exactly like a directly-passed orgless
  // `--repo`/`--org` (the targetRepo guard above). Pre-fix the derived
  // target flowed on raw: `readGhAppCredentials` treats an ORGLESS target
  // exactly like the bare default-app request, so
  // `mintInstallationToken({ targetRepo, purpose })` looked the registry up
  // under the empty org, found no row, and silently minted the DEFAULT App's
  // token — dropping both the caller's --purpose and every routing decision
  // that followed it (the same silent-identity-swap class #98/#107/#221
  // close for every OTHER shape of this flag). Return null so the CLI fails
  // loudly, naming the spelling, never mints.
  if (orgOf(ownOrg) === "") {
    return null;
  }
  return { ...args, targetRepo: ownOrg };
};

// Only run the CLI when invoked directly (not when imported by a test).
if (import.meta.main) {
  const args = parseMintArgs(process.argv.slice(2));
  if (args.positionalArgv !== undefined) {
    process.stderr.write(
      `mint-token: unrecognized argument "${args.positionalArgv}" — this CLI takes flags only, e.g. "--repo owner/repo", never a bare positional\n`
    );
    process.exit(1);
  }
  if (args.junkArgv !== undefined) {
    process.stderr.write(
      `mint-token: unrecognized argument "${args.junkArgv}" — flags are space-separated "--repo owner/repo", never "--repo=owner/repo" or single-dash\n`
    );
    process.exit(1);
  }
  const mintDeps = resolveMintDeps(args);
  if (mintDeps === null) {
    // An explicitly-passed value-taking flag with no usable value, one that
    // was repeated, a value that names no target org, or a purpose with no
    // derivable org (it can never route to a registered App) — minting the
    // bare default instead would silently ignore what the caller asked for.
    process.stderr.write(
      args.repeatedFlag !== undefined
        ? `mint-token: ${args.repeatedFlag} was passed more than once — pass exactly one value\n`
        : args.unresolvableRepoValue !== undefined
        ? `mint-token: --repo "${args.unresolvableRepoValue}" resolves to no GitHub org — check its spelling (e.g. github.com/orgs, the organizations index, names no owner)\n`
        : args.missingRepoValue === true
        ? "mint-token: --repo/--org needs a value (e.g. --repo owner/repo)\n"
        : args.missingPurposeValue === true
          ? "mint-token: --purpose needs a value (e.g. --purpose reviewer)\n"
          // Name the actual cause for the purpose-only null, the same
          // "never blame a healthy env var" discipline #207/#219/#220 apply
          // to the flag paths: a SET-but-orgless GITHUB_REPO is not "unset"
          // (and the operator must be sent to its spelling, not to re-set
          // populated env), while an UNSET GITHUB_REPO is not a spelling
          // problem at all — pre-fix both printed the orgless message, so a
          // genuinely unset var was blamed for a spelling it never had.
          : !isRepoUnset(process.env)
          ? `mint-token: GITHUB_REPO "${(process.env.GITHUB_REPO ?? "").trim()}" resolves to no GitHub org — --purpose cannot route to a registered App. Check its spelling (e.g. github.com/orgs, the organizations index, names no owner)\n`
          : "mint-token: --purpose needs a target org: pass --repo/--org or set GITHUB_REPO\n"
    );
    process.exit(1);
  }
  const code = await Effect.runPromise(
    runMint(mintInstallationToken(mintDeps), {
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
