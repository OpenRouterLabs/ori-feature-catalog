---
name: slack-chart
description: Draw a comparison or a flow diagram as an image in the Slack thread.
---

# slack-chart

Slack renders no diagram syntax, so a shape — boxes and arrows, a comparison of magnitudes — ends up as a code block that wraps in a thread pane, and a wrapped diagram stops being a diagram. This uploads it as an image instead.

Tables are NOT here. Slack renders GitHub-flavoured tables natively now, so write rows and columns as a markdown table in the reply. Drawn as an image they came out as overlapping text nobody could read.

```bash
bun features/slack/skills/slack-chart/scripts/index.ts '{
  "kind": "bars",
  "title": "PR queue",
  "rows": [
    { "label": "conflicts", "value": 20 },
    { "label": "red CI", "value": 9 },
    { "label": "ready", "value": 5 }
  ]
}'
```

```bash
bun features/slack/skills/slack-chart/scripts/index.ts '{
  "kind": "flow",
  "title": "Why the run failed",
  "nodes": [
    { "id": "a", "kind": "start", "label": "Turn starts" },
    { "id": "b", "label": "Work reaches green", "detail": "503/503 tests" },
    { "id": "c", "kind": "decision", "label": "Lint gate" },
    { "id": "d", "kind": "error", "label": "Timed out mid-refactor" },
    { "id": "e", "kind": "end", "label": "Commit + PR" }
  ],
  "edges": [
    { "from": "a", "to": "b" },
    { "from": "b", "to": "c" },
    { "from": "c", "to": "d", "label": "blocked" },
    { "from": "c", "to": "e", "label": "passes" }
  ]
}'
```

`flow` lays out top to bottom: a node sits one row below the deepest thing pointing at it, and branches out of the same node sit side by side. `kind` colours the box — `start`, `step` (the default), `decision`, `end`, `error` — so a failure arm reads at a glance.

## When it is worth it

Reach for it whenever the answer has a **shape** — and reach for it without being asked, because a technical answer with a diagram in it is almost always the better answer.

An explanation is a shape. How a request flows through the system, why a run failed, what depends on what, which step ate the time — written out, all of those become a paragraph the reader has to rebuild the diagram from in their head. `flow` draws the boxes and arrows, which is what a post-mortem or a request path actually is.

A comparison of magnitudes is a shape too: written as a sentence it makes a paragraph of numbers nobody can read, and a code block wraps in a thread pane and loses its columns.

- **flow** — boxes and arrows, with branches. The one for a technical answer: a post-mortem, a request path, a decision that went two ways.
- **bars** — comparing more than about four things, where "which is biggest" is the point.

A sentence with six inline code spans in it is a table you have not written yet — a markdown one, in the reply.

Not otherwise. Three numbers belong in the sentence, and a chart of them is slower to read than the sentence. A chart is never the whole reply — say what it shows in a line, and let the image carry the shape.

It costs a file upload, so do not reach for it on a question that a paragraph already answers.

## A flow is a shape, not a list

**Four boxes to a row.** A fan-out from one node to nine is refused: a row is centred across a fixed-width card, so nine siblings overlap into an unreadable smear. If what you have is one parent and many children, that is a **markdown table** with the parent as its heading — Slack renders those natively.

**No HTML in labels.** Labels are escaped before they reach the SVG, so `<br/>` arrives as those four characters rather than a line break. Write shorter labels instead.
