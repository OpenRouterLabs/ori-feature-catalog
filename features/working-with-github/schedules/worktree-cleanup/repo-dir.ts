/**
 * repo-dir.ts — resolve the directory the worktree-cleanup sweep's git
 * commands run from.
 *
 * Deliberately free of any `ori` import (unlike `schedule.ts`, whose only
 * other import is `ori`) so a test can value-import this module on a fresh
 * checkout where `ori` is a gitignored local SDK that `bun install` cannot
 * resolve — the same isolation discipline as `gh-auth-health.ts` and
 * `cleanup-worktrees-core.ts`.
 */

/**
 * Prefer `ORI_INTERN_WORKSPACE_ROOT` (the workspace checkout): the daemon is
 * started from `/workspace`, one level ABOVE the actual git checkout, and
 * `git worktree list`/`prune`/`remove` there fail with "not a git
 * repository", silently no-oping every daily sweep. Fall back to
 * `process.cwd()` only when it is unset. A blank value is unset, and the
 * returned path is trimmed so a padded one does not point git at a
 * nonexistent directory.
 */
export const resolveRepoDir = (): string => {
  const fromEnv = (process.env.ORI_INTERN_WORKSPACE_ROOT ?? "").trim();
  return fromEnv !== "" ? fromEnv : process.cwd();
};