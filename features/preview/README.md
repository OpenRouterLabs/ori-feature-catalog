# preview

A catalog feature that keeps a hosted intern's connected GitHub repositories running on localhost and gives the agent a persistent headless Chromium to screenshot them through. It is written against the public `ori` SDK only; Effect and its Bun platform layers are its own dependencies.

It contributes only on a hosted intern (`ORI_INTERN_PACKED=1` or a nonblank `ORI_DAEMON_TOKEN`) that opted in with `ORI_PREVIEW_ENABLED=1` or a nonempty `ORI_PREVIEW_REPOS`. Anywhere else it contributes no tools and no prompt, and its schedule is contributed disabled (`disabled: true`, a run that reports `skipped: previews_disabled`), because the loader rejects an undefined `schedule` export and would then drop the whole feature.

## What it contributes

- `preview-status`, `preview-warm`, `preview-screenshot`, and `preview-save-recipe`.
- An every-minute warm-up schedule (`overlap: "skip"`, no catch-up).
- A prompt fragment that tells the agent how to use the tools.

## Environment

- `ORI_PREVIEW_ENABLED=1` or `ORI_PREVIEW_REPOS=owner/name,...` opts the intern in. Without `ORI_PREVIEW_REPOS`, `preview-status` lists the GitHub App installation's repositories.
- `ORI_INTERN_WORKSPACE_ROOT` is the workspace the state lives in; the process working directory otherwise.
- `PREVIEW_ENV_<NAME>` binds a value for a variable a recipe lists in `requiredEnv`.
- `ORI_DAEMON_TOKEN`, or the port-keyed credential file under `~/.ori/daemon`, lets `preview-screenshot` post to a Slack thread.

## Boundaries

- Own the recipe resolution, repository sync, dev-server supervision, browser control, and the four preview tools here.
- `feature.ts` is the only file that reads the host env and the `ori` runtime values (`defineTool`, `ToolResultSchema`, the daemon-credential helpers). It hands them to `src/host.ts`, which decides whether the feature contributes; everything under `src/` takes them as arguments or services.
- Talk to GitHub only through `api.github.com` and `codeload.github.com`. The managed egress proxy injects the credential on those two hosts and nowhere else, so a `git clone` over `github.com` would go out anonymous.
- Talk to Chromium only over its DevTools HTTP and WebSocket endpoints on `127.0.0.1:9222`. There is no Playwright or Puppeteer dependency.

## Entry points

