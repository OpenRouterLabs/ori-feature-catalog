import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import { commitViaApi } from "./commit-flow.ts";

// `git add` stages a file through the repo's clean pipeline — the
// `.gitattributes` `text`/`eol` normalization, `core.autocrlf`, and any
// `filter=` driver (Git LFS's pointer swap is one). The flow is supposed to
// produce the commit `git add` + `git commit` would, but pre-fix it uploaded
// the RAW disk bytes:
//
//   *.bat text eol=crlf   checkout writes CRLF, the repo stores LF
//     git add run.bat     → "@echo off\necho one\necho two\n"
//     commit-via-api      → "@echo off\r\necho one\r\necho two\r\n"
//                           (every line of the file rewritten in the commit)
//   * text=auto           a CRLF-pasted new file: git add stores LF, the flow CRLF
//   filter=<driver>       git add stores the clean output, the flow the raw file
//
// Each test asserts the flow's blob bytes equal what `git add` stages.

/** Run the flow against a real repo with a fake GitHub, returning the uploaded
 *  blob bytes in upload order. */
const uploadedBlobs = async (dir: string): Promise<string[]> => {
  const blobs: string[] = [];
  const fetchImpl = (url: string, init?: RequestInit): Promise<Response> => {
    if (url.includes("/git/ref/heads/")) {
      return Promise.resolve(Response.json({ object: { sha: "h" } }));
    }
    if (url.includes("/git/commits/h")) {
      return Promise.resolve(Response.json({ tree: { sha: "bt" } }));
    }
    if (url.endsWith("/git/blobs")) {
      const body = JSON.parse(String(init?.body)) as {
        content: string;
        encoding: string;
      };
      blobs.push(
        Buffer.from(
          body.content,
          body.encoding === "base64" ? "base64" : "utf-8"
        ).toString("latin1")
      );
      return Promise.resolve(Response.json({ sha: `b${blobs.length}` }));
    }
    if (url.endsWith("/git/trees")) {
      return Promise.resolve(Response.json({ sha: "nt" }));
    }
    if (url.endsWith("/git/commits")) {
      return Promise.resolve(Response.json({ sha: "nc" }));
    }
    return Promise.resolve(Response.json({ object: { sha: "nc" } }));
  };
  await Effect.runPromise(
    commitViaApi(
      { branch: "b", message: "m", repo: "owner/repo", worktree: dir },
      { fetchImpl, token: "t", warn: () => undefined }
    )
  );
  return blobs;
};

/** What `git add` would stage for `path` — the oracle. */
const stagedBytes = (dir: string, path: string): string => {
  const sha = execFileSync("git", ["hash-object", "-w", "--", path], {
    cwd: dir,
    encoding: "utf-8",
  }).trim();
  return execFileSync("git", ["cat-file", "blob", sha], { cwd: dir }).toString(
    "latin1"
  );
};

const initRepo = (dir: string): void => {
  execFileSync("git", ["init", "-q", "."], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: dir });
};

describe("commitViaApi — blobs carry the bytes `git add` stages", () => {
  test("an eol=crlf file edited in the worktree commits LF, like `git add`", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wwg-eol-"));
    try {
      initRepo(dir);
      await writeFile(join(dir, ".gitattributes"), "*.bat text eol=crlf\n");
      await writeFile(join(dir, "run.bat"), "@echo off\r\necho one\r\n");
      execFileSync("git", ["add", "-A"], { cwd: dir });
      execFileSync("git", ["commit", "-q", "-m", "root"], { cwd: dir });
      await writeFile(join(dir, "run.bat"), "@echo off\r\necho one\r\necho two\r\n");

      const blobs = await uploadedBlobs(dir);

      expect(stagedBytes(dir, "run.bat")).toBe("@echo off\necho one\necho two\n");
      expect(blobs).toEqual([stagedBytes(dir, "run.bat")]);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  test("a CRLF file added under `* text=auto` commits LF, like `git add`", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wwg-eol-auto-"));
    try {
      initRepo(dir);
      await writeFile(join(dir, ".gitattributes"), "* text=auto\n");
      execFileSync("git", ["add", "-A"], { cwd: dir });
      execFileSync("git", ["commit", "-q", "-m", "root"], { cwd: dir });
      await writeFile(join(dir, "notes.md"), "line a\r\nline b\r\n");

      const blobs = await uploadedBlobs(dir);

      expect(blobs).toEqual(["line a\nline b\n"]);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  test("a filter= clean driver runs, like `git add` (the Git LFS shape)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wwg-filter-"));
    try {
      initRepo(dir);
      execFileSync("git", ["config", "filter.upper.clean", "tr a-z A-Z"], {
        cwd: dir,
      });
      execFileSync("git", ["config", "filter.upper.smudge", "cat"], {
        cwd: dir,
      });
      await writeFile(join(dir, ".gitattributes"), "*.up filter=upper\n");
      execFileSync("git", ["add", "-A"], { cwd: dir });
      execFileSync("git", ["commit", "-q", "-m", "root"], { cwd: dir });
      await writeFile(join(dir, "a.up"), "shout\n");

      const blobs = await uploadedBlobs(dir);

      expect(blobs).toEqual(["SHOUT\n"]);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  test("binary bytes with no attributes upload unchanged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wwg-binary-"));
    try {
      initRepo(dir);
      execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "root"], {
        cwd: dir,
      });
      const bytes = Buffer.from([0, 255, 13, 10, 128, 1, 13]);
      await writeFile(join(dir, "blob.bin"), bytes);

      const blobs = await uploadedBlobs(dir);

      expect(blobs).toEqual([bytes.toString("latin1")]);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});
