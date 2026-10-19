import type { TurnEnv } from "../intern-root/index.ts";
import type { MemoryKind, MemoryLine } from "../line/index.ts";

import { renderMemoryBrief } from "../brief/index.ts";
import { resolveInternRoot } from "../intern-root/index.ts";
import { MEMORY_TEXT_LIMIT, minuteStamp, singleLine } from "../line/index.ts";
import {
  describeMemory,
  foldMemoryLog,
  recallMemories,
} from "../live/index.ts";
import { memoryLogAt } from "../memory-log/index.ts";

export interface MemoryTurn {
  readonly hint: string;
  readonly env: TurnEnv;
  readonly now: Date;
}

const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

const newMemoryId = (): string =>
  `m-${[...crypto.getRandomValues(new Uint8Array(6))]
    .map((byte) => ID_ALPHABET[byte % ID_ALPHABET.length])
    .join("")}`;

const savedIds = (lines: readonly MemoryLine[]): ReadonlySet<string> =>
  new Set(lines.flatMap((line) => (line.op === "save" ? [line.id] : [])));

const present = (value: string | undefined): string | undefined => {
  const trimmed = value?.replaceAll(/\s+/gu, "") ?? "";
  return trimmed === "" ? undefined : trimmed;
};

export const memoryAuthor = (env: TurnEnv): string => {
  const user = present(env.ORI_OPENROUTER_USER);
  if (user !== undefined) {
    return `@${user}`;
  }
  const slackUser = present(env.SLACK_USER_ID);
  return slackUser === undefined ? "@local" : `@slack:${slackUser}`;
};

export const memoryChannel = (env: TurnEnv): string | undefined => {
  const channel = present(env.SLACK_CHANNEL_ID);
  return channel === undefined ? undefined : `#${channel}`;
};

const openTurnLog = async (turn: MemoryTurn) =>
  memoryLogAt(await resolveInternRoot({ hint: turn.hint, env: turn.env }));

export const saveMemory = async (
  turn: MemoryTurn,
  input: { readonly text: string; readonly kind?: MemoryKind | undefined }
): Promise<string> => {
  const text = singleLine(input.text);
  if (text === "") {
    throw new Error("Memory text is empty. Say what to remember.");
  }
  if (text.length > MEMORY_TEXT_LIMIT) {
    throw new Error(
      `Memory text is ${text.length} characters; the limit is ${MEMORY_TEXT_LIMIT}. Save a shorter summary.`
    );
  }
  const kind = input.kind ?? "note";
  const log = await openTurnLog(turn);
  const taken = savedIds(await log.read());
  const id = newMemoryId();
  if (taken.has(id)) {
    throw new Error(
      `Memory id ${id} already exists. Save again: this log keeps every id unique.`
    );
  }
  await log.append(
    [
      {
        op: "save",
        id,
        at: minuteStamp(turn.now),
        kind,
        author: memoryAuthor(turn.env),
        channel: memoryChannel(turn.env),
        text,
      },
    ],
    turn.now
  );
  return `Saved ${kind} ${id}.`;
};

export const recallMemory = async (
  turn: MemoryTurn,
  query: string
): Promise<string> => {
  const log = await openTurnLog(turn);
  const { live } = foldMemoryLog(await log.read());
  const { matches, total } = recallMemories(live, query);
  if (matches.length === 0) {
    return `No saved memory matches "${singleLine(query)}".`;
  }
  return [
    ...matches.map(describeMemory),
    ...(total > matches.length
      ? [
          `(${total - matches.length} more match; add words to narrow the query)`,
        ]
      : []),
  ].join("\n");
};

export const forgetMemories = async (
  turn: MemoryTurn,
  input: { readonly ids: readonly string[]; readonly reason: string }
): Promise<string> => {
  const log = await openTurnLog(turn);
  const view = foldMemoryLog(await log.read());
  const liveIds = new Set(view.live.map(({ id }) => id));
  const ids = [...new Set(input.ids.map((id) => id.trim()))];
  const forgettable = ids.filter((id) => liveIds.has(id));
  const already = ids.filter((id) => view.forgotten.has(id));
  const unknown = ids.filter(
    (id) => !liveIds.has(id) && !view.forgotten.has(id)
  );
  const reason =
    singleLine(input.reason).slice(0, MEMORY_TEXT_LIMIT) || "no reason given";
  const author = memoryAuthor(turn.env);
  const at = minuteStamp(turn.now);
  const lines: readonly MemoryLine[] = forgettable.map((target) => ({
    op: "forget",
    id: newMemoryId(),
    at,
    target,
    author,
    reason,
  }));
  await log.append(lines, turn.now);
  return [
    forgettable.length === 0
      ? "Forgot nothing."
      : `Forgot ${forgettable.join(", ")}.`,
    ...(already.length === 0
      ? []
      : [`Already forgotten: ${already.join(", ")}.`]),
    ...(unknown.length === 0 ? [] : [`Unknown ids: ${unknown.join(", ")}.`]),
  ].join(" ");
};

export const memoryBrief = async (input: {
  readonly hint: string;
  readonly env: TurnEnv;
}): Promise<string> => {
  const log = memoryLogAt(await resolveInternRoot(input));
  return renderMemoryBrief(foldMemoryLog(await log.read()).live);
};
