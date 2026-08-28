---
name: slack-attach
description: >
  Attach ANY file to the current Slack thread — text or binary. A log, a diff, a CSV, a long answer as a snippet, and equally a PDF, a PNG, a zip, a sqlite db, a tarball: the bytes go up unchanged. TRIGGER when the user asks you to attach, upload, or send a file, or when an answer is too long or too structured to read as a message (a full log, a wide table, hundreds of lines of output) and a file reads better than a wall of text. Also TRIGGER when the user asks for something "as a file", "as a snippet", "as an attachment", or "upload that". Write the content to a file first with Bash, then attach it. This is NOT for charts (use slack-chart) or generated images (use slack-image) — those render and upload on their own. This is NOT for ordinary replies: a short answer belongs in the message, not in an attachment.
allowed-tools: Bash
argument-hint: '--path <FILE> [--title "<shown as the file title>"] [--comment "<message posted with it>"]'
---

# slack-attach

Uploads a file from disk into the thread this turn is running in, using Slack's
`files.getUploadURLExternal` → upload → `files.completeUploadExternal` flow.

**Any file type.** The bytes are sent as-is — Slack is told the byte length up
front and the file is POSTed raw, so a PDF, an image, an archive or a database
arrives intact. Nothing is re-encoded as text.

```bash
bun features/slack/skills/slack-attach/scripts/index.ts \
  --path /tmp/deploy.log \
  --title "deploy.log" \
  --comment "The failing run, in full."
```

The thread comes from `$SLACK_CHANNEL_ID` / `$SLACK_THREAD_TS`. There is no
`--channel`: a file goes to the conversation that asked for it.

## Attaching an answer as a snippet

Write it, then attach it:

```bash
cat > /tmp/answer.md <<'TXT'
| stage | status |
| ----- | ------ |
| dedup | ok     |
TXT
bun features/slack/skills/slack-attach/scripts/index.ts \
  --path /tmp/answer.md --title "Pipeline stages"
```

Slack renders `.md`, `.txt`, `.json`, `.csv` and source files as previewable
snippets, so a long or wide answer stays readable instead of being flattened
into message text.

## Binary example

```bash
bun features/slack/skills/slack-attach/scripts/index.ts \
  --path /tmp/q3-report.pdf --comment "Q3, signed off."
```

## Flags

- `--path` (required) — the file to upload. Read by the daemon, which runs on
  this host.
- `--title` — the file's title in Slack. Defaults to the filename.
- `--comment` — a message posted alongside the file.

Prints `{"ok":true,"permalink":"https://..."}` and exits 0. Exits 1 with a
reason on failure.

## When it refuses

- **`cannot read <path>`** (HTTP 422) — the path does not exist or is not
  readable. Check the file was written before attaching it.
- **`Slack refused the upload`** (HTTP 502) — Slack rejected the file. The
  cause is logged by the daemon.
- **No thread in scope** — `SLACK_CHANNEL_ID` / `SLACK_THREAD_TS` unset.

The upload leg is given two minutes before it is abandoned, so a very large
file over a slow link can time out; the workspace's own file size limit applies
on top of that.
