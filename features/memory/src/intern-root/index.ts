import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

export const INTERN_ROOT_ENV = "ORI_INTERN_WORKSPACE_ROOT";

export type TurnEnv = Readonly<Record<string, string | undefined>>;

const runFile = promisify(execFile);

const isLinkedWorktree = async (directory: string): Promise<boolean> =>
  readFile(path.join(directory, ".git"), "utf8")
    .then((content) => content.trim().startsWith("gitdir:"))
    .catch(() => false);

const mainCheckout = async (
  directory: string
): Promise<string | undefined> => {
  const result = await runFile(
    "git",
    ["worktree", "list", "--porcelain"],
    { cwd: directory }
  ).catch(() => undefined);
  const lines = result?.stdout.split("\n") ?? [];
  const main = lines.find((line) => line.startsWith("worktree "))?.slice(9);
  if (main === undefined || main === directory) {
    return undefined;
  }
  const common = await runFile(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd: directory }
  )
    .then((output) => output.stdout.trim())
    .catch(() => undefined);
  if (common !== undefined && main === common) {
    return undefined;
  }
  return (await isLinkedWorktree(directory)) ? main : undefined;
};

export const resolveInternRoot = async (input: {
  readonly hint: string;
  readonly env: TurnEnv;
}): Promise<string> => {
  const exported = input.env[INTERN_ROOT_ENV]?.trim() ?? "";
  if (exported !== "") {
    return exported;
  }
  return (await mainCheckout(input.hint)) ?? input.hint;
};
