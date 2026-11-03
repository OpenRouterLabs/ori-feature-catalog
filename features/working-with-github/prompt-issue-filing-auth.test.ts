import { describe, expect, test } from "bun:test";

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The ambient-mode filing guidance claimed "anonymous filing works on public
// repos when the host attaches no write credential". GitHub never accepts an
// unauthenticated issue create: reproduced 2026-11-03 with a bare curl on the
// anonymous 60/h bucket (x-ratelimit-limit: 60), `POST
// /repos/octocat/Hello-World/issues` answered 401 `Requires authentication`
// on a public repo. Filing only ever worked where a host proxy attached a
// write credential, so an agent told otherwise reads the 401 as a fluke of
// the target repo instead of the missing credential it is.

const prompt = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "prompt.md"),
  "utf-8"
);

const filingSection = (): string => {
  const start = prompt.indexOf("## Filing issues");
  const end = prompt.indexOf("\n## ", start + 1);
  return prompt.slice(start, end === -1 ? undefined : end).replaceAll(/\s+/gu, " ");
};

describe("the issue-filing guidance matches what GitHub accepts", () => {
  test("it never claims an unauthenticated POST can file an issue", () => {
    expect(filingSection()).not.toContain("anonymous filing works");
  });

  test("it says filing needs a credential and names the 401 GitHub answers without one", () => {
    const section = filingSection();
    expect(section).toContain("Filing always needs a credential");
    expect(section).toContain("401 `Requires authentication`");
    expect(section).toContain("even on a public repo");
  });

  test("it still says to verify with one POST and report the blockage", () => {
    const section = filingSection();
    expect(section).toContain("Verify with one POST");
    expect(section).toContain("report the blockage");
  });
});
