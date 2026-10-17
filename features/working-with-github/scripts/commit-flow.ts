/**
 * commit-flow.ts — the mint→tree→commit→ref flow behind `commit-via-api.ts`.
 *
 * Split out of `commit-via-api.ts` (see that file for the full "why this
 * exists" / usage docs) purely to keep each module under the file-length lint
 * budget; there is no independent reuse story yet.
 */

import { Effect, Schema } from "effect";

import { mintInstallationToken } from "@ori-monorepo/working-with-github/gh-app-token-mint.ts";

import type {
  ChangedFile,
  CommitArgs,
  CommitDeps,
  FetchLike,
  ReadFile,
  RunGit,
} from "./commit-api-core.ts";

import {
  CommitApiError,
  EXEC_MODE,
  FILE_MODE,
  GITHUB_API,
  defaultRunGit,
  ghJson,
  parseStatusZ,
} from "./commit-api-core.ts";

// #region GitHub Git-Data-API response shapes

/** `POST /git/blobs`, `POST /git/trees`, `POST /git/commits` — each answers with
 *  the created object's sha, and nothing else here reads. */
const CreatedObject = Schema.Struct({
  sha: Schema.NonEmptyString,
});

/** `GET /git/ref/heads/{branch}` — the branch's head, under `object.sha`. */
const GitRef = Schema.Struct({
  object: Schema.Struct({ sha: Schema.NonEmptyString }),
});

/** `GET /git/commits/{sha}` — the commit's tree, the base the new tree sits on. */
const GitCommit = Schema.Struct({
  tree: Schema.Struct({ sha: Schema.NonEmptyString }),
});

/**
 * The ref fast-forward's response body is never read: the 2xx is the whole
 * signal, and holding its body to a shape would turn a landed push into a
 * failure the moment GitHub changes it.
 */
const IgnoredBody = Schema.Unknown;

// #endregion

// #region The commit flow

/**
 * Mint a fresh installation token for the target repo. Routing through
 * `mintInstallationToken({ targetRepo })` matters when `--repo` points at a
 * repo outside the default `GITHUB_REPO` org: the bare `GhApp` default only
 * discovers the installation for the default org, so a cross-org target would
 * mint a token that can't see the repo (every API call 404s).
 */
const mintToken = (targetRepo: string): Effect.Effect<string, CommitApiError> =>
  mintInstallationToken({ targetRepo }).pipe(
    Effect.map((token) => token.token),
    Effect.mapError(
      (error) =>
        new CommitApiError({
          stage: "mint",
          message: error.message,
        })
    )
  );

/** True if the path is tracked with the executable bit (mode 100755) in the index. */
const isExecutable = (
  worktree: string,
  path: string,
  runGit: RunGit
): boolean => {
  const result = runGit(["ls-files", "--stage", "--", path], worktree);
  if (!result.ok) {
    return false;
  }
  // Format: `<mode> <sha> <stage>\t<path>` — a new file is absent here → not exec.
  return result.stdout.startsWith(EXEC_MODE);
};

interface BuildTreeEntryInput {
  readonly file: ChangedFile;
  readonly args: CommitArgs;
  readonly token: string;
  readonly fetchImpl: FetchLike;
  readonly runGit: RunGit;
  readonly readFile: ReadFile;
}

interface TreeEntry {
  readonly path: string;
  readonly mode: string;
  readonly type: "blob";
  readonly sha: string | null;
  readonly content?: string;
}

