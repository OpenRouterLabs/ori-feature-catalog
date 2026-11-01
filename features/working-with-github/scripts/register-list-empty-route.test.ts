import { describe, expect, test } from "bun:test";
// The empty-registry `list` note is the routing answer an operator reads
// when nothing is registered. Pre-fix it said "the bare default GH_APP_* is
// used everywhere" — the mint-per-call contract #331 retired: with nothing
// registered the GITHUB_REPO org runs on the host-rotated GH_TOKEN and never
// mints from GH_APP_* at all; only another org mints the default App. #337
// retired the same claim from the prompt and skills (`→ the bare GH_APP_*
// default`) but missed this CLI line and the register-gh-app skill's
// description of it.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { openGhAppRegistryDb } from "../gh-app-registry.ts";
import { runRegisterCli } from "./register-gh-app.ts";

const listEmpty = (): string => {
  const db = openGhAppRegistryDb(":memory:");
  const out: string[] = [];
  try {
    runRegisterCli({
      argv: ["list"],
      db,
      env: {},
      writers: {
        err: () => {},
        out: (text) => {
          out.push(text);
        },
      },
    });
  } finally {
    db.close();
  }
  return out.join("");
};

const RETIRED = /bare default `?GH_APP_\*`? is used everywhere/u;

describe("the empty-registry list note names the route nothing-registered really takes", () => {
  test("the CLI note names the host-rotated GH_TOKEN, not a GH_APP_* default everywhere", () => {
    const note = listEmpty();
    expect(note).toContain("no registered apps");
    expect(note).not.toMatch(RETIRED);
    expect(note).toContain("GH_TOKEN");
  });

  test("the register-gh-app skill describes the same note", () => {
    const skill = readFileSync(
      join(import.meta.dir, "..", "skills", "register-gh-app", "SKILL.md"),
      "utf8"
    );
    expect(skill).not.toMatch(RETIRED);
  });
});
