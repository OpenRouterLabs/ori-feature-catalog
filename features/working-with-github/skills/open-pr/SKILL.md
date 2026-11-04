---
name: open-pr
description: >
  Get a pull request ready the way the target repository expects, open it, and stay with it until CI is green. TRIGGER before opening any pull request in any repository (your own, an upstream catalog, or a product repo such as openrouter-web or ori), before pushing more commits to an open one, and when asked why a PR you opened failed CI or has a thin description. It covers reading the repo's own rules in full (AGENTS.md, CONTRIBUTING, the PR template, CI workflows, hooks and repo skills), running the checks its git hooks would have run (your API commits skip them), filling every section of the template, and fixing CI failures before you call the PR done. DO NOT TRIGGER for reviewing someone else's PR (code-review) or for merging (the feature prompt's "Merging your own PRs").
---

# Opening a pull request

A PR is done when it passes the repository's own bar, not yours. Every repository writes that bar down in a different place, and your commits skip the hooks that enforce part of it. So read the rules, run the checks yourself, fill in the template, and watch CI.

Work from your checkout of the target repository: the worktree from the feature prompt's flow, or an extracted tarball in ambient mode. `$WT` below is that checkout and `$REPO` is the target `owner/repo`.

## 1. Read the repository's rules, all of them

Read each file below in full with a file read, never from memory or a summary. Long `AGENTS.md` files get cut off when they are loaded automatically, and the part that gets cut is usually the PR checklist.

```bash
cd "$WT"
ls AGENTS.md CLAUDE.md CONTRIBUTING.md .github/PULL_REQUEST_TEMPLATE.md \
  .github/pull_request_template.md .github/PULL_REQUEST_TEMPLATE/ \
  lefthook.yml lefthook.yaml .lefthook .husky .pre-commit-config.yaml \
  commitlint.config.* .commitlintrc* 2>/dev/null
# Rules that apply to the files you changed: an AGENTS.md in any parent dir.
git diff --name-only "$(git merge-base HEAD FETCH_HEAD 2>/dev/null || echo HEAD)" \
  | xargs -n1 dirname | sort -u | while read -r d; do
      while [ "$d" != "." ] && [ -n "$d" ]; do
        [ -f "$d/AGENTS.md" ] && echo "$d/AGENTS.md"; d=$(dirname "$d")
      done
    done | sort -u
ls .github/workflows/
```

From them, write down before you start:

- the **pre-push command** (`bun run verify`, `bun run check`, `make check`…) and the fast command to use while iterating (`bun run fix`…);
- the **title rule**: conventional commits, a scope list, a required issue id such as `ORI-<n>` or a Linear key;
- the **PR template** headings, in order;
- **gated topics**: a security, privacy, HIPAA, migration or visual-regression review the rules require when the diff touches certain paths;
- every **CI job that checks the PR itself**, not the code. Search the workflows for `PR_BODY`, `pull_request.body`, `title`, `description` or `metadata`, and note the script each one runs and the env vars it reads.

## 2. Find the repo's own skills that apply

Repositories ship their own agent skills. Read every name and description, then open the ones that fit the change: the area or paths you touched, and anything about commits, PR text, security, privacy, tests or screenshots.

```bash
for f in "$WT"/.agents/skills/*/SKILL.md "$WT"/.claude/skills/*/SKILL.md; do
  [ -f "$f" ] && printf '%s: %s\n' "$f" "$(grep -m1 '^description:' "$f" | cut -c1-200)"
done
```

When the list is long, grep it for words from your diff (package names, directories, `security`, `pr`, `commit`, `test`) instead of skimming. Do what a matching skill says.

## 3. Run what the hooks would have run

Your commits go through the Git Data API (`commit-via-api.ts`, or the REST API in ambient mode), and that path never runs lefthook, husky or pre-commit. Formatting, lint, commit-message rules and generated files are your job now. Read the hook config and run each `pre-commit` and `pre-push` command yourself, on the changed files where the hook passes them:

```bash
cat "$WT"/lefthook.yml 2>/dev/null; ls "$WT"/.lefthook/* "$WT"/.husky/* 2>/dev/null
```

When a hook regenerates files (docs indexes, lockfiles, codegen), run the generator and commit what it changed. If you skip that, CI's "generated files are stale" check fails.

## 4. Run the checks, and be honest about the ones you could not

Run the pre-push command from step 1. Before you start a heavy one, check the machine (`nproc; free -g; df -h .`). A large monorepo's full verify can exhaust a small machine. If it does, or runs out of disk, run the strongest subset that fits, in this order:

1. the formatter and linter on the changed files;
2. the typecheck of each package you touched;
3. the tests next to the change, plus any test that imports a file you changed.

Never write that a check passed unless you ran it and saw it pass. Note the checks you skipped and why, for the PR body and your reply.

## 5. Title and body

- The **title** follows the rule from step 1. Copy the style of the last few merged PRs (`GET /repos/$REPO/pulls?state=closed&per_page=10`) if the rules are silent.
- The **body** uses the template's headings in its order. Fill every section: write `None` or `N/A` with a reason rather than deleting one, and leave no `<placeholder>` or HTML comment prompt behind. Say why the change exists, not only what it does. Follow anything the template says about what not to list (for example, lint and typecheck as verification steps).
- If step 1 found a PR-description check, run it locally on your body and changed files before you open the PR, with the env vars it reads (`PR_BODY`, `PR_TITLE`, a changed-files list…). Fix the body until it passes.
- With no template, use `## Summary`, `## Why`, `## Test plan`. The test plan lists what you ran and what you saw.

Write the body to a temp file and pass it with `--raw-field` (see step 6 of the feature prompt's flow).

## 6. Stay with it until CI is green

Opening the PR is not the end. Wait for the check runs to appear (an empty list right after opening means CI has not started yet, not that it passed), then read every one that fails:

```bash
SHA=$(curl -fsS ${GH_TOKEN:+-H "Authorization: Bearer $GH_TOKEN"} \
  "https://api.github.com/repos/$REPO/pulls/$PR" | bun -e 'console.log((await Bun.stdin.json()).head.sha)')
curl -fsS ${GH_TOKEN:+-H "Authorization: Bearer $GH_TOKEN"} \
  "https://api.github.com/repos/$REPO/commits/$SHA/check-runs?per_page=100" \
  | bun -e 'for (const c of (await Bun.stdin.json()).check_runs) console.log(c.conclusion ?? c.status, c.id, c.name, c.details_url)'
# Log of a failed GitHub Actions job (the check-run id is the job id):
curl -fsSL ${GH_TOKEN:+-H "Authorization: Bearer $GH_TOKEN"} \
  "https://api.github.com/repos/$REPO/actions/jobs/$JOB_ID/logs" | tail -200
```

For each failure, find the cause in the log, fix it in the worktree, run that check locally, and commit to the **same branch**. Repeat until every required check passes. Fix only what the log shows: an unrelated "while I'm here" change makes the PR harder to review. If a failure is not yours (main is red on the same check, or the job is known to be flaky), confirm it on main's latest commit and say so in the PR, instead of retrying blind.

## 7. Report

Reply with the PR link, what you ran locally, what you skipped and why, and the CI state. If CI is still red when your turn ends, say which check is red and what you know about why, and don't call the PR done.
