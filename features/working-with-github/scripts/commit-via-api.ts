#!/usr/bin/env bun
/**
 * commit-via-api.ts — create a GitHub-signed (Verified) commit from a local
 * worktree, via the Git Data API.
 *
 * # Why this exists
 *
 * Direct `git commit` on the VM produces **unsigned / Unverified** commits:
 * there is no GPG (or SSH-signing) key configured for the App's bot identity,
 * and `commit.gpgsign` is `false`. A commit created through GitHub's Git Data
 * API with a GitHub **App installation token**, by contrast, is signed
 * server-side by GitHub and shows the **Verified** badge — no key on the VM
 * required.
 *
 * This is a minimal, self-contained port of the Git-Data-API commit flow. It is
 * built on this feature's `resolveGitHubToken()` (the same token
 * `scripts/mint-token.ts` prints) — it has no external monorepo or
 * `.agents/skills/*` dependency. The flow itself lives in
 * `commit-flow.ts` (and its shared pieces in `commit-api-core.ts`); this file
 * is just the CLI wrapper: argv parsing, `--message-file` read, process exit.
 *
 * # What it does
 *
 *   1. Resolve the token: the host-rotated `GH_TOKEN` for the default App, or
 *      a minted token when `--repo` routes to a registered alternate App.
 *   2. Read the branch's current head commit + its tree (the base tree).
 *   3. For every changed file in the worktree (`git status --porcelain`):
 *        - added / modified → create a blob, stage it in the new tree;
 *        - deleted          → stage a tree entry with `sha: null`.
 *   4. Create a new tree on top of the base tree.
 *   5. Create a commit (parent = old head) — **GitHub signs this**.
 *   6. Fast-forward the branch ref to the new commit.
 *   7. Point the worktree's local branch at it (fetch + mixed reset, only when
 *      the worktree is that branch at the old head), so the worktree reads
 *      clean and `git worktree remove` / the cleanup sweep can retire it.
 *
 * One signed commit covers an arbitrary mix of adds / modifies / deletes.
 *
 * # Usage
 *
 *   bun features/working-with-github/scripts/commit-via-api.ts \
 *     --worktree /tmp/worktrees/FEATURE \
 *     --branch my-branch \
 *     --message-file /tmp/msg.txt \
 *     [--repo owner/repo]   # default: $GITHUB_REPO
 *
 * `--repo` defaults to the `owner/repo` derived from the `GITHUB_REPO` env var
 * (a full https URL or a bare `owner/repo` both work). The branch must already
 * exist on the remote (create it from the base sha first — see prompt.md). On
 * success it prints the new commit sha and exits 0; on any failure it prints a
 * diagnostic to stderr and exits non-zero.
 */

import { Effect } from "effect";

import {
  CommitApiError,
  findUnknownFlag,
  findJunkArgv,
  isRepoUnset,
  resolveRepoFromEnv,
} from "./commit-api-core.ts";
import { commitViaApi } from "./commit-flow.ts";

export { CommitApiError, resolveRepoFromEnv } from "./commit-api-core.ts";
export type { ChangedFile, CommitArgs, CommitDeps } from "./commit-api-core.ts";
export { parseStatusZ } from "./commit-api-core.ts";
export { commitViaApi } from "./commit-flow.ts";

// #region CLI entrypoint

interface ParsedCli {
  readonly worktree: string;
  readonly branch: string;
  readonly messageFile: string;
  readonly repo: string;
}

/** Parse one `--flag value` pair off `argv` at `index`, or fail with an `args` error. */
const parseFlagPair = (
  argv: readonly string[],
  index: number
): Effect.Effect<
  { readonly key: string; readonly value: string },
  CommitApiError
