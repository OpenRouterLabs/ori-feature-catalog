# Slack feature — working notes

Rules that cost us something to learn. Read before adding to this feature.

## Anything with a lifecycle is a Service

State that lives across a turn goes behind a `Context.Service` and is provided from `SlackDefaultLayers` — never a module-level `Map`.

A module global is shorter and makes that capability the one thing nobody can extend. `ThreadContext` can be wrapped by another feature through `extendSlack`; a global cannot. The since-deleted `StatusSinks` was written as a global first and had to be converted, which is why this is written down.

Pure functions do not need this. A chart takes numbers and returns a string — there is nothing to inject, and a layer would be ceremony.

## One global slot, and DI for everything else

Ori does not import `feature.ts`, it rebuilds it. `importFreshModule` runs `Bun.build` into a fresh temp directory and imports the output, so every load is a new file URL bundling the feature's own files together. `discoverFeatures` is called from the harness loader, the skill contributions, feature boot and the CLI, and the module cache beside it is only consulted under an import scope that edit mode sets, so in ordinary operation each caller gets its own build.

For a feature, module scope is per-load, not per-process.

That is a bootstrap problem, not a general one. Exactly one reference has to survive: `src/feature-state.ts` keys a `globalThis` property by `Symbol.for` and is the only file in the feature allowed to name `globalThis`. It holds the running `SlackRuntime` and the buttons registered before the surface came up -- nothing else.

Everything downstream goes through the Effect context the runtime carries. `onButton` reaches `Interactions` with `Context.get(runtime.context, Interactions)` rather than keeping its own copy, which is how three `globalThis` singletons became one. Reach for the context first; the slot is only for what has to exist before the context does.

`src/feature-state.test.ts` builds the module twice, the way the loader does, and asserts the state crosses. Against a module-level binding it fails -- that is the shape #31 shipped, and it took the surface down on every intern.

## A directory index is a composition root

`index.ts` builds the subsystem its directory owns and hands back the layer. Read one and you know what that directory provides, what it needs to be built, and in what order the pieces go together, because the wiring is the file:

```ts
export type ThreadServices = AssistantThreads | ThreadContext;

export const ThreadLayer: Layer.Layer<ThreadServices, never, SlackClient> =
  Layer.mergeAll(
    Layer.effect(ThreadContext)(ThreadContextLive),
    Layer.effect(AssistantThreads)(AssistantThreadsLive())
  );
```

`SlackDefaultLayers` then composes roots rather than reaching past them for individual services, so adding a service to a subsystem touches one file instead of two.

It is not a re-export file. Callers still import the module that owns a name; a directory index that only forwards names is a second place for every name to live, and two of them that reference each other form an import cycle -- `client/index.ts` was that, twice.

A directory earns one when it has something to compose. `registry.ts` is module-level state behind plain functions, so `thread`'s root does not present it, and directories that are only pure helpers do not have one at all.

## Every directory has an index.ts, and none of them forward

`index.ts` is the directory. It is never a re-export of its siblings -- `src/index.test.ts` fails on any `export *` -- and it takes one of two shapes.

Where the directory assembles something, the index holds that assembly, moved there rather than pointed at. `thread`, `interactions`, `message-stream`, `state` and `client` build layers, in the shape of the daemon's own layer module: options schema and type, a config service where there are options, the implementation layer that acquires its dependencies, `makeXLayer(options)` with an explicit requirement list, a default instance. `turn`, `turn/routes`, `turn/attachments`, `turn/context`, `turn/listening`, `surface`, `dashboard`, `message-reply` and `helpers/charts` build handlers and pipelines the same way.

Where the directory is one module, that module IS the index -- `helpers/users/index.ts`, `helpers/modals/index.ts`, `turn/handler/index.ts`. There is no wrapper around it and no second file to keep in step.

Making an index usually means splitting the module it came from. `reply-live.ts` returned one lump with six operations inline; `attachments.ts` and `engagement.ts` owned no primitive at all and are gone, their wiring now in the index beside them. If an index would only forward a name, the composition has not been found yet.

None of this works while two directories depend on each other. `client/` held `bolt-lifecycle.ts`, `listeners.ts` and `surface-events.ts`, which wire Bolt to `thread` and `interactions` while the rest of `client/` is the SDK wrapper those two depend on -- a cycle the moment both have an index, and why `client/index.ts` failed twice. They live in `src/surface/` now and the graph has no mutual pairs.

## More than four files on one topic is a folder

A directory is for reading, not for filing. Once a topic reaches five files — counting its tests and test support, because those are what you scroll past looking for the source — it gets its own folder, and the parent gets shorter.

`turn/` is the reason the rule exists. It reached 35 entries and stopped being scannable: `attachments`, `handler` and `context` were five files each, interleaved alphabetically with everything else, so nothing read as a group.

Four or fewer stays flat. A folder holding one module and its test earns nothing, and `client/client/` is worse than the problem it solves — when the oversized topic IS the directory's own subject, the directory is already the answer.

## Nice-to-haves live in `helpers/`

`helpers/` is for optional, pure surface area: Block Kit builders, charts, modals. Everything there should be importable without booting anything.

The turn path, registries, and routes stay out of it. If a file holds state or participates in the turn lifecycle it is not a helper.

## No comments

The source carries none. A name, a type, or a smaller function says it better, and a comment is the one part of a file nothing checks — it goes stale silently while the code around it moves.

What a comment used to hold goes somewhere that stays true: a constraint or a rejected alternative belongs in this file, a bug a shape prevents belongs in the test that proves it, and the rest belongs in the commit message that made the change.

Lint and compiler directives — `oxlint-disable`, `@ts-expect-error` — are not comments for this purpose. They change what the tools do, so they stay.

## Slack constraints that shaped the design

**`markdown_text` is mutually exclusive with `blocks` and `text`.** Sending both is rejected with `markdown_text_conflict`. This is why a turn posts two messages: the progress message carries blocks and a button, the answer carries native markdown.

**A bot cannot open a modal.** `views.open` needs a `trigger_id`, which comes only from a user interaction and expires in **3 seconds**. So a blocker is a message with buttons first, and a click is what mints the trigger a modal needs. Nothing may be awaited between the click and `views.open`.

