import { Effect } from "effect";

import type { BlockersShape } from "#src/interactions/blocker.ts";
import type { AssistantThreadsShape } from "#src/thread/assistant.ts";
import type { ThreadRef } from "#src/thread/thread.ts";

import { paneOf } from "./context/pane-context.ts";

const RUN_ENDED = "the run ended before this was answered";

export const retireTurn = (input: {
  readonly assistant: AssistantThreadsShape;
  readonly blockers: BlockersShape;
  readonly instanceId: string;
  readonly ref: ThreadRef;
}): Effect.Effect<void> =>
  input.assistant
    .setStatus(paneOf(input.ref), "")
    .pipe(
      Effect.andThen(input.blockers.abandonThread(input.instanceId, RUN_ENDED)),
      Effect.withSpan("Slack.turn.retire")
    );
