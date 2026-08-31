import type { Block, KnownBlock, MarkdownBlock } from "@slack/types";

import { asMrkdwn } from "./mrkdwn.ts";

export type SlackBlock = Block | KnownBlock;

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

export const markdown = (text: string): MarkdownBlock => ({
  text,
  type: "markdown",
});

export const section = (text: string): SectionBlock => ({
  text: {
    text: truncate(asMrkdwn(text), LIMITS.sectionText),
    type: "mrkdwn",
  },
  type: "section",
});

interface HeaderBlock {
  readonly text: { readonly text: string; readonly type: "plain_text" };
  readonly type: "header";
}

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
    text: truncate(options.label, LIMITS.textObject),
    type: "plain_text",
  },
  type: "input",
  ...(options.optional === undefined ? {} : { optional: options.optional }),
});

interface ChoiceOption {
  readonly text: { readonly text: string; readonly type: "plain_text" };
  readonly value: string;
}

const optionOf = (choice: {
  readonly label: string;
  readonly value: string;
}): ChoiceOption => ({
  text: {
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

export const capBlocks = <T>(blocks: readonly T[]): readonly T[] =>
  blocks.slice(0, LIMITS.blocks);

const MAX_MESSAGE_CHARS = 39_000;
const TRUNCATION_NOTICE =
  "\n\n_… truncated: the full answer exceeded Slack's message limit._";

export const withinSlackLimit = (text: string): string =>
  text.length <= MAX_MESSAGE_CHARS
    ? text
    : text.slice(0, MAX_MESSAGE_CHARS - TRUNCATION_NOTICE.length) +
      TRUNCATION_NOTICE;
