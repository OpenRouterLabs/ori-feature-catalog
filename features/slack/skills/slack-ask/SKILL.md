---
name: slack-ask
description: Ask the person who asked a question, and wait for their answer.
---

# slack-ask

Posts a question with buttons into the Slack thread and blocks until someone answers. The answer is printed to stdout, so it can be read straight into a variable.

```bash
answer=$(bun features/slack/skills/slack-ask/scripts/index.ts \
  "The 7 conflicting PRs can be rebased or closed. Which?" \
  --choice rebase="Rebase them" \
  --choice close="Close them")
```

`--choice id=Label` sets what the reader sees and what comes back. A bare `--choice rebase` uses the word as both.

**Offer every option you can act on.** The buttons are the only way to answer this call, and the route refuses an ask with none.

If someone wants something you did not list, they have to **@-mention the bot** with it. A plain thread reply from anyone other than the person who asked is dropped as chatter and reaches nobody. A mention does get through — but it arrives as a new message, which steers the run: this ask is abandoned and you are started again with what they said. So treat an unanswered blocker as a real possibility, not an edge case.

## When to use it

Use it for a decision that is genuinely not yours to make: an ambiguous request, a destructive step, a fork where both paths are defensible and expensive to undo.

Do not use it to check in, to confirm something you already know, or to hand back a plan. A question costs the reader an interruption — the whole point of the surface is that one message runs to completion.

Ask the moment you hit the blocker, not at the end. An answer that arrives after you have finished the wrong work is worth nothing.

## What comes back

- An answer prints to stdout and exits 0. That is the `id` you offered.
- `unanswered` prints to stdout and exits 0 if nobody answers within fifteen minutes. Decide for yourself, carry on, and say in your reply what you assumed.
- Anything else exits 1 with a message on stderr.

Ask one question at a time. A second ask while one is open posts a second message, and the reader has no way to tell which one you are waiting on.
