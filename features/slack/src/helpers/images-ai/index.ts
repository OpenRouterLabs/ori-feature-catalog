import { Effect, Option, Schema } from "effect";

import { opaqueSchema } from "#src/schema-support.ts";

const DEFAULT_MODEL = "openai/gpt-5.4-image-2";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

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

const GeneratedImageSchema = Schema.Struct({
  content: opaqueSchema<Blob>("GeneratedImage.content"),
  contentType: Schema.String,
});

export type GeneratedImage = typeof GeneratedImageSchema.Type;

export type GenerateOutcome =
  | { readonly ok: true; readonly image: GeneratedImage }
  | { readonly ok: false; readonly error: string };

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

const NO_RESPONSE: Response | undefined = undefined;

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
    Effect.catchCause(() => Effect.succeed(NO_RESPONSE)),
    Effect.withSpan("Slack.imagesAi.request")
  );

export const generateImage = Effect.fn("Slack.imagesAi.generate")(
  function* (input: {
    readonly apiKey: string;
    readonly fetch: typeof globalThis.fetch;
    readonly model?: string | undefined;
    readonly prompt: string;
  }): Effect.fn.Return<GenerateOutcome> {
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

    const payload: unknown = yield* Effect.tryPromise({
      catch: (cause) => new Error(String(cause)),
      try: (): Promise<unknown> => response.json(),
    }).pipe(
      Effect.catchCause(() => Effect.succeed(null)),
      Effect.withSpan("Slack.imagesAi.readBody")
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
  }
);
