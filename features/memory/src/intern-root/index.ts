import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

export const INTERN_ROOT_ENV = "ORI_INTERN_WORKSPACE_ROOT";

export type TurnEnv = Readonly<Record<string, string | undefined>>;

const runFile = promisify(execFile);

const linkedWorktreeMainRoot = async (
  directory: string
): Promise<string | undefined> => {
  const result = await runFile(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"],
    { cwd: directory }
  ).catch(() => undefined);
  const [gitDir, commonDir] = result?.stdout.trim().split("\n") ?? [];
  return gitDir === undefined || commonDir === undefined || gitDir === commonDir
    ? undefined
    : path.dirname(commonDir);
};

export const resolveInternRoot = async (input: {
  readonly hint: string;
  readonly env: TurnEnv;
}): Promise<string> => {
  const exported = input.env[INTERN_ROOT_ENV]?.trim() ?? "";
  if (exported !== "") {
    return exported;
  }
  return (await linkedWorktreeMainRoot(input.hint)) ?? input.hint;
};
