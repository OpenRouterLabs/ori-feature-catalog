import {
  appendFile,
  mkdir,
  open,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import type { MemoryLine } from "../line/index.ts";

import { formatMemoryLine, parseMemoryLog } from "../line/index.ts";

export const MEMORY_DIRECTORY = "memory";
export const UNION_MERGE_ATTRIBUTE = "log/*.md merge=union";

const MONTH_FILE = /^\d{4}-\d{2}\.md$/u;

export interface MemoryLog {
  readonly directory: string;
  readonly read: () => Promise<readonly MemoryLine[]>;
  readonly append: (lines: readonly MemoryLine[], now: Date) => Promise<void>;
}

const errorCode = (error: unknown): unknown =>
  error instanceof Error && "code" in error ? error.code : undefined;

const monthFiles = async (logDirectory: string): Promise<readonly string[]> => {
  const names = await readdir(logDirectory).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") {
      return [];
    }
    throw error;
  });
  return names.filter((name) => MONTH_FILE.test(name)).toSorted();
};

const ensureUnionMerge = async (directory: string): Promise<void> => {
  const file = path.join(directory, ".gitattributes");
  const created = await writeFile(file, `${UNION_MERGE_ATTRIBUTE}\n`, {
    flag: "wx",
  }).then(
    () => true,
    (error: unknown) => {
      if (errorCode(error) === "EEXIST") {
        return false;
      }
      throw error;
    }
  );
  if (created) {
    return;
  }
  const current = await readFile(file, "utf8");
  if (
    !current.split("\n").some((line) => line.trim() === UNION_MERGE_ATTRIBUTE)
  ) {
    const separator = current === "" || current.endsWith("\n") ? "" : "\n";
    await appendFile(file, `${separator}${UNION_MERGE_ATTRIBUTE}\n`);
  }
};

const lastByteIsNewline = async (file: string): Promise<boolean> => {
  const handle = await open(file, "r").catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") {
      return undefined;
    }
    throw error;
  });
  if (handle === undefined) {
    return true;
  }
  try {
    const { size } = await handle.stat();
    if (size === 0) {
      return true;
    }
    const { buffer } = await handle.read(Buffer.alloc(1), 0, 1, size - 1);
    return buffer[0] === 0x0a;
  } finally {
    await handle.close();
  }
};

export const memoryLogAt = (internRoot: string): MemoryLog => {
  const directory = path.join(internRoot, MEMORY_DIRECTORY);
  const logDirectory = path.join(directory, "log");
  return {
    directory,
    read: async () => {
      const files = await monthFiles(logDirectory);
      const sources = await Promise.all(
        files.map((name) => readFile(path.join(logDirectory, name), "utf8"))
      );
      return sources.flatMap((source) => parseMemoryLog(source));
    },
    append: async (lines, now) => {
      if (lines.length === 0) {
        return;
      }
      await mkdir(logDirectory, { recursive: true });
      await ensureUnionMerge(directory);
      const file = path.join(
        logDirectory,
        `${now.toISOString().slice(0, 7)}.md`
      );
      const separator = (await lastByteIsNewline(file)) ? "" : "\n";
      await appendFile(
        file,
        `${separator}${lines.map((line) => `${formatMemoryLine(line)}\n`).join("")}`
      );
    },
  };
};
