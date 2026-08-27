---
name: spawn-thread
description: >
  Dispatch a task into a Slack thread via the ori Slack chat surface. ONLY TRIGGER when the user EXPLICITLY asks to put work in a separate thread — e.g. "spawn a new thread", "do this in a new thread", "create a thread for this", "handle this in its own thread", "go handle that thread you opened", "continue in the thread above", or any phrasing where the user clearly wants work to happen in a named/new thread rather than inline. NEVER trigger on your own initiative. Never spawn a thread because a task seems long, complex, or "significant" — if the user didn't ask for a separate thread, reply inline. This applies whether you're at the top level or already in a thread. Use `new` to open a fresh top-level thread + dispatch atomically. Use `fork` when the user asks for SEVERAL threads at once ("spin up 2 threads to talk about X", "make three threads and work on each") — one call opens them all and reports which succeeded. Use `continue` (or the legacy flag-only form) to dispatch into an already-open thread. The chat surface handles everything: "is thinking…" status, agent run, reply rendering, exactly as if a user had at-mentioned the bot there. DO NOT trigger for posting ordinary replies or follow-ups — use the normal reply flow or the slack-api skill for those.


allowed-tools: Bash
argument-hint: '{new|continue} --channel <CHANNEL_ID> [--thread-ts <TS>] [--opener "<text>"] --prompt "<task>"  # --opener/--prompt consume remaining tokens'
---

# spawn-thread

Fire-and-forget thread dispatcher. Calls the agent's `POST /slack/thread/dispatch` endpoint — a **loopback-guarded** route the ori daemon serves from the slack feature's `api.routes` (RFC 0002 api.md). The skill POSTs and exits immediately. The chat surface then owns the full message pipeline for the target thread — the "is thinking…" status, the agent run, the reply — exactly as a real at-mention would.

The route rejects any caller whose remote address is not loopback, so only processes on the same VM (this skill) can reach it regardless of the daemon's bind address. **Loopback is the entire trust boundary: there is no auth token.**

Three subcommands cover the real workflows:

- `new` — the user asked to start work in a fresh new thread.
- `fork` — the user asked for several threads at once.
- `continue` — the user asked to keep working in an existing (already-spawned) thread.

A flag-only legacy form (no subcommand) is preserved and treated as `continue`.

## `continue` — dispatch into an existing thread

```bash
bun features/slack/skills/spawn-thread/scripts/index.ts continue \
  --channel C0A3QUF1P25 \
  --thread-ts 1777121661.795389 \
  --prompt "Keep going on the refactor"
```

`continue` validates `--channel`, `--thread-ts`, `--prompt` and POSTs to `/slack/thread/dispatch`. The chat surface enqueues the turn on that thread's serial queue and runs it like a real at-mention. Exits 0 on success, 1 on failure.

## `new` — open a top-level thread + dispatch atomically

```bash
bun features/slack/skills/spawn-thread/scripts/index.ts new \
  --channel C0A3QUF1P25 \
  --opener ":thread: Starting work on the auth refactor..." \
  --prompt "Do the full refactor described in the originating thread"
```

In a single call, `new`:

1. When `$SLACK_CHANNEL_ID` / `$SLACK_THREAD_TS` are set, posts an **anchor placeholder** reply into the originating thread and captures its ts.
2. Builds a Block Kit payload: a `section` block with the opener mrkdwn, plus (when origin context is present) an `actions` block with a **View originating thread** button linking back to the source thread. The button targets the anchor reply ts so Slack opens the thread side-panel reliably.
3. Posts that payload as a top-level (un-threaded) message in `--channel`. The opener text is the notification fallback.
4. Captures the new message's `ts` from the Slack API response.
5. Rewrites the anchor placeholder to link forward to the new thread (bidirectional link).
6. POSTs to `/slack/thread/dispatch` with that `ts` and the `--prompt`.
7. Prints `{"ok":true,"channel":"C...","thread_ts":"..."}` to stdout and exits 0.

If `$SLACK_THREAD_TS` is not set (e.g. invoked at the top level), the anchor and backlink button are omitted and only the opener section is posted.

## Legacy flag-only form (treated as `continue`)

```bash
bun features/slack/skills/spawn-thread/scripts/index.ts \
  --channel C0A3QUF1P25 \
  --thread-ts 1777121661.795389 \
  --prompt "Do the refactor described above"
```

Identical to `spawn-thread continue ...`, preserved for backward compatibility.

## Flag notes

- `--channel` / `-c` — target channel ID (required for all forms)
- `--thread-ts` / `-t` — target thread timestamp (required for `continue` / legacy)
- `--opener` / `-o` — top-level opener text (required for `new`). Consumes tokens up to the next `--prompt`/`-p` flag, so `--opener "..." --prompt "..."` works.
- `--prompt` / `-p` — task description. Always consumes **all** remaining tokens — place it last (or after `--opener`).
- Positional args after all flags become the prompt if `--prompt` was not given.
- **Flag ordering**: `--channel` and `--thread-ts` MUST precede `--opener`. The `--opener` consumer absorbs every token until it hits `--prompt`/`-p`, so any identifier flag placed after `--opener` will be silently swallowed into the opener text.

## Parallel use

To activate multiple threads simultaneously, invoke `new` (or `continue`) once per thread. Each invocation dispatches immediately and returns; the chat surface handles them concurrently (one serial queue per thread).

## Environment

`ORI_RUNTIME_PORT` (default `3141`, the daemon's own port) selects the port — the skill POSTs to `http://127.0.0.1:$ORI_RUNTIME_PORT/slack/thread/dispatch`, served by the daemon. The shared default means no config in the common case.

A depth guard prevents infinite recursion: if `SPAWN_THREAD_DEPTH` is non-numeric, negative, or `>= 3`, the skill exits 1 without dispatching. The skill sends `spawn_thread_depth: depth + 1` in the request body; the chat surface threads `SPAWN_THREAD_DEPTH` into the spawned agent's per-turn env automatically. Both subcommands honour the guard.

## `fork` — several threads in one request

```bash
bun features/slack/skills/spawn-thread/scripts/index.ts fork \
  --channel C0A3QUF1P25 \
  --threads '[
    {"opener":":thread: *Intern Vision — Thread 1: identity*","prompt":"Discuss what an intern actually is."},
    {"opener":":thread: *Intern Vision — Thread 2: the fleet*","prompt":"Discuss scale: many interns, shared skills."}
  ]'
```

Each entry is opened exactly as `new` would — anchor, back-link button,
dispatch — one after another, in the order given, because the user will refer
to them as "thread 1" and "thread 2".

`--threads` is JSON rather than repeated flags because `--opener` and
`--prompt` each consume the rest of the line, so a repeated form cannot say
where one thread ends and the next begins.

At most **5** threads per call. A channel is a shared room; a larger request is
refused rather than honoured.

One failure does not abandon the rest. The report names every thread that
opened and every one that did not:

```json
{"ok":false,
 "created":[{"channel":"C0A3","thread_ts":"1777.1"}],
 "failed":[{"opener":"...Thread 2...","reason":"slack said no"}]}
```

`ok` is false and the exit code is 1 on a partial fork-out — the caller has to
know which threads it can actually refer to.
