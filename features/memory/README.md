# memory

A catalog feature that gives an Ori intern memory across sessions. The intern saves what it learns as plain markdown in its workspace, sees its pinned facts and open todos at the start of every session, and searches everything else on demand.

It is a catalog feature, not a builtin: an intern loads it with the catalog, and a local `features/memory` shadows it for anyone who forks it.

## What it contributes

- `memory_save` saves one memory. The model gives the text and a kind; the feature stamps the id, the time, who said it, and the Slack channel.
- `memory_recall` searches saved memories by keywords and returns up to 20 matches, newest first.
- `memory_forget` retires memories by id, with a reason.
- A `## Memory` section in the system prompt with pins and open todos, capped near 500 tokens. A session keeps the section it started with, so a save made mid-session shows up in the next session, not the current one. This keeps the prompt cache warm.

There are three kinds:

- `pin`: always in the `## Memory` section. Use it for something nearly every conversation needs, such as a person's preference.
- `todo`: in the `## Memory` section until forgotten. Use it for something the intern will do itself.
- `note` (the default): found only through `memory_recall`.

## What goes in memory

The `memory_save` description carries this rule, so an intern that loads this feature follows it.

- A person's preference, a fact about a person or project, a past decision, or a commitment the intern will keep goes in memory.
- What only one task uses goes in that task: a step, format, trap, or table entry in its skill, a change to when an existing chore runs in its schedule, and a rule a check could enforce in the feature's code. What holds across tasks stays a memory.
- Anything a skill, schedule, or feature already says is not saved again, even when someone asks the intern to remember it. The intern says where it is written instead.
- New recurring work is a todo, and the intern offers to set up a chore for it.
- To merge or correct memories, the intern saves the new version and forgets the old ids.

Examples from two interns backfilling memory from their past sessions:

- "Matt prefers concise replies" is a pin.
- "Recommend, don't ask" was already a rule in the triage skill, so it is not saved.
- A Linear project renamed from "Interns" to "Interns dashboard" is an edit to the triage skill's project table.
- A test that flakes under load goes in the sweep skill's lessons file.
- "I will send the Q3 report Friday" is a todo.

## Install

Load the catalog and the feature comes with it:

```sh
ori dev --features github.com/OpenRouterLabs/ori-feature-catalog
```

Or fork it into your intern, and your copy shadows the catalog one:

```sh
cp -r features/memory <your-intern>/features/memory
```

Then restart `ori start` or `ori dev`. `ori features list` shows `memory` with its three tools and its prompt.

## Files in your intern

```text
memory/
  .gitattributes   log/*.md merge=union
  log/2026-10.md   one memory per line, one file per month (UTC)
```

The folder sits at the intern root, even when a session runs in a worktree under `.sessions/`, so `ori backup` commits it with the rest of the workspace. The union merge attribute keeps two diverged copies of a log mergeable.

The root is `ORI_INTERN_WORKSPACE_ROOT` when it is set. Otherwise the feature asks git for the main checkout of the session's worktree, and falls back to the session's directory.

## Read and edit memories by hand

Each line is one memory:

```markdown
- 2026-10-13T14:02Z m-7f3k2q pin @slack:T01:U02 #C0123 | Matthew prefers short bullet replies.
- 2026-10-13T14:05Z m-a81x0c todo @local | Send the Q3 report Friday.
- 2026-10-14T09:10Z m-q2w9zz forget m-a81x0c @local | done: report sent
- Louis owns release-please merges.
```

- The fields are the UTC time to the minute, the id, the kind, who saved it (`@slack:<team>:<user>`, `@slack:<user>`, or `@local`), the Slack channel when there is one, and the text after `|`.
- A `forget` line retires the memory whose id follows it.
- A plain `- text` line you add yourself counts as a note.
- Lines that are not memories, such as headings or blank lines, are ignored.
- The feature only appends. To correct a memory, edit its text or delete its line.

Search from a shell with `grep -ri "staging" memory/log`.

## Limits

- Search is keyword matching: every word of the query must appear in the memory. There is no ranking by meaning.
- Nothing consolidates memories yet. Duplicates and stale facts stay until the model or a person forgets them.
- The tools find the intern root from the run's environment, but the `## Memory` section can only use the daemon's own directory and environment, because prompt providers do not receive the run's workspace. If a run sets a different `ORI_INTERN_WORKSPACE_ROOT` than the daemon, saves still work and `memory_recall` finds them, but the section reads the daemon's log. Run the daemon from the intern root, or set `ORI_INTERN_WORKSPACE_ROOT` on the daemon itself.
- The intern decides what to save during the conversation. Nothing extracts memories from past sessions afterwards.

## Tests

The tests run with Bun: `bun test features/memory`.
