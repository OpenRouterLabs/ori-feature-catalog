# artifacts

Save an intern's work as a self-contained HTML page in its own workspace, under `artifacts/<name>/`, and reply with the link. On a hosted intern the dashboard's Artifacts tab shows the newest version to people who can see the intern; on a laptop the page is the saved file.

## What it contributes

- three commands the skill drives, declared as `save`, `list` and `delete` and registered by ori under the feature's namespace: `artifacts-o-save <file> --name <name> --title <title>`, `artifacts-o-list`, `artifacts-o-delete <name>`
- one skill, `artifacts`, carrying when a page reads better than a chat message and the rules a page must follow
- one prompt fragment (the `prompt` export, text in `src/prompt.ts`) naming the commands, the page rules and the CDN list
- api: none, chat: none, mcp: none, tools: none

The command layer is the `ori artifact` builtin moved into the feature: the same inlining pipeline (CDN downloads put inside the page, the network-block Content-Security-Policy written into its head, the 16 MiB limit, the same refusals with the same codes) and the same workspace store (`artifacts/<name>/v<N>.html` with `artifact.json`, per-name save locks, never overwriting a version file). No file changed shape; `ori artifact` and this feature write the same layout.

## How the commands run

The commands are feature `command` contributions, so the agent reaches them through the harness command surface instead of the `ori` CLI: a person types `/artifacts-o-save`, and the agent calls the `command-artifacts-o-save` tool. Each one resolves the intern workspace from the command's own working directory (the nearest directory with a `features/` directory, else the working directory itself), so pages land in the workspace even when a session runs in a worktree.

## Environment

`ORI_INTERN_ID` is optional. On a hosted intern the daemon exports it, and `artifacts-o-save` returns the dashboard link; without it the command prints the saved file's path.

## Develop

```sh
bun test features/artifacts
```

The command takes its filesystem, HTTP client and output through Effect services plus a small `SaveDeps`, so the tests run it end to end against temp directories and a scripted CDN, without a network.
