import { Effect, Fiber } from "effect";

import type { RunState } from "#src/message-stream/run-state.ts";
import type { AssistantThreadsShape } from "#src/thread/assistant.ts";
import type { ThreadRef } from "#src/thread/thread.ts";

import { clampToWord } from "#src/clamp.ts";
import { toolSummary } from "#src/message-stream/run-state.ts";
import { paneOf } from "./context/pane-context.ts";
import { readLine } from "./live-line.ts";

const BEAT_MS = 8000;

const MINUTE_MS = 60_000;

const LINE_LIMIT = 80;

const ENTRY_LIMIT = 40;

export const loadingListOf = (line: string): readonly string[] => [
  clampToWord(line, ENTRY_LIMIT),
];

const minutesSince = (from: number, now: number): number =>
  Math.max(0, Math.floor((now - from) / MINUTE_MS));

export const beatLine = (state: RunState, now: number = Date.now()): string => {
  const elapsed = minutesSince(state.startedAt, now);
  const tools = toolSummary(state.tools);
  const doing =
    state.compactingSince === undefined
      ? tools
      : `compacting the context${
          minutesSince(state.compactingSince, now) > 0
            ? ` · ${minutesSince(state.compactingSince, now)}m so far`
            : ""
        }`;
  const parts = [
    "working",
    doing === "" ? "" : doing,
    elapsed > 0 ? `${elapsed}m` : "",
  ].filter((part) => part !== "");
  const line = parts.join(" · ");
  return line.length <= LINE_LIMIT ? line : `${line.slice(0, LINE_LIMIT - 1)}…`;
};

interface StatusBeat {
  readonly stop: Effect.Effect<void>;
}

export const beatStatus = Effect.fn("Slack.statusBeat.arm")(function* (input: {
  readonly assistant: AssistantThreadsShape;
  readonly peek: Effect.Effect<RunState>;
  readonly ref: ThreadRef;
  readonly threadKey: string;
}): Effect.fn.Return<StatusBeat> {
  const show = Effect.fn("Slack.statusBeat.show")(
    function* (): Effect.fn.Return<void> {
      const said = yield* readLine(input.threadKey);
      const state = yield* input.peek;
      const line = said ?? beatLine(state);
      yield* input.assistant.setStatus(
        paneOf(input.ref),
        line,
        loadingListOf(line)
      );
    }
  );

  yield* show();

  const fiber = yield* Effect.forkChild(
    Effect.whileLoop({
      body: () => Effect.sleep(BEAT_MS).pipe(Effect.andThen(show())),
      step: () => {
      },
      while: () => true,
    })
  );

  return { stop: Fiber.interrupt(fiber) };
});
