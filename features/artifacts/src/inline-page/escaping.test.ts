import { Effect, Result } from "effect";
import { Base64 } from "effect/encoding";

import {
  scriptedCdnHttpClientLayer,
  POLICY_META,
} from "#src/inline-page/test-support.ts";
import { describe, expect, it } from "#src/effect-bun-test.ts";

import { inlinePage } from "./index.ts";

const SCRIPT_DATA_URI = "data:text/javascript;charset=utf-8;base64,";

const parseSavedPage = (
  html: string,
  textOf: string
): { readonly tags: readonly string[]; readonly text: string } => {
  const tags: string[] = [];
  let text = "";
  new HTMLRewriter()
    .on("*", {
      element: (element) => {
        tags.push(element.tagName);
        const src = element.getAttribute("src") ?? "";
        if (element.tagName === textOf && src.startsWith(SCRIPT_DATA_URI)) {
          text += Result.getOrThrow(
            Base64.decodeString(src.slice(SCRIPT_DATA_URI.length))
          );
        }
      },
    })
    .on(textOf, {
      text: (chunk) => {
        text += chunk.text;
      },
    })
    .transform(html);
  return { tags, text };
};

describe("inlinePage", () => {
  it.effect.each([
    {
      body: 'var tpl="<!--<script>";',
      expectedTags: ["html", "head", "meta", "script", "body", "p"],
      expectedText: 'var tpl="<!--<script>";',
      name: "a script whose text opens a comment and a script tag",
      page: '<html><head><script src="https://unpkg.com/lib.js"></script></head><body><p>after</p></body></html>',
      textOf: "script",
    },
    {
      body: 'var tpl="<!--<SCRIPT>";',
      expectedTags: ["html", "head", "meta", "body", "p", "script", "script"],
      expectedText: 'var tpl="<!--<SCRIPT>";run();',
      name: "a deferred script whose text opens a comment and a script tag",
      page: '<html><head><script defer src="https://unpkg.com/lib.js"></script><script defer src="https://unpkg.com/app.js"></script></head><body><p>after</p></body></html>',
      textOf: "script",
    },
    {
      body: "const script = 4; if (1<script/2) { window.ok = true; }",
      expectedTags: ["html", "head", "meta", "script", "body", "p"],
      expectedText: "const script = 4; if (1<script/2) { window.ok = true; }",
      name: "a script comparing against a name that starts with script",
      page: '<html><head><script src="https://unpkg.com/lib.js"></script></head><body><p>after</p></body></html>',
      textOf: "script",
    },
    {
      body: "window.raw = String.raw`<!--<script></script>-->`;",
      expectedTags: ["html", "head", "meta", "script", "body", "p"],
      expectedText: "window.raw = String.raw`<!--<script></script>-->`;",
      name: "a script whose tagged template reads its raw markup",
      page: '<html><head><script src="https://unpkg.com/lib.js"></script></head><body><p>after</p></body></html>',
      textOf: "script",
    },
    {
      body: 'if(a<b&&c){x("]]>")}',
      expectedTags: ["html", "meta", "body", "svg", "script", "p"],
      expectedText: 'if(a<b&&c){x("]]>")}',
      name: "an SVG script whose text holds markup characters",
      page: '<html><body><svg><script href="https://unpkg.com/lib.js"></script></svg><p>after</p></body></html>',
      textOf: "script",
    },
    {
      body: '.a::after{content:"<b>&"}',
      expectedTags: ["html", "meta", "body", "svg", "style", "p"],
      expectedText: '.a::after{content:"<b>&"}',
      name: "an SVG stylesheet whose text holds markup characters",
      page: '<html><body><svg><link rel="stylesheet" href="https://unpkg.com/lib.css"></svg><p>after</p></body></html>',
      textOf: "style",
    },
  ])(
    "keeps the rest of the page when inlining $name",
    ({ body, expectedTags, expectedText, page, textOf }) =>
      Effect.gen(function* () {
        const saved = yield* inlinePage(page).pipe(
          Effect.provide(
            scriptedCdnHttpClientLayer({
              "https://unpkg.com/app.js": { body: "run();" },
              "https://unpkg.com/lib.css": { body },
              "https://unpkg.com/lib.js": { body },
            })
          )
        );
        expect(parseSavedPage(saved.html, textOf)).toEqual({
          tags: expectedTags,
          text: expectedText,
        });
      })
  );

  it.effect(
    "saves an SVG style's own CDATA and entities untouched while inlining its images",
    () =>
      Effect.gen(function* () {
        const saved = yield* inlinePage(
          '<svg><style><![CDATA[.a{fill:red}]]>.b::after{content:"&lt;"}.c{background:url(https://unpkg.com/a.png)}</style></svg>'
        ).pipe(
          Effect.provide(
            scriptedCdnHttpClientLayer({
              "https://unpkg.com/a.png": {
                body: new Uint8Array([1]),
                headers: { "content-type": "image/png" },
              },
            })
          )
        );
        expect(saved.html).toBe(
          `${POLICY_META}<svg><style><![CDATA[.a{fill:red}]]>.b::after{content:"&lt;"}.c{background:url(data:image/png;base64,AQ==)}</style></svg>`
        );
      })
  );

  it.effect.each([
    {
      name: "the page ends",
      page: '<svg><style>@import "https://unpkg.com/theme.css";',
    },
    {
      name: "its svg closes",
      page: '<svg><style>@import "https://unpkg.com/theme.css";</svg><p>after</p>',
    },
    {
      name: "a nested SVG style opens",
      page: '<svg><style>@import "https://unpkg.com/theme.css";<svg><style>.a{fill:red}</style></svg>',
    },
    {
      name: "another SVG style follows",
      page: '<svg><style>@import "https://unpkg.com/theme.css";</svg><svg><style>.a{fill:red}</style></svg>',
    },
  ])(
    "refuses an SVG style's @import when $name before its end tag",
    ({ page }) =>
      Effect.gen(function* () {
        const requested: string[] = [];
        const refusal = yield* inlinePage(page).pipe(
          Effect.provide(scriptedCdnHttpClientLayer({}, requested)),
          Effect.flip
        );
        expect(refusal.failureCode).toBe("ORI_CLI_ARTIFACT_RESOURCE_REFUSED");
        expect(
          refusal.detail.match(
            /https:\/\/unpkg\.com\/theme\.css \(<svg><style>\) is imported by a <style> inside <svg> or <math>/gu
          )?.length
        ).toBe(1);
        expect(requested).toEqual([]);
      })
  );

  it.effect(
    "refuses an @import that an SVG style splits across its CDATA and text",
    () =>
      Effect.gen(function* () {
        const refusal = yield* inlinePage(
          '<svg><style><![CDATA[@im]]>port "https://unpkg.com/theme.css";</style></svg>'
        ).pipe(Effect.provide(scriptedCdnHttpClientLayer({})), Effect.flip);
        expect(refusal.detail).toContain(
          "https://unpkg.com/theme.css (<svg><style>) is imported by a <style> inside <svg> or <math>"
        );
      })
  );

  it.effect(
    "refuses an @import inside an SVG style, whose stylesheet text it cannot place safely",
    () =>
      Effect.gen(function* () {
        const requested: string[] = [];
        const refusal = yield* inlinePage(
          "<svg><style>@import url(https://unpkg.com/lib.css);</style></svg>"
        ).pipe(
          Effect.provide(scriptedCdnHttpClientLayer({}, requested)),
          Effect.flip
        );
        expect(refusal.detail).toContain(
          "https://unpkg.com/lib.css (<svg><style>) is imported by a <style> inside <svg> or <math>"
        );
        expect(requested).toEqual([]);
      })
  );
});
