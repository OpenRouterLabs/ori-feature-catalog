/**
 * blocks.ts — Block Kit construction with Slack's limits applied.
 *
 * Slack rejects an over-long block outright, so the ceilings live here as data
 * rather than as scattered magic numbers. When Slack changes one, this is the
 * only file to review.
 */

import type { Block, KnownBlock, MarkdownBlock } from "@slack/types";

/**
 * What every helper here produces. Typed as Slack's own union so the boundary
 * that hands blocks to the Web API needs no assertion.
 */
export type SlackBlock = Block | KnownBlock;

/** Platform ceilings. Sourced from Slack's Block Kit reference. */
export const LIMITS = {
  actionsElements: 25,
  blocks: 50,
  buttonText: 75,
  buttonValue: 2000,
  headerText: 150,
  sectionText: 3000,
  textObject: 3000,
} as const;

const truncate = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`;

interface SectionBlock {
  readonly text: { readonly text: string; readonly type: "mrkdwn" };
  readonly type: "section";
}

/**
 * Standard markdown, which is NOT what a `section` renders.
 *
 * A section takes Slack's own `mrkdwn`: `*bold*`, no tables, no lists. This
 * takes GitHub-flavoured markdown — tables, task lists, dividers, sized
 * headers, language-tagged code blocks — added to Block Kit in March 2026.
 * `markdown_text` on `chat.postMessage` is a third dialect again and does not
 * carry tables, so the answer goes through here.
 */
export const markdown = (text: string): MarkdownBlock => ({
  text,
  type: "markdown",
});

export const section = (text: string): SectionBlock => ({
  text: {
    text: truncate(text, LIMITS.sectionText),
    type: "mrkdwn",
  },
  type: "section",
});

interface HeaderBlock {
  readonly text: { readonly text: string; readonly type: "plain_text" };
  readonly type: "header";
}

/**
 * A large title. `plain_text` only — Slack silently drops mrkdwn here, so a
 * bolded header renders with its asterisks showing.
 */
export const header = (text: string): HeaderBlock => ({
  text: {
    text: truncate(text, LIMITS.headerText),
    type: "plain_text",
  },
  type: "header",
});

interface DividerBlock {
  readonly type: "divider";
}

export const divider = (): DividerBlock => ({ type: "divider" });

export interface ButtonElement {
  readonly action_id: string;
  readonly text: { readonly text: string; readonly type: "plain_text" };
  readonly type: "button";
  readonly value?: string;
}

export const button = (input: {
  readonly actionId: string;
  readonly label: string;
  readonly value?: string;
}): ButtonElement => ({
  action_id: input.actionId,
  text: {
    text: truncate(input.label, LIMITS.buttonText),
    type: "plain_text",
  },
  type: "button",
  ...(input.value === undefined
    ? {}
    : { value: truncate(input.value, LIMITS.buttonValue) }),
});

interface ContextBlock {
  readonly elements: readonly {
    readonly text: string;
    readonly type: "mrkdwn";
  }[];
  readonly type: "context";
}

/**
 * Secondary metadata, rendered small and muted by Slack.
 *
 * This is where a tool line belongs. As a section it sits at body weight and
 * reads as an orphaned fragment under the status; as context it reads as what
 * it is — a footnote.
 */
export const context = (text: string): ContextBlock => ({
  elements: [
    {
      text: truncate(text, LIMITS.textObject),
      type: "mrkdwn",
    },
  ],
  type: "context",
});

interface InputBlock {
  readonly block_id: string;
  readonly element: {
    readonly action_id: string;
    readonly multiline?: boolean;
    readonly type: "plain_text_input";
  };
  readonly label: {
    readonly text: string;
    readonly type: "plain_text";
  };
  readonly optional?: boolean;
  readonly type: "input";
}

/**
 * A field in a modal.
 *
 * A modal carrying a submit button and no input block collects nothing — it
 * renders as a dialog whose Submit returns an empty `state.values`, which reads
 * as a Slack bug rather than a missing block.
 *
 * `block_id` is what identifies the value on the way back: a `view_submission`
 * payload keys `state.values` by it and carries no button value at all.
 */
export const inputBlock = (options: {
  readonly actionId: string;
  readonly blockId: string;
  readonly label: string;
  readonly multiline?: boolean;
  readonly optional?: boolean;
}): InputBlock => ({
  block_id: options.blockId,
  element: {
    action_id: options.actionId,
    type: "plain_text_input",
    ...(options.multiline === undefined
      ? {}
      : { multiline: options.multiline }),
  },
  label: {
    // plain_text only — Slack rejects mrkdwn on an input label.
    text: truncate(options.label, LIMITS.textObject),
    type: "plain_text",
  },
  type: "input",
  ...(options.optional === undefined ? {} : { optional: options.optional }),
});

/** One option in a radio group or checkbox set. */
interface ChoiceOption {
  readonly text: { readonly text: string; readonly type: "plain_text" };
  readonly value: string;
}

const optionOf = (choice: {
  readonly label: string;
  readonly value: string;
}): ChoiceOption => ({
  text: {
    // plain_text only — Slack rejects mrkdwn inside an option label.
    text: truncate(choice.label, LIMITS.textObject),
    type: "plain_text",
  },
  value: choice.value,
});

interface ChoiceInputBlock {
  readonly block_id: string;
  readonly element: {
    readonly action_id: string;
    readonly options: readonly ChoiceOption[];
    readonly type: "radio_buttons" | "checkboxes";
  };
  readonly label: { readonly text: string; readonly type: "plain_text" };
  readonly optional?: boolean;
  readonly type: "input";
}

/**
 * A question with choices, as an input block.
 *
 * Radio buttons rather than a dropdown: a reader can see every option without
 * a click, which is the whole reason to batch questions into one form. Slack
 * keys the answer by `block_id` on the way back, the same as a text input, so
 * a mixed form reads out of one `state.values` map.
 */
export const choiceInput = (options: {
  readonly actionId: string;
  readonly blockId: string;
  readonly choices: readonly {
    readonly label: string;
    readonly value: string;
  }[];
  readonly label: string;
  readonly multi?: boolean;
  readonly optional?: boolean;
}): ChoiceInputBlock => ({
  block_id: options.blockId,
  element: {
    action_id: options.actionId,
    options: options.choices.map(optionOf),
    type: options.multi === true ? "checkboxes" : "radio_buttons",
  },
  label: {
    text: truncate(options.label, LIMITS.textObject),
    type: "plain_text",
  },
  type: "input",
  ...(options.optional === undefined ? {} : { optional: options.optional }),
});

export const actions = (
  elements: readonly ButtonElement[]
): {
  readonly elements: readonly ButtonElement[];
  readonly type: "actions";
} => ({
  elements: elements.slice(0, LIMITS.actionsElements),
  type: "actions",
});

/** Cap a block list before it reaches Slack. */
export const capBlocks = <T>(blocks: readonly T[]): readonly T[] =>
  blocks.slice(0, LIMITS.blocks);

/**
 * Slack rejects an over-long message outright rather than trimming it, which
 * would turn a long agent answer into no answer at all. Its ceiling is 40,000
 * characters; sitting under it leaves room for the marker and for any encoding
 * expansion between here and the wire.
 */
const MAX_MESSAGE_CHARS = 39_000;
const TRUNCATION_NOTICE =
  "\n\n_… truncated: the full answer exceeded Slack's message limit._";

/** Trim text to something Slack will accept, marking that it was trimmed. */
export const withinSlackLimit = (text: string): string =>
  text.length <= MAX_MESSAGE_CHARS
    ? text
    : text.slice(0, MAX_MESSAGE_CHARS - TRUNCATION_NOTICE.length) +
      TRUNCATION_NOTICE;
