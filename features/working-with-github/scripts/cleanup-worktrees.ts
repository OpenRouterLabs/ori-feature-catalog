#!/usr/bin/env bun
/**
 * cleanup-worktrees.ts — remove worktrees under `/tmp/worktrees/<slug>/` whose
 * self-modification work is actually done.
 *
 * # When to use this
 *
 * The worktree-first workflow in this feature's prompt (see "Modifying your own
 * code") ends its last step with a single `git worktree remove "$WT"` — but
 * that line never runs if the process crashes, gets killed, or a PR is merged
 * or closed by someone else after the run has moved on. Worktrees accumulate
 * under `/tmp/worktrees/` with nothing to sweep them. Run this to clean up the
 * ones that are safe to remove, and see a report on the ones that aren't.
 *
 * # The safety model
 *
 * A worktree is only removed when BOTH hold: its branch has a merged-or-closed
 * PR (never open, never "no PR at all" — an abandoned branch with no PR is
 * reported, not deleted, since nothing signals the work is done), AND its tree
 * is clean (`git status --porcelain` is empty — no uncommitted work). Every
 * other case (open PR, no PR found, dirty tree) is reported with a reason and
 * left untouched. A directory on disk that `git worktree list` doesn't
 * recognize is reported as a "stray", never deleted directly.
 *
 * # Usage
 *
 *   bun features/working-with-github/scripts/cleanup-worktrees.ts
 *   bun features/working-with-github/scripts/cleanup-worktrees.ts --dry-run
 *   bun features/working-with-github/scripts/cleanup-worktrees.ts --repo owner/repo
 *
 * `--repo` defaults to `$GITHUB_REPO` — only that repo's own slug directory is
 * swept. Cleaning up worktrees for an upstream composed-feature fix needs an
 * explicit `--repo owner/repo` (mirroring `commit-via-api.ts --repo`) — and a
 * `--repo-dir` pointed at a checkout OF that repo: `git worktree list` runs
 * from the checkout you're standing in and only knows that repo's worktrees,
 * so an upstream-repo sweep from your own repo's checkout reports every
 * upstream worktree as a false stray and removes nothing (the dirs are
 * healthy, just tracked by a different checkout).
 * `--repo-dir` defaults to `ORI_INTERN_WORKSPACE_ROOT` when that env var
 * names a directory (the daemon-invocation shape: the process starts in
 * `/workspace`, one level ABOVE the actual git checkout, and git fails there
 * with "not a git repository" — the #75 class, fixed for the schedule's own
 * resolver and now the CLI's too), else the current working directory — run
 * this from your repo checkout (same expectation as the worktree-creation
 * flow in the feature prompt), since `git worktree list`/`prune`/`remove`
 * need a real git working directory, not just the worktrees-root container.
 * `--worktrees-root` overrides the default `/tmp/worktrees` (mainly for
 * tests). `--dry-run` prints every decision without removing anything.
 *
 * On success it prints a one-line summary per worktree to stdout and exits 0;
 * a per-worktree failure (e.g. `git worktree remove` itself failing) is
 * reported in the summary rather than aborting the whole sweep. All
 * diagnostics unrelated to a specific worktree (e.g. a missing token) go to
 * stderr with a non-zero exit.
 */

import { Effect } from "effect";

import type { GhAppError } from "@ori-monorepo/working-with-github/gh-app-token.ts";
import type { GitHubToken } from "@ori-monorepo/working-with-github/gh-app-token-mint.ts";

import { resolveGitHubToken } from "@ori-monorepo/working-with-github/gh-app-token-mint.ts";

import type { WorktreeOutcome } from "./cleanup-worktrees-core.ts";

import { cleanupWorktrees } from "./cleanup-worktrees-core.ts";
import {
  findUnknownFlag,
  findJunkArgv,
  isRepoUnset,
  resolveRepoFromEnv,
} from "./commit-api-core.ts";

