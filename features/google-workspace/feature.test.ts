import { describe, expect, it } from "bun:test";

import { GOOGLE_WORKSPACE_PROMPT, prompt } from "./feature.ts";

describe("google-workspace prompt contribution", () => {
  it("is a single provider that returns the standing rule", () => {
    expect(typeof prompt).toBe("function");
    const provider = prompt;
    if (typeof provider !== "function") {
      throw new Error("expected one provider, not a list");
    }
    expect(provider({ prompt: "", state: {} as never })).toEqual(
      GOOGLE_WORKSPACE_PROMPT
    );
  });

  it("names every skill and forbids asking for or sending a credential", () => {
    const text =
      typeof GOOGLE_WORKSPACE_PROMPT === "string"
        ? GOOGLE_WORKSPACE_PROMPT
        : GOOGLE_WORKSPACE_PROMPT.text;
    for (const skill of [
      "gmail",
      "google-calendar",
      "google-drive",
      "google-docs",
      "google-sheets",
    ]) {
      expect(text).toContain(skill);
    }
    expect(text).toContain("Never ask anyone for Google credentials");
    expect(text).toContain("never set an Authorization header");
    expect(text).toContain("401 or 403");
  });
});
