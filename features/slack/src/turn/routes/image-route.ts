/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively — the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */

import { Effect, Result, Schema } from "effect";

import type { GeneratedImage } from "../../helpers/images-ai/generate.ts";
import type { MessageReplyShape } from "../../message-reply/reply.ts";
import type { ThreadRef } from "../../thread/thread.ts";
import type { Refusal } from "./loopback-route.ts";

import { generateImage } from "../../helpers/images-ai/generate.ts";
import { loopbackRoute, refuse, threadFields } from "./loopback-route.ts";

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

interface ImageRequest {
  readonly channel: string;
  readonly prompt: string;
  readonly team: string | undefined;
  readonly threadTs: string;
  readonly title: string;
}

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

interface ImageRouteDeps {
  readonly apiKey: () => string;
  readonly fetch?: typeof globalThis.fetch;
  readonly model?: string | undefined;
  readonly replyFor: (ref: ThreadRef) => Promise<MessageReplyShape>;
  readonly workspaceTeamId: string;
}

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
