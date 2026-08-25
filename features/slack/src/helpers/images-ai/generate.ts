/**
 * generate.ts — an image from a prompt, via OpenRouter.
 *
 * For the answer a chart cannot draw: a logo, a mock-up, an illustration of a
 * concept. The chart helpers own anything with numbers in it; this owns the
 * rest, and neither should be reached for when prose would do.
 *
 * The model returns a data URL rather than a link, so nothing here fetches a
 * second host and no image outlives the turn that made it.
 */

import { Effect, Option, Schema } from "effect";

/**
 * Any image-capable model on OpenRouter; overridable per workspace with
 * `SLACK_IMAGE_MODEL`.
 *
 * This was `google/gemini-2.5-flash-image-preview`, which OpenRouter no longer
 * lists — the preview was folded into `google/gemini-2.5-flash-image` and the
 * old id stopped resolving, so every generation failed the same way a bad
 * prompt would. Pinning a `-preview` id is what made that a silent break.
 *
 * The alternatives, if this needs revisiting: `google/gemini-3-pro-image`
 * (Nano Banana Pro) is the quality option at 4x the per-image price, and
 * `google/gemini-3.1-flash-image` (Nano Banana 2) sits between the two.
 */
const DEFAULT_MODEL = "openai/gpt-5.4-image-2";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

/**
 * Generous, because a generation is slower than a chat completion and the
 * caller is a skill the agent is blocked on — but bounded, because a hung
 * request would hold the turn.
 */
const REQUEST_TIMEOUT_MS = 90_000;

const ImageUrl = Schema.Struct({
  image_url: Schema.Struct({ url: Schema.String }),
});

const Body = Schema.Struct({
  choices: Schema.Array(
    Schema.Struct({
      message: Schema.Struct({
        images: Schema.optionalKey(Schema.UndefinedOr(Schema.Array(ImageUrl))),
      }),
    })
  ),
});
const decodeBody = Schema.decodeUnknownOption(Body);

export interface GeneratedImage {
  /** A Blob rather than bytes: it is what the upload path takes, and it
   * sidesteps the ArrayBufferLike/ArrayBuffer mismatch at that boundary. */
  readonly content: Blob;
  readonly contentType: string;
}

export type GenerateOutcome =
  | { readonly ok: true; readonly image: GeneratedImage }
  | { readonly ok: false; readonly error: string };

/**
 * Decode a `data:` URL into bytes.
 *
 * Only `base64` is accepted: a percent-encoded payload would be a different
 * decode, and a remote URL is not a data URL at all — treating one as an
 * image would mean fetching whatever host the model named.
 */
export const decodeDataUrl = (url: string): GeneratedImage | undefined => {
  const match = /^data:(?<type>image\/[\w+.-]+);base64,(?<data>.+)$/su.exec(
    url
  );
  const type = match?.groups?.type;
  const data = match?.groups?.data;
  if (type === undefined || data === undefined) {
    return undefined;
  }
  return {
    content: new Blob([Buffer.from(data, "base64")], { type }),
    contentType: type,
  };
};

const firstImage = (payload: unknown): GeneratedImage | undefined =>
  Option.match(decodeBody(payload), {
    onNone: (): GeneratedImage | undefined => undefined,
    onSome: (decoded): GeneratedImage | undefined => {
      for (const choice of decoded.choices) {
        for (const image of choice.message.images ?? []) {
          const decodedImage = decodeDataUrl(image.image_url.url);
          if (decodedImage !== undefined) {
            return decodedImage;
          }
        }
      }
      return undefined;
    },
  });

/** Named so the autofixer cannot strip a bare `undefined` and widen this. */
const NO_RESPONSE: Response | undefined = undefined;

/** The call itself. `undefined` when it could not be made at all. */
const request = (input: {
  readonly apiKey: string;
  readonly fetch: typeof globalThis.fetch;
  readonly model?: string | undefined;
  readonly prompt: string;
}): Effect.Effect<Response | undefined> =>
  Effect.tryPromise({
    catch: (cause) => new Error(String(cause)),
    try: () =>
      input.fetch(ENDPOINT, {
        body: JSON.stringify({
          messages: [
            {
              content: input.prompt,
              role: "user",
            },
          ],
          modalities: ["image", "text"],
          model: input.model ?? DEFAULT_MODEL,
        }),
        headers: {
          authorization: `Bearer ${input.apiKey}`,
          "content-type": "application/json",
        },
        method: "POST",
      }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: REQUEST_TIMEOUT_MS,
      orElse: () => Effect.fail(new Error("the request timed out")),
    }),
    Effect.catchCause(() => Effect.succeed(NO_RESPONSE))
  );

export const generateImage = (input: {
  readonly apiKey: string;
  readonly fetch: typeof globalThis.fetch;
  readonly model?: string | undefined;
  readonly prompt: string;
}): Effect.Effect<GenerateOutcome> =>
  Effect.gen(function* () {
    const prompt = input.prompt.trim();
    if (prompt === "") {
      return {
        error: "a prompt is required",
        ok: false,
      } as const;
    }
    if (input.apiKey === "") {
      return {
        error: "OPENROUTER_API_KEY is not set",
        ok: false,
      } as const;
    }

    const response = yield* request({
      ...input,
      prompt,
    });

    if (response === undefined) {
      return {
        error: "could not reach OpenRouter",
        ok: false,
      } as const;
    }
    if (!response.ok) {
      return {
        error: `OpenRouter answered ${response.status}`,
        ok: false,
      } as const;
    }

    const payload: unknown = yield* Effect.promise(() =>
      response.json().catch((): unknown => null)
    );
    const image = firstImage(payload);
    return image === undefined
      ? ({
          error: "the model returned no image",
          ok: false,
        } as const)
      : ({
          image,
          ok: true,
        } as const);
  });
