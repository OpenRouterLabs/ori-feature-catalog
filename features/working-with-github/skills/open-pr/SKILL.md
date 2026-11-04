---
name: open-pr
description: >
  Get a pull request ready the way the target repository expects, open it fast, and follow it until CI is green without blocking the conversation. TRIGGER before opening any pull request in any repository, whatever the language, host org or company, before pushing more commits to an open one, and when asked why a PR you opened failed CI or has a thin description. It covers getting the code with a temporary partial clone, reading the repo's own rules in full (AGENTS.md, CONTRIBUTING, the PR template, CI workflows, hooks and repo skills), running the checks its git hooks would have run (your API commits skip them), running the tests scoped to the change while CI runs the rest, filling every section of the template, and following CI with scheduled check-ins instead of waiting inside the turn. DO NOT TRIGGER for reviewing someone else's PR (code-review) or for merging (the feature prompt's "Merging your own PRs").
---

# Opening a pull request

A PR is done when it passes the repository's own bar, not yours. Every repository writes that bar down in a different place, and your commits skip the hooks that enforce part of it. So read the rules, run the checks yourself, fill in the template, and follow CI until it is green.

Be fast without skipping a check. Most of the time to a PR goes to three things, so avoid them:

- **Downloading and indexing the whole repository.** Work in a temporary partial clone (step 1). It fetches file contents only for the directories you check out, and it is already a git repo, so you never need to `git init` it to get a diff.
- **One small tool call after another.** Each call waits on a full model round trip. Put independent reads in one call: read every rules file in one command, run every search in one command.
- **Retrying what already failed.** When a command fails the same way twice, stop and change the approach. A loop that "fixes" an error must check that each pass made progress, and stop when it didn't.
- **Waiting on CI inside the turn.** Never `sleep` waiting on CI. Post the PR link the moment the PR exists, then follow CI with scheduled check-ins (step 8).

Nothing here assumes a language, a package manager, a CI vendor or a company. Use whatever the repository uses. `$REPO` is the target `owner/repo` and `$WT` is your checkout.

## 1. Get the code: a temporary partial clone

```bash
WT=/tmp/worktrees/${REPO//\//-}/<branch>
git clone -q --depth 1 --filter=blob:none --sparse "https://github.com/$REPO.git" "$WT"
cd "$WT"
git ls-tree -r --name-only HEAD | grep -i '<words from the task>'   # every path, without downloading files
git sparse-checkout set --skip-checks .github .agents .claude .lefthook .husky .githooks <dirs the change touches>
git grep -n '<symbol>' -- <dir>                                    # search only what is checked out
```

- Root files (`AGENTS.md`, `package.json`, hook configs) are always checked out; `set` adds the directories. Add more with `git sparse-checkout add --skip-checks <dir>` as you learn what the change needs.
- `--skip-checks` is needed for directory names with `[`, `]`, `*` or `?` in them, which are common in web routing trees (`app/[locale]/…`).
- Search with `git grep` or `rg`, never a plain recursive `grep`. Find which directories to check out with `git ls-tree` first, rather than checking out everything.
- When the clone answers HTTP 429 (rate limited), wait about 20 seconds and retry once. When cloning is not allowed at all, download the tarball instead, as the feature prompt describes.
- In App mode, put the token in the clone URL for that one command, never in git config (see the feature prompt). Commit from `$WT` with `commit-via-api.ts --worktree "$WT"`, or the REST API in ambient mode.
- Delete `$WT` when the PR is up and you no longer need it. Nothing is kept between tasks.
- Run your own helper scripts (a `bun -e` one-liner, a commit script) from outside `$WT` (`cd /tmp`, then pass paths in). A repository's runtime config, such as a `bunfig.toml` preload, `.npmrc` or `.nvmrc`, applies to anything started inside it and can break a script that has nothing to do with the repository.

## 2. Read the repository's rules, all of them, in one call

Read each file that exists in full, never from memory or a summary. Long `AGENTS.md` files get cut off when they are loaded automatically, and the part that gets cut is usually the PR checklist.

```bash
cd "$WT"; for f in AGENTS.md CLAUDE.md CONTRIBUTING.md CONTRIBUTING .github/CONTRIBUTING.md docs/CONTRIBUTING.md \
  .github/PULL_REQUEST_TEMPLATE.md .github/pull_request_template.md PULL_REQUEST_TEMPLATE.md \
  .github/PULL_REQUEST_TEMPLATE/* docs/pull_request_template.md \
  lefthook.yml lefthook.yaml .pre-commit-config.yaml .overcommit.yml commitlint.config.* .commitlintrc*; do
  [ -f "$f" ] && printf '\n===== %s\n' "$f" && cat "$f"; done
ls .husky .lefthook .githooks Makefile justfile Taskfile.yml package.json pyproject.toml Cargo.toml go.mod 2>/dev/null
for f in .husky/* .lefthook/*/* .lefthook/*.sh .githooks/*; do [ -f "$f" ] && printf '\n===== %s\n' "$f" && cat "$f"; done   # the commands the hook config runs often live here
# Rules for the directories you touch: an AGENTS.md in any of their parents.
for d in <dirs the change touches>; do while [ "$d" != "." ] && [ -n "$d" ]; do
  [ -f "$d/AGENTS.md" ] && printf '\n===== %s\n' "$d/AGENTS.md" && cat "$d/AGENTS.md"; d=$(dirname "$d"); done; done
ls .github/workflows/ .circleci/ .gitlab-ci.yml .buildkite/ 2>/dev/null; grep -ln 'draft' .github/workflows/* 2>/dev/null
```

From them, write down before you start:

- the **pre-push command** (`verify`, `check`, `make check`, `just ci`, `tox`…) and the fast command to use while iterating (a `fix` or `format` script);
- the **title rule**: conventional commits, a scope list, a required ticket id (a Jira, Linear or GitHub issue key);
- the **PR template** headings, in order;
- **gated topics**: a security, privacy, compliance, migration or visual-regression review the rules require when the diff touches certain paths;
- every **CI job that checks the PR itself**, not the code. Search the CI config for `PR_BODY`, `pull_request.body`, `title`, `description` or `metadata`, and note the script each one runs and the env vars it reads;
- whether **CI skips draft PRs** (a workflow that checks `pull_request.draft`). Many repositories run nothing on a draft.

## 3. Find the repo's own skills that apply

Repositories may ship their own agent skills. List every name and description in one call, then open the ones that fit the change: the area or paths you touched, and anything about commits, PR text, security, privacy, tests or screenshots.

```bash
for f in "$WT"/.agents/skills/*/SKILL.md "$WT"/.claude/skills/*/SKILL.md "$WT"/.cursor/rules/*; do
  [ -f "$f" ] && printf '%s: %s\n' "$f" "$(grep -m1 '^description:' "$f" | cut -c1-200)"
done
```

When the list is long, grep it for words from your diff (package names, directories, `security`, `pr`, `commit`, `test`) instead of skimming. Do what a matching skill says.

## 4. Run what the hooks would have run

Your commits go through the Git Data API (`commit-via-api.ts`, or the REST API in ambient mode), and that path never runs lefthook, husky, pre-commit or any other git hook. Formatting, lint, commit-message rules and generated files are your job now. Read the hook config from step 2, including the scripts it calls, and run each `pre-commit` and `pre-push` command yourself, on the changed files where the hook passes them. When the repository has a `commit-msg` rule (a commitlint config, a `commit-msg` hook), check your commit message and PR title against it too.

When a hook regenerates files (docs indexes, lockfiles, codegen), run the generator and commit what it changed. If you skip that, CI's "generated files are stale" check fails.

## 5. Run the checks scoped to the change

Before the first push, run the checks scoped to your change. They take seconds, and CI runs the full suite:

1. the formatter and linter on the changed files;
2. the typecheck or build of each package you touched;
3. the tests related to the change: tests next to the changed files, and tests that import, load or read them. Use the repo's own tool for this where it has one (`jest --findRelatedTests`, `vitest related`, `nx affected`, `turbo run test --filter=...[<base>]`, `pytest <paths>`, `go test ./<pkg>/...`, `cargo test -p <crate>`); otherwise `git grep` the test files for the changed paths and module names. A change only to docs or prompts still runs the tests that read those files.

Install only what those checks need, with the package manager's own workspace filter: `bun install --filter <pkg>`, `pnpm install --filter <pkg>...`, `npm install -w <pkg>`, `yarn workspaces focus <pkg>`, `uv sync --package <pkg>`; a Cargo or Go build already fetches only what the crate or package needs. Check the touched package's directories out first so the filter can see them. Never resolve a monorepo's imports by hand (linking packages one missing module at a time): it is slow, and installing a dependency at a version other than the lockfile's breaks in ways that look like the change's fault. Before a heavy step, look at the machine (`nproc; free -g; df -h .`). When a check cannot run here (no room for the dependencies, a service it needs, a filter the package manager does not support), leave it to CI and say so.

Never write that a check passed unless you ran it and saw it pass. Note the checks you skipped and why, for the PR body and your reply.

## 6. Title and body

- The **title** follows the rule from step 2. Copy the style of the last few merged PRs (`GET /repos/$REPO/pulls?state=closed&per_page=10`) if the rules are silent.
- The **body** uses the template's headings in its order. Fill every section: write `None` or `N/A` with a reason rather than deleting one, and leave no `<placeholder>` or HTML comment prompt behind. Say why the change exists, not only what it does. Follow anything the template says about what not to list (for example, lint and typecheck as verification steps).
- If step 2 found a PR-description check, run it locally on your body and changed files, with the env vars it reads (`PR_BODY`, `PR_TITLE`, a changed-files list…). Fix the body until it passes.
- With no template, use `## Summary`, `## Why`, `## Test plan`. The test plan lists what you ran and what you saw.

Write the body to a temp file and pass it with `--raw-field` (see step 6 of the feature prompt's flow).

## 7. Open the PR, ready for review by default

Open it ready for review unless the repository's rules ask for drafts. A draft only helps where CI still runs on drafts, and many repositories run nothing on one (step 2). If you do open a draft, mark it ready as soon as CI is green, or right away when CI skips drafts:

```bash
AS=(); [ -n "$GH_TOKEN" ] || AS=(-H "x-github-as: member")   # ambient mode: see below
curl -fsS ${GH_TOKEN:+-H "Authorization: Bearer $GH_TOKEN"} "${AS[@]}" https://api.github.com/graphql \
  -d "{\"query\":\"mutation { markPullRequestReadyForReview(input: {pullRequestId: \\\"$NODE_ID\\\"}) { pullRequest { isDraft } } }\"}"
```

In ambient mode (no `GH_TOKEN`), send this call as the person asking with `x-github-as: member`. A host's proxy attaches the workspace credential per repository owner, and a GraphQL call that names the PR only by its node id has no owner in its URL, so without the header it goes out unauthenticated and GitHub refuses it (403, rate limited). GitHub has no REST route that marks a draft ready, so this header is the only way to do it in ambient mode. A 401 on it means the person's linked identity could not make the call: say so and leave the draft for them to mark ready.

## 8. Follow CI without blocking the turn

**Post the PR link first.** The moment the create call returns, write the link into your reply (reply text streams to the person as you write it), before cleanup, scheduling or anything else. Then schedule the check-in, delete `$WT`, and finish the report (step 9). Never `sleep` waiting on CI, not even to see that it started: the first check-in does that.

**Schedule the check-in** on the same conversation with the `routine` tool:

- `when: { once: <10 minutes from now> }` and `continueThisConversation: true`. Read the clock for it (`TZ=<the person's zone> date '+%Y-%m-%dT%H:%M' -d '+10 min'`), never estimate the time. Scheduling has no minute-level repeat, so each check-in that finds CI still running schedules the next one 10 minutes out, the same way. Stop after about 2 hours of pending and say so.
- `actAsAsker: true` when the PR was opened under the person's identity (`x-github-as: member`). A check-in that runs as the intern can read CI but cannot push fixes to that branch. The person has to approve it once under Routines; say that in your reply. Until they do, or when they don't, the check-in reports a failure instead of trying to push.
- Put everything the check-in needs in its prompt: the repo, PR number, branch, how to read CI (below), what to do on failure, and to schedule the next check-in while CI is pending.
- Where there is no `routine` tool, use your host's loop skill. Where there is no scheduling at all, say CI is pending and stop; never claim it passed.

Each check-in reads the runs. If the first one finds no runs at all, find out why (a workflow that skips drafts, path filters that skip every changed file) instead of calling it green:

```bash
SHA=$(curl -fsS ${GH_TOKEN:+-H "Authorization: Bearer $GH_TOKEN"} \
  "https://api.github.com/repos/$REPO/pulls/$PR" | bun -e 'console.log((await Bun.stdin.json()).head.sha)')
curl -fsS ${GH_TOKEN:+-H "Authorization: Bearer $GH_TOKEN"} \
  "https://api.github.com/repos/$REPO/commits/$SHA/check-runs?per_page=100&filter=latest" \
  | bun -e 'for (const c of (await Bun.stdin.json()).check_runs) console.log(c.conclusion ?? c.status, c.id, c.name, c.details_url)'
# Commit statuses are a separate list (external CI posts there):
curl -fsS ${GH_TOKEN:+-H "Authorization: Bearer $GH_TOKEN"} \
  "https://api.github.com/repos/$REPO/commits/$SHA/status" \
  | bun -e 'const s = await Bun.stdin.json(); console.log(s.state); for (const x of s.statuses) console.log(x.state, x.context, x.target_url)'
# Log of a failed GitHub Actions job (the check-run id is the job id):
curl -fsSL ${GH_TOKEN:+-H "Authorization: Bearer $GH_TOKEN"} \
  "https://api.github.com/repos/$REPO/actions/jobs/$JOB_ID/logs" | tail -200
```

For a check outside GitHub Actions, open its `details_url` or `target_url` for the log.

For each failure, find the cause in the log, fix it, run that check locally, and commit to the **same branch**. Keep checking in until every required check passes, then post the result and schedule nothing more. Fix only what the log shows: an unrelated "while I'm here" change makes the PR harder to review. If a failure is not yours (main is red on the same check, or the job is known to be flaky), confirm it on main's latest commit and say so in the PR, instead of retrying blind.

## 9. Report

The link is already in your reply (step 8). Add what you ran locally, what you skipped and why, when the next check-in runs, and whether it needs the person's approval to push fixes. Don't call the PR done until CI is green.
