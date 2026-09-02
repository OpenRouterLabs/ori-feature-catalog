import { Effect, Result, Schema } from "effect";

import type { MessageReplyShape } from "#src/message-reply/reply.ts";
import type { ThreadRef } from "#src/thread/thread.ts";
import type { Addressed } from "./loopback-route.ts";

import { loopbackRoute, refuse } from "./loopback-route.ts";

const HTTP_BAD_GATEWAY = 502;
const HTTP_UNPROCESSABLE = 422;

const MAX_TITLE_CHARS = 100;

const AttachBodySchema = Schema.Struct({
  channel: Schema.String,
  comment: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
  path: Schema.String,
  thread_ts: Schema.String,
  title: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
});

const decodeBody = Schema.decodeUnknownResult(AttachBodySchema);

interface AttachRequest extends Addressed {
  readonly comment: string | undefined;
  readonly path: string;
  readonly title: string | undefined;
}

const blank = (value: string): boolean => value.trim().length === 0;

const present = (value: string | undefined): string | undefined =>
  value === undefined || blank(value) ? undefined : value;

const parse = (raw: unknown): Result.Result<AttachRequest, string> =>
  Result.match(decodeBody(raw), {
    onFailure: (): Result.Result<AttachRequest, string> =>
      Result.fail("expected { channel, thread_ts, path, title?, comment? }"),
    onSuccess: (decoded): Result.Result<AttachRequest, string> => {
      if (blank(decoded.channel) || blank(decoded.thread_ts)) {
        return Result.fail("channel and thread_ts must not be empty");
      }
      if (blank(decoded.path)) {
        return Result.fail("path must not be empty");
      }
      return Result.succeed({
        channel: decoded.channel,
        comment: present(decoded.comment),
        path: decoded.path,
        team: undefined,
        threadTs: decoded.thread_ts,
        title: present(decoded.title)?.slice(0, MAX_TITLE_CHARS),
      });
    },
  });

const basename = (path: string): string =>
  path.split("/").filter((part) => part !== "").at(-1) ?? "attachment";

export interface AttachRouteDeps {
  readonly readFile: (path: string) => Promise<Blob>;
  readonly replyFor: (ref: ThreadRef) => Promise<MessageReplyShape>;
  readonly workspaceTeamId: string;
}

export const makeAttachRoute = (
  deps: AttachRouteDeps
): ((request: Request) => Promise<Response>) =>
  loopbackRoute<AttachRequest, { readonly permalink: string | undefined }>({
    capKiB: 8,
    handle: Effect.fn("Slack.attach.handle")(function* ({ ref, request }) {
      const content = yield* Effect.tryPromise(() =>
        deps.readFile(request.path)
      ).pipe(Effect.orElseSucceed(() => undefined));
      if (content === undefined) {
        return refuse(HTTP_UNPROCESSABLE, `cannot read ${request.path}`);
      }

      const reply = yield* Effect.promise(() => deps.replyFor(ref));
      return yield* reply
        .attach(
          {
            content,
            filename: basename(request.path),
            ...(request.title === undefined ? {} : { title: request.title }),
          },
          request.comment
        )
        .pipe(
          Effect.map((file) => Result.succeed({ permalink: file.permalink })),
          Effect.catchCause((cause) =>
            Effect.logError("[slack] could not attach the file", cause).pipe(
              Effect.as(refuse(HTTP_BAD_GATEWAY, "Slack refused the upload"))
            )
          )
        );
    }),
    parse,
    workspaceTeamId: deps.workspaceTeamId,
  });
