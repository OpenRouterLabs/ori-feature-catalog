import { describe, expect, test } from "bun:test";
// The default App's token is the host-rotated GH_TOKEN (resolveGitHubToken):
// nothing mints it per command, and commit-via-api / cleanup-worktrees read
// it rather than minting. The prompt and skills are the interface agents act
// on, so they must not still teach the retired mint-per-call contract the
// Access-mode-2 section forbids ("Never mint a token per command").
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const read = (path: string) => readFileSync(join(import.meta.dir, path), "utf8");

const SURFACES = {
  "prompt.md": read("prompt.md"),
  "skills/cleanup-worktrees/SKILL.md": read("skills/cleanup-worktrees/SKILL.md"),
  "skills/register-gh-app/SKILL.md": read("skills/register-gh-app/SKILL.md"),
  "skills/open-pr/SKILL.md": read("skills/open-pr/SKILL.md"),
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

// `GH_TOKEN=$(bun mint-token.ts) gh …` runs gh even when the mint fails: a
// failed command substitution in a prefix assignment never stops the command
// it prefixes. gh then ran with an empty GH_TOKEN and answered "To get started
// with GitHub CLI, please run: gh auth login", the one step these rules
// forbid (reproduced with gh 2.103.3, a GH_APP_ID and no GH_TOKEN). The same
// held for the skills' `${WWG:?…}` guard: it printed its pointer and gh ran.
describe("a failed mint stops the command it was minted for", () => {
  const header = read("scripts/mint-token.ts")
    .split("\n")
    .map((line) => line.replace(/^ \*   ?/u, ""))
    .join("\n");
  const surfaces: Record<string, string> = { ...SURFACES, "scripts/mint-token.ts": header };
  const mintedCommands = (text: string): string[] => {
    const joined = text.replace(/\\\n/gu, " ");
    return joined
      .split("\n")
      .filter((line) => /\$\(bun [^)]*mint-token\.ts[^)]*\)/u.test(line) && /\bgh /u.test(line));
  };

  test("every surface's minted gh one-liner is found", () => {
    const counts = Object.fromEntries(
      Object.entries(surfaces).map(([name, text]) => [name, mintedCommands(text).length])
    );
    expect(counts).toEqual({
      "prompt.md": 2,
      "scripts/mint-token.ts": 1,
      "skills/cleanup-worktrees/SKILL.md": 0,
      "skills/open-pr/SKILL.md": 0,
      "skills/register-gh-app/SKILL.md": 1,
    });
  });

  for (const [name, text] of Object.entries(surfaces)) {
    for (const command of mintedCommands(text)) {
      test(`${name}: gh never runs after a failed mint — ${command.trim().slice(0, 60)}`, () => {
        const dir = mkdtempSync(join(tmpdir(), "mint-oneliner-"));
        const ran = join(dir, "gh-ran");
        writeFileSync(join(dir, "bun"), "#!/bin/sh\necho 'mint-token: refused' >&2\nexit 1\n", { mode: 0o755 });
        writeFileSync(join(dir, "gh"), `#!/bin/sh\ntouch '${ran}'\n`, { mode: 0o755 });
        for (const wwg of [dir, undefined]) {
          const child = Bun.spawnSync(["bash", "-c", command], {
            env: { PATH: `${dir}:/usr/bin:/bin`, REPO: "acme/widgets", ...(wwg === undefined ? {} : { WWG: wwg }) },
            stderr: "pipe",
            stdout: "pipe",
          });
          expect(child.exitCode).not.toBe(0);
          expect(existsSync(ran)).toBe(false);
        }
        rmSync(dir, { force: true, recursive: true });
      });
    }
  }
});