**A modal with a submit button and no input block collects nothing.** It renders correctly, Submit works, and `state.values` comes back empty — so the answer is silently blank rather than obviously broken. A `view_submission` payload also carries no button value at all, which is why the ask id has to ride in the callback id.

**Custom emoji do not render** in a workspace that has not installed them — they show as literal text. Use standard emoji, with one deliberate exception: the progress spinner is `:braille-loader:`, because a static emoji does not read as movement on a message whose whole job is to show that a run is alive. `SLACK_LOADING_EMOJI` is the escape hatch for a workspace without it, rather than everyone losing the animation.

**A technical answer with a diagram in it is almost always the better answer.** The prompt asks for one whenever the answer has a shape — how a request flows, why a run failed, what depends on what — and says to reach for it unprompted. Routing only tabular data at the chart helper left explanations as prose the reader had to rebuild the diagram from themselves; `flow` draws real boxes and arrows with branches — a post-mortem, a request path, a decision that went two ways.

**Slack has no tables and renders no diagram syntax.** Anything structural or tabular becomes an uploaded image — a code block wraps in a thread pane and loses its columns, which is the whole thing it was for. The per-turn prompt names the `slack-chart` command outright, because "put it in a table" is advice a model deep in a task reads past.

**A chart must draw its own background.** Without a background rect the PNG is transparent and Slack composites it against the reader's theme — grey-on-white in light mode. Colour carries rank (brightest bar is biggest, a stack darkens with depth) so magnitude reads before any number does.

**`conversations.replies` allows one call a minute** for an unlisted app. A failed cold-start read degrades to no thread context, and is logged rather than swallowed — the symptom is a bot that appears to forget the thread.

## A helper must never be able to kill the surface

Import anything native lazily. `@resvg/resvg-js` was imported statically and so sat in the chain `index.ts -> turn-routes.ts -> chart-route.ts -> rasterise.ts`. A per-platform binary that fails to load then takes the whole chat surface down at import time, and it surfaces as `chat "slack" failed` on boot rather than as anything mentioning charts.

Nice-to-haves are allowed to be broken. They are not allowed to take the turn path with them.

## The thread must show the run is alive

A throttle that DROPS an update rather than deferring it needs a tick behind it, or the last change before a quiet stretch never reaches Slack and the message looks frozen for as long as the agent is busy.

The progress line carries an elapsed counter for the same reason: identical renders are skipped, so without something that changes every minute a quiet run cannot be told apart from a wedged one.

## The progress message is a terminal, the answer is a message

The progress message shows the last ten things the agent SAID — its posted statuses and the narration it writes before each tool call — in a code block, and is DELETED when the answer is posted as its own new message. Two surfaces, because they want opposite things: one is live and disposable, the other is the durable reply that notifies.

Never the tool calls. A feed of `bash`, `read`, `bash` is spam that says nothing a person wants, and rendering tool arguments would put whatever a call happens to carry into a Slack thread. The sentence written before reaching for the tool is the whole signal.

What it said goes on TOP at body weight; the spinner is a small `context` footer under it. Inverted, the eye landed on the word "Working" in white while the content sat below in small grey — the least interesting line given the most weight. Before there is anything to say, the footer is the whole message.

Plain prose, not a code block — a fixed-width grey box reads as terminal output to be parsed rather than as someone talking. The sentence still being written is rendered too, so the text visibly grows instead of appearing all at once when a tool call happens to close the block; that in-flight line is windowed from the END, since truncating it from the front freezes it after the first screenful.

The tail is budgeted in WRAPPED lines, not in entries. Slack collapses on rendered height and a thread pane is narrow, so five long sentences wrap to eight visual lines and land back under "Show more" — which re-collapses on every edit, making the tail unreadable by construction. Counting entries misses this completely. The sentence being written always holds the last slot and is paid for out of the same budget; the top scrolls off to make room. Past roughly that much text Slack collapses a message behind "Show more" — and since every flush edits the message, it snaps shut again the moment the reader expands it. Consecutive restatements are dropped rather than costing a line, because an agent narrating its own progress repeats itself constantly.

The footer carries the spinner, the model, and the tool counts — the small print. Tool counts as the HEADLINE said nothing a person wants ("bash ×36"), but beside the model in grey they are the useful kind of detail. They never go in the prose log above. The agent's latest status is the last line of the log directly below it, and printing it in both places read as a stutter.

## One state, one writer

The runtime event stream and the status route both change what the thread shows. Fold them into a single `Ref` — when each held its own copy of `RunState`, a posted status rendered and was then overwritten by the next event applied to a copy that had never seen it, so the status appeared and vanished. Any new writer goes through the same `apply`.

## The acknowledgement is the thread reply

A mention is acknowledged by the progress message landing in its thread, posted before the agent has produced anything. That is what shows the ping was seen.

Do NOT `reply_broadcast` it. Slack renders a broadcast in the channel as `fix replied to a thread: <original message>` with the whole progress message and its Cancel button underneath — a second copy of something already visible, in the place least suited to it. This was tried and reverted.

The first render says `Starting up…`, not `Queued`. Queued means waiting on another run in the same thread; saying it when nothing is queued sends the reader looking for work that is not there.

## The answer is the last thing the agent said

Prose deltas are folded per assistant message, not per run. A tool call closes the block. Concatenating everything replayed a twenty-minute run as a wall of "now let me check…" in place of the answer, and the block before the last is kept so a run whose final act was a tool call still answers.

## A capability nothing reaches is not a capability

The blocker helpers, registry and click handler all existed and were tested for three PRs before anything could reach them: there was no route and no skill, so no run could raise a blocker. Tests over unreachable code prove only that it compiles.

When adding one, wire the whole path in the same change — helper, service, route, skill, and the line in the per-turn prompt that tells the agent it exists.

## Guidance the model needs mid-task goes in the per-turn prompt

A cadence left in a SKILL.md is only read by an agent that has already decided to reach for the skill. One deep in a long task has not. Deferring the status cadence to save a few tokens a turn bought twenty minutes of silence.

## Assert the output is useful, not merely well-formed

PNG magic bytes and a non-zero length are both satisfied by a render with zero glyphs. A renderer that can succeed and produce nothing needs a test that compares against a known-different input — the chart tests passed through a completely blank image because they only proved a PNG existed.

## Changing an import from static to dynamic changes the module shape

