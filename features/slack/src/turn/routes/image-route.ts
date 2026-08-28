/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively — the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */
/**
 * image-route.ts — the loopback route behind the `slack-image` skill.
 *
 * Generates an image and uploads it into the thread. Same shape as the chart
 * route: the image is part of the answer, so it lands as its own file and
 * survives the progress message being removed.
 *
 * The HTTP handler is the one real edge here, so Effect is run exactly once,
 * at the top of the request: generating, addressing the thread and uploading
 * all stay inside the one fiber, as named spans, and share its interruption.
 */

import { Effect, Result, Schema } from "effect";

import type { GeneratedImage } from "../../helpers/images-ai/generate.ts";
import type { MessageReplyShape } from "../../message-reply/reply.ts";
import type { ThreadRef } from "../../thread/index.ts";
import type { Refusal } from "./loopback-route.ts";

import { generateImage } from "../../helpers/images-ai/generate.ts";
import { loopbackRoute, refuse, threadFields } from "./loopback-route.ts";

/** A prompt is a description, not a document. */
const MAX_PROMPT_CHARS = 1000;
/** Long enough to recognise, short of any filesystem limit. */
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

/** Decode the wire body. Rejects rather than guessing at a malformed shape. */
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
          // Falls back on empty as well as absent — a whitespace title would
          // otherwise become a filename of nothing.
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

/** Upload the image as its own file, so it survives the progress message. */
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

/**
 * The whole request, in one fiber.
 *
 * `replyFor` is addressed only once the provider has actually produced an
 * image: a refusal must not leave a reply half-opened on the thread.
 */
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
    // The provider refused, not us — hand its reason back verbatim.
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
    // A prompt and a title; anything larger is not an image request.
    capKiB: 16,
    handle: async ({ ref, request }) =>
      // The one boundary the route owns: HTTP is a Promise, everything under
      // it is not.
      Effect.runPromise(
        handleImage({
          deps,
          ref,
          request,
        })
      ),
    parse: (raw): Result.Result<ImageRequest, string> => {
      const parsed = parseImageBody(raw);
      return parsed.ok
        ? Result.succeed(parsed.request)
        : Result.fail(parsed.error);
    },
    workspaceTeamId: deps.workspaceTeamId,
  });
