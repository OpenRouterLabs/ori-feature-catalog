# working-with-github

GitHub for an intern workspace, in whichever access mode it runs. The feature detects the mode from the environment and teaches the matching path:

- **Ambient mode** (`GH_APP_ID` unset) — the machine holds no credentials by design; on hosts that attach one through an egress proxy, a bare `curl` reaches `api.github.com`. The prompt carries the full REST-reading discipline: read the repository before answering, raw-file and tarball recipes, typical grants, capability probing, repo discovery (installation list ∪ org crawl), and acting-as-the-person-asking when the host supports it.
- **App mode** (`GH_APP_ID` set) — read and act on GitHub with short-lived GitHub App installation tokens, change its own code from a worktree with signed commits, and clean up after merged pull requests.

## What it contributes

- `prompt`: the two access models and how to detect them; in App mode, how GitHub auth works (mint a ~1-hour installation token per command, never `gh auth login`), filing issues, the worktree-first change flow, merging its own pull requests, and handling untrusted content from GitHub
- skills: `register-gh-app` (act through a different GitHub App for another org or role) and `cleanup-worktrees` (remove worktrees whose pull request closed)
- scripts under `scripts/`: `mint-token.ts`, `commit-via-api.ts` (signed commits through the Git Data API), `register-gh-app.ts`, `cleanup-worktrees.ts`
- schedules: `gh-auth-health` (every 30 minutes; App mode proves a token mints and reads `GITHUB_REPO`, ambient mode probes that the API is reachable) and `worktree-cleanup` (daily; sweeps in ambient mode too — the PR lookup goes bare through the host's proxy-attached credential)
- api: none, chat: none, mcp: none

## Environment

- `GH_APP_ID`, `GH_APP_PRIVATE_KEY`: the GitHub App the intern acts as. When `GH_APP_ID` is unset the feature runs in ambient mode: the minting scripts are not used, `gh-auth-health` probes the API without an Authorization header instead, and the prompt teaches the REST-first path through the host's proxy.
- `GITHUB_REPO`: the intern's own repository. Bare `owner/repo` is canonical, and every resolver in this feature tolerates the other spellings too (a full `https://github.com/…` URL, an optional `.git` suffix, a trailing slash) — `orgOf`, `resolveRepoFromEnv`, `resolveAllowedOrgs`, and `resolveConfigDirName` all normalize before use. `gh --repo`, the `repos/{owner}/{repo}` API routes, and the `github.com/…` fetch URL take bare `owner/repo` only, so the prompt's recipes normalize once per shell (`REPO=$(printf '%s' "$GITHUB_REPO" | sed -E …)`) and interpolate `$REPO`, never the raw env var.
- `GH_APP_ALLOWED_ORGS` (optional): the installation owners a token may be minted against, comma or space separated. Defaults to the owner of `GITHUB_REPO`. Discovery fails closed, so an App installed on a foreign account is never used.
- `GH_AUTH_HEALTH_ALERT_CHANNEL_ID`, `SLACK_BOT_TOKEN` (optional): post `gh-auth-health` failures to a Slack channel. Without them the failure is only logged.
- Ambient mode (`GH_APP_ID` unset): the cleanup paths sweep without a token — the PR lookup goes bare through the host's proxy-attached credential — instead of refusing to run. `commit-via-api.ts` still requires an App (signed commits need one).

Registered alternate Apps live in a SQLite registry under `~/.config/<intern>/gh-app-registry.db`, which stores environment variable names, never key material.

## Develop

```sh
bun test features/working-with-github
```

## Vendored installs: edits need a root `bun install` before anything loads them

When a workspace consumes this feature as a `file:` dependency
(`vendor/ori-feature-catalog/features/working-with-github` in its
`package.json`), the daemon and every `"$WWG"/scripts/...` path resolve through
`node_modules/@ori-monorepo/working-with-github` — a **`.bun` store copy**
materialized at install time, not a live view of the vendored tree. Editing
the vendored source changes nothing that runs until the store is re-synced:

```sh
bun install   # at the WORKSPACE ROOT — a bun install inside
              # vendor/ori-feature-catalog/ is a no-op for the store
```

Run it after every edit to the vendored source (after the test suite passes),
and verify with `diff -rq -x node_modules
vendor/ori-feature-catalog/features/working-with-github
node_modules/@ori-monorepo/working-with-github` — it must print nothing. The
`node_modules/` directory the vendored tree carries after its own install (from
the catalog root's workspace layout) never exists inside the `.bun` store copy,
so an unexcluded `diff -rq` reports `Only in …: node_modules` on every
correctly-synced install — a false mismatch that taught the operator to ignore
the check. A `bun install` inside the vendored tree prints "no changes" and
re-syncs nothing.

Keep `--no-dereference` OFF this recipe. The store path
(`node_modules/@ori-monorepo/working-with-github`) is a symlink into the `.bun`
store, and `diff -rq --no-dereference` compares the LINK instead of descending
into it: it exits 2 with a bogus `No such file or directory` on every
correctly-synced install, so the check can never pass. Plain dereference
(diff's default) is what walks the real tree through the link.
