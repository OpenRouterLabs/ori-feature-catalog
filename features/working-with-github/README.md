# working-with-github

GitHub for an intern workspace, in whichever access mode it runs. The feature detects the mode from the environment and teaches the matching path:

- **Ambient mode** (`GH_APP_ID` unset) — the machine holds no credentials by design; on hosts that attach one through an egress proxy, a bare `curl` reaches `api.github.com`. The prompt carries the full REST-reading discipline: read the repository before answering, raw-file and tarball recipes, typical grants, capability probing, repo discovery (installation list ∪ org crawl), and acting-as-the-person-asking when the host supports it.
- **App mode** (`GH_APP_ID` set) — read and act on GitHub with short-lived GitHub App installation tokens, change its own code from a worktree with signed commits, and clean up after merged pull requests.

## What it contributes

- `prompt`: the two access models and how to detect them; in App mode, how GitHub auth works (mint a ~1-hour installation token per command, never `gh auth login`), filing issues, the worktree-first change flow, merging its own pull requests, and handling untrusted content from GitHub
- skills: `register-gh-app` (act through a different GitHub App for another org or role) and `cleanup-worktrees` (remove worktrees whose pull request closed)
- scripts under `scripts/`: `mint-token.ts`, `commit-via-api.ts` (signed commits through the Git Data API), `register-gh-app.ts`, `cleanup-worktrees.ts`
- schedules: `gh-auth-health` (every 30 minutes; App mode proves a token mints and reads `GITHUB_REPO`, ambient mode probes that the API is reachable) and `worktree-cleanup` (daily)
- api: none, chat: none, mcp: none

## Environment

- `GH_APP_ID`, `GH_APP_PRIVATE_KEY`: the GitHub App the intern acts as. When `GH_APP_ID` is unset the feature runs in ambient mode: the minting scripts are not used, `gh-auth-health` probes the API without an Authorization header instead, and the prompt teaches the REST-first path through the host's proxy.
- `GITHUB_REPO`: the intern's own repository, `owner/repo`.
- `GH_APP_ALLOWED_ORGS` (optional): the installation owners a token may be minted against, comma or space separated. Defaults to the owner of `GITHUB_REPO`. Discovery fails closed, so an App installed on a foreign account is never used.
- `GH_AUTH_HEALTH_ALERT_CHANNEL_ID`, `SLACK_BOT_TOKEN` (optional): post `gh-auth-health` failures to a Slack channel. Without them the failure is only logged.

Registered alternate Apps live in a SQLite registry under `~/.config/<intern>/gh-app-registry.db`, which stores environment variable names, never key material.

## Develop

```sh
bun test features/working-with-github
```