- `feature.ts` - the catalog entry: exports `tools`, `schedule`, and `prompt` from `makePreviewContributions` in `src/host.ts`, which builds the Bun platform layer (`previewHostLayer`) and runs the gates (`previewHosted`, `previewEnabled`, `previewWorkspaceRoot`).
- `src/feature.ts` - `makePreviewSchedule`, the every-minute warm-up sweep, and `PREVIEW_PROMPT`, the prompt fragment that tells the agent how to use the tools.
- `src/tools/index.ts` - `makePreviewTools(env)`, returning `preview-status`, `preview-warm`, `preview-screenshot`, and `preview-save-recipe`.
- `makePreviewTools(env, defineTool)` and `makePreviewSchedule` are Effects that require `PreviewServices` (`src/tools/context.ts`). `src/host.ts` provides them once, and each captures that context, so every tool call and sweep runs on it with `Effect.runPromiseWith`.
- `src/daemon-credentials/` - the `DaemonCredentials` service, typed from the SDK's `daemonAuthorizationOf` and `publishedDaemonCredentialFile`; `feature.ts` binds the real helpers and tests a scripted one.
- `src/process-groups/` - the `ProcessGroups` port: detached, OOM-first process groups (`spawnDetached`, `runToExit`, which SIGKILLs the group when interrupted, `signal`, `ownPid`). `bun/` holds `bunProcessGroupsLayer`, the only `Bun.spawn`, `process.kill`, and `process.pid` in the package.
- `src/tcp-probe/` - the `TcpProbe` port: `isPortFree` on both loopbacks and the raw HTTP `get` readiness uses. `bun/` holds `bunTcpProbeLayer`, the only `Bun.listen` and `Bun.connect`; `src/readiness/direct-get.ts` keeps the pure request and response parsing.
- `src/process/index.ts` builds `isAlive`, `killGroup`, `assignPort`, `ensurePortFree`, and `currentProcess` over those two ports, and `src/browser/cdp.ts` opens DevTools sockets through Effect's `Socket.WebSocketConstructor`. `previewHostLayer` supplies `bunProcessGroupsLayer`, `bunTcpProbeLayer`, and `BunSocket.layerWebSocketConstructor`; tests use `recordingProcessGroupsLayer` and `scriptedTcpProbeLayer` from each port's `test-support.ts`.
- `src/warm/index.ts` - `connectedRepos` returns `ORI_PREVIEW_REPOS` when set, otherwise the GitHub App installation's repositories unioned with every readable repository of each owner the installation names (`src/repo/discover.ts`, most recently pushed first, archived skipped, deduplicated with the later listing winning, each listing paged up to 100 pages with a warning when it is cut off); `reconcilePreviews` keeps warm only what a person chose (`ORI_PREVIEW_REPOS`, or repos with a `lastUsedAt` from a tool call), up to `PREVIEW_MAX_WARM` most recently used, and parks the rest. It never calls installation discovery, which only `preview-status` uses, so an idle intern spends no GitHub quota. A failed head check leaves a live warm server serving its last checkout instead of marking it not runnable; `makeRoom` parks the coldest before a tool call warms one more.
- `src/warm/warm-repo.ts` - one repository end to end: resolve the default-branch head, sync the tarball, resolve a recipe, check required env, install when the lockfile changed, start, wait for a clean page, precompile it in the browser, and record `warm`. Every `PreviewError` becomes a `not_runnable` status carrying the reason.
- `src/recipe/index.ts` - resolution order: the repo's committed `.ori/preview.json`, the recipe the agent saved with `preview-save-recipe`, then package.json heuristics refined by `.devcontainer/devcontainer.json`.
- `src/browser/index.ts` - launches or reuses the one Chromium, and `capturePage` returns a PNG, the page title, and console errors.
- `src/alternate/index.ts` - the second dev server started from the agent's changed copy for before/after screenshots, on its own assigned port. The screenshot tool stops it right after the `after` capture, because previews share the intern's own machine and `PREVIEW_MAX_WARM` is 1.
- `src/slack/index.ts` - in a Slack turn (`SLACK_CHANNEL_ID` / `SLACK_THREAD_TS` in the thread's env), `preview-screenshot` posts its images to the thread through the runtime's `internal` `/slack/thread/attach` route, the same one the attach skill calls, with the daemon credential from `ORI_DAEMON_TOKEN` or the port-keyed file under `~/.ori/daemon`. Without one it posts nothing and logs why. Outside Slack it posts nothing.
- `src/sandbox/index.ts` - `sandboxed` (setpriv to `PREVIEW_UID`), `sandboxEnv` (allowlisted env), and `prepareSandbox`, which makes the workspace root-only (0700), hands `PREVIEW_UID` its own directories under `/preview`, and refuses to run anything unless the platform's host firewall answers for `PREVIEW_UID`.

## State

- Everything lives under `<workspace>/.ori/preview/`, which the agent's file tools treat as read-only and `.gitignore` already excludes. Screenshots go to `<workspace>/preview-shots/` so the agent can attach them.
- One status file per repository (`status/<owner>__<name>.json`), written atomically. The daemon's sweep and the tool calls both write them, so a per-repo lock directory (`locks/<slug>/owner.json`) serializes warm and park. The sweep skips a held lock; a tool call waits for it. A lock whose owner is dead is taken over, and one with no owner file is taken over after 30 seconds.
- Every recorded process is a `ProcessRef`: the pid plus its `/proc/<pid>/stat` start time. `isAlive` and `killGroup` compare both, so a pid the kernel reused for something else is never signalled. Dev servers and Chromium are detached process groups marked with `oom_score_adj=1000` by `markOomFirst` (`src/oom-first-child.ts`), so under memory pressure the kernel kills them before the agent.
- The sweep checks the default-branch head at most every five minutes per repo and does not retry a repo already `not_runnable` at the current head. A tool call always rechecks and retries.
- Warming a new head installs into the running checkout, then stops the old server just before starting the new one, so the preview is down for the start time only.

## Invariants

- Import ori contracts only from `ori`; nothing from the ori monorepo's internal packages.
- A preview is `warm` only after a page answered below 500 without a known framework error overlay. Never record `warm` for a server that is merely listening.
- `preview-screenshot` only ever loads the preview's own loopback origin: `joinUrl` strips leading slashes so a path cannot name another host.
- Chromium renders repository code, so it runs as `PREVIEW_UID` with the sandbox env like the dev servers. Launches are serialized, and stale `Singleton*` profile locks are cleared first, because a crashed instance leaves them behind and the next launch would otherwise exit immediately.
- Repository code (tar, install, dev servers, the changed copy, Chromium) runs as `PREVIEW_UID` (10001) through `setpriv`, never as root. Its env is built from an allowlist. A name a recipe lists in `requiredEnv` gets only the value an operator bound as `PREVIEW_ENV_<NAME>`, never the host's own variable of that name, and names matching `ORI_*`, `SLACK_*`, `OPENROUTER_*`, `OTEL_*`, `VAULT_*`, or `*PROXY` are never passed at all. Repository-sourced text in tool results (page titles, console errors, log tails) is wrapped by `untrusted()` in `src/untrusted/index.ts`, which neutralizes planted fence markers. Stripping env alone is not a boundary: root's `/proc/<pid>/environ` and the metadata server are, which is why the uid and the firewall exist.
- The platform installs the host firewall (an `ORI_PREVIEW` chain matching `--uid-owner 10001`): DNS, loopback ports 41000-41999, and the internet only. The metadata server, the vault egress proxy, ori, the Chromium debug port, and private ranges are rejected. `PREVIEW_UID` and `PREVIEW_PORT_RANGE` must match the provisioner's `startup-script/preview.ts`.
- Every server gets its own port from `PREVIEW_PORT_RANGE`, substituted for `{port}` in the recipe and set as `PORT`. A dev script that pins its own port is `recipe_unresolved` until the agent saves a `{port}` recipe. A port is checked free before the server starts, so a server is never mistaken for another.
- Root never writes inside a checkout: the sync marker lives in `synced/`, and the tree swap runs as `PREVIEW_UID`, so a symlink planted by repository code cannot redirect a root write.
- Everything repository code touches (checkouts in `/preview/repos`, changed copies in `/preview/work`, its home, the Chromium profile, sync scratch) lives under `PREVIEW_SANDBOX_ROOT` (`/preview`), a host directory the platform mounts beside the workspace. The workspace itself is 0700, so `PREVIEW_UID` cannot enter it at all, including files created later. Root-only state (status, logs, locks, recipes, sync markers, screenshots) stays in the workspace.
- `changedDirectory` must resolve, after symlinks, to a directory under `/preview/work`, because it is re-owned to `PREVIEW_UID` before it runs.

## Tests

- Run `bun test features/preview` from the catalog root; `bun run typecheck` after `ori init .`.
