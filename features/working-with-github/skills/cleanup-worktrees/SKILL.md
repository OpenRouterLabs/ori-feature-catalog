---
name: cleanup-worktrees
description: >
  Remove worktrees under /tmp/worktrees/<repo-slug>/ that the worktree-first self-modification workflow (see the feature prompt's "Modifying your own code" section) left behind after their PR merged or closed. TRIGGER when asked to clean up, prune, or remove old/stale/leftover worktrees ("clean up your worktrees", "prune old worktrees", "how much disk space are your worktrees using"), when told a self-modification task is done or abandoned and its worktree should go away, or when `git worktree add` fails because a worktree/branch from a previous run is still around. Runs bun "$WWG"/scripts/cleanup-worktrees.ts, which only removes a worktree when its branch's PR is merged/closed AND the worktree has no uncommitted changes — everything else is reported, never force-deleted. DO NOT TRIGGER for creating a new worktree (that's the "Modifying your own code" flow in the feature prompt) or for removing a worktree that's still mid-task.
---

# Cleaning up worktrees

The worktree-first workflow ends with a single `git worktree remove "$WT"` as its last step — but that line never runs if the process crashes, gets killed, or a PR is merged/closed by someone else after the run has moved on. Worktrees (each a full checkout with its own `node_modules`) accumulate under `/tmp/worktrees/` with nothing to sweep them. This skill covers the tool that does.

## The safety model

A worktree is removed only when **both** hold:

- Its branch has a **merged or closed** PR (matched via `GET /pulls?head=owner:branch`) — never an open PR, and never "no PR found at all". An abandoned branch with no PR is **reported, not deleted**, since nothing signals the work is actually done.
- `git status --porcelain` in the worktree is **empty** — no uncommitted changes.

Every other case (open PR, no PR found, dirty tree) is reported with a reason and left untouched. A directory on disk that `git worktree list` doesn't recognize (e.g. one manually `rm -rf`'d outside git) is reported as a **stray** and never acted on directly — only `git worktree prune` (run automatically, once per sweep) clears git's own bookkeeping for it.

## Run it

Run from your repo checkout, same expectation as the worktree-creation flow — `git worktree list`/`prune`/`remove` need a real git working directory, not just the worktrees-root container:

```bash
bun "$WWG"/scripts/cleanup-worktrees.ts
```

Prints one line per worktree it looked at, e.g.:

```text
[removed] /tmp/worktrees/acme-corp-intern-base/fix-linear-typo — removed (PR #42 closed, tree clean)
[skipped-open-pr] /tmp/worktrees/acme-corp-intern-base/add-feature — PR #43 is still open
[skipped-no-pr] /tmp/worktrees/acme-corp-intern-base/abandoned-idea — no PR found for this branch
```

- `--dry-run` — show every decision without removing anything. Use this first if you're unsure what a sweep would do.
- `--repo owner/repo` — sweep a different repo's slug directory. Defaults to `$GITHUB_REPO`, so only your own repo's worktrees are swept by default; cleaning up worktrees left behind while fixing a **composed/upstream** feature (see the feature prompt's upstream-fix guidance) needs this flag pointed at `$UPSTREAM` explicitly. **Pair it with `--repo-dir`**: `git worktree list` runs from the checkout you're standing in, and it only knows that repo's worktrees. Sweeping `$UPSTREAM`'s slug from your own repo's checkout reports every upstream worktree as a false `stray` ("unknown to `git worktree list`") and removes nothing — the dir is healthy, just tracked by a different checkout, so the report's own `git worktree prune` advice is a no-op there too.
- `--repo-dir /path/to/checkout` — override the repo checkout the git commands run from. Defaults to the current working directory. Pass a checkout **of the repo named by `--repo`** whenever `--repo` names a repo other than the one you're standing in — the sweep needs it to see the worktrees at all (see the `--repo` note above).

In App mode (`GH_APP_ID` set) it mints its own token internally (same as `commit-via-api.ts`) — you don't pass it one. In ambient mode (`GH_APP_ID` unset) there is no App to mint from: the sweep runs with no token and the PR lookup goes bare through the host's proxy-attached credential, the same ambient REST path the feature prompt teaches.

## Rules

- Never pass `--worktrees-root` in normal use — it exists for tests, not for redirecting a real sweep somewhere outside `/tmp/worktrees/`.
- A worktree `git` itself tracks outside `/tmp/worktrees/<slug>/` (most notably the repo checkout you're running this from) is simply out of scope — it's never reported, and never touched.
- If a worktree is stuck (e.g. `git worktree remove` fails because of an unexpected lock), fix the root cause manually rather than reaching for `rm -rf` on the directory — that leaves git's own metadata dangling, which is exactly what `git worktree prune` (run automatically here) exists to clean up on the next sweep.
