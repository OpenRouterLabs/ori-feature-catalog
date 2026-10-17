import { expect, test } from "bun:test";

import type { MemoryLine, SavedMemory } from "#src/line/index.ts";

import { foldMemoryLog, RECALL_LIMIT, recallMemories } from "./index.ts";

const save = (id: string, text: string, at?: string | null): SavedMemory => ({
  op: "save",
  id,
  at: at === null ? undefined : (at ?? "2026-10-13T14:02Z"),
  kind: "note",
  author: "@local",
  channel: undefined,
  text,
});

test("a forgotten memory leaves the live view and the rest are newest first", () => {
  const log: readonly MemoryLine[] = [
    save("m-aaaaaa", "first"),
    save("m-bbbbbb", "second"),
    {
      op: "forget",
      id: "m-cccccc",
      at: "2026-10-13T15:00Z",
      target: "m-aaaaaa",
      author: "@local",
      reason: "wrong",
    },
    save("m-dddddd", "third"),
  ];
  const view = foldMemoryLog(log);
  expect(view.live.map(({ id }) => id)).toEqual(["m-dddddd", "m-bbbbbb"]);
  expect([...view.forgotten]).toEqual(["m-aaaaaa"]);
});

test("recall needs every query word, ignores case, and keeps newest first", () => {
  const { live } = foldMemoryLog([
    save("m-aaaaaa", "The staging key lives in the vault."),
    save("m-bbbbbb", "Staging deploys run on Fridays."),
    save("m-cccccc", "The VAULT holds the STAGING key now."),
  ]);
  expect(
    recallMemories(live, "staging  Key").matches.map(({ id }) => id)
  ).toEqual(["m-cccccc", "m-aaaaaa"]);
});

test("recall returns at most the limit and reports the total", () => {
  const { live } = foldMemoryLog(
    Array.from({ length: 25 }, (_, index) =>
      save(`m-${String(index).padStart(6, "0")}`, `deploy note ${index}`)
    )
  );
  const result = recallMemories(live, "deploy");
  expect(result.matches).toHaveLength(RECALL_LIMIT);
  expect(result.total).toBe(25);
  expect(result.matches[0]?.text).toBe("deploy note 24");
});

test("a merged log out of time order still recalls newest first, undated notes last", () => {
  const { live } = foldMemoryLog([
    save("m-oct120", "deploy moved to Tuesday", "2026-10-12T09:00Z"),
    save("m-oct100", "deploy runs Friday", "2026-10-10T09:00Z"),
    save("m-undate", "deploy by hand", null),
    save("m-oct110", "deploy needs approval", "2026-10-11T09:00Z"),
  ]);
  expect(live.map(({ id }) => id)).toEqual([
    "m-oct120",
    "m-oct110",
    "m-oct100",
    "m-undate",
  ]);
});
