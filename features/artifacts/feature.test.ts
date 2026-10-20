import { describe, expect, it } from "bun:test";

/**
 * The prompt, command names and skill text are data: they assert without
 * importing `feature.ts`, whose `ori` imports resolve only with the SDK present
 * (a checkout with `.ori/sdk`, or a loaded intern). The command behavior is
 * asserted in `src/command/command.test.ts` against the same layer
 * `feature.ts` wires into command contributions.
 */

import { readFileSync } from "node:fs";

import {
  ARTIFACT_COMMAND_NAMES,
  qualifiedArtifactCommand,
} from "./src/command/names.ts";
import { ARTIFACTS_PROMPT } from "./src/prompt.ts";

const skill = readFileSync(
  new URL("./skills/artifacts/SKILL.md", import.meta.url),
  "utf8"
);

describe("artifacts skill", () => {
  it("drives the feature's own commands by the names ori registers, not the ori CLI", () => {
    for (const name of Object.values(ARTIFACT_COMMAND_NAMES)) {
      expect(skill).toContain(`\`${qualifiedArtifactCommand(name)}`);
      expect(skill).toContain(`\`command-${qualifiedArtifactCommand(name)}\``);
    }
    expect(skill).toContain("/artifacts-o-save /tmp/");
    expect(skill).toContain("`artifacts-o-delete <name>`");
    expect(skill).not.toContain("`ori artifact");
    expect(skill).not.toContain("`artifact save");
    expect(skill).not.toMatch(/^artifact save/mu);
  });

  it("keeps the CDN allowlist the inlining pipeline enforces", () => {
    for (const host of [
      "cdnjs.cloudflare.com",
      "cdn.jsdelivr.net",
      "unpkg.com",
      "fonts.googleapis.com",
      "fonts.gstatic.com",
    ]) {
      expect(skill).toContain(host);
    }
  });

  it("names every command and its tool in the prompt fragment", () => {
    const text =
      typeof ARTIFACTS_PROMPT === "string"
        ? ARTIFACTS_PROMPT
        : ARTIFACTS_PROMPT.text;
    for (const name of Object.values(ARTIFACT_COMMAND_NAMES)) {
      expect(text).toContain(qualifiedArtifactCommand(name));
      expect(text).toContain(`command-${qualifiedArtifactCommand(name)}`);
    }
    expect(text).not.toContain("artifact save");
  });

  it("keeps the page rules", () => {
    expect(skill).toContain("**At most 16 MiB**");
    expect(skill).toContain("No frames and no live data");
    expect(skill).toContain("Light and dark themes");
  });
});