> => {
  const key = argv[index];
  const value = argv[index + 1];
  if (key === undefined || !key.startsWith("--") || value === undefined) {
    return Effect.fail(
      new CommitApiError({
        stage: "args",
        message: `malformed argument near "${key ?? ""}"`,
      })
    );
  }
  // Trim BEFORE the flag-shape check: a value that is a flag modulo
  // surrounding whitespace (`--branch " --worktree "`) is the same omitted
  // value, but the raw token passed the guard first, trimmed to "--worktree",
  // and flowed on as a real branch — minting a token and creating blobs
  // before dying on the 404 from `GET /git/ref/heads/--worktree`, the same
  // late-failure class as the unpadded shape below. A following token that is
  // itself a flag means the value was omitted (e.g. `--branch --worktree`) —
  // the sibling CLIs (`mint-token.ts` `parseMintArgs`, `register-gh-app.ts`
  // `readFlag`, `cleanup-worktrees.ts` `parseCleanupArgs`) all reject it here
  // rather than persisting a garbage value. Accepted, it silently succeeds the
  // parse (branch "--worktree") and fails much later — or commits to whatever
  // branch literally carries that name.
  if (value.trim().startsWith("--")) {
    return Effect.fail(
      new CommitApiError({
        stage: "args",
        message: `flag "${key}" is missing its value (got "${value}", which is a flag)`,
      })
    );
  }
  // An empty (or whitespace-only) value is unusable — the same class as the
  // flag-shaped value above, and the same rule `mint-token.ts` applies to
  // `--repo`/`--org`/`--purpose`. Pre-fix, `--branch ""` parsed clean and the
  // flow failed LATE — after minting a token and creating blobs, on a 404
  // from `GET /git/ref/heads/` — instead of failing at the parse, after side
  // effects, with a message that never named the flag.
  if (value.trim() === "") {
    return Effect.fail(
      new CommitApiError({
        stage: "args",
        message: `flag "${key}" is missing its value (got an empty string)`,
      })
    );
  }
  // Trim surrounding whitespace, matching `mint-token.ts`'s `read` and
  // `register-gh-app.ts`'s `readFlag`: a padded value (`--branch " fix-x "`)
  // otherwise goes through raw and the flow fails LATE — a 404 from
  // `GET /git/ref/heads/ fix-x ` after minting a token and creating blobs —
  // or commits to a branch that literally carries the padding.
  return Effect.succeed({
    key: key.slice(2),
    value: value.trim(),
  });
};

const FLAG_STRIDE = 2;

/** Every flag the CLI accepts — anything else `--`-prefixed is a usage error
 *  (see {@link findUnknownFlag}), never a silently-dropped token that eats
 *  its value. */
const KNOWN_FLAGS = ["--worktree", "--branch", "--message-file", "--repo"] as const;

