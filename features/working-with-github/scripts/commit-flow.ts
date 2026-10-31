/**
 * commit-flow.ts — the mint→tree→commit→ref flow behind `commit-via-api.ts`.
 *
 * Split out of `commit-via-api.ts` (see that file for the full "why this
 * exists" / usage docs) purely to keep each module under the file-length lint
 * budget; there is no independent reuse story yet.
 */

import { Effect, Schema } from "effect";

import { accessSync, constants, lstatSync } from "node:fs";
import { readlink } from "node:fs/promises";

import { resolveGitHubToken } from "@ori-monorepo/working-with-github/gh-app-token-mint.ts";

import type {
  ChangedFile,
  CommitArgs,
  CommitDeps,
  FetchLike,
  ReadLink,
  ReadFile,
  RunGit,
} from "./commit-api-core.ts";

import {
  CommitApiError,
  EXEC_MODE,
  FILE_MODE,
  GITLINK_MODE,
  GITHUB_API,
  defaultRunGit,
  ghJson,
  parseStatusZ,
  SYMLINK_MODE,
} from "./commit-api-core.ts";

/**
 * Percent-encode ONLY the characters GitHub's Git-Data-API ref path treats
 * as delimiters — not the `/` that separates ref-path segments. `GET
 * /repos/{repo}/git/ref/heads/{branch}` routes the branch as PATH segments
 * (`owner/repo/…/heads/<a>/<b>` for `a/b`), and GitHub answers 404 for
 * `%2F`-encoded slashes (verified live; the same behavior the go-gh team
 * fixed in cli/cli#10049 and go-github documents for repo branch names).
 * `encodeURIComponent` alone over-encodes: it emits `%2F` for every `/`,
 * so ANY branch with a slash — the feature prompt's own `branch-name`
 * convention is `fix/<topic>` — fails the ref lookup with 404. `#` and `?`
 * MUST still be encoded (they delimit the fragment/query), so a hand-rolled
 * `encodeURI`-style pass encodes the reserved set except `/`.
 */
const encodeRefPathSegment = (branch: string): string =>
  encodeURIComponent(branch).replaceAll("%2F", "/");

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
 * Get the token for the target repo. Routing through
 * `resolveGitHubToken({ targetRepo })` matters when `--repo` points at a repo
 * covered by a registered alternate App: the default App's host-rotated
 * `GH_TOKEN` can't see it (every API call 404s).
 */
const mintToken = (targetRepo: string): Effect.Effect<string, CommitApiError> =>
  resolveGitHubToken({ targetRepo }).pipe(
    Effect.map((token) => token.token),
    Effect.mapError(
      (error) =>
        new CommitApiError({
          stage: "mint",
          message: error.message,
        })
    )
  );

/** True when the worktree path is a symbolic link (`lstat` — the link itself,
 *  not its target; a dangling link is still a link). */
const isSymlink = (worktree: string, path: string): boolean => {
  try {
    return lstatSync(`${worktree}/${path}`).isSymbolicLink();
  } catch {
    return false;
  }
};

/** True when the worktree path is a directory on disk (`lstat`, not `stat` —
 *  a symlink to a directory is still a symlink blob, not a directory). */
const isDirectory = (worktree: string, path: string): boolean => {
  try {
    return lstatSync(`${worktree}/${path}`).isDirectory();
  } catch {
    return false;
  }
};

/**
 * The commit sha a gitlink entry points at, for a path git tracks as mode
 * `160000` (a submodule or embedded repo). The nested repo's OWN `HEAD` is
 * the sha `git add` stages for the path: a bumped-but-unstaged submodule
 * (` M sub` — exactly the porcelain record this branch handles) leaves the
 * index row at the OLD commit while the nested repo has already moved, so
 * reading the index row first would commit a STALE gitlink — a sha the
 * branch's own history says was superseded, and a silent divergence from
 * `git add -A && git commit` on the same worktree. Read the nested HEAD
 * first; fall back to the index row only when the nested repo cannot answer
 * (e.g. a submodule whose working tree was not checked out, where `git add`
 * itself reads the index row). Returns null when the path holds no nested
 * repo: a plain untracked directory has no commit to point at and is skipped
 * instead, matching what `git add -A` stages for it (nothing).
 */
