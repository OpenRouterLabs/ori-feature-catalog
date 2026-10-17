import type {
  PromptContext,
  PromptFragment,
  ToolCallContext,
  ToolResult,
} from "ori";

import { defineTool, Schema, ToolResultSchema } from "ori";

import type { MemoryTurn } from "#src/memory-tools/index.ts";

import type { TurnEnv } from "#src/intern-root/index.ts";

import { sessionMemoryBrief } from "#src/brief/index.ts";
import { MEMORY_ID_PATTERN, MEMORY_KINDS } from "#src/line/index.ts";
import {
  forgetMemories,
  memoryBrief,
  recallMemory,
  saveMemory,
} from "#src/memory-tools/index.ts";

const turnOf = (context: ToolCallContext): MemoryTurn => ({
  hint: context.workspace.root,
  env: { ...globalThis.process.env, ...context.thread.input.config.env },
  now: new Date(),
});

const textResult = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
});

const promptHint = (): string => globalThis.process.cwd();
const promptEnv = (): TurnEnv => globalThis.process.env;

// Prompt providers receive no run workspace, so the brief necessarily reads the
// daemon's own root. Tools resolve the root per run instead, which can differ
// when a run exports another ORI_INTERN_WORKSPACE_ROOT; the README documents it.

export const tools = [
  defineTool({
    name: "memory_save",
    description: [
      "Save one memory a later session needs: a person's preference, a fact about a person or project, a past decision, or a commitment you will keep yourself.",
      "If only one task uses it, change that task instead: a step, format, trap, or table entry goes in the task's skill, a change to when an existing chore runs goes in its schedule, and a rule a check could enforce goes in the feature's code. What holds across your tasks stays a memory.",
      "If a skill, schedule, or feature already says it, save nothing, even when asked to remember it, and say where it is written.",
      "Save proactively when you learn one, and immediately when asked to remember something new. Do not save chit-chat or one-off task details. Write one self-contained sentence that names who or what it is about.",
      "Kinds: pin = shown at the start of every session, for something nearly every conversation needs; todo = something you will do yourself, shown at the start of every session until forgotten (for new recurring work, save a todo and offer to set up a chore); note (default) = found later with memory_recall.",
      "To change a memory, including merging two into one, save the new version and forget the old ids. Never keep two memories that say the same thing.",
    ].join(" "),
    capabilities: ["write"],
    inputSchema: Schema.Struct({
      text: Schema.NonEmptyString,
      kind: Schema.optional(Schema.Literals(MEMORY_KINDS)),
    }),
    outputSchema: ToolResultSchema,
    run: async ({ args, ...context }) =>
      textResult(await saveMemory(turnOf(context), args)),
  }),
  defineTool({
    name: "memory_recall",
    description:
      "Search saved memories from earlier sessions by keywords. Every word must appear (case-insensitive). Returns up to 20 matches, newest first, with ids. Use it before answering anything that may depend on what you were told before.",
    capabilities: ["read"],
    inputSchema: Schema.Struct({ query: Schema.NonEmptyString }),
    outputSchema: ToolResultSchema,
    run: async ({ args, ...context }) =>
      textResult(await recallMemory(turnOf(context), args.query)),
  }),
  defineTool({
    name: "memory_forget",
    description:
      "Retire saved memories that are wrong, outdated, or done (a finished todo). Pass their ids and a short reason.",
    capabilities: ["write"],
    inputSchema: Schema.Struct({
      ids: Schema.NonEmptyArray(
        Schema.String.check(Schema.isPattern(MEMORY_ID_PATTERN))
      ),
      reason: Schema.NonEmptyString,
    }),
    outputSchema: ToolResultSchema,
    run: async ({ args, ...context }) =>
      textResult(await forgetMemories(turnOf(context), args)),
  }),
];

export const prompt = async (
  context: PromptContext
): Promise<readonly PromptFragment[]> => {
  const text = await sessionMemoryBrief({
    state: context.state,
    sessionId: context.sessionId,
    render: () =>
      memoryBrief({
        hint: promptHint(),
        env: promptEnv(),
      }),
  });
  return text === "" ? [] : [{ name: "memory", order: 900, text }];
};
