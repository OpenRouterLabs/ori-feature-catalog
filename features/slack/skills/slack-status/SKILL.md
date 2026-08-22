---
name: slack-status
description: Say what you are doing and what you find, in the Slack thread you were started in. TRIGGER within the first minute of every turn, again on every action you take, and with --notify the moment you discover something.
---

# slack-status

```bash
# the live line — free, silent, replaced by your next one. Keep it current.
bun features/slack/skills/slack-status/scripts/index.ts "reading run-events.ts to find where AgentFailure comes from"

# a finding — permanent, pings the thread, and still sets the line
bun features/slack/skills/slack-status/scripts/index.ts --notify "It is not the code: .ori/sdk is generated per machine, and yours predates AgentFailure"
```

The thread comes from your environment. You never pass it.

## Not for a turn you can just answer

A greeting, an acknowledgement, a correction, a question you can answer off the top of your head — those are finished before any status could land. `I'll say hello back` followed by `hello` is two messages where one was wanted, and the thread keeps the useless one. **If you are about to reply, reply.**

Everything below is for a turn that is still running a minute from now.

## Three obligations, not options

1. **Within the first minute**, on any turn that will still be going after it. Not once you have finished thinking — as soon as you know what you are about to look at.
2. **On every action.** A command, a file, a search: say what you are doing as you do it. It is one line, it replaces the last one, it interrupts nobody, and it is free. The only way to get it wrong is to leave it stale.
3. **The moment you discover something**, with `--notify`. A cause found, a decision made, a number that changes what happens next. That one is permanent and people can read it later; the plain line dies with your next update.

A run that works in silence is indistinguishable from a crash.

## Write a sentence

`Checking CI on the 9 red PRs — 6 are the same flaky timeout, looking at the other 3`, not `checking CI`. A bare label tells nobody anything.

## Limits

The line is capped at **120 characters** — Slack renders it on one line and never folds it. A `--notify` message may run to **300**. Over the cap it is rejected with the reason, not cut: shorten and send again.

**Lead with the point.** The line shows in full under the composer, but the copy inside the thread — the one people actually read while they wait — is shortened to about **40 characters**, on a word boundary. So put the subject first: `rebasing the 7 conflicting PRs` survives whole, while `going through the list of open pull requests to rebase the 7 that conflict` reaches the reader as `going through the list of open…` and says nothing.
