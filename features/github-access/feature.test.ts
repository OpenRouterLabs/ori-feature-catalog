import { describe, expect, it } from "bun:test";

import { GITHUB_ACCESS_PROMPT, prompt } from "./feature.ts";

describe("github-access prompt contribution", () => {
  it("is a single provider that returns the standing rule", () => {
    expect(typeof prompt).toBe("function");
    const provider = prompt;
    if (typeof provider !== "function") {
      throw new Error("expected one provider, not a list");
    }
    expect(provider({ prompt: "", state: {} as never })).toEqual(
      GITHUB_ACCESS_PROMPT
    );
  });

  it("reaches GitHub through the egress proxy and never asks for a credential", () => {
    const text =
      typeof GITHUB_ACCESS_PROMPT === "string"
        ? GITHUB_ACCESS_PROMPT
        : GITHUB_ACCESS_PROMPT.text;
    expect(text).toContain("egress proxy");
    expect(text).toContain(
      "attaches this workspace's GitHub credential to api.github.com and codeload.github.com requests automatically"
    );
    expect(text).toContain(
      "missing local tooling (gh, tokens, SSH keys) says nothing about your access"
    );
  });

  it("states the union discovery rule, not the installation list alone", () => {
    const text =
      typeof GITHUB_ACCESS_PROMPT === "string"
        ? GITHUB_ACCESS_PROMPT
        : GITHUB_ACCESS_PROMPT.text;
    expect(text).toContain("never trust one endpoint alone");
    expect(text).toContain(
      "/installation/repositories only lists repos the GitHub App installation selected directly"
    );
    expect(text).toContain("/orgs/{org}/repos?type=all&per_page=100");
    expect(text).toContain("de-duplicate by full_name");
    expect(text).toContain(
      "a 404 from a listing only means the listing is incomplete"
    );
  });

  it("names the member-acting header and its 401 meaning", () => {
    const text =
      typeof GITHUB_ACCESS_PROMPT === "string"
        ? GITHUB_ACCESS_PROMPT
        : GITHUB_ACCESS_PROMPT.text;
    expect(text).toContain("x-openrouter-github-as: member");
    expect(text).toContain("works only for the person asking");
    expect(text).toContain("could not be made under their name");
  });
});