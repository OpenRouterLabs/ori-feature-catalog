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
 * built on this feature's `mintInstallationToken()` (the same token mint that
 * `scripts/mint-token.ts` prints for ephemeral `GH_TOKEN` injection) — it has no
 * external monorepo or `.agents/skills/*` dependency. The flow itself lives in
 * `commit-flow.ts` (and its shared pieces in `commit-api-core.ts`); this file
 * is just the CLI wrapper: argv parsing, `--message-file` read, process exit.
 *
 * # What it does
 *
 *   1. Mint a fresh installation token (or honour an injected `GH_TOKEN`).
 *   2. Read the branch's current head commit + its tree (the base tree).
 *   3. For every changed file in the worktree (`git status --porcelain`):
 *        - added / modified → create a blob, stage it in the new tree;
 *        - deleted          → stage a tree entry with `sha: null`.
 *   4. Create a new tree on top of the base tree.
 *   5. Create a commit (parent = old head) — **GitHub signs this**.
 *   6. Fast-forward the branch ref to the new commit.
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

import { CommitApiError, resolveRepoFromEnv } from "./commit-api-core.ts";
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
  return Effect.succeed({
    key: key.slice(2),
    value,
  });
};

const FLAG_STRIDE = 2;

/** Parse `--flag value` argv into the CLI shape, or fail with an `args` error. */
export const parseCliArgs = (
  argv: readonly string[],
  // oxlint-disable-next-line node/no-process-env -- default deps seam; callers pass a fake env in tests.
  env: Readonly<Record<string, string | undefined>> = process.env
): Effect.Effect<ParsedCli, CommitApiError> =>
  Effect.gen(function* () {
    const flags = new Map<string, string>();
    for (let i = 0; i < argv.length; i += FLAG_STRIDE) {
      const pair = yield* parseFlagPair(argv, i);
      flags.set(pair.key, pair.value);
    }
    const worktree = flags.get("worktree");
    const branch = flags.get("branch");
    const messageFile = flags.get("message-file");
    const repo = flags.get("repo") ?? resolveRepoFromEnv(env);
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