/** Parse `--flag value` argv into the CLI shape, or fail with an `args` error. */
export const parseCliArgs = (
  argv: readonly string[],
  // oxlint-disable-next-line node/no-process-env -- default deps seam; callers pass a fake env in tests.
  env: Readonly<Record<string, string | undefined>> = process.env
): Effect.Effect<ParsedCli, CommitApiError> =>
  Effect.gen(function* () {
    // A single-dash or equals-form argv token is a usage error in this CLI
    // too — the same `findJunkArgv` rule the sibling CLIs apply to the WHOLE
    // argv. The pair loop below only rejects the KEY position (its
    // `key.startsWith("--")` guard), so pre-fix the VALUE position slipped
    // through: `--branch -x` parsed clean with branch "-x", `--repo -repo`
    // parsed clean with repo "-repo" — and the flow then minted a token and
    // read `GET /git/ref/heads/-x` before failing, or committed to a branch
    // literally named "-x". #155 closed the shape in mint-token,
    // cleanup-worktrees and register-gh-app; this closes the fourth CLI's
    // remaining position so all four agree on the same argv.
    const junkArgv = findJunkArgv(argv);
    if (junkArgv !== undefined) {
      return yield* new CommitApiError({
        stage: "args",
        message: `unrecognized argument "${junkArgv}" — flags are space-separated "--repo owner/repo", never "--repo=owner/repo" or single-dash`,
      });
    }
    // A repeated `--flag` is a usage error, never a silent winner: the Map
    // below keys on the flag name, so pre-fix the LAST occurrence silently
    // won (`--repo acme/a --repo acme/b` committed to `acme/b`) — while the
    // sibling CLIs' `indexOf` readers took the FIRST, so one pasted command
    // block could mint a token for the first `--repo` and land the Verified
    // commit on the second. All four CLIs refuse the repeat, naming the flag.
    const seen = new Set<string>();
    // An unknown well-formed flag (`--mesage-file /x` — the typo for
    // `--message-file`) is a usage error here too: the pair loop below only
    // rejects the KEY position's shape, so pre-fix the unknown flag parsed
    // clean, its value token vanished with it, and the flow committed with
    // the message of the `--message-file` the argv ALSO carried (or failed
    // late on a missing one) — the flag the caller actually typed never
    // reached the flow at all. mint-token.ts refuses the same shape via its
    // own guard; one contract, four CLIs.
    const unknownFlag = findUnknownFlag(argv, KNOWN_FLAGS);
    if (unknownFlag !== undefined) {
      return yield* new CommitApiError({
        stage: "args",
        message: `unrecognized argument "${unknownFlag}" — flags are space-separated "--repo owner/repo", never "--repo=owner/repo", single-dash, or an unknown flag`,
      });
    }
    for (let i = 0; i < argv.length; i += FLAG_STRIDE) {
      const key = argv[i];
      if (key === undefined) {
        break;
      }
      if (seen.has(key)) {
        return yield* new CommitApiError({
          stage: "args",
          message: `flag "${key}" was passed more than once — pass exactly one value`,
        });
      }
      seen.add(key);
    }
    const flags = new Map<string, string>();
    for (let i = 0; i < argv.length; i += FLAG_STRIDE) {
      const pair = yield* parseFlagPair(argv, i);
      flags.set(pair.key, pair.value);
    }
    const worktree = flags.get("worktree");
    const branch = flags.get("branch");
    const messageFile = flags.get("message-file");
    // `--repo` tolerates the same spellings `GITHUB_REPO` does (a full https
    // URL with optional .git, or a bare owner/repo): the tool is unusable
    // against any URL-shaped repo name otherwise — every Git Data API call
    // 404s, since `/repos/https://github.com/o/r/...` is not a real route.
    const repo = resolveRepoFromEnv({
      ...env,
      GITHUB_REPO: flags.get("repo") ?? env.GITHUB_REPO,
    });
    const missing = [
      worktree === undefined ? "--worktree" : undefined,
      branch === undefined ? "--branch" : undefined,
      messageFile === undefined ? "--message-file" : undefined,
      repo === "" ? "--repo (or set GITHUB_REPO)" : undefined,
    ].filter((v): v is string => v !== undefined);
    if (
      worktree === undefined ||
      branch === undefined ||
      messageFile === undefined ||
      repo === ""
    ) {
      // An explicitly-passed `--repo` that RESOLVES to nothing is not
      // "missing" — the caller passed it, and telling them to pass it again
      // (or to set GITHUB_REPO, which may be healthy) is a dead end that
      // never names the actual cause: the spelling. Same for a SET-but-
      // unresolvable GITHUB_REPO. Pre-fix both cases folded into the
      // "missing required flag(s): --repo (or set GITHUB_REPO)" message
      // (#207's "name the actual cause" class, reopened through the repo
      // resolution path) — the flag case even claimed a flag the argv
      // carried was absent.
      const repoFlag = flags.get("repo");
      if (repo === "") {
        if (repoFlag !== undefined) {
          return yield* new CommitApiError({
            stage: "args",
            message: `--repo "${repoFlag}" resolves to no owner/repo — check its spelling (e.g. github.com/orgs, the organizations index, names no owner)`,
          });
        }
        if (!isRepoUnset(env)) {
          return yield* new CommitApiError({
            stage: "args",
            message: `GITHUB_REPO "${(env.GITHUB_REPO ?? "").trim()}" resolves to no owner/repo — check its spelling (e.g. github.com/orgs, the organizations index, names no owner)`,
          });
        }
      }
      return yield* new CommitApiError({
        stage: "args",
        message: `missing required flag(s): ${missing.join(", ")}`,
      });
    }
    return {
      worktree,
      branch,
      messageFile,
      repo,
    };
  });

const runCli = (): Promise<number> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const parsed = yield* parseCliArgs(process.argv.slice(2));
      const message = yield* Effect.tryPromise({
        try: () => Bun.file(parsed.messageFile).text(),
        catch: (cause) =>
          new CommitApiError({
            stage: "args",
            message: `could not read --message-file ${parsed.messageFile}: ${String(cause)}`,
          }),
      });
      // An empty (or whitespace-only) message file must fail HERE, at the
      // parse boundary — never after side effects. Pre-fix the trimmed ""
      // flowed through the whole flow: the mint, the ref/head reads, every
      // blob POST and the tree POST all landed, and only the final commit
      // POST came back 422 "Validation Failed" — leaving unreachable orphan
      // blobs/tree objects on the remote and a diagnostic that never named
      // the empty message. The same late-failure class the sibling flags
      // were closed for (`--branch ""` fails at the parse with a message
      // naming the flag, #111/#162).
      if (message.trim() === "") {
        return yield* new CommitApiError({
          stage: "args",
          message: `--message-file ${parsed.messageFile} is empty (its contents trimmed to nothing) — a commit needs a message`,
        });
      }
      const sha = yield* commitViaApi({
        worktree: parsed.worktree,
        branch: parsed.branch,
        message: message.trim(),
        repo: parsed.repo,
      });
      process.stdout.write(`${sha}\n`);
      return 0;
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          process.stderr.write(
            `commit-via-api: [${error.stage}] ${error.message}\n`
          );
          return 1;
        })
      )
    )
  );

// Only run the CLI when invoked directly (not when imported by a test).
if (import.meta.main) {
  process.exit(await runCli());
}

// #endregion
