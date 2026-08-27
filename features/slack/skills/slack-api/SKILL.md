---
name: slack-api
description: Read Slack from the agent — thread replies, channel history, user lookup and mention resolution, and opening a DM. Channel and thread resolve env-first ($SLACK_CHANNEL_ID / $SLACK_THREAD_TS) with a --channel fallback, so you can usually omit them. TRIGGER when asked to fetch a thread or channel history, find someone's user id, resolve a mention, or DM someone. This skill does NOT post, edit, delete or react — your answer is just the text you write, and progress goes through the slack-status skill.
---

# slack-api — Slack Web API toolbox

Reading Slack, and nothing else. Built on the same `@slack/web-api` `WebClient` (from `$SLACK_BOT_TOKEN`) the chat surface uses.

**This skill used to write.** It could post, edit, delete, react, post ephemerals and set titles, and every one of those bypassed the surface: no update rationing, no `markdown` block, no one-answer-per-turn rule. The SKILL.md carried a warning asking the agent not to use `chat.postMessage` for its reply because it produced a duplicate message — a hazard documented rather than removed. Those commands are gone.

This skill does not write at all. Progress goes through **`slack-status`**, questions through **`slack-questions`** or **`slack-ask`**, pictures through **`slack-chart`** and **`slack-image`**, and a new thread through **`spawn-thread`**. Your answer itself is posted by the surface when the turn ends.

## CLI usage

```bash
bun features/slack/skills/slack-api/scripts/slack.ts <command> [--flags ...]
```

On success it prints the Slack API response (or aggregated data) as pretty JSON and exits 0. On failure it prints `ERROR: <message>` to stderr and exits 1.

## Channel & thread routing (env-first)

- `--channel` falls back to `$SLACK_CHANNEL_ID`. In most turns you can omit it and the toolbox posts in the current channel.
- Same-channel posts auto-use `$SLACK_THREAD_TS` — omit `--thread-ts` to reply in the current thread.
- A **cross-channel** post (target ≠ `$SLACK_CHANNEL_ID`, when that env var is set) requires an explicit `--thread-ts <ts>` or `--no-thread`.
- `--no-thread` posts a top-level (unthreaded) message.

> **Note on env availability:** the agent currently runs in a separate process from the chat handler, so `$SLACK_CHANNEL_ID` / `$SLACK_THREAD_TS` may not yet be present as literal env vars. Until they are, pass `--channel` (and `--thread-ts` where needed) explicitly. The per-turn Slack context block injected into the prompt tells you the current channel/thread/user to use. The toolbox is already env-first, so when the framework begins threading those env vars (the parallel "B2" framework change) it works with zero changes.

## Commands

### `conversations.replies`

```bash
bun features/slack/skills/slack-api/scripts/slack.ts conversations.replies \
  --channel C123 --ts 1234567890.123456 [--limit 50]
```

Output: `{ messages: [...], hasMore }`. `hasMore` is true when `--limit` was hit and Slack had more pages (detect silent truncation).

### `conversations.history`

```bash
bun features/slack/skills/slack-api/scripts/slack.ts conversations.history \
  --channel C123 [--oldest 1700000000.000000] [--latest 1700009999.999999] [--limit 1000]
```

Output: `{ messages: [...], hasMore }`, deduped by `ts`. `--limit 0` = unlimited (capped at 10k — window large channels with `--oldest`).

### `conversations.open`

```bash
bun features/slack/skills/slack-api/scripts/slack.ts conversations.open --users U123,U456
```

Response includes `channel.id` of the DM.

### `users.list`

```bash
bun features/slack/skills/slack-api/scripts/slack.ts users.list [--search "Chris"]
```

Output: JSON array of `{ user_id, display_name, real_name }`. Bots, deleted users, and USLACKBOT are excluded. Fetches live each call (no cache).

### `users.mention`

```bash
bun features/slack/skills/slack-api/scripts/slack.ts users.mention --name "lab"
# → <@U05AJSRUVPT>
```

Always use the resulting `<@USERID>` form in posts — plain-text `@name` does not notify or link.

## Notes / limitations

- Non-Marketplace Slack apps may be capped at 15 messages/request and 1 req/min for `conversations.replies` / `conversations.history`, so large fetches can be slow.
- This skill carries vendored Result / arg-parsing helpers (`result.ts`) rather than depending on a shared workspace package, matching the `clickhouse` skill's convention. Markdown is converted with `slackify-markdown` (the chat surface's dependency), not Perry's `@ori-monorepo/egg`.
