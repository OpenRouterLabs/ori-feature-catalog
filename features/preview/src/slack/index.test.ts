import { layer as BunFileSystemLayer } from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer, Option } from "effect";

import { postShotsToThread, slackThreadFor } from "./index.ts";
import { scriptedDaemonCredentialsLayer } from "../daemon-credentials/test-support.ts";
import { fetchHttpClientLayer } from "../http.ts";
import { decodeUnknownJson, jsonResponse } from "../json.ts";
import { describe, expect, it } from "../effect-bun-test.ts";

const DAEMON_TOKEN = "preview-test-daemon-token";

const postingLayer = Layer.mergeAll(
  fetchHttpClientLayer,
  BunFileSystemLayer,
  scriptedDaemonCredentialsLayer
);

describe("slackThreadFor", () => {
  it("finds no thread outside a Slack turn, so dashboard chat never posts anywhere", () => {
    expect(slackThreadFor({}, { ORI_RUNTIME_PORT: "7070" })).toEqual(
      Option.none()
    );
  });

  it("treats the literal string undefined as no thread, as the attach skill does", () => {
    expect(
      slackThreadFor(
        { SLACK_CHANNEL_ID: "C1", SLACK_THREAD_TS: "undefined" },
        {}
      )
    ).toEqual(Option.none());
  });

  it("targets the runtime's own port from the host env", () => {
    expect(
      slackThreadFor(
        { SLACK_CHANNEL_ID: "C1", SLACK_THREAD_TS: "1.2" },
        { ORI_RUNTIME_PORT: "7070" }
      )
    ).toEqual(Option.some({ channel: "C1", threadTs: "1.2", port: 7070 }));
  });
});

describe("postShotsToThread", () => {
  it.effect(
    "posts every screenshot to the thread's attach route, with the comment on the first only",
    () =>
      Effect.gen(function* () {
        const bodies: unknown[] = [];
        const server = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          idleTimeout: 0,
          fetch: async (request) => {
            if (
              request.headers.get("authorization") !== `Bearer ${DAEMON_TOKEN}`
            ) {
              return new Response("Unauthorized", { status: 401 });
            }
            bodies.push(decodeUnknownJson(await request.text()));
            return jsonResponse({ ok: true });
          },
        });
        const posted = yield* postShotsToThread(
          { channel: "C1", threadTs: "1.2", port: server.port ?? 0 },
          [
            { path: "/w/preview-shots/a-before.png", title: "acme/web before" },
            { path: "/w/preview-shots/a-after.png", title: "acme/web after" },
          ],
          "acme/web: before and after",
          { ORI_DAEMON_TOKEN: DAEMON_TOKEN }
        );
        server.stop(true);
        expect(posted).toBe(2);
        expect(bodies).toEqual([
          {
            channel: "C1",
            thread_ts: "1.2",
            path: "/w/preview-shots/a-before.png",
            title: "acme/web before",
            comment: "acme/web: before and after",
          },
          {
            channel: "C1",
            thread_ts: "1.2",
            path: "/w/preview-shots/a-after.png",
            title: "acme/web after",
          },
        ]);
      }).pipe(Effect.provide(postingLayer))
  );

  it.effect(
    "counts a rejected upload as not posted instead of failing the screenshot",
    () =>
      Effect.gen(function* () {
        const server = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          idleTimeout: 0,
          fetch: () => new Response("no", { status: 500 }),
        });
        const posted = yield* postShotsToThread(
          { channel: "C1", threadTs: "1.2", port: server.port ?? 0 },
          [{ path: "/w/x.png", title: "x" }],
          "x",
          { ORI_DAEMON_TOKEN: DAEMON_TOKEN }
        );
        server.stop(true);
        expect(posted).toBe(0);
      }).pipe(Effect.provide(postingLayer))
  );

  it.effect(
    "posts nothing and never calls the daemon when no daemon credential can be found",
    () =>
      Effect.gen(function* () {
        let called = 0;
        const server = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          idleTimeout: 0,
          fetch: () => {
            called += 1;
            return jsonResponse({ ok: true });
          },
        });
        const posted = yield* postShotsToThread(
          { channel: "C1", threadTs: "1.2", port: server.port ?? 0 },
          [{ path: "/w/x.png", title: "x" }],
          "x",
          {}
        );
        server.stop(true);
        expect(posted).toBe(0);
        expect(called).toBe(0);
      }).pipe(Effect.provide(postingLayer))
  );
});
