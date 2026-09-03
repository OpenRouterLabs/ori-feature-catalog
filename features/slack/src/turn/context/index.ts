import type { PaneContext } from "#src/thread/assistant.ts";
import type { IncomingTurn } from "#src/turn/turn-input.ts";

import {
  SLACK_REPLY_STYLE,
  SLACK_STYLE_REMINDER,
} from "#src/turn/reply-style.ts";

import { paneContextBlock } from "./pane-context.ts";
import { steerContextBlock } from "./steer-context.ts";
import { toolContextBlock } from "./tool-context.ts";

export const makeTurnPrompt = (input: {
  readonly context: string;
  readonly paneContext: PaneContext | undefined;
  readonly resuming: boolean;
  readonly turn: IncomingTurn;
}): string =>
  [
    input.resuming ? SLACK_STYLE_REMINDER : SLACK_REPLY_STYLE,
    paneContextBlock(input.paneContext),
    toolContextBlock(input.turn.ref),
    input.turn.attachmentWarning ?? "",
    input.context,
    steerContextBlock(input.turn.priorAsk),
    input.turn.text,
  ]
    .filter((part) => part !== "")
    .join("\n\n");
