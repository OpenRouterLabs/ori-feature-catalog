---
name: slack-questions
description: Ask the person a batch of questions and END YOUR TURN. Posts a form and returns immediately — it does not wait. TRIGGER for a decision that is genuinely not yours — an ambiguous request, a destructive step, a fork where both paths are defensible.
---

# slack-questions

```bash
bun features/slack/skills/slack-questions/scripts/index.ts \
  "Before I start on the 7 conflicting PRs, two things." <<'JSON'
[
  {"id":"strategy","prompt":"Rebase them or close them?","kind":"single","choices":["Rebase","Close"]},
  {"id":"order","prompt":"Any that should go first?","kind":"text","optional":true}
]
JSON
```

**Use the heredoc.** Passing the JSON as a quoted argument works right up until a question contains an apostrophe — `Delete Ahmed's branch?` ends the shell quote and you get a parse error that looks like nothing to do with this skill. Double quotes are worse: `$HOME` and backticks expand silently, and a different question reaches the person than the one you wrote.

The thread comes from your environment. You never pass it.

## It does not wait — end your turn

This posts the form and returns immediately. **Say what you are blocked on and finish your turn.** When they answer, you are started again on the same thread, with their answers and everything you already knew. A turn that keeps working after asking will have moved on by the time anyone replies.

## Batch everything

Up to 10 questions, each with its own `id` — that is how the answer comes back labelled. Three questions at once costs one interruption; three separately costs three.

Each question takes:

- `id` — yours, and how the answer is labelled coming back. Must be unique.
- `prompt` — the question itself.
- `kind` — `single` (pick one), `multi` (pick any), or `text` (free typing). Defaults to `single` when `choices` are given, `text` when they are not.
- `choices` — the options, when there are options.
- `optional` — default false. True lets them skip it.

## When to use it

For a decision that is genuinely not yours: an ambiguous request, a destructive step, a fork where both paths are defensible and expensive to undo. Ask the moment you hit the blocker, not at the end — an answer that arrives after you have done the wrong work is worth nothing.

Do not use it to check in, to confirm something you already know, or to hand back a plan.

## Related

`slack-ask` asks ONE question and blocks the run for up to fifteen minutes waiting. Use that only when the next line of work genuinely cannot be written without the answer. This skill is the default.