For a CommonJS package the named exports land on `default`. `const { Resvg } = await import(...)` returned undefined where `import { Resvg } from ...` had worked. Read both `mod.X` and `mod.default?.X`, and fail loudly when neither is there.

## Pictures: charts draw data, slack-image draws everything else

`slack-chart` owns anything with rows, columns, magnitudes or a flow — it draws the real numbers. `slack-image` generates a picture from a description, for a logo or a mock-up or an idea easier to see than to read. Generating a picture _of_ your data instead of charting it is worse than useless.

Needs `OPENROUTER_API_KEY`; `SLACK_IMAGE_MODEL` overrides the model. The key is read per request, not captured at boot, so a rotated key does not need a restart.

## Configuration is read once, in one place

`src/config.ts` decodes the whole environment at boot and hands the result down. Nothing else calls `Bun.env` — a lookup in the renderer is invisible to a test and unreachable for a wrapping feature.

Only the two secrets stop a boot, and they name themselves. Everything else falls back: a surface that refuses to start because an optional emoji is malformed is a worse failure than the malformed emoji. The one value worth care is the timeout — `Number("soon")` is NaN, and NaN as a `setTimeout` delay fires immediately, aborting every turn on arrival.

## An ending that is not an answer still owes a record

The progress message is deleted when a turn ends, so on a timeout, a cancel or a failure the work log dies with it. That rendered an hour of real work as `Timed out.` and nothing else — no answer AND no record, which is the worst outcome available. Those endings now carry what the run got done. A successful turn does not: there the answer IS the record, and repeating the narration under it is the "bash ×36" mistake in another costume.

## Lint-driven refactoring is not the task

A strict `max-lines-per-function` (67) and `max-lines` (420) make it very easy to spend a whole run splitting files you merely opened. That work is tidy and it is not what anyone asked for; an hour of it is an hour the person waiting got nothing.

The per-turn prompt says so outright, because "finish the whole assignment" on its own reads as licence to fix everything in reach. When a rule blocks the change you were asked for, do the smallest thing that unblocks it. When it blocks something you only touched, leave it and say so.

## A second message steers, it does not queue

A new message in a live thread interrupts the running turn and starts a fresh one carrying `priorPartial` — what the interrupted turn had produced. Queueing meant a correction landed only after the run it was correcting had finished, which is the one moment it was worth nothing.

It renders as "Picking up your new message", never as a cancel: nobody asked for the work to stop, they asked for it to go somewhere else.

## Latency

Nothing that can be deferred sits in front of `sendMessage`. `conversations.replies` is the one that keeps creeping back in: it is rate-limited to one call a minute for an unlisted app, a 429 is retried by the client, and it is awaited before the agent starts. It is now bounded by a timeout AND skipped entirely for a mention that opened its own thread, which has no history to read. The progress message is posted without being awaited; the agent starts immediately. A round-trip before the first token is the whole latency on a short question.

## Local checks disagreeing with CI

Almost always the module graph, not the code. `ori init .` regenerates `.ori/sdk`, and a stale linked `ori` on `PATH` will typecheck against contracts months out of date. If lint suddenly reports hundreds of type errors in files you did not touch, check that before believing them.

## Stepping back is silent

The bot mutes on a second participant and says nothing about it. The note explaining it fired the moment somebody else spoke — often an aside mid-run, often not addressed to the bot at all — so a conversation between two people collected a paragraph about the surface neither had asked for. With two agents in the channel they each posted their own.

Nothing is lost. A mention still gets through, which is how anyone who wants it back gets it, and `unmute` still confirms because that answers a request somebody actually made.

## The bot follows a thread until it is a crowd

A mention engages a thread; after that a plain reply is answered without one. Making someone re-mention the bot on every message of a conversation it is already holding is friction that buys nothing.

That assumption dies the moment a second participant appears. The bot then steps back, says so once, and answers only explicit mentions — `unmute` retires the heuristic for that thread when the group actually wants it listening.

The order in `engagement.ts` is the whole design: a message is COUNTED before it is judged. The gates drop every bot message, so asking them first means a second app could fill a thread without ever being noticed — and another app arriving is exactly the crowd worth stepping back from. Counted but never answered.

Our own messages never count. Without that the bot's own reply is a second participant and it mutes every thread it answers, which is why the bot user id is read from `auth.test` rather than trusted to an env var. When it is genuinely unknown no bot counts at all: under-counting other apps degrades to mention-only, while counting ourselves would silence everything.

An aside does not count either. A `//` note is addressed to nobody, so writing one is not joining the conversation — it does not answer, and it does not crowd.

## Slack delivers a thread mention twice

Once as `app_mention`, once as `message`. They are separate deliveries and can arrive in either order, so a turn claims the message timestamp where it actually starts rather than where the event arrives. Claiming on arrival lets the plain copy — which an unengaged thread drops — swallow the mention behind it.

## The house style goes in the first turn, not every turn

A resumed session replays the whole conversation, so a block in the per-turn prompt does not cost its tokens once — it costs them again on every turn after, and stays there. `SLACK_REPLY_STYLE` is about a thousand tokens; by turn thirty the model was reading thirty copies of it. That is the block's own DENSITY complaint aimed back at itself.

The first turn carries the whole thing (it is a cold start anyway, and the copy stays in context for the life of the session). Later turns carry `SLACK_STYLE_REMINDER`, about an eighth the size.

Split it by FUNCTION, never by length. Formatting guidance is only needed when a reply is composed, and turn one's copy is still in context then. What decays is behaviour deep in a long task — so the cadence, scope discipline and when-to-ask are what repeat, and the status command is spelled out in full. A reminder that only gestures at the script re-buys the twenty minutes of silence that put the cadence in the prompt to begin with.

