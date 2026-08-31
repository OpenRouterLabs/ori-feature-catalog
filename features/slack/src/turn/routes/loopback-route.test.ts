/* oxlint-disable typescript/no-unsafe-type-assertion -- the shell is generic over its body, and a test names one shape */
/**
 * loopback-route.test.ts — the shell every loopback route shares.
 *
 * The cap is the reason this exists. Five routes each checked
 * `content-length` and then called `request.json()` unbounded, so a chunked
 * request — which carries no such header — walked straight past a ceiling
 * that read as enforced.
 */

import { describe, expect, test } from "#src/test-support/effect-test.ts";

import { Effect, Result, Schema } from "effect";

import type { Addressed } from "./loopback-route.ts";

import { loopbackRoute, refuse, threadFields } from "./loopback-route.ts";

const Body = Schema.Struct({
  ...threadFields,
  note: Schema.String,
});
const decode = Schema.decodeUnknownResult(Body);

const parse = (
  raw: unknown
): Result.Result<Addressed & { note: string }, string> =>
  Result.match(decode(raw), {
    onFailure: () => Result.fail("expected { channel, thread_ts, note }"),
    onSuccess: (body) =>
      Result.succeed({
        channel: body.channel,
        note: body.note,
        team: body.team,
        threadTs: body.thread_ts,
      }),
  });

const seen: { refs: string[] } = { refs: [] };

const route = loopbackRoute({
  capKiB: 1,
  handle: ({ ref, request }) => {
    seen.refs.push(`${ref.teamId}/${ref.channelId}/${ref.threadTs}`);
    return Effect.succeed(
      request.note === "no"
        ? refuse(418, "refused by the handler")
        : Result.succeed({ noted: request.note })
    );
  },
  parse,
  workspaceTeamId: "T_FALLBACK",
});

const body = (note: string): string =>
  JSON.stringify({
    channel: "C1",
    note,
    thread_ts: "1.2",
  });

/** A body with no content-length, which is what a chunked POST looks like. */
const chunked = (payload: string): Request =>
  new Request("http://127.0.0.1/slack/thread/x", {
    body: new ReadableStream({
      start(controller): void {
        controller.enqueue(new TextEncoder().encode(payload));
        controller.close();
      },
    }),
    method: "POST",
    // @ts-expect-error -- duplex is required for a stream body and is not in the DOM types
    duplex: "half",
  });

describe("the cap holds however the body arrives", () => {
  test("a declared oversize body is refused", async () => {
    const response = await route(
      new Request("http://127.0.0.1/x", {
        body: body("x".repeat(4096)),
        headers: { "content-type": "application/json" },
        method: "POST",
      })
    );

    expect(response.status).toBe(413);
  });

  test("an UNDECLARED oversize body is refused too", async () => {
    // The bug: no content-length, so the old guard compared against 0 and
    // fell through to an unbounded json().
    const before = seen.refs.length;

    const response = await route(chunked(body("x".repeat(4096))));

    expect(response.status).toBe(413);
    expect(seen.refs).toHaveLength(before);
  });

  test("a small chunked body still gets through", async () => {
    const response = await route(chunked(body("fine")));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      noted: "fine",
      ok: true,
    });
  });
});

describe("what the shell does around the work", () => {
  test("garbage json is a 400 carrying the parser's sentence", async () => {
    const response = await route(
      new Request("http://127.0.0.1/x", {
        body: "{not json",
        method: "POST",
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "expected { channel, thread_ts, note }",
    });
  });

  test("a body with no team falls back to the workspace", async () => {
    seen.refs.length = 0;

    await route(
      new Request("http://127.0.0.1/x", {
        body: body("ok"),
        method: "POST",
      })
    );

    expect(seen.refs).toEqual(["T_FALLBACK/C1/1.2"]);
  });

  test("a refusal from the handler keeps its own status and sentence", async () => {
    const response = await route(
      new Request("http://127.0.0.1/x", {
        body: body("no"),
        method: "POST",
      })
    );

    expect(response.status).toBe(418);
    expect(await response.json()).toEqual({ error: "refused by the handler" });
  });
});
