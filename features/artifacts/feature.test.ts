import { describe, expect, it } from "bun:test";

/**
 * The prompt and skill text are data: they assert without importing
 * `feature.ts`, whose `ori` imports resolve only with the SDK present
 * (a checkout with `.ori/sdk`, or a loaded intern). The command behavior is
 * asserted in `src/command/command.test.ts` against the same layer
 * `feature.ts` wires into command contributions.
 */

import { readFileSync } from "node:fs";

const skill = readFileSync(
  new URL("./skills/artifacts/SKILL.md", import.meta.url),
  "utf8"
);

describe("artifacts skill", () => {
  it("drives the feature's own commands, not the ori CLI", () => {
    expect(skill).toContain("`artifact save`");
    expect(skill).toContain("`artifact list`");
    expect(skill).toContain("`artifact delete <name>`");
    expect(skill).not.toContain("`ori artifact");
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

  it("keeps the page rules", () => {
    expect(skill).toContain("**At most 16 MiB**");
    expect(skill).toContain("No frames and no live data");
    expect(skill).toContain("Light and dark themes");
  });
});
