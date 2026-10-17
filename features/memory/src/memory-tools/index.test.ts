import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { parseMemoryLog } from "#src/line/index.ts";
import { withTempDir } from "#src/test-support/index.ts";

import type { MemoryTurn } from "./index.ts";

import { forgetMemories, recallMemory, saveMemory } from "./index.ts";

const NOW = new Date("2026-10-13T14:02:31.000Z");

const turnAt = (hint: string, env: MemoryTurn["env"] = {}): MemoryTurn => ({
  hint,
  env,
  now: NOW,
});

const monthLog = (root: string): Promise<string> =>
  readFile(path.join(root, "memory", "log", "2026-10.md"), "utf8");

const savedId = (reply: string): string =>
  reply.split(" ")[2]?.replace(/\.$/u, "") ?? "";

test("a save stamps time, author and channel from the turn env, not from the model", async () => {
  await withTempDir(async (root) => {
    await saveMemory(
      turnAt(root, {
        ORI_OPENROUTER_USER: "slack:T01:U02",
        SLACK_USER_ID: "U02",
        SLACK_CHANNEL_ID: "C0123",
      }),
      { text: "Matthew prefers\nshort bullet replies.", kind: "pin" }
    );
    await saveMemory(turnAt(root, { SLACK_USER_ID: "U09" }), {
      text: "Slack user without an OpenRouter subject.",
    });
    await saveMemory(turnAt(root), { text: "Local terminal note." });
    const written = (await monthLog(root)).trimEnd().split("\n");
    expect(
      written.map((line) => line.replace(/ m-[a-z0-9]{6} /u, " m-ID "))
    ).toEqual([
      "- 2026-10-13T14:02Z m-ID pin @slack:T01:U02 #C0123 | Matthew prefers short bullet replies.",
      "- 2026-10-13T14:02Z m-ID note @slack:U09 | Slack user without an OpenRouter subject.",
      "- 2026-10-13T14:02Z m-ID note @local | Local terminal note.",
    ]);
    expect(
      await readFile(path.join(root, "memory", ".gitattributes"), "utf8")
    ).toBe("log/*.md merge=union\n");
  });
});

test("a save longer than the limit is refused with a reason the model can act on", async () => {
  await withTempDir(async (root) => {
    await expect(
      saveMemory(turnAt(root), { text: "x".repeat(501) })
    ).rejects.toThrow("the limit is 500");
  });
});

test("200 concurrent saves all land as intact lines", async () => {
  await withTempDir(async (root) => {
    const replies = await Promise.all(
      Array.from({ length: 200 }, (_, index) =>
        saveMemory(turnAt(root), { text: `concurrent memory number ${index}` })
      )
    );
    const parsed = parseMemoryLog(await monthLog(root));
    expect(parsed).toHaveLength(200);
    expect(new Set(parsed.map(({ id }) => id))).toEqual(
      new Set(replies.map(savedId))
    );
    expect(
      new Set(parsed.map((line) => (line.op === "save" ? line.text : "")))
    ).toEqual(
      new Set(
        Array.from(
          { length: 200 },
          (_, index) => `concurrent memory number ${index}`
        )
      )
    );
  });
});

test("forget retires live ids and reports ids it cannot forget", async () => {
  await withTempDir(async (root) => {
    const first = savedId(
      await saveMemory(turnAt(root), { text: "Demo is Thursday." })
    );
    const second = savedId(
      await saveMemory(turnAt(root), { text: "Demo room is B." })
    );
    expect(
      await forgetMemories(turnAt(root), {
        ids: [first],
        reason: "moved to Friday",
      })
    ).toBe(`Forgot ${first}.`);
    expect(
      await forgetMemories(turnAt(root), {
        ids: [first, second, "m-zzzzzz"],
        reason: "cleanup",
      })
    ).toBe(
      `Forgot ${second}. Already forgotten: ${first}. Unknown ids: m-zzzzzz.`
    );
    expect(await recallMemory(turnAt(root), "demo")).toBe(
      'No saved memory matches "demo".'
    );
  });
});

test("a hand-edited log without a trailing newline keeps both lines on the next save", async () => {
  await withTempDir(async (root) => {
    await saveMemory(turnAt(root), { text: "Written by the tool." });
    const file = path.join(root, "memory", "log", "2026-10.md");
    await Bun.write(file, `${await readFile(file, "utf8")}- Typed by a human`);
    await saveMemory(turnAt(root), { text: "Written after the edit." });
    expect(await recallMemory(turnAt(root), "human")).toStartWith(
      "- Typed by a human (h-"
    );
    expect(await recallMemory(turnAt(root), "after the edit")).toStartWith(
      "- Written after the edit. (m-"
    );
  });
});

test("a save that draws an existing id is refused instead of silently discarded", async () => {
  await withTempDir(async (root) => {
    const turn = turnAt(root);
    const first = await saveMemory(turn, { text: "First memory." });
    const firstId = savedId(first);
    const original = globalThis.crypto;
    let drawn = false;
    globalThis.crypto = {
      ...original,
      getRandomValues: (array: Uint8Array): Uint8Array => {
        if (!drawn) {
          drawn = true;
          const id = firstId.slice(2);
          for (let index = 0; index < 6; index++) {
            array[index] = Number.parseInt(id[index], 36);
          }
        } else {
          for (let index = 0; index < array.length; index++) {
            array[index] = 42 + index;
          }
        }
        return array;
      },
    } as typeof globalThis.crypto;
    try {
      await expect(
        saveMemory(turn, { text: "Second memory." })
      ).rejects.toThrow(`Memory id ${firstId} already exists`);
      await saveMemory(turn, { text: "Third memory." });
    } finally {
      globalThis.crypto = original;
    }
    const live = (await monthLog(root)).trimEnd().split("\n");
    expect(live).toHaveLength(2);
    expect(live[1]).toContain("Third memory.");
  });
});