`sendMessage({ systemPrompt })` is NOT the answer, however much it looks like it: it REPLACES the prompt the runtime assembles, feature-development rules and all. `appendSystemPrompt` (ori #1799) is the one that adds rather than replaces, and supersedes the reminder split once the SDK carries it.

## Verify against Slack before merging

Every regression this surface has shipped came from a Slack behaviour that could be reasoned about but not executed: the answer fusing onto the opening line, `chat.update` clearing a finalised stream, a card with no id that could never be closed, a status line printing a whole paragraph under the composer. Tests written against a model of Slack pass for exactly as long as the model is right, and a green suite has never once caught these.

Run it for any change to the turn surface — status, cards, the answer, the teardown. A change that cannot be checked this way is a change to write down as unverified rather than one to assume.

## Nothing is edited — a turn posts

A thread is a log. The opening line, each progress update, and the answer are separate messages, posted in order, and none of them is ever rewritten.

Every design that reused one message needed the same three things: a timestamp kept alive for the length of the run, a fallback for when Slack had moved on from the message, and a rule for what the message MEANT in between. Each was a new way to be wrong — a card holding half a word marked as an error, the same sentence rendered twice, an answer clipped into a 256-character title, a card that could never be closed because a `BlocksChunk` has no id.

The invariant that survived is narrower and it is the one that mattered: **the answer is delivered once.** A turn may post many times, but exactly one of those posts carries the answer, and it is the only one built from blocks. Counting messages was the wrong shape for it — that only ever caught double-answers by accident, and it started failing honest updates the moment a turn was more than one message. Nothing checks this automatically today: a UX eval encoded it as a rule, its runner went with the `scripts/` directory, and the rules went with it.

**Tables are written, never drawn.** `slack-chart` has no `table` kind. It used to, from when Slack had no tables, and it rendered them as an SVG image — which came out as overlapping unreadable text in the same reply as a native markdown table that rendered perfectly. Charts draw SHAPES: `flow`, `bars`. Rows and columns go in the markdown.

**A stack is a flow drawn worse.** `slack-chart` has no `layers` kind. It drew a plain ordered stack of boxes top to bottom, and the order was the only thing it carried — it could not say what depended on what, so every architecture answer that reached for it lost the edges that were the point. `flow` draws the same boxes WITH the arrows, and a stack is just a flow that happens to be a straight line. The prompt already says a straight line of boxes is almost never the truth.

**The answer is a `markdown` BLOCK.** There are three markdown dialects here and only one of them does tables:

- `section` block — Slack's own `mrkdwn`. `*bold*`, no tables, no lists. Prints `**like this**` literally.
- `markdown_text` on `chat.postMessage` — renders `**bold**`, but carries no tables, and is mutually exclusive with `text`/`blocks` so it cannot have fallback text.
- `markdown` block — GitHub-flavoured. Tables, task lists, dividers, sized headers, language-tagged code blocks. Added to Block Kit on 6 March 2026.

The answer goes through the `markdown` block, which also lets `replyBlocks` carry plain fallback text for the notification. The house style tells the agent to use tables for rows and columns rather than drawing them as a chart — it used to say "Slack has no tables", which was true when it was written and is why every comparison came back as six facts in a paragraph.

**The narration does not survive the turn.** Those lines are mid-work thoughts — "Let me confirm what upstream lacks" — and under a finished answer they read as a reply that stopped half way. They had their moment in the status line.

A steered turn that produced no output posts NOTHING: the turn that replaced it is already answering, and "Picking up your new message" as a message of its own is a line about the surface rather than the work.

## What Slack actually gives a channel agent

Researched rather than guessed, because two rounds of this were guessed wrong.

**`assistant.threads.setStatus` is the native working indicator, and it is NOT pane-only.** That was the old reading of the docs and it is contradicted by what agents actually do: Devin renders "Devin is working…" under the composer of a plain channel thread, and shows "Starting up…" in the channel under the parent message, with no message posted for either. Both carry the AGENT badge, which `fix` has too.

Slack enabled this deliberately: the 5 March 2026 changelog widened the method to accept `chat:write` "to allow channel-based apps to use AI loading states in channels". `chat:write` is the future; `assistant:write` is being retired. The manifest already requests both. So the surface ATTEMPTS it on every thread and logs a refusal rather than gating on pane membership. It costs one call per status and it is the only indicator a channel agent gets that does not spend a message. `setTitle` and `setSuggestedPrompts` stay pane-gated; those are genuinely pane concepts.

**Slack CLEARS the status as soon as the app posts anything**, so it is re-asserted on a beat rather than set once. A run posts plenty on the way — the chatter's handover line, a chart, an approval prompt, the cancel offer fifteen seconds in — and each one silently took the indicator away and left the rest of the turn looking idle. Rendered as `<App Name> <status>` under the composer, on ONE line and never folded — so it is a status LINE, not a paragraph. Feeding it the prose the agent is drafting put the whole answer down there as a wall of text under the typing area. It takes what the run POSTED in preference to what it is drafting, first sentence only, clamped to 80 characters.

**Give it `loading_messages` or Slack invents them.** `status` is the line under the composer; `loading_messages` is the greyed line INSIDE the thread, which Slack cycles. Left empty it cycles its own — "Gathering information…", "Reviewing findings…", "Putting it all together…" — which is true of every run and therefore about none of them. It gets the last ten things this run actually said instead. Slack caps the list at ten.

**It is set the moment the message lands**, before the chatter and before the session lookup — both of which take seconds a reader otherwise spends looking at nothing.

**Nothing is posted before the agent speaks.** The native line covers the gap, so the progress message opens on first content and a turn the chatter answers never opens one at all. The placeholder card that used to fill that gap is gone.

**The chatter is the top of this surface, not a filter in front of the worker.** Every message a person sends reaches it first; it holds the conversation, and the worker is a separate runtime it hands a task to. Only the Slack path — a dispatched or spawned turn is already a task someone decided on, and triaging it as conversation lets the chatter answer a loopback request with small talk instead of doing it.

It runs on its own model when `SLACK_CHATTER_MODEL` is set. It is deciding "is this small talk" and, when it is, saying one sentence back, in front of EVERY turn — a big model there spends the latency budget of the thing it exists to make fast.

**Acknowledge with a reaction, not a message.** A button needs its own post, which costs a message per turn and lands in the reader's activity feed as "This message contains interactive elements". `reactions.add` is the Slack idiom for "seen it" and costs neither. Removed when the turn ends, so it reads as working rather than done.

**Nobody ships a cancel button.** Devin is stopped by talking to it — `EXIT`, `mute`, `sleep`, or plain "be quiet" / "stop responding in this thread". Here a second message already steers the run, which is the same gesture. A button buys nothing a sentence does not.

**`expand: true` on a section block defeats "Show more".** It exists precisely so an AI app can post a long message without the reader clicking to expand. The wrapped-line budget that used to fight the fold was solving a problem Slack had already solved.

**`chat.update` at most once every 3 seconds** is the documented ceiling. The old throttle ran at 2s.

## One markdown, everywhere

Slack has three dialects and two of them silently drop things:

- a `section` block speaks Slack's own `mrkdwn` — `*bold*`, no tables, no
  `[label](url)`
- `markdown_text` on `chat.postMessage` renders `**bold**` but carries NO
  tables, and is mutually exclusive with `text`/`blocks`
- a `markdown` block is GitHub-flavoured: tables, task lists, dividers

Nothing in this feature asks a caller to know which one it is holding.
**Everything takes GitHub-flavoured markdown**; `section()` converts on the
way in and the answer already goes out through a `markdown` block. Write
`**bold**` and `[label](url)` wherever you are.

That is not tidiness. The `<` `>` `&` escape rides with the conversion, and
`<!channel>` in model-authored text broadcasts to the workspace — so a caller
who forgot `asMrkdwn` was not merely printing asterisks, it was skipping the
escape. `permissions.ts` forgot it in three places. Making the block do it
means it cannot be forgotten.

If a table does not render, the message went out through one of the other two
dialects. That is the whole diagnosis.

## There is no message streaming, and that is deliberate

`chat.startStream` / `appendStream` / `stopStream` were how the progress
message rendered. The progress message went (see `message-stream/stream.ts`
for every shape it took and how each one was wrong), and the client methods
outlived it by a while: three port methods, their live implementations and two
sets of fakes that nothing called, plus a shutdown window documented as
covering "one `chat.stopStream` per turn" that could never happen. All of it
is now gone — a capability nothing reaches is not a capability.

If streaming is ever worth another try — for the ANSWER, which is the one use
the removal rationale never argued against — the trap that cost us a release
is this: **`chat.update` with `markdown_text` against a stopped stream CLEARS
it.** The docs say a stopped stream "converts to a standard message", which
reads like an ordinary update should work; live, every reply came back empty.
It was guarded so a REFUSED update would leave the answer in place, and the
guard was useless because the update did not fail — it succeeded and blanked
the message. A fallback only helps against the failure you predicted. Check it
against a real workspace before trusting it.

The other one, for the same reader: **`chat.stopStream`'s `markdown_text` is
APPENDED to whatever was streamed, not a final value for the message.** Putting
the opening line in the body fused it to the front of the answer —
`IHere — sorry for the silence…`.

## The first thing it says opens the message

Devin's shape. The agent's reading of the ask leads, in prose; the work appears as cards underneath it; the answer replaces both at the end. So the acknowledgement is not a placeholder for content — it IS content, which is why no wording for it ever landed: every attempt was a line about the surface rather than about the ask.

Nothing is posted before that first line, so a turn still says nothing until it has something to say.

There is no reaction. The eyes were a stand-in for an acknowledgement while the opening line did not exist, and two acknowledgements is one too many.

## A crowded thread only answers a mention

Two distinct humans in a thread and the bot steps back: `CROWD_LIMIT` is 1, so the second person's message mutes it. A mention still gets through; a plain reply does not. `unmute` opts the thread back in and retires the heuristic for good.

That rule was always right and always tested. What broke it was FORGETTING: participants lived in memory, so `ori start` reset the count to zero. A thread that had correctly stood the bot down came back with nobody in it, and the next mention re-engaged it into what looked like a one-to-one conversation — so it answered plain replies in a room of five. Persisting the participant set is what makes the rule hold across a restart, not just within one.

## There is no chatter

Every message a person sends starts a worker turn. There is no triage, no second session, no model deciding whether something counts as small talk.

That gate was the single biggest source of clunk. It sat in the request path, so its latency was the floor on everything behind it — including work that had nothing to do with it. As a bare model call it answered in a second and knew nothing ("I don't have a personal name"). As an ori turn it knew everything and often did not answer at all. Both failures were the same seam.

A second message STEERS the run it is correcting: the live turn is aborted and its partial work handed to the replacement. That is the pre-chatter behaviour and it is the right one — a correction that lands after the run it was correcting is worth nothing. A dispatched or spawned turn never steers, because nobody asked for the running one to stop.

## The opening message is not a model call

`_On it…_` is posted the instant a message is admitted, before the run starts. Nothing that has to think can be relied on to answer in a second, and a reader cannot tell a slow bot from a dead one. That is why it is a fixed string and not something clever.

It stays where it is. Earlier versions edited it into the answer; see above for why nothing is edited any more.

## An update is a message, then the indicator

`slack-status` sends a progress report to two places: the thread, and Slack's native indicator. In that order, and the order is load-bearing — **Slack clears the indicator whenever the app posts**, so setting it before the message would set it and then immediately wipe it.

A `--notify` update is a real message because the indicator is not a record. It holds one line, the next one replaces it, and it is gone when the turn ends. Someone scrolling back an hour later should still see what the run was doing; someone watching live should not have to catch a line before it rotates away.

Nothing re-asserts the indicator any more. A beat did, every 8s, precisely because those posts keep clearing it — and it went with the rest of the in-process machinery. The cost is real and accepted: a message from anyone takes the indicator down until the agent's next `slack-status` call.

**Which channel an update deserves is the MODEL's call.** A message per narration turned one route fix into four posts — "Retrying bun install", "607 tests pass", "PR is up, waiting on CI", "merged" — and then repeated most of them in the answer. Every line was true and the thread was still noise. The surface answered that with a two-minute clock, which is code with no idea what the run found choosing what is worth interrupting someone for, and it was wrong in both directions. Now `--notify` says so explicitly, and the only rule left with the code is that the first update of a turn always posts.

## Writing goes through the daemon; the token only reads

Two auth models, and the split is deliberate. `slack-questions`, `slack-ask`, `slack-chart`, `slack-image` and `spawn-thread` POST to loopback routes on the daemon: no credentials, loopback-guarded, scoped to the live thread. `slack-api` and `slack-status` build their own `WebClient` from `SLACK_BOT_TOKEN` — full bot authority, any channel the app is in.

So `slack-api` **reads only**: `conversations.replies`, `conversations.history`, `users.list`, `users.mention`, `conversations.open`. It used to post, edit, delete, react, post ephemerals and set titles, and every one of those bypassed the surface — no update rationing, no `markdown` block, no one-answer-per-turn. Its SKILL.md carried a warning asking the agent not to use `chat.postMessage` for its reply because it produced a duplicate message; that is a hazard documented rather than removed, and the commands are gone now.

`chat.postMessage`/`chat.update` survive as private helpers inside `spawn-thread`, which needs to open a fresh top-level thread — the one write the daemon has no route for. They are not agent-callable.

Untrusted Slack content and bot authority still meet in the same context, which is why this matters: `untrusted-files.ts` and the attachment ordering exist for the same reason. Shrinking what the token can DO is the part that does not depend on the model's judgement.

## There is no MCP server

There was one, serving `slack_status` and then `slack_ask`, and everything about it was a fight with paths.

Be careful with the story that was written down at the time, because it was wrong and it propagated. It said pi's cwd is "whatever the agent is working in — often a clone under /tmp/worktrees". It is not: `harness-workspace-steps.ts` sets cwd to `dirname(featuresRoot)`, i.e. the workspace itself, and only `ori code` anchors it to the caller's directory. What actually broke was narrower — pi resolves a BARE `mcp.json` against its own cwd, and under a composed features root that is `<repo>/.ori/composed`, where a repo-root config does not exist. Hence "a missing config is quiet, pi just registers no tools". The server script half would have resolved fine.

That matters beyond the MCP: it is the same reason the relative `bun features/slack/skills/…` path in every SKILL.md works, and has worked, for all seven skills.

`${VAR}` expansion looks like a fix and is not: it applies to a server's `env` record and to nothing else. So a config was written to the temp dir at boot with an absolute path, and `ORI_MCP_CONFIG` pointed pi at it — a lot of apparatus, resting on a misdiagnosis.

That is a lot of apparatus for two calls a shell script can make. Both are skills now, and a skill is invoked by the path the prompt gives it — no config file, no transport, no server process, nothing to expand.

What was genuinely good about the tool shape, and is worth keeping in mind if it ever comes back: a model reaches for a tool mid-task more readily than for a command it has to remember, and a tool RESULT can say "END YOUR TURN" in a way an exit code cannot. `slack-questions` prints that sentence on stdout instead.

## A question ends the turn instead of holding it

`slack-questions` posts a form and RETURNS. The turn then finishes, saying what it is blocked on. When someone answers, the submission starts a NEW turn on the same thread — which maps to the same session, so the model carries on with everything it knew plus the answers.

Nothing is held: not the thread's queue, not a session, not an HTTP response. A form left over a weekend costs what an unread message costs.

That is why the pending form lives in a service and not on the turn. The turn that asked is gone by the time anyone clicks.

`slack-ask` (the blocking, one-question skill) still exists. It holds the run for up to fifteen minutes, which is the right shape only when the next line of work genuinely cannot be written without the answer.

**A form is cleared before its turn starts.** Slack will happily deliver a second `view_submission` for the same modal, and two turns on one thread means the second steers the first — the answers would interrupt the work they triggered.

**Answers come back in the order the questions were ASKED.** `state.values` is keyed by block id with no guaranteed order, and a list whose order drifts from the questions leaves the reader and the model reading different documents.

**Read every element shape at the boundary.** `readViewSubmissionPayload` used to take `element.value` only, so a form built from radio buttons or checkboxes came back empty — with Submit working and `state.values` populated, which reads as the answer being blank rather than as unread.

## The surface shows the working; the agent reports the findings

Liveness is not the model's job. It was, briefly, and it failed in both directions in the same week: a greeting had "I'll say hello back" posted permanently to the thread, because the model narrated before it knew anything and the first-update rule made that the record — while a four-minute run showed nothing at all, because the model never called the skill and nothing else was keeping the indicator alive. No prompt wording fixes both, because the model is the wrong thing to ask.

So `status-beat.ts` renders the indicator from what the daemon is ALREADY folding — tool calls, elapsed time — every eight seconds, for the life of the turn. It needs nothing from the agent, it cannot go stale while a run is working, and Slack clearing the indicator on every message the app posts costs the run nothing. This is not the pipeline that was deleted: no service, no loopback route, no sink, no cross-process state. A fiber reads the run state the turn already keeps.

What is left for the agent is the half only it can judge. `slack-status` posts a MESSAGE, every time, and there is no free channel any more — "call it often, it is free" is exactly what produced the noise. An update is for a finding, a decision, a number worth knowing before the answer. If the run turns up nothing like that, the reply is the record.

The first-update rule is gone with the gate that enforced it: the marker file, the turn id it was keyed by, and the claim-and-release dance around a failed post. Four of the sixteen defects an audit found lived in that gate, and its one job was to guarantee a message that, on a short turn, is worse than silence.

## The model picks the channel, the surface renders it

`slack-status` takes `--notify`. Without it the line goes on the live indicator: free, silent, one line, replaced by the next. With it the line is also posted as a message, which is permanent and pings the thread.

The surface used to decide this on a two-minute clock, which is code with no idea what the run found choosing what is worth interrupting someone for. It was wrong both ways — swallowing the finding and posting the filler.

One rule is not the model's: the FIRST update of a turn always posts, whatever it asked for. That is not editorial, it is the promise that something real lands in the thread within a minute. The skill is a fresh process per call, so it tells a first update from a fifth by `SLACK_TURN_ID` and a marker file — `wx`, so two calls racing cannot both be first.

The indicator carries ONE entry. Slack rotates any list it is given, so the last ten statuses read as a carousel of work already moved on from. The field is still sent — omit it and Slack cycles its own filler instead.

## The surface waits, however long it takes

It is a view. Deciding that work should stop is not its call, and the last place it still made that call was `pulse.ts`: five minutes with no transcribed event and no open tool settled the message and, through the `finally` in `turn-routes.ts`, aborted the run behind it.

It fired on healthy runs. The pulse fingerprints only what the surface transcribes, and model reasoning is not in it — so a run composing a long answer is indistinguishable from a dead one. A codebase review died that way at five minutes while the same ask answered elsewhere in seven.

There is no watchdog now. A run ends because it finished, because a person cancelled it, or because a new message steered it. If it never finishes, the thread stays quiet and that is the runtime's problem, not the view's.

## Progress is a skill, and it talks to Slack directly

`slack-status` was a skill, then an MCP tool, and is a skill again. The tool shape was not the problem; the machinery under it was. Reaching the live turn in-process meant a `StatusSinks` service keyed by thread, a loopback route, a sink folding into run state, a beat re-asserting the indicator, and a watcher wiring the three together — six hops between the model and one `setStatus` call, every one of them a place for the line to go missing.

The skill posts to Slack itself with `SLACK_BOT_TOKEN`, the same authority `slack-api` already has. There is no route, no service, no sink. The daemon does not know what the agent said and does not need to.

What that costs: nothing re-asserts the indicator. Slack clears it whenever any message lands in the thread — including one addressed to somebody else — and the agent's next call is what puts it back. A run that says nothing for ten minutes shows nothing for ten minutes, which is the honest rendering of a run that is saying nothing.

The surface sets the indicator only before the agent can speak for itself, and clears it after. `startStatus` (`notes.ts`) puts "is starting up…" up the moment a Slack message is admitted; `openPane` (`pane-context.ts`) sets "is thinking…" once the turn is actually running, and covers the turns that never went through `startStatus` at all — a dispatched turn, a spawned thread, a form answer resuming a run. Then `handler.ts` clears it.

**The clear is an `Effect.ensuring`, not the last line of the happy path.** A defect between opening the pane and opening the stream is caught and logged upstream without posting anything, so a plain statement left the pane thinking forever next to a thread that never heard back. A run that dies must not look alive. It is safe as a finalizer because `setStatus` is best-effort and never fails, so it cannot mask the original error.

## The surface does not kill runs

It is a view. Its job is observability: show the work, deliver the answer. Deciding that work should stop is not a view's call, and it was making that call three separate ways — a 3-minute stall abort, a 30-minute deadline, and the surface watchdog's `giveUp`. All three are gone, and `deadlines.ts` with them, because aborting on a clock was the only thing that file did.

A run now ends for exactly three reasons, and **somebody asked** for all three: it finished, a person cancelled it, or a new message steered it.

What survives is the part that was always legitimate — after a long silence the surface stops WAITING and posts what the turn has, so nobody is left staring at nothing. The copy says so: "Quiet for a while, so here is where it got to. Still running." The old line ("Stopped waiting… ask again and I will pick it up") was accurate only because it shipped alongside an abort.

**The one remaining coupling, stated honestly:** when the surface stops watching, `handleTurn` returns and the `finally` in `turn-routes.ts` still calls `live.abort()`. Fully decoupling run lifetime from turn lifetime means a run streaming with nobody consuming it, and a wedged run holding its thread's queue with no way back. That is a real design fork, not an oversight.

**Silence is not a death signal for this harness.** The runtime log has a pi run emitting NOTHING between `tool.started` and `tool.succeeded` for forty-two minutes, twice back to back — no output, no progress, nothing to fingerprint. A blocking `slack-ask` waiting on a person is unbounded by design and looks identical. So every clock stops while a tool is in flight: `isWorking(state)` is `openTools > 0`, and both stall watches skip entirely rather than accumulating silence. The 30-minute deadline stays as the backstop, because a tool CAN hang and the thread queue cannot be held forever — it rearms up to three times while a tool is open, then aborts regardless. Bounded patience, not none.

**There are TWO watchdogs, and they must read the same signal.** `armDeadlines` runs a 3-minute stall watch that ABORTS the turn; `pulse.ts` runs a 5-minute one that stops waiting and settles the message. The first is meant to fire first and be the polite one.

The abort watch read `live.readPartial()` — prose and log lines, the thing a STEER hands to its replacement. That is a different question from "is it producing", and a run four minutes into one command answers them differently: no new prose, plenty of tool events. So it killed healthy turns, and the thread reported it as "Stopped waiting", which reads as giving up rather than as killing. `readPulse` is now its own thing and both watchdogs read the pulse.

**The watchdog measures the RUN, not the thread.** `pulseOf` fingerprints phase, narration, tool count and `alive`; five minutes without any of those moving and the surface stops waiting and settles the message with what it has. It exists because aborting a run is a _request_ — a run wedged below the SDK never hears it, `for await` never returns, and a thread once sat on three progress cards for thirteen minutes.

It fired on healthy runs because it only counted tool STARTS: a six-minute `bun install` bumped the pulse once and then looked exactly like a dead process. `alive` counts `ToolOutputDelta`, `ToolProgress`, `ToolSucceeded` and `ToolFailed` — events with nothing to show, which is precisely why they are the right liveness signal. Note that `Tag` is a deliberate SUBSET of the runtime's tags (the payload predicates narrow off it), so a tag nobody transcribes is invisible here; that is how these four went missing.

**An ignored message costs a live run its indicator, and that is the accepted price.** Slack drops the indicator whenever ANY message lands in the thread — including one addressed to somebody else that the turn will never answer. The drop path used to call `StatusSinks.restore(threadKey)` to put it straight back; there is no sink to ask any more, so it stays down until the agent's next `slack-status` call. Anything that restores it has to be able to name the line the run last set, and only the agent knows that now.

**A refused loading list narrows before it gives up.** Evidence from a live thread: a ONE-entry list (`["is starting up…"]`, 15 characters) was accepted in `#intern-fix`, and a few minutes later a multi-entry list of ~80-character lines was refused in the same channel. So a refusal is a fact about the payload, not about channels or about lists — do not latch it per channel. What is still unknown is WHICH property Slack objects to, entry length or entry count. `src/turn/status-beat.ts` sends ONE entry and `assistant.ts` falls back to the line alone when it is refused.

**A rejected loading list must never cost the status line.** They ride in one payload, and the call used to be best-effort — so Slack refusing `loading_messages` swallowed the whole call, the indicator went down with it, and every 8s beat re-sent the same rejected payload. A run that was working fine looked dead from its first progress update onwards. `setStatus` in the skill attempts the list, and on rejection retries with the line alone; the skill prints which rung landed, because a silently narrowed payload is how the list limit went unnoticed for as long as it did.

**Send the line and the list together, always** — and this was re-learned the hard way: a rebuild dropped `loading_messages` on the reasoning that the list was the agent's business, and Slack answered by putting "Gathering information…" in the thread on every run. The slot is not optional; leaving it empty hands the reader Slack's filler instead of the run's own words.

**Send the line and the list together, always.** `setStatus` with no `loading_messages` OMITS the field, and Slack answers that by cycling its own filler: "Organizing…", "Analyzing…", true of every run and therefore about none. One call sets both, so the rotation is never handed back.

`skills/slack-status/scripts/*.test.ts` and `src/turn/status-beat.test.ts` cover it: the skill spawns as its own process, so a test that never spawns one proves nothing about it.

## Only a steer stops a run

`steerInto` aborted whatever was running the moment ANY new turn arrived. So asking for one more thing threw away the thing already in progress, a chatter that merely failed cost a healthy run, and a dispatched loopback turn killed whatever a person was waiting on.

The chatter's verdict decides it now. `steer` — and only `steer` — stops the run and hands its partial work to the replacement. `work` queues behind it, `unsure` queues behind it, and a turn nobody asked for never steers at all.

## A mention of somebody else hands the thread over

Engagement asked one question — has this bot spoken here? — and treated every later message as its own. So `cc @lab to review too` got answered, because the bot happened to be in the thread. That is the bot deciding that anything said near it was said to it.

A message that names someone, none of them us, now stands the thread down: not muted, just no longer following. A mention brings it back. The crowd heuristic stays armed underneath.

This is proactive where auto-mute is reactive. Auto-mute needs a second participant to have already spoken, so by construction the first wrong reply always escapes — which is the one people actually see.

## Stopping is a sentence, not a button

`stop`, `cancel`, `abort`, `never mind` on their own interrupt the run. Devin's idiom, and the reason there is no Cancel button: a second message already steers, so the button only ever duplicated a gesture people make anyway.

Only when the whole message is the word. "stop using the cached client" is a request, not a command, and answering it as one would be worse than not having the feature.

## A custom button is for a feature, not for the agent

The section above still holds for the agent: it steers with sentences, and it
has no way to post a button of its own. Nothing in `onButton` changes that,
and no skill exposes it.

What it changes is the sibling feature. `interactions.on` always routed any
action id, and the service exists so a downstream feature can add one — but
nothing outside this feature could reach the service. It lives in the Effect
graph, and the public surface was `postMessage` and `webClient`. So a feature
could post a perfectly good button and the click went nowhere: `dispatch`
looked the id up, found no handler, and returned. The button rendered and did
nothing, silently.

Two constraints fall out of the design and are enforced rather than
documented:

`ori_` is reserved. Every built-in action id carries that prefix, and `on` is
last-registration-wins, so a custom button claiming `ori_cancel_turn` would
have quietly taken over stopping a run. Registration throws instead, at boot,
where the author sees it.

The click carries no `trigger_id` and no `response_url`. Those are the
seconds-lived provider capabilities this file warns about elsewhere, and a
registered handler runs after the ack, so it could not spend one anyway.
Leaving them off the payload means a consumer cannot capture one by accident.
It also means a custom button cannot open a modal — that needs a trigger the
surface has to spend itself, within three seconds of the click.


## Test with ids Slack would actually send

`U_SELF` is not a Slack user id and `<@U_SELF>` does not match the mention pattern, so the first version of these tests passed against fixtures no workspace can produce. Real ids are uppercase alphanumeric with no underscore.

## A diagram is written in Mermaid, drawn by us

The node/edge JSON was a schema the model had to be taught, and the only worked example in the per-turn prompt was a `table` — so it inferred the flow shape, played safe, and emitted a straight chain every time. The renderer had supported branches and merges all along; nothing ever asked for one.

`graph` takes Mermaid flowchart syntax instead. The model already knows it, so it writes a diagram rather than filling in a form, and the prompt now carries a worked example that actually branches and rejoins.

Only the GRAMMAR is borrowed. Mermaid measures text through a real browser layout engine — `mermaid-cli` ships Chromium for exactly that, and under jsdom it dies on `getBBox`, then on the next missing layout API after that. A chat surface that a headless browser can take down is the thing this feature has already been burned by twice. Parsed here, laid out by `flow.ts` as before.

An unreadable line is skipped rather than failing the render: a diagram missing one edge still reads, an error message does not.

## Acknowledgement and liveness are different jobs

The opening line answers "did you understand me?" — once, at the start. A mark on the asking message answers "are you still there?" — continuously, and only matters while nothing else is happening.

Removing the reaction as a duplicate of the opening line was wrong. It left a turn with NO sign of life between narration lines, so an agent quiet for four minutes looked identical to one that had died. That is the failure this file already records twice.

Count the liveness signals before removing one. The progress spinner, its heartbeat, the placeholder, the Cancel button and the reaction were each removed for a good local reason, and the aggregate was a surface that could look dead for minutes. Every one of those arguments was about noise; none of them asked what was left.

## A worker and a chatter

A message arriving while a turn is running steers it: the run is aborted and its work handed to a replacement, which is right for "actually, do this instead" and blunt for "how's it going?".

There was a CHATTER that answered the second kind from its own session, and it is gone. What it read — `peekThread`, the running turn's narration — went with it, so a question mid-run now steers like any other message.

## Progress cannot wait for a finished sentence

Cards are driven off `RunState.log`, and the log only gains a line when a prose block CLOSES — which needs a sentence boundary. An agent that reaches for a tool mid-thought closes nothing, so a run with ten tool calls produced no progress at all. That requirement was added to stop a sentence splitting mid-word across two log lines, and it starved the thing it was protecting.

The sentence being written is now pushed to the OPEN card, throttled, reusing its id so the card is edited rather than duplicated. A finished line still replaces it. Waiting for a full stop was the wrong thing to wait for.

## Render the model in exactly one place

`renderRunState` appends it on a Done turn and the streamed footer appended it again, so every answer ended with the model on two lines. The footer owns it now and passes `withModel: false`.


This is the same misreading as the collapse: the docs say a stopped stream "converts to a standard message", and that sentence has now cost two separate bugs. A streamed message is append-only until it is closed, and closing does not give you a blank slate.

## Never open the message on a fragment

The in-flight sentence is worth showing on a card that already exists. It is not worth OPENING the message with — `writingAt` starting at 0 meant the first delta cleared the throttle, and a turn shipped as a message reading `I`. Forty characters before the message exists; after that, anything.
