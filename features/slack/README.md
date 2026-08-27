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
- `api.exports.postMessage`, `api.exports.webClient`, `api.exports.onButton` — `use("slack")`
- skills: `slack-api`, `slack-ask`, `slack-chart`, `slack-image`, `slack-questions`, `slack-status`, `spawn-thread` (paths under `features/slack/...`)
- the typing indicator is the surface's own: `src/turn/status-beat.ts` renders it from tool calls, so it never depends on the agent remembering to speak
- mcp: none — the surface serves no MCP server

## Custom buttons

A sibling feature can post its own button and answer the click, without
forking this surface or taking a dependency on `effect` or `@slack/web-api`.

```ts
import { use } from "ori";

const slack = use("slack");

// Register once, at module scope — before the surface boots.
await slack.onButton("redeploy", async (click) => {
  // click: { actionId, channelId, threadTs, userId, value }
  await redeploy(click.value);
});

await slack.postMessage({
  channel: "C123",
  text: "Ready to redeploy",          // the notification fallback
  blocks: [
    { type: "section", text: { type: "mrkdwn", text: "*Ready to redeploy*" } },
    {
      type: "actions",
      elements: [
        { type: "button", action_id: "redeploy", value: "v42",
          text: { type: "plain_text", text: "Redeploy" } },
      ],
    },
  ],
});
```

`actions` and `button` builders are exported too, if you would rather not
hand-write the Block Kit — they apply Slack's label and value ceilings so an
over-long label is truncated instead of rejecting the whole message.

Rules worth knowing:

- **`ori_` is reserved.** Every built-in action id uses that prefix and the
  router is last-registration-wins, so claiming one would silently take over a
  surface button. Registration throws.
- **Anyone who can see the thread can click.** The payload names the clicker
  in `userId` — check it if the action is privileged.
- **The click carries no `trigger_id`.** So a custom button cannot open a
  modal: that needs a trigger spent within three seconds, which only the
  surface can do. Buttons that answer a question (`slack-ask`,
  `slack-questions`) are the supported path for collecting input.
- **A handler that throws is logged, not swallowed** — and the click still
  acks, so Slack does not show the reader an error.
- Registering after boot works and wires immediately, rather than being
  silently dropped.

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
