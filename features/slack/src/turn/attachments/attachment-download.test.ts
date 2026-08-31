/* oxlint-disable typescript/no-unsafe-type-assertion typescript/explicit-function-return-type eslint/max-lines-per-function eslint/require-await eslint/no-unsafe-optional-chaining typescript/no-invalid-void-type promise/avoid-new promise/param-names unicorn/consistent-function-scoping -- test doubles assert on recorded `unknown` args and stand in for Slack SDK shapes; cases read better whole than split */
import {
  afterEach,
  describe,
  expect,
  test,
} from "#src/test-support/effect-test.ts";

import { Effect } from "effect";

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import type { DownloadableFile } from "./attachment-download.ts";

import {
  attachmentDirFor,
  discardAttachments,
  downloadAttachments,
  isAllowedFileUrl,
  safeFileName,
} from "./attachment-download.ts";

const dirs: string[] = [];
const scratch = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "ori-attach-test-"));
  dirs.push(dir);
  return dir;
};

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) =>
      rm(dir, {
        force: true,
        recursive: true,
      })
    )
  );
});

const file = (over: Partial<DownloadableFile> = {}): DownloadableFile => ({
  filetype: "png",
  id: "F1",
  label: "shot.png",
  urlPrivate: "https://files.slack.com/files-pri/T1-F1/shot.png",
  ...over,
});

const okFetch = (body: BlobPart = "content") =>
  ((): Promise<Response> =>
    Promise.resolve(
      new Response(new Blob([body]), { status: 200 })
    )) as unknown as typeof fetch;

describe("isAllowedFileUrl", () => {
  test.effect.each([
    "https://files.slack.com/files-pri/T1-F1/a.png",
    "https://files-origin.slack.com/x",
  ])("admits %s", (url) =>
    Effect.gen(function* () {
      expect(yield* isAllowedFileUrl(url)).toBe(true);
    })
  );

  test.effect.each([
    "http://169.254.169.254/latest/meta-data/",
    "https://internal.corp/secrets",
    "https://evil.test/files.slack.com",
    "https://files.slack.com.evil.test/x",
    "file:///etc/passwd",
    "not a url",
    "",
  ])("refuses %s", (url) =>
    Effect.gen(function* () {
      expect(yield* isAllowedFileUrl(url)).toBe(false);
    })
  );
});

describe("safeFileName", () => {
  test.each([
    ["../../.ssh/authorized_keys", "authorized_keys"],
    ["/etc/passwd", "passwd"],
    ["..%2f..%2fetc", ".._2f.._2fetc".replace(/^\.+/u, "")],
  ])("neutralises %p", (input, expected) => {
    expect(safeFileName(input, "F1")).toBe(expected);
  });

  test("never returns a path separator", () => {
    const name = safeFileName("a/b/c/../../d.txt", "F1");

    expect(name).not.toContain("/");
    expect(basename(name)).toBe(name);
  });

  test("falls back to the file id when nothing usable survives", () => {
    expect(safeFileName("...", "F_ID")).toBe("F_ID");
    expect(safeFileName("", "F_ID")).toBe("F_ID");
  });

  test("caps an absurdly long name", () => {
    expect(
      safeFileName(`${"x".repeat(500)}.png`, "F1").length
    ).toBeLessThanOrEqual(128);
  });

  test("keeps an ordinary name intact", () => {
    expect(safeFileName("screenshot.png", "F1")).toBe("screenshot.png");
  });
});

describe("attachmentDirFor", () => {
  test("strips anything path-shaped out of the thread ts", () => {
    const dir = attachmentDirFor("../../etc/1700.0001");

    expect(dir).not.toContain("..");
    expect(dir).not.toContain("etc");
    expect(dir).toContain("1700.0001");
  });

  test("is unique per call, not per thread", () => {
    expect(attachmentDirFor("1700.0001")).not.toBe(
      attachmentDirFor("1700.0001")
    );
  });
});

describe("discardAttachments", () => {
  test.effect("removes the directory and everything in it", () =>
    Effect.gen(function* () {
      const writeDir = yield* Effect.promise(scratch);
      const [downloaded] = yield* downloadAttachments([file()], {
        fetch: okFetch("secret"),
        token: "t",
        writeDir,
      });

      const written = yield* Effect.promise(() =>
        readFile(downloaded?.path ?? "", "utf-8")
      );

      expect(written).toBe("secret");

      yield* discardAttachments(writeDir);

      yield* Effect.promise(async () => {
        await expect(
          readFile(downloaded?.path ?? "", "utf-8")
        ).rejects.toThrow();
      });
    })
  );

  test.effect("a missing directory is not an error", () =>
    Effect.gen(function* () {
      expect(
        yield* discardAttachments(join(tmpdir(), "ori-never-existed-xyz"))
      ).toBeUndefined();
    })
  );
});

