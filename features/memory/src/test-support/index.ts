import type { StateStore } from "ori";

import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const withTempDir = async <A>(
  run: (directory: string) => Promise<A>
): Promise<A> => {
  const directory = await realpath(
    await mkdtemp(path.join(tmpdir(), "ori-memory-"))
  );
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

export const inMemoryStateStore = (): StateStore => {
  const values = new Map<string, string>();
  return {
    name: "memory-test",
    get: async (key) => values.get(key),
    set: async (key, value) => {
      values.set(key, value);
    },
    exec: async () => {},
    query: async () => [],
  };
};

export const git = (cwd: string, ...args: readonly string[]): string => {
  const result = Bun.spawnSync(
    [
      "git",
      "-c",
      "user.name=Memory Test",
      "-c",
      "user.email=memory@example.com",
      ...args,
    ],
    { cwd, stdout: "pipe", stderr: "pipe" }
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr.toString()}`
    );
  }
  return result.stdout.toString().trim();
};
