import { expect, test } from "bun:test";

import type { MemoryLine } from "./index.ts";

import {
  formatMemoryLine,
  handWrittenNoteId,
  parseMemoryLine,
  parseMemoryLog,
} from "./index.ts";

const lines: readonly MemoryLine[] = [
  {
    op: "save",
    id: "m-7f3k2q",
    at: "2026-10-13T14:02Z",
    kind: "pin",
    author: "@slack:T01:U02",
    channel: "#C0123",
    text: "Matthew prefers short bullet replies.",
  },
  {
    op: "save",
    id: "m-a81x0c",
    at: "2026-10-13T14:05Z",
    kind: "todo",
    author: "@local",
    channel: undefined,
    text: "Send Q3 report Friday | before noon.",
  },
  {
    op: "forget",
    id: "m-q2w9zz",
    at: "2026-10-14T03:17Z",
    target: "m-a81x0c",
    author: "@local",
    reason: "done: report sent",
  },
];

test("every written line reads back as the same memory", () => {
  expect(lines.map((line) => parseMemoryLine(formatMemoryLine(line)))).toEqual([
    ...lines,
  ]);
});

test("the written line matches the documented format", () => {
  expect(lines.map(formatMemoryLine)).toEqual([
    "- 2026-10-13T14:02Z m-7f3k2q pin @slack:T01:U02 #C0123 | Matthew prefers short bullet replies.",
    "- 2026-10-13T14:05Z m-a81x0c todo @local | Send Q3 report Friday | before noon.",
    "- 2026-10-14T03:17Z m-q2w9zz forget m-a81x0c @local | done: report sent",
  ]);
});

test("a hand-written bullet reads as a note with an id derived from its text", () => {
  expect(parseMemoryLine("- Louis owns   release-please merges.  ")).toEqual({
    op: "save",
    id: handWrittenNoteId("Louis owns release-please merges."),
    at: undefined,
    kind: "note",
    author: undefined,
    channel: undefined,
    text: "Louis owns release-please merges.",
  });
});

test("lines that are not memories are skipped instead of failing the read", () => {
  const log = [
    "# Memory log",
    "",
    "Some prose a human typed.",
    "-",
    "- 2026-10-13T14:02Z m-7f3k2q pin @local | Kept.",
    "\r",
  ].join("\n");
  expect(
    parseMemoryLog(log).map((line) => line.op === "save" && line.text)
  ).toEqual(["Kept."]);
});
