# slack

Project-owned Slack chat surface for this intern. Forked from ori's `@ori-builtins/slack` builtin and registered under the builtin's own name (`slack`) so the workspace feature **shadows** the framework catalog entry — only this surface boots.

## What it contributes

- `chat` name `slack` — Bolt Events API bridge
- `api` routes:
  - `POST /slack/events` (Slack Events + interactivity)
  - `POST /slack/thread/dispatch` (loopback spawn-thread)
  - `POST /slack/thread/ask` (loopback slack-ask, held until answered)
  - `POST /slack/thread/questions` (loopback slack-questions)
  - `POST /slack/thread/chart` (loopback slack-chart)
  - `POST /slack/thread/image` (loopback slack-image)
- `api.exports.postMessage` — `use("slack")`
- skills: `slack-api`, `slack-ask`, `slack-chart`, `slack-image`, `slack-questions`, `slack-status`, `spawn-thread` (paths under `features/slack/...`)
- the typing indicator is the surface's own: `src/turn/status-beat.ts` renders it from tool calls, so it never depends on the agent remembering to speak
- mcp: none — the surface serves no MCP server

## Cut over from the ori builtin

1. Merge this feature and redeploy / restart `ori start`.
2. In the Slack app config, point **Event Subscriptions** and **Interactivity** request URLs at `https://<host>/slack/events` (the same path the builtin served — no Slack-side change needed if it already points there).
3. Keep existing `SLACK_BOT_TOKEN` / `SLACK_SIGNING_SECRET` (and optional `SLACK_BOT_USER_ID`, allowlists, etc.).
4. Confirm boot logs show `slack chat surface is live` and that mention traffic hits this surface (cloudflared → daemon port unchanged).

Because this feature shadows the builtin by name, the framework builtin no longer registers a competing `POST /slack/events` route or `use("slack")` api — this feature owns both.

## Env

Every name is read in one place — `src/config.ts`, decoded once at boot. `SLACK_ENV_VARS` there is the authoritative list.

Required (a missing one names itself and stops the boot):

- `SLACK_BOT_TOKEN`
- `SLACK_SIGNING_SECRET`

Optional, each with a default. A malformed value falls back rather than failing the boot — a surface that will not start over a bad emoji is a worse failure than the bad emoji:

- `SLACK_ALLOWED_USER_IDS` — comma-separated; empty means anyone in the channel
- `SLACK_BOT_USER_ID` — used to skip the bot's own messages
- `SLACK_SKIP_PREFIXES` — comma-separated; a message starting with one is not for the bot
- `SLACK_LOADING_EMOJI` — default `:braille-loader:`, an animated custom emoji; set a standard one such as `:hourglass_flowing_sand:` in a workspace that has not installed it
- `OPENROUTER_API_KEY` — enables `slack-image`; absent means image generation is unavailable, not that boot fails
- `SLACK_IMAGE_MODEL` — overrides the image model
