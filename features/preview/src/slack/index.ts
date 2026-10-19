import { Effect, FileSystem, Option, Predicate } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import type { HostEnv } from "../sandbox/index.ts";

import type { DaemonAuthorization } from "../daemon-credentials/index.ts";

import { DaemonCredentials } from "../daemon-credentials/index.ts";
import { isOkStatus } from "../http.ts";

const DEFAULT_RUNTIME_PORT = 3141;

export interface SlackShot {
  readonly path: string;
  readonly title: string;
}

export interface SlackThread {
  readonly channel: string;
  readonly threadTs: string;
  readonly port: number;
}

const present = (value: string | undefined): Option.Option<string> =>
  Option.fromNullishOr(value).pipe(
    Option.filter((text) => text !== "" && text !== "undefined")
  );

const runtimePort = (env: HostEnv): number => {
  const parsed = Number(env.ORI_RUNTIME_PORT ?? "");
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65_535
    ? parsed
    : DEFAULT_RUNTIME_PORT;
};

export const slackThreadFor = (
  turnEnv: HostEnv,
  hostEnv: HostEnv
): Option.Option<SlackThread> =>
  Option.all({
    channel: present(turnEnv.SLACK_CHANNEL_ID),
    threadTs: present(turnEnv.SLACK_THREAD_TS),
  }).pipe(
    Option.map(({ channel, threadTs }) => ({
      channel,
      threadTs,
      port: runtimePort({ ...hostEnv, ...turnEnv }),
    }))
  );

const daemonAuthorization = Effect.fnUntraced(function* (
  env: HostEnv,
  port: number
) {
  const credentials = yield* DaemonCredentials;
  const file = credentials.publishedFile(env, port, undefined);
  const fs = yield* FileSystem.FileSystem;
  const published = Predicate.isUndefined(file)
    ? undefined
    : Option.getOrUndefined(yield* fs.readFileString(file).pipe(Effect.option));
  return credentials.authorizationOf({
    env,
    homeDirectory: undefined,
    port,
    published,
  });
});

const postOne = Effect.fn("Preview.slack.postOne")(function* (
  thread: SlackThread,
  authorization: Extract<DaemonAuthorization, { readonly kind: "bearer" }>,
  shot: SlackShot,
  comment: string | undefined
) {
  const client = yield* HttpClient.HttpClient;
  const request = yield* HttpClientRequest.post(
    `http://127.0.0.1:${thread.port}/slack/thread/attach`
  ).pipe(
    HttpClientRequest.setHeaders(authorization.headers),
    HttpClientRequest.bodyJson({
      channel: thread.channel,
      thread_ts: thread.threadTs,
      path: shot.path,
      title: shot.title,
      comment,
    })
  );
  const response = yield* client.execute(request);
  return isOkStatus(response.status);
});

export const postShotsToThread = Effect.fn("Preview.slack.postShots")(
  function* (
    thread: SlackThread,
    shots: readonly SlackShot[],
    comment: string,
    env: HostEnv
  ) {
    const authorization = yield* daemonAuthorization(env, thread.port);
    if (authorization.kind === "unavailable") {
      yield* Effect.logWarning(
        `could not post screenshots to the Slack thread: ${authorization.reason}`
      );
      return 0;
    }
    const posted = yield* Effect.forEach(shots, (shot, index) =>
      postOne(
        thread,
        authorization,
        shot,
        index === 0 ? comment : undefined
      ).pipe(Effect.orElseSucceed(() => false))
    );
    return posted.filter(Boolean).length;
  }
);
