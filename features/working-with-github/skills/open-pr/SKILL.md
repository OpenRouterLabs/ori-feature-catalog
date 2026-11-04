---
name: open-pr
description: >
  Get a pull request ready the way the target repository expects, open it fast as a draft, and stay with it until CI is green. TRIGGER before opening any pull request in any repository, whatever the language, host org or company, before pushing more commits to an open one, and when asked why a PR you opened failed CI or has a thin description. It covers reading the repo's own rules in full (AGENTS.md, CONTRIBUTING, the PR template, CI workflows, hooks and repo skills), running the checks its git hooks would have run (your API commits skip them), running the tests scoped to the change while CI runs the rest, filling every section of the template, and fixing CI failures before you mark the PR ready. DO NOT TRIGGER for reviewing someone else's PR (code-review) or for merging (the feature prompt's "Merging your own PRs").
---

# Opening a pull request

A PR is done when it passes the repository's own bar, not yours. Every repository writes that bar down in a different place, and your commits skip the hooks that enforce part of it. So read the rules, run the checks yourself, fill in the template, and watch CI.

Be fast without skipping a check. Put the slow parts in parallel instead of in a line: open the PR as a **draft** as soon as the scoped checks pass, let CI run the full suite while you finish the body and any long local check, and mark it ready only when both are green. A draft is not done. Never report it as done.

Work from your checkout of the target repository: the worktree from the feature prompt's flow, or an extracted tarball in ambient mode. `$WT` below is that checkout and `$REPO` is the target `owner/repo`. Nothing here assumes a language, a package manager or a CI vendor. Use whatever the repository uses.

## 1. Read the repository's rules, all of them

Read each file below that exists, in full, with a file read, never from memory or a summary. Long `AGENTS.md` files get cut off when they are loaded automatically, and the part that gets cut is usually the PR checklist.

```bash
cd "$WT"
ls AGENTS.md CLAUDE.md CONTRIBUTING.md CONTRIBUTING .github/CONTRIBUTING.md docs/CONTRIBUTING.md \
  .github/PULL_REQUEST_TEMPLATE.md .github/pull_request_template.md PULL_REQUEST_TEMPLATE.md \
  .github/PULL_REQUEST_TEMPLATE/ docs/pull_request_template.md \
  lefthook.yml lefthook.yaml .lefthook .husky .pre-commit-config.yaml .overcommit.yml .githooks \
  commitlint.config.* .commitlintrc* \
  Makefile justfile Taskfile.yml package.json pyproject.toml Cargo.toml go.mod 2>/dev/null
git config --get core.hooksPath
# Rules that apply to the files you changed: an AGENTS.md in any parent dir.
git diff --name-only "$(git merge-base HEAD FETCH_HEAD 2>/dev/null || echo HEAD)" \
  | xargs -n1 dirname | sort -u | while read -r d; do
      while [ "$d" != "." ] && [ -n "$d" ]; do
        [ -f "$d/AGENTS.md" ] && echo "$d/AGENTS.md"; d=$(dirname "$d")
      done
    done | sort -u
ls .github/workflows/ .circleci/ .gitlab-ci.yml .buildkite/ 2>/dev/null
```

From them, write down before you start:

- the **pre-push command** (`verify`, `check`, `make check`, `just ci`, `tox`…) and the fast command to use while iterating (a `fix` or `format` script);
- the **title rule**: conventional commits, a scope list, a required ticket id (a Jira, Linear or GitHub issue key);
- the **PR template** headings, in order;
- **gated topics**: a security, privacy, compliance, migration or visual-regression review the rules require when the diff touches certain paths;
- every **CI job that checks the PR itself**, not the code. Search the CI config for `PR_BODY`, `pull_request.body`, `title`, `description` or `metadata`, and note the script each one runs and the env vars it reads;
- whether the rules **forbid pushing before a full local check**. Most don't, and then the draft flow in step 4 applies. If they do, run that check before the first push.

## 2. Find the repo's own skills that apply

Repositories may ship their own agent skills. Read every name and description, then open the ones that fit the change: the area or paths you touched, and anything about commits, PR text, security, privacy, tests or screenshots.

```bash
for f in "$WT"/.agents/skills/*/SKILL.md "$WT"/.claude/skills/*/SKILL.md "$WT"/.cursor/rules/*; do
  [ -f "$f" ] && printf '%s: %s\n' "$f" "$(grep -m1 '^description:' "$f" | cut -c1-200)"
done
```

When the list is long, grep it for words from your diff (package names, directories, `security`, `pr`, `commit`, `test`) instead of skimming. Do what a matching skill says.

## 3. Run what the hooks would have run

Your commits go through the Git Data API (`commit-via-api.ts`, or the REST API in ambient mode), and that path never runs lefthook, husky, pre-commit or any other git hook. Formatting, lint, commit-message rules and generated files are your job now. Read the hook config from step 1 and run each `pre-commit` and `pre-push` command yourself, on the changed files where the hook passes them.

When a hook regenerates files (docs indexes, lockfiles, codegen), run the generator and commit what it changed. If you skip that, CI's "generated files are stale" check fails.

## 4. Scoped checks, then a draft, then the rest in parallel

Before you start a heavy check, look at the machine (`nproc; free -g; df -h .`). A large repo's full suite can take minutes on a small machine, or not fit at all.

**Before the first push**, run the checks scoped to your change. They take seconds:

1. the formatter and linter on the changed files;
2. the typecheck or build of each package you touched;
3. the tests related to the change: tests next to the changed files, and tests that import, load or read them. Use the repo's own tool for this where it has one (`jest --findRelatedTests`, `vitest related`, `nx affected`, `turbo run test --filter=...[<base>]`, `pytest <paths>`, `go test ./<pkg>/...`, `cargo test -p <crate>`); otherwise grep the test files for the changed paths and module names. A change only to docs or prompts still runs the tests that read those files.

**Then open the PR as a draft** (`"draft": true` in the create call). CI starts on the full suite right away. If the repository refuses drafts (a 422 that names draft pull requests), open it normally, start the body with `Not ready for review: CI pending`, and remove that line once step 6 is green.

**While CI runs**, do the rest in parallel: start the repo's full pre-push check in the background (`<cmd> > /tmp/full-check-$ORI_SESSION_ID.log 2>&1 &`) if the machine can hold it, and finish the title and body (step 5). Reading the log at the end costs nothing, so don't sit and wait on it.

Never write that a check passed unless you ran it and saw it pass. Note the checks you skipped and why, for the PR body and your reply.

## 5. Title and body

- The **title** follows the rule from step 1. Copy the style of the last few merged PRs (`GET /repos/$REPO/pulls?state=closed&per_page=10`) if the rules are silent.
- The **body** uses the template's headings in its order. Fill every section: write `None` or `N/A` with a reason rather than deleting one, and leave no `<placeholder>` or HTML comment prompt behind. Say why the change exists, not only what it does. Follow anything the template says about what not to list (for example, lint and typecheck as verification steps).
- If step 1 found a PR-description check, run it locally on your body and changed files, with the env vars it reads (`PR_BODY`, `PR_TITLE`, a changed-files list…). Fix the body until it passes. When the draft was opened with a short body, update it with `PATCH /repos/$REPO/pulls/$PR` before marking ready.
- With no template, use `## Summary`, `## Why`, `## Test plan`. The test plan lists what you ran and what you saw.

Write the body to a temp file and pass it with `--raw-field` (see step 6 of the feature prompt's flow).

## 6. Get CI green, then mark ready

Wait for the check runs to appear (an empty list right after opening means CI has not started yet, not that it passed), then read every one that fails:

```bash
SHA=$(curl -fsS ${GH_TOKEN:+-H "Authorization: Bearer $GH_TOKEN"} \
  "https://api.github.com/repos/$REPO/pulls/$PR" | bun -e 'console.log((await Bun.stdin.json()).head.sha)')
curl -fsS ${GH_TOKEN:+-H "Authorization: Bearer $GH_TOKEN"} \
  "https://api.github.com/repos/$REPO/commits/$SHA/check-runs?per_page=100" \
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

For each failure, find the cause in the log, fix it in the worktree, run that check locally, and commit to the **same branch**. Repeat until every required check passes and the background full check from step 4 (if you started one) passed too. Fix only what the log shows: an unrelated "while I'm here" change makes the PR harder to review. If a failure is not yours (main is red on the same check, or the job is known to be flaky), confirm it on main's latest commit and say so in the PR, instead of retrying blind.

Then mark the PR ready. The REST API cannot leave draft, so use GraphQL with the PR's `node_id`:

```bash
curl -fsS ${GH_TOKEN:+-H "Authorization: Bearer $GH_TOKEN"} https://api.github.com/graphql \
  -d "{\"query\":\"mutation { markPullRequestReadyForReview(input: {pullRequestId: \\\"$NODE_ID\\\"}) { pullRequest { isDraft } } }\"}"
```

## 7. Report

Reply with the PR link, what you ran locally, what you skipped and why, and the CI state. If your turn ends with CI still red or pending, leave the PR as a draft, say which check is red or pending and what you know about it, and don't call the PR done.
