import type { MemoryLine, SavedMemory } from "#src/line/index.ts";

export const RECALL_LIMIT = 20;

export interface MemoryView {
  readonly live: readonly SavedMemory[];
  readonly forgotten: ReadonlySet<string>;
}

const newestFirst = (memories: readonly SavedMemory[]): SavedMemory[] =>
  memories
    .toReversed()
    .toSorted((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));

export const foldMemoryLog = (lines: readonly MemoryLine[]): MemoryView => {
  const targets = new Set(
    lines.flatMap((line) => (line.op === "forget" ? [line.target] : []))
  );
  const saved = new Map<string, SavedMemory>();
  for (const line of lines) {
    if (line.op === "save" && !saved.has(line.id)) {
      saved.set(line.id, line);
    }
  }
  const all = [...saved.values()];
  return {
    live: newestFirst(all.filter((memory) => !targets.has(memory.id))),
    forgotten: new Set(
      all.filter((memory) => targets.has(memory.id)).map(({ id }) => id)
    ),
  };
};

export interface RecallResult {
  readonly matches: readonly SavedMemory[];
  readonly total: number;
}

export const recallMemories = (
  live: readonly SavedMemory[],
  query: string
): RecallResult => {
  const words = query.toLowerCase().split(/\s+/u).filter(Boolean);
  const matches = live.filter((memory) => {
    const text = memory.text.toLowerCase();
    return words.every((word) => text.includes(word));
  });
  return { matches: matches.slice(0, RECALL_LIMIT), total: matches.length };
};

export const describeMemory = (memory: SavedMemory): string => {
  const details = [
    memory.id,
    memory.kind,
    ...(memory.at === undefined ? [] : [memory.at]),
    ...(memory.author === undefined ? [] : [memory.author]),
    ...(memory.channel === undefined ? [] : [memory.channel]),
  ];
  return `- ${memory.text} (${details.join(", ")})`;
};
