/**
 * run-state.ts — the lifecycle a long turn moves through, and how it renders.
 *
 * A Slack turn is not a request/response; it is a state machine the thread has
 * to show. Modelling it explicitly is what makes "the message says working…
 * forever" a representable bug rather than the default.
 *
 * `failed` is the state most systems omit. Without a terminal state that
 * always arrives, a wedged turn renders as a live-looking message.
 */

import { answerText } from "./answer-text.ts";

export const RunPhase = {
  Cancelled: "cancelled",
  Done: "done",
  Failed: "failed",
  Queued: "queued",
  Running: "running",
  Starting: "starting",
  Steered: "steered",
  TimedOut: "timed-out",
} as const;

export type RunPhase = (typeof RunPhase)[keyof typeof RunPhase];

const flatten = (line: string): string => line.replaceAll(/\s+/gu, " ").trim();

/** Where a sentence has actually landed, rather than paused mid-word. */
const SENTENCE_END = /[.!?…:]["')\]]?$/u;

/** Letters only, lowercased — so punctuation and case do not hide a repeat. */
const gistOf = (line: string): string =>
  flatten(line)
    .toLowerCase()
    .replaceAll(/[^a-z0-9 ]/gu, "");

export interface RunState {
  /**
   * When the harness began compacting the context, if it still is.
   *
   * Compaction is a model call that summarises the conversation, and it emits
   * no tool events while it runs — so the indicator, which is built from tool
   * calls, has nothing new to say and the thread reads as a run that stopped.
   * That is the failure this surface exists to avoid, so the one thing the
   * daemon does know gets said: that the pause is compaction, and how long it
   * has been going.
   */
  readonly compactingSince: number | undefined;
  readonly phase: RunPhase;
  /**
   * When the run last put a line in the work log, so the surface can say how
   * long it has been quiet.
   *
   * Fed by {@link appendLine} rather than by the agent's own status, which the
   * surface no longer sees at all — `slack-status` talks to Slack directly.
   * It is also more of the truth than the status was: it moves for prose and
   * tool lines too, so a visibly working run is not reported as quiet.
   *
   * Only {@link renderStatusLine} reads it, and that has no caller outside its
   * tests — the progress message it belonged to is gone. Kept because the
   * field costs a timestamp and the renderer is the obvious place to start if
   * a surface wants a liveness line back.
   */
  readonly lastLineAt: number | undefined;
  /** When the run began, so a live message can show that it is still moving. */
  readonly startedAt: number;
  /** Prose in the assistant message currently being written. */
  readonly text: string;
  /** The prose block before this one, kept so a run ending on a tool still has an answer. */
  readonly priorText: string;
  /** Tool name -> invocation count, surfaced as progress. */
  readonly tools: ReadonlyMap<string, number>;
  /** Events proving the run lives but showing nothing. See `pulse.ts`. */
  readonly alive: number;
  /** Tool calls started and not yet finished. Nonzero means it is working. */
  readonly openTools: number;
  /** The last few things the run did, newest last. Rendered like a terminal. */
  readonly log: readonly string[];
  /** How many lines the log has EVER held. `log` is a capped tail. */
  readonly logged: number;
  readonly model: string | undefined;
  /** Which agent runtime ran it — `pi`, `claude`. Stamped like `model`. */
  readonly harness: string | undefined;
  readonly error: string | undefined;
}

export const initialRunState = (now: number = Date.now()): RunState => ({
  compactingSince: undefined,
  alive: 0,
  openTools: 0,
  error: undefined,
  lastLineAt: undefined,
  harness: undefined,
  model: undefined,
  log: [],
  logged: 0,
  phase: RunPhase.Starting,
  priorText: "",
  startedAt: now,
  text: "",
  tools: new Map(),
});

/**
 * The tail is budgeted in WRAPPED lines, not in entries.
 *
 * Slack collapses on rendered height, and a thread pane is narrow — five long
 * sentences wrap to eight visual lines and land back under "Show more".
 * Estimates of someone else's renderer, so deliberately conservative: a line
 * short costs nothing, a line over costs the whole tail.
 */
const VISUAL_LINE_BUDGET = 6;
const CHARS_PER_VISUAL_LINE = 66;

/** Kept as a hard ceiling on retained history, well above the visual budget. */
const LOG_LINES = 12;

const visualCost = (line: string): number =>
  Math.max(1, Math.ceil(line.length / CHARS_PER_VISUAL_LINE));

/**
 * The newest entries that fit the budget, oldest first.
 *
 * Filled from the END backwards: the last line is the one that must always
 * survive, and the top is what scrolls off to make room.
 */
const withinBudget = (lines: readonly string[]): readonly string[] => {
  const kept: string[] = [];
  let spent = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? "";
    const cost = visualCost(line);
    if (kept.length > 0 && spent + cost > VISUAL_LINE_BUDGET) {
      break;
    }
    kept.unshift(line);
    spent += cost;
  }
  return kept;
};

