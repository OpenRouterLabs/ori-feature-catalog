// Regression (companion to repo-string-upperscheme.test.ts): an upper-case
// SCHEME on a bare-host spelling — `HTTPS://github.com` (also `HTTP://`,
// `FTP://`, `SSH://github.com`, and a mixed-case host under it) — is the
// same URL as its lowercase form (RFC 3986 §3.1: schemes are
// case-insensitive), and the code resolvers answer "" for all of them. The
// prompt's `REPO=` recipe disagrees: its final bare-host rule lists the
// scheme words case-SENSITIVELY (`(https?|ssh|git\+ssh)://`), so an
// upper-case scheme kept its case, fell every branch, and the raw URL
// interpolated as `$REPO` — `gh --repo HTTPS://github.com`,
// `repos/HTTPS://github.com` (404), and a fetch URL that never resolves —
// the same silent-dead-value class the recipe's host-case corpus
// (prompt-recipes.test.ts) closed for the mixed-case HOST, reopened through
// the scheme word. The recipe must agree with the resolvers: one spelling
// contract, one answer.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "bun:test";

import { orgOf } from "@ori-monorepo/working-with-github/gh-app-registry.ts";
import { resolveRepoFromEnv } from "@ori-monorepo/working-with-github/commit-api-core.ts";

const promptPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "prompt.md"
);
const prompt = readFileSync(promptPath, "utf-8");

const fences: readonly string[] = [
  ...prompt.matchAll(/```bash[^\n]*\n([\s\S]*?)```/g),
].map((match) => match[1] ?? "");

const isNormalizerLine = (line: string): boolean =>
  /^\s*REPO=\$\(printf '%s' "\$GITHUB_REPO" \| sed -E /.test(line);

const UPPER_SCHEME_BARE_HOSTS: readonly string[] = [
  "HTTPS://github.com",
  "HTTP://github.com",
  "FTP://github.com",
  "SSH://github.com",
  "HTTPS://GitHub.com",
  "HTTPS://GITHUB.COM",
];

describe("the REPO= recipe empties an upper-case scheme on a bare host like the resolvers", () => {
  test("the code resolvers answer no owner for every spelling", () => {
    for (const raw of UPPER_SCHEME_BARE_HOSTS) {
      expect(orgOf(raw)).toBe("");
      expect(resolveRepoFromEnv({ GITHUB_REPO: raw })).toBe("");
    }
  });

  test("the recipe agrees with the resolvers on every spelling", () => {
    const line = fences
      .join("\n")
      .split("\n")
      .map((candidate) => candidate.trim())
      .find(isNormalizerLine);
    expect(line).toBeDefined();
    if (line === undefined) {
      return;
    }
    for (const raw of UPPER_SCHEME_BARE_HOSTS) {
      const output = execFileSync(
        "bash",
        ["-c", `${line}\nprintf '%s' "$REPO"`],
        {
          encoding: "utf-8",
          env: { ...process.env, GITHUB_REPO: raw },
        }
      );
      expect(output).toBe("");
    }
  });

  test("a port on an upper-case-scheme bare host empties like its portless form", () => {
    const line = fences
      .join("\n")
      .split("\n")
      .map((candidate) => candidate.trim())
      .find(isNormalizerLine);
    expect(line).toBeDefined();
    if (line === undefined) {
      return;
    }
    for (const raw of ["HTTPS://github.com:443", "SSH://github.com:22"]) {
      expect(orgOf(raw)).toBe("");
      const output = execFileSync(
        "bash",
        ["-c", `${line}\nprintf '%s' "$REPO"`],
        {
          encoding: "utf-8",
          env: { ...process.env, GITHUB_REPO: raw },
        }
      );
      expect(output).toBe("");
    }
  });

  test("an upper-case scheme with an owner/repo keeps resolving the owner/repo", () => {
    const line = fences
      .join("\n")
      .split("\n")
      .map((candidate) => candidate.trim())
      .find(isNormalizerLine);
    expect(line).toBeDefined();
    if (line === undefined) {
      return;
    }
    const raw = "HTTPS://github.com/acme/widgets";
    expect(orgOf(raw)).toBe("acme");
    expect(resolveRepoFromEnv({ GITHUB_REPO: raw })).toBe("acme/widgets");
    const output = execFileSync(
      "bash",
      ["-c", `${line}\nprintf '%s' "$REPO"`],
      {
        encoding: "utf-8",
        env: { ...process.env, GITHUB_REPO: raw },
      }
    );
    expect(output).toBe("acme/widgets");
  });
});