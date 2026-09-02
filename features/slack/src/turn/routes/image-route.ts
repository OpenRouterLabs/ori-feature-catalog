import { Effect, Result, Schema } from "effect";

import { type GeneratedImage, generateImage } from "#src/helpers/images-ai/generate.ts";
import type { MessageReplyShape } from "#src/message-reply/reply.ts";
import type { ThreadRef } from "#src/thread/index.ts";
import { type Refusal, loopbackRoute, refuse, threadFields } from "./loopback-route.ts";

import { functionSchema } from "#src/schema-support.ts";

const MAX_PROMPT_CHARS = 1000;
const MAX_FILENAME_CHARS = 48;

const HTTP_BAD_GATEWAY = 502;

const ImageBody = Schema.Struct({
  ...threadFields,
  prompt: Schema.String,
  title: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
});
const decodeBody = Schema.decodeUnknownResult(ImageBody);

const nonEmpty = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
};

const ImageRequestSchema = Schema.Struct({
  channel: Schema.String,
  prompt: Schema.String,
  team: Schema.UndefinedOr(Schema.String),
  threadTs: Schema.String,
  title: Schema.String,
});

type ImageRequest = typeof ImageRequestSchema.Type;

type ImageParse =
  | { readonly ok: true; readonly request: ImageRequest }
  | { readonly ok: false; readonly error: string };

const parseImageBody = (raw: unknown): ImageParse =>
  Result.match(decodeBody(raw), {
    onFailure: (): ImageParse => ({
      error: "expected { channel, thread_ts, prompt, title?, team? }",
      ok: false,
    }),
    onSuccess: (decoded): ImageParse => {
      const prompt = decoded.prompt.trim();
      if (prompt === "" || decoded.channel === "" || decoded.thread_ts === "") {
        return {
          error: "channel, thread_ts and prompt must not be empty",
          ok: false,
        };
      }
      return {
        ok: true,
        request: {
          channel: decoded.channel,
          prompt: prompt.slice(0, MAX_PROMPT_CHARS),
          team: decoded.team,
          threadTs: decoded.thread_ts,
          title: nonEmpty(decoded.title) ?? "image",
        },
      };
    },
  });

const ImageRouteDepsSchema = Schema.Struct({
  apiKey: functionSchema<() => string>("ImageRouteDeps.apiKey"),
  fetch: Schema.optionalKey(
    functionSchema<typeof globalThis.fetch>("ImageRouteDeps.fetch")
  ),
  model: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
  replyFor: functionSchema<(ref: ThreadRef) => Promise<MessageReplyShape>>(
    "ImageRouteDeps.replyFor"
  ),
  workspaceTeamId: Schema.String,
});

type ImageRouteDeps = typeof ImageRouteDepsSchema.Type;

const upload = Effect.fn("Slack.image.upload")(function* (input: {
  readonly image: GeneratedImage;
  readonly reply: MessageReplyShape;
  readonly title: string;
}): Effect.fn.Return<boolean> {
  const extension = input.image.contentType.split("/").at(1) ?? "png";
  return yield* input.reply
    .attach({
      content: input.image.content,
      filename: `${input.title.replaceAll(/[^\w-]/gu, "-").slice(0, MAX_FILENAME_CHARS)}.${extension}`,
      title: input.title,
    })
    .pipe(
      Effect.andThen(Effect.succeed(true)),
      Effect.catchCause((cause) =>
        Effect.logError("[slack] could not upload the image", cause).pipe(
          Effect.andThen(Effect.succeed(false))
        )
      )
    );
});

const handleImage = Effect.fn("Slack.image.handle")(function* (input: {
  readonly deps: ImageRouteDeps;
  readonly ref: ThreadRef;
  readonly request: ImageRequest;
}): Effect.fn.Return<Result.Result<Record<string, never>, Refusal>> {
  const outcome = yield* generateImage({
    apiKey: input.deps.apiKey(),
    fetch: input.deps.fetch ?? globalThis.fetch,
    model: input.deps.model,
    prompt: input.request.prompt,
  });
  if (!outcome.ok) {
    return refuse(HTTP_BAD_GATEWAY, outcome.error);
  }

  const reply = yield* Effect.promise(() => input.deps.replyFor(input.ref));
  const uploaded = yield* upload({
    image: outcome.image,
    reply,
    title: input.request.title,
  });

  return uploaded
    ? Result.succeed({})
    : refuse(HTTP_BAD_GATEWAY, "Slack refused the upload");
});

export const makeImageRoute = (
  deps: ImageRouteDeps
): ((request: Request) => Promise<Response>) =>
  loopbackRoute<ImageRequest, Record<string, never>>({
    capKiB: 16,
    handle: ({ ref, request }) =>
      handleImage({
        deps,
        ref,
        request,
      }),
    parse: (raw): Result.Result<ImageRequest, string> => {
      const parsed = parseImageBody(raw);
      return parsed.ok
        ? Result.succeed(parsed.request)
        : Result.fail(parsed.error);
    },
    workspaceTeamId: deps.workspaceTeamId,
  });
