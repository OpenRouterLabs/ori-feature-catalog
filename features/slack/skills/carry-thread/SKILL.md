---
name: carry-thread
description: >
  Move THIS conversation onto a fresh Slack thread, keeping the same agent session and everything it remembers. ONLY TRIGGER when the user EXPLICITLY asks to continue the current conversation somewhere else — e.g. "continue this in a new thread", "move this to a fresh thread", "same conversation, new thread", "this thread is too long, carry on in a new one". NEVER trigger on your own initiative. Never carry because a thread looks long, cluttered, or busy — if the user did not ask, keep replying where you are. This is NOT for starting separate work: if the user wants a NEW task in its own thread with a fresh start, that is the spawn-thread skill instead. Carrying MUTES the thread you are in, so doing it unasked strands whoever is talking to you.
allowed-tools: Bash
argument-hint: '--opener "<the message that opens the new thread>"  # --opener consumes remaining tokens'
---

# carry-thread

Moves the current agent session onto a new top-level Slack thread. The
conversation keeps its memory — it is the same session at a new address.

```bash
bun features/slack/skills/carry-thread/scripts/index.ts \
  --opener ":thread: Continuing here — the other thread got long."
```

The thread being carried is the one this turn is running in, read from
`$SLACK_CHANNEL_ID` / `$SLACK_THREAD_TS`. There is no `--channel` flag: a
conversation cannot be carried into a channel its participants may not be in.

## What happens

1. An anchor reply is posted into the current thread, then rewritten to link
   forward to the new one.
2. A top-level message is posted with the opener and a **View originating
   thread** button pointing back.
3. `POST /slack/thread/carry` (loopback-guarded) moves the session binding onto
   the new thread and mutes the old one.
4. A closing line is posted in the old thread saying where the conversation
   went.

Prints `{"ok":true,"channel":"C...","thread_ts":"...","sessionId":"..."}` and
exits 0. Exits 1 with a reason on failure.

## When it refuses

- **The current thread has never run a turn** (HTTP 422). There is no session
  to carry — the user wants `spawn-thread new`.
- **The current thread is mid-turn** (HTTP 409). Rebinding underneath a running
  turn would hand the new thread a session the old turn is still writing to.
  Wait for the run to finish and carry again.
- **No thread in scope.** `SLACK_CHANNEL_ID` / `SLACK_THREAD_TS` unset.

On a failure after the new thread was already posted, the reason is posted into
the ORIGINAL thread — that is where the user is looking — and the session stays
where it was.

## Why not spawn-thread

`spawn-thread new` opens a thread and lets the daemon mint a **fresh** session:
the new thread knows only what you put in its prompt. Use it for separate work.
`carry-thread` keeps the **same** session. Use it when the user means "this
conversation, elsewhere".
