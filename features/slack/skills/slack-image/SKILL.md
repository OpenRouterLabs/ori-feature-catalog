---
name: slack-image
description: Generate an image and post it into the Slack thread.
---

# slack-image

Generates an image from a description and uploads it into the thread you are replying to.

```bash
bun features/slack/skills/slack-image/scripts/index.ts \
  "a flat vector logo for a CLI tool called ori, monoline, deep blue on charcoal" \
  --title "ori logo"
```

## When to use it

- Someone asks for one — a logo, an icon, a mock-up, a picture of anything.
- An idea is easier to see than to describe, and it is not made of numbers.

Use `slack-chart` instead for anything with rows, columns, magnitudes or a flow. That draws the real data; this invents a picture, and inventing a picture of your data is worse than useless.

Do not decorate. An image attached to an answer that did not need one is noise, and it costs the reader a scroll.

## Notes

Needs `OPENROUTER_API_KEY` on the daemon. `SLACK_IMAGE_MODEL` overrides the model.

Generation takes a while, so post a status first — the thread should say what you are waiting on.
