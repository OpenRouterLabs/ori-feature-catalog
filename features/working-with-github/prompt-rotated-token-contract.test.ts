import { describe, expect, test } from "bun:test";
// The default App's token is the host-rotated GH_TOKEN (resolveGitHubToken):
// nothing mints it per command, and commit-via-api / cleanup-worktrees read
// it rather than minting. The prompt and skills are the interface agents act
// on, so they must not still teach the retired mint-per-call contract the
// Access-mode-2 section forbids ("Never mint a token per command").
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path: string) => readFileSync(join(import.meta.dir, path), "utf8");

const SURFACES = {
  "prompt.md": read("prompt.md"),
  "skills/cleanup-worktrees/SKILL.md": read("skills/cleanup-worktrees/SKILL.md"),
  "skills/register-gh-app/SKILL.md": read("skills/register-gh-app/SKILL.md"),
};

const RETIRED = [
  /mint a short-lived installation token and inject it yourself for every/u,
  /mints a fresh installation token itself/u,
  /mints its own token internally/u,
  /with a minted token/u,
  /mint a token once for this whole flow/u,
  /→ the bare `GH_APP_\*` default/u,
];

describe("the prompt and skills teach the host-rotated GH_TOKEN contract", () => {
  for (const [name, text] of Object.entries(SURFACES)) {
    test(`${name} carries no retired mint-per-call instruction`, () => {
      expect(RETIRED.filter((pattern) => pattern.test(text)).map(String)).toEqual([]);
    });
  }

  test("the App-mode overview agrees with Access mode 2: never mint per command", () => {
    const overview = SURFACES["prompt.md"].split("\n").find((line) =>
      line.startsWith("- **App mode**")
    );
    expect(overview).toContain("GH_TOKEN");
    expect(overview).not.toMatch(/you mint/iu);
  });
});
