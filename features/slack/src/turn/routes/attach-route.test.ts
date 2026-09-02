import { Effect } from "effect";

import { describe, expect, test } from "#src/test-support/effect-test.ts";

import type { MessageReplyShape } from "#src/message-reply/reply.ts";

import { makeAttachRoute } from "./attach-route.ts";

interface Attached {
  readonly comment: string | undefined;
  readonly filename: string;
  readonly title: string | undefined;
}

const harness = (
  options: {
    readonly readFails?: boolean;
    readonly uploadFails?: boolean;
  } = {}
) => {
  const attached: Attached[] = [];
  const route = makeAttachRoute({
    readFile: (path) =>
      options.readFails === true
        ? Promise.reject(new Error(`no such file ${path}`))
        : Promise.resolve(new Blob(["stage,status\ndedup,ok\n"])),
    replyFor: () =>
      Promise.resolve({
        attach: (file: { filename: string; title?: string }, comment?: string) => {
          attached.push({
            comment,
            filename: file.filename,
            title: file.title,
          });
          return options.uploadFails === true
            ? Effect.fail(new Error("slack said no") as never)
            : Effect.succeed({
                fileId: "F1",
                permalink: "https://slack.example/F1",
              });
        },
      } as unknown as MessageReplyShape),
    workspaceTeamId: "T1",
  });
  return { attached, route };
};

const post = (body: unknown): Request =>
  new Request("http://127.0.0.1/slack/thread/attach", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

const VALID = {
  channel: "C1",
  path: "/tmp/answer.csv",
  thread_ts: "1700.1",
};

describe("attaching a file to a thread", () => {
  test("uploads it and hands back the permalink", async () => {
    const { attached, route } = harness();

    const response = await route(post(VALID));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      permalink: "https://slack.example/F1",
    });
    expect(attached[0]?.filename).toBe("answer.csv");
  });

  test("the filename comes off the path, not the whole path", async () => {
    const { attached, route } = harness();

    await route(post({ ...VALID, path: "/var/log/nested/deploy.log" }));

    expect(attached[0]?.filename).toBe("deploy.log");
  });

  test("title and comment ride along when given", async () => {
    const { attached, route } = harness();

    await route(
      post({ ...VALID, comment: "the failing run", title: "deploy.log" })
    );

    expect(attached[0]?.title).toBe("deploy.log");
    expect(attached[0]?.comment).toBe("the failing run");
  });

  test("a blank title is absent rather than empty", async () => {
    const { attached, route } = harness();

    await route(post({ ...VALID, title: "   " }));

    expect(attached[0]?.title).toBeUndefined();
  });

  test("an unreadable path is refused before Slack is called", async () => {
    const { attached, route } = harness({ readFails: true });

    const response = await route(post(VALID));

    expect(response.status).toBe(422);
    expect(attached).toHaveLength(0);
  });

  test("a refused upload answers 502 rather than claiming success", async () => {
    const { route } = harness({ uploadFails: true });

    expect((await route(post(VALID))).status).toBe(502);
  });

  test.each([
    ["channel", { ...VALID, channel: "" }],
    ["thread_ts", { ...VALID, thread_ts: "" }],
    ["path", { ...VALID, path: "  " }],
  ])("a blank %s is rejected", async (_field, body) => {
    expect((await harness().route(post(body))).status).toBe(400);
  });
});

describe("binary files", () => {
  const PDF_BYTES = new Uint8Array([
    0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x00, 0xff, 0xfe,
    0x80, 0x0d, 0x0a,
  ]);

  const binaryHarness = () => {
    const sent: Blob[] = [];
    const route = makeAttachRoute({
      readFile: () => Promise.resolve(new Blob([PDF_BYTES])),
      replyFor: () =>
        Promise.resolve({
          attach: (file: { content: BlobPart; filename: string }) => {
            sent.push(new Blob([file.content]));
            return Effect.succeed({ fileId: "F1", permalink: undefined });
          },
        } as unknown as MessageReplyShape),
      workspaceTeamId: "T1",
    });
    return { route, sent };
  };

  test("a pdf arrives byte-for-byte, not re-encoded as text", async () => {
    const { route, sent } = binaryHarness();

    await route(post({ ...VALID, path: "/tmp/report.pdf" }));

    expect(sent[0]?.size).toBe(PDF_BYTES.length);
    const round = new Uint8Array(await (sent[0] as Blob).arrayBuffer());
    expect([...round]).toEqual([...PDF_BYTES]);
  });

  test("a null byte and a high byte survive the round trip", async () => {
    const { route, sent } = binaryHarness();

    await route(post({ ...VALID, path: "/tmp/report.pdf" }));

    const round = new Uint8Array(await (sent[0] as Blob).arrayBuffer());
    expect(round).toContain(0x00);
    expect(round).toContain(0xff);
  });

  test("a permalink Slack withholds is not invented", async () => {
    const { route } = binaryHarness();

    const response = await route(post({ ...VALID, path: "/tmp/report.pdf" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
  });
});