const DEFAULT_WORKTREES_ROOT = "/tmp/worktrees";

/** Every flag the cleanup CLI accepts — anything else `--`-prefixed is a
 *  usage error (see {@link findUnknownFlag}), never a silently-dropped
 *  token that eats its value. */
const KNOWN_FLAGS = [
  "--repo",
  "--repo-dir",
  "--worktrees-root",
  "--dry-run",
] as const;

/** Output seam so a test can capture stdout/stderr without touching the process. */
export interface CleanupWriters {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

export interface CleanupCliArgs {
  readonly repo: string;
  readonly repoDir: string;
  readonly worktreesRoot: string;
  readonly dryRun: boolean;
  /** Parse-time usage error: a single-dash argv token (`-repo`, the near-universal
   *  typo for `--repo`). A silent ignore retargeted a DESTRUCTIVE sweep at the
   *  default repo (GITHUB_REPO), removing ITS worktrees while the caller asked for
   *  another repo — the same never-silently-derive-a-default contract the
   *  `missingFlagValue` guard below exists to enforce. */
  readonly junkArgv?: string;
  /** Parse-time usage error: a value-taking flag was passed with no usable
   *  value (e.g. `--repo --dry-run`). Carried so the CLI entrypoint can fail
   *  loudly instead of silently sweeping a wrong default — the same shape
   *  `mint-token.ts` (`missingRepoValue`) and `commit-via-api.ts`
   *  (`parseFlagPair`) both reject. */
  readonly missingFlagValue?: string;
  /** Parse-time usage error: a value-taking flag was passed more than once
   *  (`--repo acme/a --repo acme/b` — a paste error). `readFlag` keys on
   *  `argv.indexOf`, so pre-fix the FIRST occurrence silently won while the
   *  caller may have meant the second — a wrong-target destructive sweep
   *  with no diagnostic. A repeat is refused, naming the flag. */
  readonly repeatedFlag?: string;
  /**
   * The RAW `--repo` value, present whenever the flag was passed with a
   * usable-looking value (one that is not itself a flag and not blank). The
   * empty-repo diagnostic below needs it to name the actual cause: a
   * `--repo` spelling that resolves to no owner/repo (e.g. the orgs-page
   * index URL) must be reported against the FLAG, never against
   * `GITHUB_REPO` — pre-fix the diagnostic always named the env var, so
   * `--repo https://github.com/orgs` with a healthy `GITHUB_REPO` printed
   * `GITHUB_REPO "acme/widgets" resolves to no owner/repo` — a lie about a
   * populated, resolvable env var, and a dead end for the operator (#207's
   * "name the actual cause" class, reopened through the flag path).
   */
  readonly repoFlagValue?: string;
  /** Parse-time usage error: a POSITIONAL token in argv (no `--` prefix —
   *  `cleanup-worktrees.ts acme/widgets`, the natural "drop the flag" typo).
   *  Pre-fix every flag-shape guard left it alone, so the parse silently
   *  swallowed it and swept the DEFAULT repo's slug directory — a
   *  wrong-target DESTRUCTIVE sweep with exit 0, the exact class the
   *  junk/repeated/missing-value guards exist to close. No documented
   *  invocation carries a positional. */
  readonly positionalArgv?: string;
}

/** Parse `--repo`, `--repo-dir`, `--worktrees-root`, and `--dry-run` out of argv. */
export const parseCleanupArgs = (
  argv: readonly string[],
  // oxlint-disable-next-line node/no-process-env -- default deps seam; callers pass a fake env in tests.
  env: Readonly<Record<string, string | undefined>> = process.env,
  cwd: string = process.cwd()
): CleanupCliArgs => {
  // The CLI's --repo-dir default honors ORI_INTERN_WORKSPACE_ROOT exactly
  // like the schedule's `repo-dir.ts` resolver: a daemon-context invocation
  // (cwd `/workspace`, not a git repo) otherwise fails the whole sweep on
  // "not a git repository" even though the env var names the healthy
  // checkout — the #75 class, closed for the schedule but left open here.
  // A blank value is unset, and the resolved path is trimmed so a padded one
  // does not point git at a nonexistent directory.
  const envRepoDir = (env.ORI_INTERN_WORKSPACE_ROOT ?? "").trim();
  const junkArgv = findJunkArgv(argv);
  // A POSITIONAL token — no `--` prefix, so findJunkArgv/findUnknownFlag
  // both miss it — must fail the parse, never silently retarget a
  // destructive sweep at the default repo. The token after a known
  // value-taking flag is that flag's slot (the existing guards judge it);
  // `--dry-run` takes none.
  const findPositionalArgv = (argv: readonly string[]): string | undefined =>
    argv.find(
      (token, i) =>
        !(i > 0 &&
          KNOWN_FLAGS.includes(argv[i - 1] as never) &&
          argv[i - 1] !== "--dry-run") &&
        !token.startsWith("--")
    );
  const positionalArgv = junkArgv === undefined
    ? findPositionalArgv(argv)
    : undefined;
  // An unknown well-formed flag (`--dryrun`, `--repro o/r`) is the same
  // usage error as the single-dash/equals shapes: pre-fix `--dryrun`
  // parsed clean as a REAL sweep (`dryRun: false`) — the caller believed
  // they had a dry run — and a typo'd `--repro o/r` silently swept the
  // DEFAULT repo's slug directory, the same wrong-target destructive
  // class the repeated-flag guard refuses for a repeated `--repo`.
  const unknownFlag =
    junkArgv === undefined ? findUnknownFlag(argv, KNOWN_FLAGS) : undefined;
  // A value-taking flag repeated in argv is a usage error, never a silent
  // first-wins: `readFlag` below reads `argv.indexOf(flag)`, so a repeated
  // flag silently dropped every occurrence after the first.
  const repeatedFlag = ["--repo", "--repo-dir", "--worktrees-root"].find(
    (flag) => argv.filter((token) => token === flag).length > 1
  );
  const readFlag = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    if (i === -1 || i + 1 >= argv.length) {
      return undefined;
    }
    // Trim BEFORE the flag-shape check: a value that is a flag modulo
    // surrounding whitespace (`--repo " --dry-run "`) is the same unusable
    // shape, but checking the raw token first let it trim to "--dry-run" and
    // flow on as a real repo — sweeping a repo named after the flag while
    // the real flag was silently consumed as its value. An empty/
    // whitespace-only value is unusable the same way (`undefined`), so the
    // missingFlagValue marker below fires for an explicit `--repo ""` too
    // (an empty value silently fell through to GITHUB_REPO before,
    // misdiagnosed as "GITHUB_REPO is unset" when it was set — the same
    // class as #98/#107 in mint-token.ts).
    const value = argv[i + 1];
    const trimmed = value === undefined ? "" : value.trim();
    return trimmed.startsWith("--") || trimmed === ""
      ? undefined
      : trimmed;
    // The value is returned TRIMMED, matching `mint-token.ts`'s `read` and
    // `register-gh-app.ts`'s `readFlag`: a padded path (`--worktrees-root
    // " /tmp/w "`) otherwise goes through raw, `realpath` falls back to the
    // padded string on ENOENT, `readdir` swallows the error, and the sweep
    // exits 0 with "nothing under the worktrees root" — a silent no-op.
  };
  // A value-taking flag PRESENT but with no usable value (its slot eaten by
  // the next flag, or trailing at the end of argv) is a usage error, not a
  // silent default: `--repo --dry-run` would otherwise sweep the
  // GITHUB_REPO slug (or cwd-run git) as if the caller had asked for it.
  const missingFlagValue = ["--repo", "--repo-dir", "--worktrees-root"].find(
    (flag) => argv.includes(flag) && readFlag(flag) === undefined
  );
  // `--repo` tolerates the same spellings `GITHUB_REPO` does (a full https
  // URL with optional .git, or a bare owner/repo) — the same normalization
  // `commit-via-api.ts` applies to its `--repo`. A raw URL passed straight
  // through 404s every PR lookup, so the sweep reports each worktree as an
  // error and removes nothing; routing the flag through the env resolver
  // keeps both spellings on one path.
  const repo = resolveRepoFromEnv({
    ...env,
    GITHUB_REPO: readFlag("--repo") ?? env.GITHUB_REPO,
  });
  const repoFlagValue = readFlag("--repo");
  return {
    dryRun: argv.includes("--dry-run"),
    ...(positionalArgv === undefined ? {} : { positionalArgv }),
    ...((junkArgv ?? unknownFlag) === undefined
      ? {}
      : { junkArgv: junkArgv ?? unknownFlag }),
    ...(missingFlagValue === undefined ? {} : { missingFlagValue }),
    ...(repeatedFlag === undefined ? {} : { repeatedFlag }),
    ...(repoFlagValue === undefined ? {} : { repoFlagValue }),
    repo,
    repoDir: readFlag("--repo-dir") ?? (envRepoDir !== "" ? envRepoDir : cwd),
    worktreesRoot: readFlag("--worktrees-root") ?? DEFAULT_WORKTREES_ROOT,
  };
};