/** Read one changed file's bytes and create a base64 blob for it. */
const createBlobForFile = (
  input: BuildTreeEntryInput
): Effect.Effect<string, CommitApiError> =>
  Effect.gen(function* () {
    // Read the file's bytes from disk and create a base64 blob — robust for both
    // text and binary content.
    const bytes = yield* Effect.tryPromise({
      try: () => input.readFile(`${input.args.worktree}/${input.file.path}`),
      catch: (cause) =>
        new CommitApiError({
          stage: "git",
          message: `could not read ${input.file.path}: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
    });
    const blob = yield* ghJson({
      fetchImpl: input.fetchImpl,
      token: input.token,
      method: "POST",
      schema: CreatedObject,
      url: `${GITHUB_API}/repos/${input.args.repo}/git/blobs`,
      body: {
        content: Buffer.from(bytes).toString("base64"),
        encoding: "base64",
      },
    });
    return blob.sha;
  });

/** Build one tree entry: a created blob sha for adds/mods, `sha: null` for deletes. */
const buildTreeEntry = (
  input: BuildTreeEntryInput
): Effect.Effect<TreeEntry, CommitApiError> =>
  Effect.gen(function* () {
    if (input.file.deleted) {
      return {
        path: input.file.path,
        mode: FILE_MODE,
        type: "blob" as const,
        sha: null,
      };
    }
    const blobSha = yield* createBlobForFile(input);
    const mode = isExecutable(
      input.args.worktree,
      input.file.path,
      input.runGit
    )
      ? EXEC_MODE
      : FILE_MODE;
    return {
      path: input.file.path,
      mode,
      type: "blob" as const,
      sha: blobSha,
    };
  });

/** Discover the worktree's changes, failing typed when there are none. */
const discoverChangedFiles = (
  args: CommitArgs,
  runGit: RunGit
): Effect.Effect<ChangedFile[], CommitApiError> =>
  Effect.gen(function* () {
    const status = runGit(
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      args.worktree
    );
    if (!status.ok) {
      return yield* new CommitApiError({
        stage: "git",
        message: `git status failed: ${status.stderr.trim()}`,
      });
    }
    const changed = parseStatusZ(status.stdout);
    if (changed.length === 0) {
      return yield* new CommitApiError({
        stage: "nothing-to-commit",
        message: "no changes in worktree",
      });
    }
    return changed;
  });

interface BaseTreeInput {
  readonly args: CommitArgs;
  readonly token: string;
  readonly fetchImpl: FetchLike;
}

/** Read the branch's head commit sha + its base tree sha. */
const readBaseTree = (
  input: BaseTreeInput
): Effect.Effect<
  { readonly headSha: string; readonly baseTreeSha: string },
  CommitApiError
> =>
  Effect.gen(function* () {
    const ref = yield* ghJson({
      fetchImpl: input.fetchImpl,
      token: input.token,
      method: "GET",
      schema: GitRef,
      url: `${GITHUB_API}/repos/${input.args.repo}/git/ref/heads/${encodeURIComponent(input.args.branch)}`,
    });
    const headSha = ref.object.sha;
    const headCommit = yield* ghJson({
      fetchImpl: input.fetchImpl,
      token: input.token,
      method: "GET",
      schema: GitCommit,
      url: `${GITHUB_API}/repos/${input.args.repo}/git/commits/${headSha}`,
    });
    return {
      headSha,
      baseTreeSha: headCommit.tree.sha,
    };
  });

interface BuildTreeInput {
  readonly args: CommitArgs;
  readonly token: string;
  readonly fetchImpl: FetchLike;
  readonly runGit: RunGit;
  readonly readFile: ReadFile;
  readonly changed: readonly ChangedFile[];
  readonly baseTreeSha: string;
}

/** Build every changed file's tree entry, then create the new tree on top of `baseTreeSha`. */
const buildNewTree = (
  input: BuildTreeInput
): Effect.Effect<string, CommitApiError> =>
  Effect.gen(function* () {
    const entryEffects = input.changed.map((file) =>
      buildTreeEntry({
        file,
        args: input.args,
        token: input.token,
        fetchImpl: input.fetchImpl,
        runGit: input.runGit,
        readFile: input.readFile,
      })
    );
    const treeEntries = yield* Effect.all(entryEffects);
    const newTree = yield* ghJson({
      fetchImpl: input.fetchImpl,
      token: input.token,
      method: "POST",
      schema: CreatedObject,
      url: `${GITHUB_API}/repos/${input.args.repo}/git/trees`,
      body: {
        base_tree: input.baseTreeSha,
        tree: treeEntries,
      },
    });
    return newTree.sha;
  });

interface CreateAndPushCommitInput {
  readonly args: CommitArgs;
  readonly token: string;
  readonly fetchImpl: FetchLike;
  readonly headSha: string;
  readonly newTreeSha: string;
}

/** Create the (GitHub-signed) commit on top of `newTreeSha`, then fast-forward the branch ref to it. */
const createAndPushCommit = (
  input: CreateAndPushCommitInput
): Effect.Effect<string, CommitApiError> =>
  Effect.gen(function* () {
    // Create the commit — GitHub signs it (Verified) because the token is an
    // App installation token.
    const commit = yield* ghJson({
      fetchImpl: input.fetchImpl,
      token: input.token,
      method: "POST",
      schema: CreatedObject,
      url: `${GITHUB_API}/repos/${input.args.repo}/git/commits`,
      body: {
        message: input.args.message,
        tree: input.newTreeSha,
        parents: [input.headSha],
      },
    });
    const newCommitSha = commit.sha;

    // Fast-forward the branch ref to the new commit.
    yield* ghJson({
      fetchImpl: input.fetchImpl,
      token: input.token,
      method: "PATCH",
      schema: IgnoredBody,
      url: `${GITHUB_API}/repos/${input.args.repo}/git/refs/heads/${encodeURIComponent(input.args.branch)}`,
      body: {
        sha: newCommitSha,
        force: false,
      },
    });

    return newCommitSha;
  });

/**
 * Create one GitHub-signed commit from the worktree's changes. Succeeds with
 * the new commit sha; any stage failure is a `CommitApiError` in the failure
 * channel. `git` and `fetch` are injected (defaults are real) so the whole flow
 * is unit-testable with no repo and no network.
 */
export const commitViaApi = (
  args: CommitArgs,
  deps: CommitDeps = {}
): Effect.Effect<string, CommitApiError> => {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const runGit = deps.runGit ?? defaultRunGit;
  const readFile =
    deps.readFile ??
    ((absolutePath: string): Promise<ArrayBuffer> =>
      Bun.file(absolutePath).arrayBuffer());

  return Effect.gen(function* () {
    // 1. Resolve a token (injected wins; else mint for the target repo).
    const token = deps.token ?? (yield* mintToken(args.repo));

    // 2. Discover the worktree's changes.
    const changed = yield* discoverChangedFiles(args, runGit);

    // 3. Read the branch head + its base tree.
    const { headSha, baseTreeSha } = yield* readBaseTree({
      args,
      token,
      fetchImpl,
    });

    // 4. Build the new tree's entries and create the new tree.
    const newTreeSha = yield* buildNewTree({
      args,
      token,
      fetchImpl,
      runGit,
      readFile,
      changed,
      baseTreeSha,
    });

    // 5-6. Create the commit and fast-forward the branch ref to it.
    return yield* createAndPushCommit({
      args,
      token,
      fetchImpl,
      headSha,
      newTreeSha,
    });
  });
};

// #endregion