/**
 * Append, unless it repeats what was just said.
 *
 * An agent narrating its own progress restates itself constantly ("Now I have
 * the full picture. Writing the code." / "Now I have the full picture. Let me
 * write it."), and each near-repeat costs a line that a real update needed.
 */
export const appendLine = (
  state: RunState,
  line: string,
  now: number = Date.now()
): Pick<RunState, "lastLineAt" | "log" | "logged"> =>
  gistOf(line) === gistOf(state.log.at(-1) ?? "")
    ? {
        lastLineAt: state.lastLineAt,
        log: state.log,
        logged: state.logged,
      }
    : {
        lastLineAt: now,
        log: [...state.log, line].slice(-LOG_LINES),
        logged: state.logged + 1,
      };

/**
 * Close the prose block a tool call interrupts, and log what it said.
 *
 * Without the close, the answer is every interstitial line the run ever
 * emitted, concatenated — a long run replayed as narration nobody asked for.
 *
 * A block is NOT closed mid-sentence. Closing unconditionally froze half a
 * sentence into the log and started the rest as a new line — "Mapping the
 * current tu" above "rn path."
 */
const endProseBlock = (state: RunState): RunState => {
  const text = state.text.trim();
  if (text === "" || !SENTENCE_END.test(text)) {
    return state;
  }
  return {
    ...state,
    ...appendLine(state, state.text),
    priorText: state.text,
    text: "",
  };
};

export const withTool = (state: RunState, tool: string): RunState => {
  const tools = new Map(state.tools);
  tools.set(tool, (tools.get(tool) ?? 0) + 1);
  return {
    ...endProseBlock(state),
    tools,
  };
};

/**
 * The spinner on a live message.
 *
 * Read at module load from the environment before, which made it invisible to
 * a test and unchangeable by a wrapping feature. Configuration now; this is
 * the fallback for a caller with none.
 */
const DEFAULT_LOADING = ":braille-loader:";
let LOADING = DEFAULT_LOADING;

/** The spinner, for a surface rendering its own first line. */
export const loadingEmoji = (): string => LOADING;

/** Set once at boot from the decoded config. */
export const setLoadingEmoji = (emoji: string): void => {
  LOADING = emoji === "" ? DEFAULT_LOADING : emoji;
};

/** Tools the run touched, as names with repeat counts. Small print only. */
export const toolSummary = (tools: ReadonlyMap<string, number>): string =>
  [...tools.entries()]
    .map(([name, count]) => (count > 1 ? `${name} ×${count}` : name))
    .join(", ");

const MINUTE_MS = 60_000;

/** How long without a word before the surface says so rather than implying progress. */
const QUIET_MINUTES = 5;

export const minutesSince = (from: number, now: number): number =>
  Math.max(0, Math.floor((now - from) / MINUTE_MS));

/**
 * The header: that the run is alive, and how long it has been going.
 *
 * Deliberately NOT the agent's latest status — that is the last line of the
 * work log directly below, and printing it in both places read as a stutter.
 * The elapsed counter is the liveness signal: without it a run that says
 * nothing for twenty minutes renders the identical string every flush, and
 * cannot be told apart from a wedged one.
 */
export const renderStatusLine = (
  state: RunState,
  now: number = Date.now()
): string => {
  if (state.phase === RunPhase.Queued) {
    return `${LOADING} Queued — starting once the current run in this thread finishes`;
  }
  // Before the first event there is nothing true to say but this. It used to
  // render the queued line, which claimed a run was waiting on another when
  // nothing was, and is the first thing anyone reads.
  if (state.phase === RunPhase.Starting) {
    return `${LOADING} Starting up…`;
  }
  // No elapsed counter: Slack already timestamps the message, so it was one
  // more number saying what the reader can see. Silence is the part Slack
  // cannot show, and it falls back to the run's start — a run that has never
  // logged a line is exactly the one worth flagging.
  const quiet = minutesSince(state.lastLineAt ?? state.startedAt, now);
  const parts = [
    quiet >= QUIET_MINUTES
      ? `${LOADING} Working… (quiet for ${quiet}m)`
      : `${LOADING} Working…`,
    state.model ?? "",
    toolSummary(state.tools),
  ];
  return parts.filter((part) => part !== "").join(" · ");
};

/**
 * A safety cap, not a style. Slack wraps a long line perfectly well, and
 * cutting one mid-word ("before designi…") reads as damage rather than as
 * brevity — so this only exists to stop a pasted wall of text taking the
 * whole message, and it breaks on a word.
 */
const MAX_LOG_LINE_CHARS = 300;

/**
 * The line still being written gets more room, and is windowed from the END.
 *
 * Truncating it from the front would freeze after the first screenful, which
 * is the opposite of the point: the newest words have to keep moving.
 */
const MAX_LIVE_CHARS = 240;

/** Cut at the last space before the cap, so a word is never sliced in half. */
const clip = (line: string, max: number): string => {
  if (line.length <= max) {
    return line;
  }
  const head = line.slice(0, max);
  const lastSpace = head.lastIndexOf(" ");
  return `${(lastSpace > max / 2 ? head.slice(0, lastSpace) : head).trimEnd()}…`;
};

