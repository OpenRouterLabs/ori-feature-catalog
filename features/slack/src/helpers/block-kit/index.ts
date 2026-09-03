import type { Block, KnownBlock, MarkdownBlock } from "@slack/types";

import { Schema } from "effect";

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

const SectionBlockSchema = Schema.Struct({
  text: Schema.Struct({
    text: Schema.String,
    type: Schema.Literal("mrkdwn"),
  }),
  type: Schema.Literal("section"),
});

type SectionBlock = typeof SectionBlockSchema.Type;

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

const HeaderBlockSchema = Schema.Struct({
  text: Schema.Struct({
    text: Schema.String,
    type: Schema.Literal("plain_text"),
  }),
  type: Schema.Literal("header"),
});

type HeaderBlock = typeof HeaderBlockSchema.Type;

export const header = (text: string): HeaderBlock => ({
  text: {
    text: truncate(text, LIMITS.headerText),
    type: "plain_text",
  },
  type: "header",
});

const DividerBlockSchema = Schema.Struct({
  type: Schema.Literal("divider"),
});

type DividerBlock = typeof DividerBlockSchema.Type;

export const divider = (): DividerBlock => ({ type: "divider" });

const ButtonElementSchema = Schema.Struct({
  action_id: Schema.String,
  text: Schema.Struct({
    text: Schema.String,
    type: Schema.Literal("plain_text"),
  }),
  type: Schema.Literal("button"),
  value: Schema.optionalKey(Schema.String),
});

export type ButtonElement = typeof ButtonElementSchema.Type;

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

const ContextBlockSchema = Schema.Struct({
  elements: Schema.Array(
    Schema.Struct({
      text: Schema.String,
      type: Schema.Literal("mrkdwn"),
    })
  ),
  type: Schema.Literal("context"),
});

type ContextBlock = typeof ContextBlockSchema.Type;

export const context = (text: string): ContextBlock => ({
  elements: [
    {
      text: truncate(text, LIMITS.textObject),
      type: "mrkdwn",
    },
  ],
  type: "context",
});

const InputBlockSchema = Schema.Struct({
  block_id: Schema.String,
  element: Schema.Struct({
    action_id: Schema.String,
    multiline: Schema.optionalKey(Schema.Boolean),
    type: Schema.Literal("plain_text_input"),
  }),
  label: Schema.Struct({
    text: Schema.String,
    type: Schema.Literal("plain_text"),
  }),
  optional: Schema.optionalKey(Schema.Boolean),
  type: Schema.Literal("input"),
});

type InputBlock = typeof InputBlockSchema.Type;

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

const ChoiceOptionSchema = Schema.Struct({
  text: Schema.Struct({
    text: Schema.String,
    type: Schema.Literal("plain_text"),
  }),
  value: Schema.String,
});

type ChoiceOption = typeof ChoiceOptionSchema.Type;

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

const ChoiceInputBlockSchema = Schema.Struct({
  block_id: Schema.String,
  element: Schema.Struct({
    action_id: Schema.String,
    options: Schema.Array(ChoiceOptionSchema),
    type: Schema.Literals(["radio_buttons", "checkboxes"]),
  }),
  label: Schema.Struct({
    text: Schema.String,
    type: Schema.Literal("plain_text"),
  }),
  optional: Schema.optionalKey(Schema.Boolean),
  type: Schema.Literal("input"),
});

type ChoiceInputBlock = typeof ChoiceInputBlockSchema.Type;

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
