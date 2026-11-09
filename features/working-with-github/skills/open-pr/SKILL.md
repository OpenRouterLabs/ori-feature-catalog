---
name: open-pr
description: >
  Get a pull request ready the way the target repository expects, open it fast, and follow it until CI is green without blocking the conversation. TRIGGER before opening any pull request in any repository, whatever the language, host org or company, before pushing more commits to an open one, and when asked why a PR you opened failed CI or has a thin description. It covers getting the code with a temporary shallow clone (partial when no install is needed, full when one is), reading the repo's own rules in full (AGENTS.md, CONTRIBUTING, the PR template, CI workflows, hooks and repo skills), running the checks its git hooks would have run (your API commits skip them), running each check once and scoped to the change while CI runs the rest, filling every section of the template, and checking CI when the person comes back instead of waiting inside the turn or scheduling a routine for it. DO NOT TRIGGER for reviewing someone else's PR (code-review) or for merging (the feature prompt's "Merging your own PRs").
---

# Opening a pull request

A PR is done when it passes the repository's own bar, not yours. Every repository writes that bar down in a different place, and your commits skip the hooks that enforce part of it. So read the rules, run the checks yourself, fill in the template, and follow CI until it is green.

Be fast without skipping a check. Most of the time to a PR goes to these things, so avoid them:

- **Downloading and indexing the whole repository, or too little of it.** Work in a temporary shallow clone (step 1): partial when the change needs no install, full when it does. A partial clone fetches file contents only for the directories you check out, and it is already a git repo, so you never need to `git init` it to get a diff. But a partial clone that an install or typecheck then needs more of costs more than it saved.
- **One small tool call after another.** Each call waits on a full model round trip. Put independent reads in one call: read every rules file in one command, run every search in one command.
- **Retrying what already failed.** When a command fails the same way twice, stop and change the approach. A loop that "fixes" an error must check that each pass made progress, and stop when it didn't.
- **Running the same check again and again.** Run each check once on the finished change, scoped to what changed, and after a fix rerun only the check that failed (step 5).
- **Waiting on CI inside the turn.** Never `sleep` waiting on CI. Post the PR link the moment the PR exists, read CI once, and check it again when the person comes back (step 8).

Nothing here assumes a language, a package manager, a CI vendor or a company. Use whatever the repository uses. `$REPO` is the target `owner/repo` and `$WT` is your checkout.

## 1. Get the code: a temporary shallow clone

```bash
WT=/tmp/worktrees/${REPO//\//-}/<branch>
git clone -q --depth 1 --filter=blob:none --sparse "https://github.com/$REPO.git" "$WT"
cd "$WT"
git switch -q -c <branch>   # a new PR; for an open one, clone with --branch <branch> instead
git ls-tree -r --name-only HEAD | grep -i '<words from the task>'   # every path, without downloading files
git sparse-checkout set --skip-checks .github .agents .claude .cursor .circleci .buildkite .lefthook .config/lefthook .config/lefthook-local .husky .githooks <dirs the change touches>
git grep -n '<symbol>' -- <dir>                                    # search only what is checked out
```

- **Pick the clone by what the checks will need, before you clone.** Decide from the task and the root manifests (`git ls-tree` or the API list the tree without a clone):
  - **No install needed**: the change is to prompts, docs, config or skill text, or the checks it needs (step 5) run without installed dependencies. Use the partial clone above.
  - **An install is needed**: you will build, typecheck, lint or test the change with the repository's dependencies installed. Use a full shallow clone: the same command without `--filter=blob:none --sparse` (and without the `git sparse-checkout set` line), in the credential-helper form below too in App mode. A package manager reads workspace manifests, patch files, lockfiles and config from all over the tree. A sparse checkout without them fails to install, or the typecheck reports hundreds of errors in modules that are not checked out, and those look like the change's fault.
  - **Started partial and an install or typecheck now needs more**: run `git sparse-checkout disable` once, which fetches the rest in one go. Never add directories one failure at a time.
- **A partial fetch that fails is not retried.** A partial clone fetches file contents lazily on every later `sparse-checkout`, `switch` or `grep`, so a flaky connection (`fetch-pack`, `invalid index-pack output`, a dropped TLS read) fails each of those again. Switch once to a full shallow clone of the same commit (for an open PR, of its branch) and copy your edits across. Prefer it over the tarball: a tarball has no `.git`, so the branch, commit and push steps below cannot run in it until you `git init`, fetch the branch's commit and `git reset --soft` onto it, which is another round of network work.
- Put the checkout on the PR's branch before the first commit: `git switch -c <branch>` for a new PR, then create the branch on GitHub at the clone's own `HEAD` (`git rev-parse HEAD`, the feature prompt's change flow, step 5). For an open PR, clone its head instead (add `--branch <branch>` to the clone). `commit-via-api.ts` points the local branch at each commit it makes only when the checkout has that branch checked out. A clone left on the default branch keeps listing the committed files as changed, and the next round on the same branch (a CI fix) is refused for them, with a `git merge` remedy that fails on those same local changes.
- Root files (`AGENTS.md`, `package.json`, hook configs) are always checked out; `set` adds the directories. Add more with `git sparse-checkout add --skip-checks <dir>` as you learn what the change needs.
- `--skip-checks` is needed for directory names with `[`, `]`, `*` or `?` in them, which are common in web routing trees (`app/[locale]/…`).
- Search with `git grep` or `rg`, never a plain recursive `grep`. Find which directories to check out with `git ls-tree` first, rather than checking out everything.
- When the clone answers HTTP 429 (rate limited), wait about 20 seconds and retry once. When cloning is not allowed at all, download the tarball instead, as the feature prompt describes.
- In App mode, never put the token in the clone URL. `git clone` saves that URL, token and all, as the clone's `origin` in `.git/config`, where `git remote -v` prints it and every later fetch of the partial clone sends that same token again, even after it expires (an installation token lasts an hour). Let git read the rotated `GH_TOKEN` through a credential helper instead. The helper holds the variable's name, never its value, and stays in the clone's config for the fetches `sparse-checkout` and `switch` make later:

  ```bash
  AUTH='!f() { test "$1" = get && echo username=x-access-token && echo "password=$GH_TOKEN"; }; f'
  git -c credential.https://github.com.helper="$AUTH" clone -q --depth 1 --filter=blob:none --sparse "https://github.com/$REPO.git" "$WT"
  git -C "$WT" config credential.https://github.com.helper "$AUTH"
  ```

  For an alternate App's token (`mint-token.ts --repo`), export it as `GH_TOKEN` in that shell first.
- Commit from `$WT` with `commit-via-api.ts --worktree "$WT" --branch <branch> --message-file <file> --repo "$REPO"`, adding `--as member` in ambient mode; never hand-write the Git Data API calls. Always pass `--repo "$REPO"`: without it the script commits to `$GITHUB_REPO`, this workspace's own repository, not the one you cloned. In ambient mode that variable is usually unset and the script stops with `missing required flag(s): --repo`; when it names a different repository, every call goes there and fails on a branch that does not exist.
- Delete `$WT` when the PR is up and you no longer need it. Nothing is kept between tasks.
- Run your own helper scripts (a `bun -e` one-liner, a commit script) from outside `$WT` (`cd /tmp`, then pass paths in). A repository's runtime config, such as a `bunfig.toml` preload, `.npmrc` or `.nvmrc`, applies to anything started inside it and can break a script that has nothing to do with the repository.

## 2. Read the repository's rules, all of them, in one call

Read each file that exists in full, never from memory or a summary. Long `AGENTS.md` files get cut off when they are loaded automatically, and the part that gets cut is usually the PR checklist.

The first command lists the rules files from the clone's index and prints them with `git show`, never from the disk. The sparse checkout leaves `docs/` out, where GitHub also reads a PR template and a CONTRIBUTING file, so a `[ -f ]` test on the disk skips both without a word. GitHub also matches these names in any case (`PULL_REQUEST_TEMPLATE.md` or `pull_request_template.md`, at the root, in `docs/` or in `.github/`), which `grep -i` covers, and with any extension or none: a `pull_request_template.txt` fills the PR body just like the `.md`, and a `CONTRIBUTING.rst` is linked like a `CONTRIBUTING.md`. Lefthook reads its main config as `lefthook`, `.lefthook` or `.config/lefthook`, with a `.yml`, `.yaml`, `.json`, `.jsonc` or `.toml` extension, and merges a `lefthook-local` config of the same forms on top (`lefthook-local.yml`, `.lefthook-local.json`, `.config/lefthook-local.toml`), so the list takes all thirty. Husky before v5 keeps its hooks in `.huskyrc` (bare, `.json`, `.yaml`, `.yml`, `.js` or `.cjs`), `husky.config.js` or `.cjs`, or the `husky` key of `package.json`, never in `.husky/`, so read that key too when `package.json` has one. Overcommit merges `.local-overcommit.yml` over `.overcommit.yml`.

```bash
cd "$WT"; git ls-tree -r --name-only HEAD | grep -iE '^(AGENTS\.md|CLAUDE\.md|(\.config/|\.)?lefthook(-local)?\.(ya?ml|jsonc?|toml)|\.pre-commit-config\.yaml|\.(local-)?overcommit\.yml|\.huskyrc(\.(json|ya?ml|c?js))?|husky\.config\.c?js|commitlint\.config\.[^/]+|\.commitlintrc[^/]*)$|^((\.github|docs)/)?(contributing(\.[^/]+)?|pull_request_template(\.[^/]+)?|pull_request_template/[^/]+)$' |
  while IFS= read -r f; do printf '\n===== %s\n' "$f"; git show "HEAD:$f"; done   # from the index: docs/ is not checked out
ls .husky .lefthook .githooks Makefile justfile Taskfile.yml package.json pyproject.toml Cargo.toml go.mod 2>/dev/null
for f in .husky/* .lefthook/*/* .lefthook/*.sh .config/lefthook/*/* .config/lefthook-local/*/* .githooks/*; do [ -f "$f" ] && printf '\n===== %s\n' "$f" && cat "$f"; done   # the commands the hook config runs often live here
# Rules for the directories you touch: an AGENTS.md in any of their parents. A path under "$WT" is read
# relative to it, and the walk also stops at "/" (dirname "/" is "/", so an absolute path never ended).
for d in <dirs the change touches>; do d=${d#"$WT"/}; while [ "$d" != "." ] && [ "$d" != "/" ] && [ -n "$d" ]; do
  [ -f "$d/AGENTS.md" ] && printf '\n===== %s\n' "$d/AGENTS.md" && cat "$d/AGENTS.md"; d=$(dirname "$d"); done; done
ls .github/workflows/ .circleci/ .gitlab-ci.yml .buildkite/ 2>/dev/null; grep -ln 'draft' .github/workflows/* 2>/dev/null
# No PR template or CONTRIBUTING of its own: GitHub uses the one in the owner's public .github repository.
O=/tmp/owner-dot-github-$$; [ -n "${REPO%%/*}" ] && for k in 'pull_request_template(\.[^/]+)?(/[^/]+)?' 'contributing(\.[^/]+)?'; do p='^((\.github|docs)/)?'"$k"'$'
  git ls-tree -r --name-only HEAD | grep -qiE "$p" && continue
  [ -d "$O" ] || GIT_TERMINAL_PROMPT=0 git clone -q --depth 1 --filter=blob:none --no-checkout "https://github.com/${REPO%%/*}/.github.git" "$O" 2>/dev/null || break
  git -C "$O" ls-tree -r --name-only HEAD | grep -iE "$p" | while IFS= read -r f; do printf '\n===== %s/.github: %s\n' "${REPO%%/*}" "$f"; git -C "$O" show "HEAD:$f"; echo; done
done; rm -rf "$O"
```

A repository with no PR template of its own, or no CONTRIBUTING file, gets the one in its owner's `.github` repository: GitHub fills the PR form from that default template and links that default CONTRIBUTING, and neither ever appears in the repository's own tree, so the first command cannot list them. The last command reads them from that repository when it is public (GitHub uses no other), with no credential, and prints nothing when the owner has none or `$REPO` is unset.

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
  [ -f "$f" ] && printf '%s: %s\n' "$f" "$(awk '{ sub(/\r$/, "") } /^description:/ { sub(/^description:[ \t]*/, ""); if ($0 !~ /^([>|][-+0-9]*)?$/) { print; exit } block = 1; next }
    block && /^[ \t]/ { sub(/^[ \t]+/, ""); text = text (text == "" ? "" : " ") $0; next } block { exit } END { if (block) print text }' "$f" | cut -c1-200)"
done
```

The `awk` reads a description written as a YAML block (`description: >` or `|`, with the text on the indented lines below), or as plain text that starts on the line under a bare `description:`, as well as a one-line one. Many skills, this one included, use the block form, and a plain `grep '^description:'` prints only its `>`. It drops the carriage return of a file saved with Windows line endings first: otherwise `>` plus that return no longer reads as a block marker, and the listing prints `>` again.

When the list is long, grep it for words from your diff (package names, directories, `security`, `pr`, `commit`, `test`) instead of skimming. Do what a matching skill says.

## 4. Run what the hooks would have run

Your commits go through the Git Data API (`commit-via-api.ts`, with `--as member` in ambient mode), and that path never runs lefthook, husky, pre-commit or any other git hook. Formatting, lint, commit-message rules and generated files are your job now. Read the hook config from step 2, including the scripts it calls, and run each `pre-commit` and `pre-push` command yourself, on the changed files where the hook passes them. When the repository has a `commit-msg` rule (a commitlint config, a `commit-msg` hook), check your commit message and PR title against it too.

When a hook regenerates files (docs indexes, lockfiles, codegen), run the generator and commit what it changed. If you skip that, CI's "generated files are stale" check fails.

## 5. Run each check once, scoped to the change

Before the first push, run the checks scoped to your change. CI runs the full suite, so locally you only need enough to push a change that is likely green:

1. the formatter and linter on the changed files;
2. the typecheck or build of each package you touched;
3. the tests related to the change: tests next to the changed files, and tests that import, load or read them. Use the repo's own tool for this where it has one (`jest --findRelatedTests`, `vitest related`, `nx affected`, `turbo run test --filter=...[<base>]`, `pytest <paths>`, `go test ./<pkg>/...`, `cargo test -p <crate>`); otherwise `git grep` the test files for the changed paths and module names. A change only to docs or prompts still runs the tests that read those files.

Run each check once, when the change is finished, not after every edit:

- **After a fix, rerun only the check that failed**, on the files it failed on. Never rerun a whole suite to confirm a one-line fix, and never run the same command twice to compare its output.
- **Never widen a test run past the related tests.** Running a whole app's or package's test directory, when the related tests are known, takes minutes and tells you nothing CI won't.
- **No extra passes nobody asked for**: reverting the fix to watch a test fail, stashing the change to run a baseline, or a second typecheck to compare error counts. Two exceptions: when the repository's rules ask for one, and when a check fails only in files you did not touch. Then run that one check once on the base commit to confirm the failure is not yours, and say so in the PR. A `--depth 1` clone of a PR branch usually lacks the base commit, so fetch it first (`git fetch --depth 1 origin <base-sha>`) and run the check in a second worktree on it (`git worktree add <dir> <base-sha>`).
- **Errors in files you did not touch** have two causes; tell them apart before acting. Missing-module or missing-file errors (`Cannot find module`, a path that is not checked out) mean the checkout or the install is incomplete (step 1): fix the checkout once and run the check again, never triage those errors one by one. Type or test errors in callers of something you changed (an exported signature, a shared type) are the change's own regressions. When the check passes on the base commit and fails on yours, the change caused it: investigate and fix it, never report it as unrelated.
- **A change only to prompts, docs, skill text, or config the build does not read needs no build.** Compiler, bundler, package-manager and CI config is build input: for those, run the build or typecheck of the affected package as for code. Run the tests that read those files, and the repository's validate command for that kind of file if it names one, once. Try them before installing anything, and install only when they fail on a missing module.

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
NODE_ID=$(curl -fsS ${GH_TOKEN:+-H "Authorization: Bearer $GH_TOKEN"} \
  "https://api.github.com/repos/$REPO/pulls/$PR" | bun -e 'console.log((await Bun.stdin.json()).node_id)')
curl -fsS ${GH_TOKEN:+-H "Authorization: Bearer $GH_TOKEN"} "${AS[@]}" https://api.github.com/graphql \
  -d "{\"query\":\"mutation { markPullRequestReadyForReview(input: {pullRequestId: \\\"$NODE_ID\\\"}) { pullRequest { isDraft } } }\"}" \
  | bun -e 'const r = await Bun.stdin.json(); if (r.errors?.length) { console.error(r.errors.map((e) => e.message).join("; ")); process.exit(1); } console.log("isDraft:", r.data.markPullRequestReadyForReview.pullRequest.isDraft)'
```

`$PR` is the PR's number. The mutation takes the PR's GraphQL node id, which the first call reads from the PR itself. GraphQL reports a refused mutation as `errors` in an HTTP 200 answer, which `curl -f` lets through, so the last line prints those errors and exits 1 instead of letting a draft that stayed a draft read as done.

In ambient mode (no `GH_TOKEN`), send this call as the person asking with `x-github-as: member`. A host's proxy attaches the workspace credential per repository owner, and a GraphQL call that names the PR only by its node id has no owner in its URL, so without the header it goes out unauthenticated and GitHub refuses it (403, rate limited). GitHub has no REST route that marks a draft ready, so this header is the only way to do it in ambient mode. A 401 on it means the person's linked identity could not make the call: say so and leave the draft for them to mark ready.

## 8. Follow CI without blocking the turn

**Post the PR link first.** The moment the create call returns, write the link into your reply (reply text streams to the person as you write it), before cleanup or anything else. Then delete `$WT` and finish the report (step 9). Never `sleep` waiting on CI, not even to see that it started.

**Never create a routine to follow CI.** No `routine` tool call, no loop skill, no schedule of any kind for a CI check-in. Each one lands in the person's Routines tab, where it reads as clutter they never asked for and outlives the PR. Schedule a CI follow-up only when the person explicitly asks for one ("keep checking CI and tell me here"); then the routines skill covers it.

**Read CI once, then again whenever the person comes back.** At the end of the turn, read the runs (below) once. Report what you see: failed, still running, or green. When the person returns to the conversation, or asks you to check CI, read them again before anything else. If a read finds no runs at all, find out why (a workflow that skips drafts, path filters that skip every changed file) instead of calling it green:

```bash
SHA=$(curl -fsS ${GH_TOKEN:+-H "Authorization: Bearer $GH_TOKEN"} \
  "https://api.github.com/repos/$REPO/pulls/$PR" | bun -e 'console.log((await Bun.stdin.json()).head.sha)')
curl -fsS ${GH_TOKEN:+-H "Authorization: Bearer $GH_TOKEN"} \
  "https://api.github.com/repos/$REPO/commits/$SHA/check-runs?per_page=100&filter=latest" \
  | bun -e 'for (const c of (await Bun.stdin.json()).check_runs) console.log(c.conclusion ?? c.status, c.id, c.name, c.details_url)'
# Commit statuses are a separate list (external CI posts there). GitHub answers
# "pending" when nothing posted one at all, so that case prints as none posted:
curl -fsS ${GH_TOKEN:+-H "Authorization: Bearer $GH_TOKEN"} \
  "https://api.github.com/repos/$REPO/commits/$SHA/status" \
  | bun -e 'const s = await Bun.stdin.json(); console.log(s.total_count === 0 ? "no commit status posted" : s.state); for (const x of s.statuses) console.log(x.state, x.context, x.target_url)'
# Log of a failed GitHub Actions job (the check-run id is the job id):
curl -fsSL ${GH_TOKEN:+-H "Authorization: Bearer $GH_TOKEN"} \
  "https://api.github.com/repos/$REPO/actions/jobs/$JOB_ID/logs" | tail -200
```

For a check outside GitHub Actions, open its `details_url` or `target_url` for the log.

For each failure, find the cause in the log, fix it, run that check locally, and commit to the **same branch**. Keep fixing on each read until every required check passes. Fix only what the log shows: an unrelated "while I'm here" change makes the PR harder to review. If a failure is not yours (main is red on the same check, or the job is known to be flaky), confirm it on main's latest commit and say so in the PR, instead of retrying blind.

## 9. Report

The link is already in your reply (step 8). Add what you ran locally, what you skipped and why, and what CI showed on your read. While checks are still running, say so and tell the person to ask you to check CI; never claim it passed. Don't call the PR done until CI is green.
