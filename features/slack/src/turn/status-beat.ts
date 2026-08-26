/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively; the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */
/**
 * status-beat.ts — keeping the indicator honest without asking the model.
 *
 * Liveness used to depend on the agent remembering to narrate, and that fails
 * in both directions at once: a greeting got "I'll say hello back" posted
 * permanently to the thread, while a four-minute run sat on "is starting up…"
 * because the model never called anything. No prompt wording fixes both,
 * because the model is the wrong thing to ask. The DAEMON already knows the
 * run is alive — it is folding every tool call and every token into `RunState`
 * — so it can say so itself.
 *
 * This is deliberately not the pipeline that was deleted. There is no service,
 * no loopback route, no sink and no cross-process state: a fiber reads the run
 * state the turn is already keeping, and writes one line. What the agent has
 * to say goes to the THREAD, where it is durable and where only the agent
 * knows whether it is worth keeping.
 */

import { Effect, Fiber } from "effect";

import type { RunState } from "../message-stream/run-state.ts";
import type { AssistantThreadsShape } from "../thread/assistant.ts";
import type { ThreadRef } from "../thread/thread.ts";

import { clampToWord } from "../clamp.ts";
import { toolSummary } from "../message-stream/run-state.ts";
import { paneOf } from "./context/pane-context.ts";
import { readLiveLine } from "./live-line.ts";

/**
 * Often enough that a post cannot leave the run looking idle for long, rarely
 * enough to stay invisible in the API budget.
 */
const BEAT_MS = 8000;

const MINUTE_MS = 60_000;

/** Slack renders the indicator on ONE line and never folds it. */
const LINE_LIMIT = 80;

/**
 * A rotating entry is SHORTER than the status line, and that is not taste.
 *
 * The list is rejected whole when an entry is too long. Observed against the
 * live workspace: `is starting up…` (15) was accepted in a channel where a
 * single ~80-character entry was refused minutes later, so the constraint is
 * entry LENGTH rather than how many there are. 40 is bounded by those two
 * readings, not derived — Slack does not document it.
 */
const ENTRY_LIMIT = 40;

/**
 * What goes in `loading_messages`, which is the slot the READER sees in the
 * thread. Omit it and Slack does not leave it empty — it cycles its own
 * filler, "Gathering information…", which is true of every run and about
 * none. One entry, because Slack rotates any list it is given and the last
 * ten lines read as a carousel of work already moved on from.
 */
export const loadingListOf = (line: string): readonly string[] => [
  clampToWord(line, ENTRY_LIMIT),
];

const minutesSince = (from: number, now: number): number =>
  Math.max(0, Math.floor((now - from) / MINUTE_MS));

/**
 * What the run is doing, in the surface's own words.
 *
 * Built from what the daemon already sees rather than from anything the model
 * said, which is the whole point: it is true whether or not the agent has
 * spoken, and it cannot go stale while a run is working.
 */
export const beatLine = (state: RunState, now: number = Date.now()): string => {
  const elapsed = minutesSince(state.startedAt, now);
  const tools = toolSummary(state.tools);
  const parts = [
    "working",
    tools === "" ? "" : tools,
    elapsed > 0 ? `${elapsed}m` : "",
  ].filter((part) => part !== "");
  const line = parts.join(" · ");
  return line.length <= LINE_LIMIT ? line : `${line.slice(0, LINE_LIMIT - 1)}…`;
};

interface StatusBeat {
  readonly stop: Effect.Effect<void>;
}

/**
 * Show the indicator now, then keep showing it until the turn is done.
 *
 * `peek` is read on each beat rather than passed a value, so the line follows
 * the run rather than freezing at whatever it said when this was armed. Slack
 * clears the indicator whenever the app posts to the thread, so re-asserting
 * on a beat is what makes an answer, a chart or somebody else's message cost
 * the run nothing.
 */
export const beatStatus = (input: {
  readonly assistant: AssistantThreadsShape;
  readonly peek: Effect.Effect<RunState>;
  readonly ref: ThreadRef;
  readonly threadKey: string;
}): Effect.Effect<StatusBeat> =>
  Effect.gen(function* () {
    // The agent's own words win when it has said something recently: it knows
    // what it is doing and the surface only knows which tools were called.
    // Falling back rather than deferring is what keeps the indicator alive
    // through a turn where the agent never speaks.
    const show = Effect.gen(function* () {
      const said = yield* Effect.promise(() => readLiveLine(input.threadKey));
      const state = yield* input.peek;
      const line = said ?? beatLine(state);
      yield* input.assistant.setStatus(
        paneOf(input.ref),
        line,
        loadingListOf(line)
      );
    });

    yield* show;

    const fiber = yield* Effect.forkChild(
      Effect.whileLoop({
        body: () => Effect.sleep(BEAT_MS).pipe(Effect.andThen(show)),
        step: () => {
          /* runs until interrupted */
        },
        while: () => true,
      })
    );

    return { stop: Fiber.interrupt(fiber) };
  });