/** One-line, log-friendly summary of a single worktree outcome. */
export const formatOutcome = (outcome: WorktreeOutcome): string =>
  `[${outcome.decision}] ${outcome.path} — ${outcome.detail}`;

/**
 * The CLI core as an Effect: mint a token, sweep, write one summary line per
 * outcome to stdout. Resolves to the intended process exit code — never
 * throws. `mint` is injected so a test drives it with a fake.
 */
export const runCleanup = Effect.fn("CleanupWorktreesCli.runCleanup")(
  function* (
    mint: Effect.Effect<GitHubToken, GhAppError> | undefined,
    args: CleanupCliArgs,
    writers: CleanupWriters,
    // Ambient mode (GH_APP_ID unset): no App token can be minted, and the
    // host's egress proxy attaches the workspace credential to the bare PR
    // lookup instead — the same ambient REST discipline the feature prompt
    // teaches and gh-auth-health implements. The mint is skipped entirely;
    // an unauthorized bare lookup still surfaces as an error outcome.
    // Defaults to App mode (mint) for backwards compatibility with the tests
    // that inject a fake mint.
    ambient = false,
    // The env the empty-repo diagnostic reads (unset vs set-but-unresolvable);
    // the CLI passes the same env the parse read.
    // oxlint-disable-next-line node/no-process-env -- default deps seam; tests pass a fake env.
    env: Readonly<Record<string, string | undefined>> = process.env
  ) {
    if (args.missingFlagValue !== undefined) {
      // A parse-time usage error: the caller passed a value-taking flag with
      // no usable value (`--repo --dry-run`). Fail loudly — never sweep a
      // silently-derived default (GITHUB_REPO / cwd / /tmp/worktrees).
      writers.err(
        `cleanup-worktrees: ${args.missingFlagValue} needs a value (e.g. ${
          args.missingFlagValue === "--repo" ? "owner/repo" : "/a/path"
        })\n`
      );
      return 1;
    }
    if (args.repeatedFlag !== undefined) {
      // A parse-time usage error: a value-taking flag was passed more than
      // once. Never silently sweep the first occurrence's target.
      writers.err(
        `cleanup-worktrees: ${args.repeatedFlag} was passed more than once — pass exactly one value\n`
      );
      return 1;
    }
    if (args.junkArgv !== undefined) {
      // A single-dash token (`-repo o/r`) is a typo no CLI accepts: fail loudly
      // rather than silently sweeping the default repo's slug directory.
      writers.err(
        `cleanup-worktrees: unrecognized argument "${args.junkArgv}" — flags are space-separated "--repo owner/repo", never "--repo=owner/repo" or single-dash\n`
      );
      return 1;
    }
    if (args.positionalArgv !== undefined) {
      // A parse-time usage error: a bare positional token (no `--` prefix)
      // was never part of any documented invocation, and swallowing it
      // silently retargets a DESTRUCTIVE sweep at the default repo.
      writers.err(
        `cleanup-worktrees: unrecognized argument "${args.positionalArgv}" — this CLI takes flags only, e.g. "--repo owner/repo", never a bare positional\n`
      );
      return 1;
    }
    if (args.repo === "") {
      // The causes of an empty repo each need their own guidance, and the
      // parse already read the same argv/env: an explicit `--repo` whose
      // spelling resolves to no owner/repo (name the FLAG value — the env var
      // may be healthy, and blaming it is a lie), genuinely-unset env (the
      // operator must configure it), vs SET-but-unresolvable env — e.g. the
      // orgs-page INDEX URL `https://github.com/orgs` (#203), which names no
      // owner at all. Pre-fix both env cases printed "unset", a lie for the
      // set case, and the flag case named the ENV too (#207's "name the
      // actual cause" class, reopened through the flag path).
      writers.err(
        args.repoFlagValue !== undefined
          ? `cleanup-worktrees: --repo "${args.repoFlagValue}" resolves to no owner/repo — check its spelling (e.g. github.com/orgs, the organizations index, names no owner).\n`
          : isRepoUnset(env)
          ? "cleanup-worktrees: no --repo given and GITHUB_REPO is not set.\n"
          : `cleanup-worktrees: GITHUB_REPO "${(env.GITHUB_REPO ?? "").trim()}" resolves to no owner/repo — check its spelling (e.g. github.com/orgs, the organizations index, names no owner).\n`
      );
      return 1;
    }
    const token = ambient
      ? undefined
      : yield* (mint as Effect.Effect<GitHubToken, GhAppError>).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              writers.err(
                `cleanup-worktrees: could not mint a token: ${error.message}\n`
              );
            })
          )
        );
    if (!ambient && token === undefined) {
      return 1;
    }
    const summary = yield* cleanupWorktrees(
      // Ambient mode (no minted token): the lookup goes bare — see the
      // CleanupDeps.token doc in cleanup-worktrees-core.ts.
      { ...(token === undefined ? {} : { token: token.token }) },
      {
        dryRun: args.dryRun,
        repo: args.repo,
        // Scoped to this repo's own slug directory: a sibling slug belongs to
        // another repo, and this sweep's PR lookup cannot speak for it.
        repoSlug: args.repo.replaceAll("/", "-"),
        repoDir: args.repoDir,
        worktreesRoot: args.worktreesRoot,
      }
    );
    if (summary.outcomes.length === 0) {
      writers.out("cleanup-worktrees: nothing under the worktrees root.\n");
      return 0;
    }
    for (const outcome of summary.outcomes) {
      writers.out(`${formatOutcome(outcome)}\n`);
    }
    return summary.gitListFailed === true ||
      summary.outcomes.some((outcome) => outcome.decision === "error")
      ? 1
      : 0;
  }
);

// Only run the CLI when invoked directly (not when imported by a test).
if (import.meta.main) {
  const args = parseCleanupArgs(process.argv.slice(2));
  // oxlint-disable-next-line node/no-process-env -- GH_APP_ID is service config.
  const ambient = (process.env.GH_APP_ID ?? "") === "";
  const code = await Effect.runPromise(
    runCleanup(
      // In ambient mode the mint cannot succeed (no App credentials exist);
      // the runCleanup call above skips it, and this Effect is never forced.
      ambient ? undefined : resolveGitHubToken({ targetRepo: args.repo }),
      args,
      {
        err: (text) => {
          process.stderr.write(text);
        },
        out: (text) => {
          process.stdout.write(text);
        },
      },
      // The diagnostic reads the same live env the parse above read.
      ambient,
      process.env
    )
  );
  process.exit(code);
}