const gitlinkSha = (
  worktree: string,
  path: string,
  runGit: RunGit
): string | null => {
  // Nested HEAD first — see the docblock: `git add -A` records the nested
  // repo's current HEAD for a gitlink path, not the (possibly stale) index row.
  const head = runGit(["rev-parse", "HEAD"], `${worktree}/${path}`);
  if (head.ok && head.stdout.trim() !== "") {
    return head.stdout.trim();
  }
  const staged = runGit(["ls-files", "--stage", "--", path], worktree);
  if (staged.ok && staged.stdout.startsWith(`${GITLINK_MODE} `)) {
    const sha = staged.stdout.split(/\s+/u)[1] ?? "";
    if (sha !== "") {
      return sha;
    }
  }
  return null;
};

/** The default readlink seam: resolve a symlink to its target string. */
const defaultReadLink = (absolutePath: string): Promise<string> =>
  readlink(absolutePath);

/** True when git tracks the worktree's file mode for this repo
 *  (`core.fileMode`, default true). When it is false — a checkout on a
 *  filesystem without real permission bits (Windows/CIFS/FAT), where every
 *  file reads as executable — git ignores chmods entirely and the index
 *  row's mode is what a commit preserves. */
const tracksFileMode = (worktree: string, runGit: RunGit): boolean => {
  const result = runGit(["config", "--get", "core.fileMode"], worktree);
  // Unset (exit 1) or a failed call → git's default: the mode is tracked.
  return !(result.ok && result.stdout.trim() === "false");
};

