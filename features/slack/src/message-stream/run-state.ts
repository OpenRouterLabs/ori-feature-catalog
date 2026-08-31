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

const SENTENCE_END = /[.!?…:]["')\]]?$/u;

const gistOf = (line: string): string =>
  flatten(line)
    .toLowerCase()
    .replaceAll(/[^a-z0-9 ]/gu, "");

export interface RunState {
  readonly compactingSince: number | undefined;
  readonly phase: RunPhase;
  readonly lastLineAt: number | undefined;
  readonly startedAt: number;
  readonly text: string;
  readonly priorText: string;
  readonly tools: ReadonlyMap<string, number>;
  readonly alive: number;
  readonly openTools: number;
  readonly log: readonly string[];
  readonly logged: number;
  readonly model: string | undefined;
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

const VISUAL_LINE_BUDGET = 6;
const CHARS_PER_VISUAL_LINE = 66;

const LOG_LINES = 12;

const visualCost = (line: string): number =>
  Math.max(1, Math.ceil(line.length / CHARS_PER_VISUAL_LINE));

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

const DEFAULT_LOADING = ":braille-loader:";
let LOADING = DEFAULT_LOADING;

export const loadingEmoji = (): string => LOADING;

export const setLoadingEmoji = (emoji: string): void => {
  LOADING = emoji === "" ? DEFAULT_LOADING : emoji;
};

export const toolSummary = (tools: ReadonlyMap<string, number>): string =>
  [...tools.entries()]
    .map(([name, count]) => (count > 1 ? `${name} ×${count}` : name))
    .join(", ");

const MINUTE_MS = 60_000;

const QUIET_MINUTES = 5;

export const minutesSince = (from: number, now: number): number =>
  Math.max(0, Math.floor((now - from) / MINUTE_MS));

export const renderStatusLine = (
  state: RunState,
  now: number = Date.now()
): string => {
  if (state.phase === RunPhase.Queued) {
    return `${LOADING} Queued — starting once the current run in this thread finishes`;
  }
  if (state.phase === RunPhase.Starting) {
    return `${LOADING} Starting up…`;
  }
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

const MAX_LOG_LINE_CHARS = 300;

const MAX_LIVE_CHARS = 240;

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

const stillWriting = (line: string): string =>
  SENTENCE_END.test(line) ? line : `${line}…`;
const trimLive = (line: string): string => {
  const flat = flatten(line);
  if (flat.length <= MAX_LIVE_CHARS) {
    return stillWriting(flat);
  }
  const tail = flat.slice(flat.length - MAX_LIVE_CHARS);
  const firstSpace = tail.indexOf(" ");
  const windowed = (
    firstSpace !== -1 && firstSpace < MAX_LIVE_CHARS / 2
      ? tail.slice(firstSpace)
      : tail
  ).trimStart();
  return `…${stillWriting(windowed)}`;
};

export const renderWorkLog = (state: RunState): string => {
  const live = flatten(state.text);
  const settled = state.log.map((line) => trimLine(line));
  if (live === "") {
    return withinBudget(settled).join("\n");
  }
  return withinBudget([...settled, trimLive(live)]).join("\n");
};

const soFar = (state: RunState): string => {
  const done = renderWorkLog(state).trim();
  return done === "" ? "" : `\n\n*What I got done:*\n${done}`;
};

interface RenderOptions {
  readonly withModel?: boolean;
  readonly withWorkLog?: boolean;
}
export const renderRunState = (
  state: RunState,
  options: RenderOptions = {}
): string => {
  const recap = options.withWorkLog === false ? "" : soFar(state);
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
      return `${body}\n\n↪️ _Picking up your new message._${recap}`.trim();
    }
    case RunPhase.TimedOut: {
      return `${body}\n\n⏳ _Quiet for a while, so here is where it got to. Still running — I will post if it lands._${recap}`.trim();
    }
    case RunPhase.Failed: {
      const reason = state.error ?? "the run ended without a result";
      return `${body}\n\n⚠️ _Failed — ${reason}._${recap}`.trim();
    }
    case RunPhase.Done: {
      const answer = body || "_Done — no output._";
      return footer ? `${answer}\n\n_${footer}_` : answer;
    }
    default: {
      return body;
    }
  }
};