describe("downloadAttachments", () => {
  test.effect("writes an allowed file and reports its path", () =>
    Effect.gen(function* () {
      const writeDir = yield* Effect.promise(scratch);

      const [downloaded] = yield* downloadAttachments([file()], {
        fetch: okFetch("hello"),
        token: "xoxb-test",
        writeDir,
      });

      expect(downloaded?.id).toBe("F1");
      expect(downloaded?.bytes).toBe(5);
      expect(
        yield* Effect.promise(() => readFile(downloaded?.path ?? "", "utf-8"))
      ).toBe("hello");
    })
  );

  test.effect(
    "sends the bot token, or Slack serves a sign-in page instead",
    () =>
      Effect.gen(function* () {
        const writeDir = yield* Effect.promise(scratch);
        const headers: string[] = [];

        yield* downloadAttachments([file()], {
          fetch: ((_url: string, init?: RequestInit) => {
            headers.push(
              (init?.headers as Record<string, string>).authorization
            );
            return Promise.resolve(new Response("x", { status: 200 }));
          }) as unknown as typeof fetch,
          token: "xoxb-secret",
          writeDir,
        });

        expect(headers[0]).toBe("Bearer xoxb-secret");
      })
  );

  test.effect("bounds each download so a stall cannot cost the turn", () =>
    Effect.gen(function* () {
      const writeDir = yield* Effect.promise(scratch);
      let signal: AbortSignal | undefined;

      yield* downloadAttachments([file()], {
        fetch: ((_url: string, init?: RequestInit) => {
          signal = init?.signal ?? undefined;
          return Promise.resolve(new Response("x", { status: 200 }));
        }) as unknown as typeof fetch,
        token: "t",
        writeDir,
      });

      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal?.aborted).toBe(false);
    })
  );

  test.effect("a download that aborts costs that file, not the turn", () =>
    Effect.gen(function* () {
      const writeDir = yield* Effect.promise(scratch);

      const result = yield* downloadAttachments(
        [
          file({
            id: "F1",
            urlPrivate: "https://files.slack.com/x/F1.png",
          }),
          file({
            id: "F2",
            urlPrivate: "https://files.slack.com/x/F2.png",
          }),
        ],
        {
          fetch: ((url: string) =>
            url.includes("F1")
              ? Promise.reject(
                  Object.assign(new Error("timed out"), {
                    name: "TimeoutError",
                  })
                )
              : Promise.resolve(
                  new Response("ok", { status: 200 })
                )) as unknown as typeof fetch,
          token: "t",
          writeDir,
        }
      );

      expect(result.map((r) => r.id)).toEqual(["F2"]);
    })
  );

  test.effect("skips a file on a host that is not Slack", () =>
    Effect.gen(function* () {
      const writeDir = yield* Effect.promise(scratch);
      let called = false;

      const result = yield* downloadAttachments(
        [file({ urlPrivate: "http://169.254.169.254/latest/meta-data/" })],
        {
          fetch: (() => {
            called = true;
            return Promise.resolve(new Response("secrets", { status: 200 }));
          }) as unknown as typeof fetch,
          token: "t",
          writeDir,
        }
      );

      expect(result).toEqual([]);
      expect(called).toBe(false);
    })
  );

  test.effect("skips a file Slack refuses to serve", () =>
    Effect.gen(function* () {
      const writeDir = yield* Effect.promise(scratch);

      const result = yield* downloadAttachments([file()], {
        fetch: (() =>
          Promise.resolve(
            new Response("nope", { status: 403 })
          )) as unknown as typeof fetch,
        token: "t",
        writeDir,
      });

      expect(result).toEqual([]);
    })
  );

  test.effect("skips a file past the per-file ceiling", () =>
    Effect.gen(function* () {
      const writeDir = yield* Effect.promise(scratch);
      const huge = new Uint8Array(26 * 1024 * 1024);

      const result = yield* downloadAttachments([file()], {
        fetch: okFetch(huge),
        token: "t",
        writeDir,
      });

      expect(result).toEqual([]);
    })
  );

  test.effect("skips an empty file rather than writing a zero-byte path", () =>
    Effect.gen(function* () {
      const writeDir = yield* Effect.promise(scratch);

      const result = yield* downloadAttachments([file()], {
        fetch: okFetch(new Uint8Array(0)),
        token: "t",
        writeDir,
      });

      expect(result).toEqual([]);
    })
  );

  test.effect("a fetch that throws costs that file, not the turn", () =>
    Effect.gen(function* () {
      const writeDir = yield* Effect.promise(scratch);

      const result = yield* downloadAttachments(
        [
          file({
            id: "F1",
            urlPrivate: "https://files.slack.com/x/F1.png",
          }),
          file({
            id: "F2",
            urlPrivate: "https://files.slack.com/x/F2.png",
          }),
        ],
        {
          fetch: ((url: string) =>
            url.includes("F1")
              ? Promise.reject(new Error("connection reset"))
              : Promise.resolve(
                  new Response("ok", { status: 200 })
                )) as unknown as typeof fetch,
          token: "t",
          writeDir,
        }
      );

      expect(result.map((r) => r.id)).toEqual(["F2"]);
    })
  );

  test.effect("writes nothing at all when there are no attachments", () =>
    Effect.gen(function* () {
      const writeDir = join(yield* Effect.promise(scratch), "never-created");

      expect(
        yield* downloadAttachments([], {
          fetch: okFetch(),
          token: "t",
          writeDir,
        })
      ).toEqual([]);
    })
  );

  test.effect("a traversing filename lands inside the download directory", () =>
    Effect.gen(function* () {
      const writeDir = yield* Effect.promise(scratch);

      const [downloaded] = yield* downloadAttachments(
        [file({ label: "../../escaped.png" })],
        {
          fetch: okFetch("x"),
          token: "t",
          writeDir,
        }
      );

      expect(downloaded?.path.startsWith(writeDir)).toBe(true);
      expect(downloaded?.path).not.toContain("..");
    })
  );
});