/** True if the worktree file carries the executable bit on disk. */
const diskExecutable = (worktree: string, path: string): boolean => {
  try {
    accessSync(`${worktree}/${path}`, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** True if the path should be committed with the executable bit (mode 100755).
 *  Mirrors git's own rule for what `git add` stages, which keys on
 *  `core.fileMode` FIRST — even for an untracked (newly added) file:
 *  - The repo tracks file modes (the default): the worktree's own exec bit —
 *    for a new file that is the only source, and for a tracked file the index
 *    row is STALE for a chmod-ed file until it is restaged, so trusting it
 *    would silently drop a `chmod +x` (or keep a dropped bit).
 *  - `core.fileMode` is false: never the disk bit — on a filesystem without
 *    real permission bits (Windows/CIFS/FAT) every file reads as executable,
 *    so `git add` records 100644 for everything; committing the raw disk bit
 *    would stage every new file as 100755 and diverge from the branch's own
 *    history. A tracked file keeps its index row's mode (git preserves it
 *    as-is); a new file is 100644, as `git add` would record.
 */
const isExecutable = (
  worktree: string,
  path: string,
  runGit: RunGit
): boolean => {
  if (!tracksFileMode(worktree, runGit)) {
    const result = runGit(["ls-files", "--stage", "--", path], worktree);
    const hasIndexRow = result.ok && result.stdout !== "";
    // Format: `<mode> <sha> <stage>\t<path>` — git preserves this as-is.
    return hasIndexRow && result.stdout.startsWith(EXEC_MODE);
  }
  return diskExecutable(worktree, path);
};

interface BuildTreeEntryInput {
  readonly file: ChangedFile;
  readonly args: CommitArgs;
  readonly token: string;
  readonly fetchImpl: FetchLike;
  readonly runGit: RunGit;
  readonly readFile: ReadFile;
  readonly readLink: ReadLink;
}

interface TreeEntry {
  readonly path: string;
  readonly mode: string;
  /** A gitlink entry is a commit pointer, everything else is a blob. */
  readonly type: "blob" | "commit";
  /** Null only for a deletion; an entry that stages nothing is not built. */
  readonly sha: string | null;
  readonly content?: string;
}

/** Create a blob from raw text content (a symlink's target string) — the
 *  Git-Data form of what `git add` writes for a `120000` entry. */
const createTextBlob = (
  input: BuildTreeEntryInput,
  content: string
): Effect.Effect<string, CommitApiError> =>
  ghJson({
    fetchImpl: input.fetchImpl,
    token: input.token,
    method: "POST",
    schema: CreatedObject,
    url: `${GITHUB_API}/repos/${input.args.repo}/git/blobs`,
    body: {
      content,
      encoding: "utf-8",
    },
  }).pipe(Effect.map((blob) => blob.sha));

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
): Effect.Effect<TreeEntry | null, CommitApiError> =>
  Effect.gen(function* () {
    if (input.file.deleted) {
      return {
        path: input.file.path,
        mode: FILE_MODE,
        type: "blob" as const,
        sha: null,
      };
    }
    // A symbolic link is a `120000` blob whose CONTENT is the link-target
    // string — never the target's own bytes. Reading the worktree path with
    // `readFile` would follow the link (a valid target's CONTENT lands under
    // the link's path as a regular file; a dangling link ENOENTs and fails
    // the whole commit), and either way the commit diverges from what
    // `git add`/`git commit` produce for the same worktree.
    if (isSymlink(input.args.worktree, input.file.path)) {
      let target: string;
      try {
        target = yield* Effect.tryPromise({
          try: () => input.readLink(`${input.args.worktree}/${input.file.path}`),
          catch: (cause) =>
            new CommitApiError({
              stage: "git",
              message: `could not read symlink ${input.file.path}: ${cause instanceof Error ? cause.message : String(cause)}`,
            }),
        });
      } catch (error) {
        return yield* Effect.fail(
          error instanceof CommitApiError
            ? error
            : new CommitApiError({
                stage: "git",
                message: `could not read symlink ${input.file.path}: ${String(error)}`,
              })
        );
      }
      const sha = yield* createTextBlob(input, target);
      return {
        path: input.file.path,
        mode: SYMLINK_MODE,
        type: "blob" as const,
        sha,
      };
    }
    // A directory on disk is a gitlink (`160000`) commit entry when it holds
    // a nested git repo (submodule or embedded), never a blob: reading the
    // directory as a file fails the whole run ("Directories cannot be read
    // like files"), and a regular-file entry would diverge from what `git
    // add -A && git commit` produce for the same worktree.
    if (isDirectory(input.args.worktree, input.file.path)) {
      const linkedSha = gitlinkSha(
        input.args.worktree,
        input.file.path,
        input.runGit
      );
      if (linkedSha === null) {
        // The only `?? dir/` records that reach here hold a nested git
        // repo (submodule or embedded) — `--untracked-files=all` flattens
        // every plain directory into per-file records, so a plain dir never
        // arrives. No sha means the nested repo has no commit checked out
        // (an unborn HEAD: `git init`, nothing committed yet). `git add -A`
        // refuses the WHOLE commit on this worktree ("'<path>/' does not
        // have a commit checked out", exit 128) — so the flow refuses too.
        // Pre-fix it silently skipped the record and landed a green
        // `Verified` commit that ignored the path — a divergence `git`
        // itself refuses, and a `sha: null` entry would instead DELETE
        // the path. Commit the nested repo first, or gitignore the path.
        return yield* new CommitApiError({
          stage: "git",
          message: `nested git repo at ${input.file.path} has no commit checked out (git add -A refuses this worktree: "'${input.file.path}/' does not have a commit checked out") — commit the nested repo first, or add it to .gitignore`,
        });
      }
      return {
        path: input.file.path,
        mode: GITLINK_MODE,
        type: "commit" as const,
        sha: linkedSha,
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
    const { changed, unmerged } = parseStatusZ(status.stdout);
    if (unmerged.length > 0) {
      // A conflicted worktree: `git commit` refuses it, and committing the
      // markers into a Verified commit would corrupt the branch. Refuse the
      // same way — resolve the conflicts first.
      return yield* new CommitApiError({
        stage: "nothing-to-commit",
        message: `worktree has unmerged (conflicted) paths: ${unmerged.join(", ")}. Resolve the conflicts, then commit.`,
      });
    }
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
      // The branch is PATH segments, not one encoded segment: a `%2F`-encoded
      // slash makes GitHub answer 404 for every slash-bearing branch name,
      // and the feature prompt's own branch convention (`fix/<topic>`)
      // always carries one.
      url: `${GITHUB_API}/repos/${input.args.repo}/git/ref/heads/${encodeRefPathSegment(input.args.branch)}`,
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
  readonly readLink: ReadLink;
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
        readLink: input.readLink,
      })
    );
    const built = yield* Effect.all(entryEffects);
    // A `null` entry is one the flow deliberately skipped (a plain untracked
    // directory with no nested repo): it stages nothing, so it must not
    // reach the tree API at all — not even as a `sha: null` removal.
    const treeEntries = built.filter(
      (entry): entry is TreeEntry => entry !== null
    );
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
      // Same path-segment rule as the ref read: a `%2F`-encoded slash would
      // 404 every slash-bearing branch.
      url: `${GITHUB_API}/repos/${input.args.repo}/git/refs/heads/${encodeRefPathSegment(input.args.branch)}`,
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
  const readLink = deps.readLink ?? defaultReadLink;

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
      readLink,
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