const trimLine = (line: string): string =>
  clip(flatten(line), MAX_LOG_LINE_CHARS);

/**
 * The sentence still being written, marked as unfinished.
 *
 * It is caught mid-word on most renders — "Mapping the current tu" — which
 * reads as damage without something saying so. The mark turns a half-word
 * from a bug into a cursor. Not added to a sentence that already ended.
 */
const stillWriting = (line: string): string =>
  SENTENCE_END.test(line) ? line : `${line}…`;
const trimLive = (line: string): string => {
  const flat = flatten(line);
  if (flat.length <= MAX_LIVE_CHARS) {
    return stillWriting(flat);
  }
  // Windowed from the END so the newest words keep moving, and cut at a space
  // so the window opens on a word rather than mid-way through one.
  const tail = flat.slice(flat.length - MAX_LIVE_CHARS);
  const firstSpace = tail.indexOf(" ");
  const windowed = (
    firstSpace !== -1 && firstSpace < MAX_LIVE_CHARS / 2
      ? tail.slice(firstSpace)
      : tail
  ).trimStart();
  return `…${stillWriting(windowed)}`;
};

/**
 * The last few things the agent SAID, newest last, with the sentence it is
 * still writing on the end.
 *
 * Its own words only — never the tool calls between them. A feed of `bash`,
 * `read`, `bash` says nothing a person wants; the sentence the agent wrote
 * before reaching for the tool is the whole signal.
 *
 * Plain text, not a code block: a fixed-width grey box reads as terminal
 * output to parse rather than as someone talking.
 */
export const renderWorkLog = (state: RunState): string => {
  const live = flatten(state.text);
  const settled = state.log.map((line) => trimLine(line));
  if (live === "") {
    return withinBudget(settled).join("\n");
  }
  // The sentence being written always holds the last slot; the top scrolls
  // off to pay for it.
  return withinBudget([...settled, trimLive(live)]).join("\n");
};

/**
 * What the run got done, for an ending that is not an answer.
 *
 * The progress message is deleted when the turn ends, so on a timeout or a
 * cancel the work log dies with it — an hour of real work rendered as
 * "Timed out." and nothing else. That is the worst possible outcome for the
 * person who asked: no answer AND no record.
 */
const soFar = (state: RunState): string => {
  const done = renderWorkLog(state).trim();
  return done === "" ? "" : `\n\n*What I got done:*\n${done}`;
};

/** A streamed message keeps its cards; repeating them below would be noise. */
interface RenderOptions {
  /** Off when the caller renders its own small print, so it is not doubled. */
  readonly withModel?: boolean;
  readonly withWorkLog?: boolean;
}
export const renderRunState = (
  state: RunState,
  options: RenderOptions = {}
): string => {
  const recap = options.withWorkLog === false ? "" : soFar(state);
  // Tool counts are tracked on the state but never rendered: a long run turns
  // the footer into "bash ×36", which is noise to the person who asked and
  // says nothing about progress. The counts stay because cancellation and
  // future surfaces read them; the footer is just the model.
  const footer =
    options.withModel === false
      ? ""
      : [state.harness ?? "", state.model ?? ""]
          .filter((part) => part !== "")
          .join(" · ");
  const body = answerText(state);

  switch (state.phase) {
    case RunPhase.Queued: {
      return `${LOADING} Queued — starting once the current run in this thread finishes`;
    }
    case RunPhase.Starting: {
      return `_${LOADING} Starting up…_`;
    }
    case RunPhase.Running: {
      return body ? `${body}\n\n_${LOADING} Working_` : `_${LOADING} Working_`;
    }
    case RunPhase.Cancelled: {
      return `${body}\n\n🛑 _Cancelled._${recap}`.trim();
    }
    case RunPhase.Steered: {
      // Not a cancel: nobody asked for the work to stop, they asked for it to
      // go somewhere else, and the next turn carries what this one had.
      return `${body}\n\n↪️ _Picking up your new message._${recap}`.trim();
    }
    case RunPhase.TimedOut: {
      // The surface stopped WATCHING; it did not stop the run, and saying so
      // matters. "Stopped waiting… ask again and I will pick it up" read as
      // the work being dead, and for a while it was — the same line used to
      // ship alongside an abort. Nothing here kills a run any more.
      return `${body}\n\n⏳ _Quiet for a while, so here is where it got to. Still running — I will post if it lands._${recap}`.trim();
    }
    case RunPhase.Failed: {
      const reason = state.error ?? "the run ended without a result";
      return `${body}\n\n⚠️ _Failed — ${reason}._${recap}`.trim();
    }
    case RunPhase.Done: {
      // A turn can finish having emitted no prose at all — it ran tools and
      // said nothing. Rendering "" makes the final update an empty message,
      // which Slack rejects, so the edit fails and the thread keeps showing
      // the loader for a run that is already over.
      const answer = body || "_Done — no output._";
      return footer ? `${answer}\n\n_${footer}_` : answer;
    }
    default: {
      return body;
    }
  }
};
