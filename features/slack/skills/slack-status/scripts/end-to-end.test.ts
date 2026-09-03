/* oxlint-disable typescript/no-unsafe-type-assertion eslint/max-lines-per-function -- the recorded bodies are read as the form data they are, and each case reads better whole */

import { afterAll, describe, expect, test } from "#src/test-support/index.ts";
import { Schema } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENTRY = join(import.meta.dir, "index.ts");

const CallSchema = Schema.Struct({
  body: Schema.Record(Schema.String, Schema.mutableKey(Schema.String)),
  method: Schema.String,
});

type Call = typeof CallSchema.Type;

const homes: string[] = [];

afterAll(async () => {
  await Promise.all(
    homes.splice(0).map((dir) =>
      rm(dir, {
        force: true,
        recursive: true,
      })
    )
  );
});

const withSlack = async (
  body: (input: {
    readonly calls: Call[];
    readonly run: (
      args: readonly string[],
      env?: Record<string, string>
    ) => Promise<{ code: number; stderr: string; stdout: string }>;
  }) => Promise<void>
): Promise<void> => {
  const calls: Call[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      calls.push({
        body: Object.fromEntries(new URLSearchParams(await request.text())),
        method: new URL(request.url).pathname.replace("/", ""),
      });
      return Response.json({
        ok: true,
        ts: "1.3",
      });
    },
  });
  const home = await mkdtemp(join(tmpdir(), "slack-status-e2e-"));
  homes.push(home);

  try {
    await body({
      calls,
      run: async (args, env = {}) => {
        const proc = Bun.spawn([process.execPath, ENTRY, ...args], {
          env: {
            PATH: Bun.env.PATH ?? "",
            SLACK_API_URL: `http://127.0.0.1:${server.port}/`,
            SLACK_BOT_TOKEN: "xoxb-test",
            SLACK_CHANNEL_ID: "C1",
            SLACK_THREAD_TS: "1.2",
            TMPDIR: home,
            ...env,
          },
          stderr: "pipe",
          stdout: "pipe",
        });
        const [stdout, stderr, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        return {
          code,
          stderr,
          stdout,
        };
      },
    });
  } finally {
    server.stop(true);
  }
};

describe("the line the model is told to keep current", () => {
  test("a bare update sets the indicator and posts nothing", async () => {
    await withSlack(async ({ calls, run }) => {
      const result = await run(["reading run-events.ts"]);

      expect(result.code).toBe(0);
      expect(calls.map((call) => call.method)).toEqual([
        "assistant.threads.setStatus",
      ]);
      expect(calls[0]?.body.status).toBe("reading run-events.ts");
    });
  });

  test("--notify posts the message first, then sets the line", async () => {
    await withSlack(async ({ calls, run }) => {
      await run(["--notify", "It is not the code"]);

      expect(calls.map((call) => call.method)).toEqual([
        "chat.postMessage",
        "assistant.threads.setStatus",
      ]);
    });
  });

  test("--notify is a flag only when it leads, never a word in the sentence", async () => {
    await withSlack(async ({ calls, run }) => {
      await run(["explaining", "why", "--notify", "exists"]);

      expect(calls.map((call) => call.method)).toEqual([
        "assistant.threads.setStatus",
      ]);
      expect(calls[0]?.body.status).toContain("--notify");
    });
  });

  test("a multi-word update arrives whole", async () => {
    await withSlack(async ({ calls, run }) => {
      await run(["re-running", "the", "suite", "rather", "than", "patching"]);

      expect(calls[0]?.body.status).toBe(
        "re-running the suite rather than patching"
      );
    });
  });
});

describe("what it will not send", () => {
  test("over the cap is rejected before anything reaches Slack", async () => {
    await withSlack(async ({ calls, run }) => {
      const result = await run(["--notify", "x".repeat(301)]);

      expect(result.code).toBe(1);
      expect(calls).toBeEmpty();
      expect(result.stderr).toContain("max 300");
    });
  });

  test("no thread in scope is named, not guessed at", async () => {
    await withSlack(async ({ calls, run }) => {
      const result = await run(["working"], { SLACK_THREAD_TS: "" });

      expect(result.code).toBe(1);
      expect(calls).toBeEmpty();
      expect(result.stderr).toContain("SLACK_THREAD_TS");
    });
  });
});

describe("what Slack is actually handed", () => {
  test("markdown becomes mrkdwn, because the prompt teaches markdown", async () => {
    await withSlack(async ({ calls, run }) => {
      await run([
        "--notify",
        "**nine** of them, see [the PR](https://example.com/p/1)",
      ]);

      const text = calls[0]?.body.text ?? "";
      expect(text).not.toContain("**nine**");
      expect(text).toContain("<https://example.com/p/1|the PR>");
    });
  });

  test("a broadcast in model-authored text is defused", async () => {
    await withSlack(async ({ calls, run }) => {
      await run(["--notify", "ping <!channel> about the timeout"]);

      expect(calls[0]?.body.text).not.toContain("<!channel>");
      expect(calls[0]?.body.text).toContain("&lt;!channel&gt;");
    });
  });

  test("links do not drag preview cards into the thread", async () => {
    await withSlack(async ({ calls, run }) => {
      await run(["--notify", "see https://example.com/p/1"]);

      expect(calls[0]?.body.unfurl_links).toBe("false");
      expect(calls[0]?.body.unfurl_media).toBe("false");
    });
  });
});