/* oxlint-disable typescript/no-unsafe-type-assertion -- fetch stubs stand in for the platform type */
import { describe, expect, test } from "#src/test-support/effect-test.ts";

import { Effect } from "effect";

import type { GenerateOutcome } from "./generate.ts";

import { decodeDataUrl, generateImage } from "./generate.ts";

const PIXEL =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const answering = (body: unknown, status = 200) =>
  (() =>
    Promise.resolve(
      Response.json(body, { status })
    )) as unknown as typeof globalThis.fetch;

const withImage = (url: string): unknown => ({
  choices: [{ message: { images: [{ image_url: { url } }] } }],
});

const run = (input: {
  fetch: typeof globalThis.fetch;
  apiKey?: string;
  prompt?: string;
}): Effect.Effect<GenerateOutcome> =>
  generateImage({
    apiKey: input.apiKey ?? "sk-test",
    fetch: input.fetch,
    prompt: input.prompt ?? "a logo",
  });

describe("decodeDataUrl", () => {
  test("decodes a base64 image into a blob of the right type", () => {
    const decoded = decodeDataUrl(`data:image/png;base64,${PIXEL}`);

    expect(decoded?.contentType).toBe("image/png");
    expect(decoded?.content.size).toBeGreaterThan(0);
  });

  test("refuses a remote URL — that is a fetch, not a decode", () => {
    expect(decodeDataUrl("https://example.com/logo.png")).toBeUndefined();
  });

  test("refuses a non-image data URL", () => {
    expect(decodeDataUrl("data:text/html;base64,PHNjcmlwdD4=")).toBeUndefined();
  });
});

describe("generateImage", () => {
  test.effect("returns the first decodable image the model produced", () =>
    Effect.gen(function* () {
      const outcome = yield* run({
        fetch: answering(withImage(`data:image/png;base64,${PIXEL}`)),
      });

      expect(outcome.ok).toBe(true);
      expect(outcome.ok && outcome.image.contentType).toBe("image/png");
    })
  );

  test.effect(
    "skips an image it cannot decode rather than failing outright",
    () =>
      Effect.gen(function* () {
        const outcome = yield* run({
          fetch: answering({
            choices: [
              {
                message: {
                  images: [
                    { image_url: { url: "https://example.com/a.png" } },
                    { image_url: { url: `data:image/png;base64,${PIXEL}` } },
                  ],
                },
              },
            ],
          }),
        });

        expect(outcome.ok).toBe(true);
      })
  );

  test.effect("a text-only answer is reported, not treated as an image", () =>
    Effect.gen(function* () {
      const outcome = yield* run({
        fetch: answering({ choices: [{ message: {} }] }),
      });

      expect(outcome.ok).toBe(false);
      expect(!outcome.ok && outcome.error).toContain("no image");
    })
  );

  test.effect("a missing key is named, so the failure is actionable", () =>
    Effect.gen(function* () {
      const outcome = yield* run({
        apiKey: "",
        fetch: answering({}),
      });

      expect(!outcome.ok && outcome.error).toContain("OPENROUTER_API_KEY");
    })
  );

  test.effect("an upstream error carries its status", () =>
    Effect.gen(function* () {
      const outcome = yield* run({
        fetch: answering({ error: "nope" }, 429),
      });

      expect(!outcome.ok && outcome.error).toContain("429");
    })
  );

  test.effect("an unreachable host is an outcome, not a crash", () =>
    Effect.gen(function* () {
      const outcome = yield* run({
        fetch: (() =>
          Promise.reject(
            new Error("ENOTFOUND")
          )) as unknown as typeof globalThis.fetch,
      });

      expect(outcome.ok).toBe(false);
    })
  );

  test.effect("refuses an empty prompt before spending a request", () =>
    Effect.gen(function* () {
      let called = false;
      const outcome = yield* run({
        fetch: (() => {
          called = true;
          return Promise.resolve(Response.json({}));
        }) as unknown as typeof globalThis.fetch,
        prompt: "   ",
      });

      expect(outcome.ok).toBe(false);
      expect(called).toBe(false);
    })
  );
});
