export const MEMORY_KINDS = ["pin", "todo", "note"] as const;

export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const MEMORY_TEXT_LIMIT = 500;

export interface SavedMemory {
  readonly op: "save";
  readonly id: string;
  readonly at: string | undefined;
  readonly kind: MemoryKind;
  readonly author: string | undefined;
  readonly channel: string | undefined;
  readonly text: string;
}

export interface ForgottenMemory {
  readonly op: "forget";
  readonly id: string;
  readonly at: string;
  readonly target: string;
  readonly author: string;
  readonly reason: string;
}

export type MemoryLine = SavedMemory | ForgottenMemory;

const STAMP = String.raw`(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z)`;
const ID = String.raw`([mh]-[a-z0-9]{6,})`;
const AUTHOR = String.raw`(@\S+)`;

const SAVE_LINE = new RegExp(
  String.raw`^\s*-\s+${STAMP}\s+${ID}\s+(pin|todo|note)\s+${AUTHOR}(?:\s+(#\S+))?\s*\|\s*(.+)$`,
  "u"
);
const FORGET_LINE = new RegExp(
  String.raw`^\s*-\s+${STAMP}\s+${ID}\s+forget\s+${ID}\s+${AUTHOR}\s*\| ?(.*)$`,
  "u"
);
const BARE_LINE = /^[-*] (.+)$/u;

export const MEMORY_ID_PATTERN = new RegExp(`^${ID}$`, "u");

export const singleLine = (text: string): string =>
  text.replaceAll(/\s+/gu, " ").trim();

export const minuteStamp = (date: Date): string =>
  `${date.toISOString().slice(0, 16)}Z`;

const isMemoryKind = (value: string): value is MemoryKind =>
  MEMORY_KINDS.some((kind) => kind === value);

export const handWrittenNoteId = (text: string): string => {
  let hash = 0x81_1c_9d_c5;
  for (const char of text) {
    hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 0x01_00_01_93) >>> 0;
  }
  return `h-${hash.toString(36).padStart(7, "0")}`;
};

const handWrittenNote = (text: string): SavedMemory => ({
  op: "save",
  id: handWrittenNoteId(text),
  at: undefined,
  kind: "note",
  author: undefined,
  channel: undefined,
  text,
});

export const parseMemoryLine = (raw: string): MemoryLine | undefined => {
  const line = raw.trimEnd();
  const forget = FORGET_LINE.exec(line);
  if (forget !== null) {
    const [, at = "", id = "", target = "", author = "", reason = ""] = forget;
    return { op: "forget", id, at, target, author, reason: reason.trim() };
  }
  const save = SAVE_LINE.exec(line);
  if (save !== null) {
    const [, at, id = "", kind = "", author, channel, text = ""] = save;
    if (isMemoryKind(kind) && singleLine(text) !== "") {
      return {
        op: "save",
        id,
        at,
        kind,
        author,
        channel,
        text: singleLine(text),
      };
    }
  }
  const bare = BARE_LINE.exec(line);
  const text = singleLine(bare?.[1] ?? "");
  return text === "" ? undefined : handWrittenNote(text);
};

export const parseMemoryLog = (source: string): readonly MemoryLine[] =>
  source
    .split("\n")
    .map(parseMemoryLine)
    .filter((line) => line !== undefined);

const savedHeader = (memory: SavedMemory): string | undefined =>
  memory.at === undefined || memory.author === undefined
    ? undefined
    : [
        memory.at,
        memory.id,
        memory.kind,
        memory.author,
        ...(memory.channel === undefined ? [] : [memory.channel]),
      ].join(" ");

export const formatMemoryLine = (line: MemoryLine): string => {
  if (line.op === "forget") {
    return `- ${line.at} ${line.id} forget ${line.target} ${line.author} | ${line.reason}`;
  }
  const header = savedHeader(line);
  return header === undefined ? `- ${line.text}` : `- ${header} | ${line.text}`;
};
