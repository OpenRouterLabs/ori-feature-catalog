import { Effect, Schema } from "effect";
import { Base64 } from "effect/encoding";

import {
  type CdnFile,
  scriptedCdnHttpClientLayer,
  POLICY_META,
} from "#src/inline-page/test-support.ts";
import { describe, expect, it } from "#src/effect-bun-test.ts";

import { inlinePage } from "./index.ts";

const CHART_URL =
  "https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js";
const FONT_CSS_URL =
  "https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap";
const FONT_FILE_URL = "https://fonts.gstatic.com/s/inter/v13/inter.woff2";
const FONT_BYTES = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0x00, 0xff]);

const chartPage = `<!doctype html>
<html><head>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="${FONT_CSS_URL.replaceAll("&", "&amp;")}" rel="stylesheet">
<script src="${CHART_URL}" integrity="sha384-x" crossorigin="anonymous"></script>
<style>body { font-family: "Inter", sans-serif; }</style>
</head><body>
<a href="https://example.com/vendor">Vendor site</a>
<canvas id="c"></canvas>
<script>new Chart(document.getElementById("c"), { type: "bar" });</script>
</body></html>`;

const chartCdn: Record<string, CdnFile> = {
  [CHART_URL]: {
    body: 'window.Chart=function(){};var s="</script>";',
    headers: { "content-type": "application/javascript; charset=utf-8" },
  },
  [FONT_CSS_URL]: {
    body: `@font-face { font-family: 'Inter'; src: url(${FONT_FILE_URL}) format('woff2'); }`,
    headers: { "content-type": "text/css; charset=utf-8" },
  },
  [FONT_FILE_URL]: {
    body: FONT_BYTES,
    headers: { "content-type": "font/woff2" },
  },
};

const RESOURCE_REFERENCE =
  /(?:src|href)\s*=\s*["']?(?:https?:)?\/\/|url\(\s*["']?(?:https?:)?\/\//iu;

describe("inlinePage", () => {
  it.effect.each([
    {
      expected: `<!doctype html><html><head>${POLICY_META}<meta charset="utf-8"><title>t</title></head><body>x</body></html>`,
      page: '<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body>x</body></html>',
    },
    {
      expected: `<html>${POLICY_META}<body><p>x</p></body></html>`,
      page: "<html><body><p>x</p></body></html>",
    },
    { expected: `${POLICY_META}<p>x</p>`, page: "<p>x</p>" },
    { expected: `<html>${POLICY_META}</html>`, page: "<html></html>" },
    { expected: `${POLICY_META}just text`, page: "just text" },
  ])(
    "writes the network block before anything else in the head of $page",
    ({ expected, page }) =>
      Effect.gen(function* () {
        const saved = yield* inlinePage(page).pipe(
          Effect.provide(scriptedCdnHttpClientLayer({}))
        );
        expect(saved.html).toBe(expected);
      })
  );

  it.effect(
    "runs a deferred CDN script after the page's inline scripts, as defer would",
    () =>
      Effect.gen(function* () {
        const page = yield* inlinePage(
          '<html><head><script defer src="https://unpkg.com/init.js"></script><script>window.mode = "ready";</script></head><body><p id="p"></p></body></html>'
        ).pipe(
          Effect.provide(
            scriptedCdnHttpClientLayer({
              "https://unpkg.com/init.js": {
                body: "window.seen = window.mode;",
              },
            })
          )
        );
        expect(page.html.indexOf('window.mode = "ready"')).toBeLessThan(
          page.html.indexOf("window.seen = window.mode;")
        );
        expect(page.html).not.toContain("defer");
        expect(page.inlinedCount).toBe(1);
      })
  );

  it.effect(
    "keeps a stylesheet's id and media, and refuses a disabled or alternate one",
    () =>
      Effect.gen(function* () {
        const cdn = scriptedCdnHttpClientLayer({
          "https://unpkg.com/theme.css": { body: "body{color:red}" },
        });
        const page = yield* inlinePage(
          '<link id="theme" media="print" rel="stylesheet" href="https://unpkg.com/theme.css">'
        ).pipe(Effect.provide(cdn));
        expect(page.html).toBe(
          `${POLICY_META}<style id="theme" media="print">body{color:red}</style>`
        );
        const disabled = yield* inlinePage(
          '<link rel="stylesheet" disabled href="https://unpkg.com/theme.css"><link rel="alternate stylesheet" href="https://unpkg.com/theme.css">'
        ).pipe(Effect.provide(cdn), Effect.flip);
        expect(disabled.detail).toContain("disabled or alternate stylesheet");
        expect(disabled.detail.match(/theme\.css/gu)?.length).toBe(2);
      })
  );

  it.effect("refuses every frame, whatever it holds", () =>
    Effect.gen(function* () {
      const refusal = yield* inlinePage(
        '<iframe srcdoc="<p>Summary</p>"></iframe><iframe src="data:text/html,<img src=https://x.example.com/p.gif>"></iframe><object data="https://unpkg.com/doc.pdf"></object><iframe src="about:blank"></iframe>'
      ).pipe(Effect.provide(scriptedCdnHttpClientLayer({})), Effect.flip);
      expect(refusal.detail).toContain("an inline document (<iframe srcdoc>)");
      expect(refusal.detail).toContain("data:text/html");
      expect(refusal.detail).toContain(
        "https://unpkg.com/doc.pdf (<object data>)"
      );
      expect(refusal.detail).not.toContain("about:blank");
    })
  );

  it.effect("stops downloading a CDN file at 16 MiB", () =>
    Effect.gen(function* () {
      const failure = yield* inlinePage(
        '<script src="https://unpkg.com/huge.js"></script>'
      ).pipe(
        Effect.provide(
          scriptedCdnHttpClientLayer({
            "https://unpkg.com/huge.js": {
              body: "x".repeat(16 * 1024 * 1024 + 1),
            },
          })
        ),
        Effect.flip
      );
      expect(failure.failureCode).toBe("ORI_CLI_ARTIFACT_TOO_LARGE");
      expect(failure.detail).toContain("https://unpkg.com/huge.js");
    })
  );

  it.effect(
    "puts Chart.js from jsDelivr and a Google font inside the page, leaving no address to load",
    () =>
      Effect.gen(function* () {
        const page = yield* inlinePage(chartPage).pipe(
          Effect.provide(scriptedCdnHttpClientLayer(chartCdn))
        );
        expect(page.inlinedCount).toBe(3);
        expect(page.html).toContain(
          `<script src="data:text/javascript;charset=utf-8;base64,${Base64.encode('window.Chart=function(){};var s="</script>";')}"></script>`
        );
        expect(page.html).toContain(
          `url(data:font/woff2;base64,${Base64.encode(FONT_BYTES)})`
        );
        expect(page.html).not.toContain("integrity=");
        expect(page.html).not.toContain("preconnect");
        expect(page.html).toContain('<a href="https://example.com/vendor">');
        expect(
          page.html.replace('<a href="https://example.com/vendor">', "")
        ).not.toMatch(RESOURCE_REFERENCE);
      })
  );

  it.effect("refuses a script on a host off the list, naming its address", () =>
    Effect.gen(function* () {
      const requested: string[] = [];
      const refusal = yield* inlinePage(
        '<html><head><script src="https://example.com/x.js"></script></head></html>'
      ).pipe(
        Effect.provide(scriptedCdnHttpClientLayer({}, requested)),
        Effect.flip
      );
      expect(refusal.failureCode).toBe("ORI_CLI_ARTIFACT_RESOURCE_REFUSED");
      expect(refusal.detail).toContain("https://example.com/x.js");
      expect(refusal.detail).toContain("<script src>");
      expect(requested).toEqual([]);
    })
  );

  it.effect(
    "refuses every unlisted reference at once, across HTML, inline CSS and module imports",
    () =>
      Effect.gen(function* () {
        const refusal = yield* inlinePage(
          [
            '<img src="chart.png">',
            '<div style="background: url(https://images.example.org/bg.png)"></div>',
            '<iframe src="https://cdn.jsdelivr.net/npm/x/index.html"></iframe>',
            '<script type="module">import Chart from "https://cdn.jsdelivr.net/npm/chart.js/+esm";</script>',
            "<style>@import url(https://cdn.example.net/theme.css);</style>",
          ].join("")
        ).pipe(Effect.provide(scriptedCdnHttpClientLayer({})), Effect.flip);
        const detail = refusal.detail;
        expect(detail).toContain("chart.png");
        expect(detail).toContain("https://images.example.org/bg.png");
        expect(detail).toContain("https://cdn.jsdelivr.net/npm/x/index.html");
        expect(detail).toContain("https://cdn.jsdelivr.net/npm/chart.js/+esm");
        expect(detail).toContain("https://cdn.example.net/theme.css");
      })
  );

  it.effect("refuses a listed file that redirects off the list", () =>
    Effect.gen(function* () {
      const refusal = yield* inlinePage(
        '<script src="https://unpkg.com/chart.js"></script>'
      ).pipe(
        Effect.provide(
          scriptedCdnHttpClientLayer({
            "https://unpkg.com/chart.js": {
              body: "",
              headers: { location: "https://evil.example.com/chart.js" },
              status: 302,
            },
          })
        ),
        Effect.flip
      );
      expect(refusal.detail).toContain("https://evil.example.com/chart.js");
    })
  );

  it.effect("refuses an off-list address inside a fetched stylesheet", () =>
    Effect.gen(function* () {
      const refusal = yield* inlinePage(
        '<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/x/1/x.css">'
      ).pipe(
        Effect.provide(
          scriptedCdnHttpClientLayer({
            "https://cdnjs.cloudflare.com/ajax/libs/x/1/x.css": {
              body: ".a{background:url(https://tracker.example.com/p.gif)}",
            },
          })
        ),
        Effect.flip
      );
      expect(refusal.detail).toContain("https://tracker.example.com/p.gif");
    })
  );

  it.effect(
    "follows relative font addresses and @import inside a listed stylesheet",
    () =>
      Effect.gen(function* () {
        const page = yield* inlinePage(
          '<link rel="stylesheet" media="screen" href="https://cdnjs.cloudflare.com/ajax/libs/fa/6/css/all.css">'
        ).pipe(
          Effect.provide(
            scriptedCdnHttpClientLayer({
              "https://cdnjs.cloudflare.com/ajax/libs/fa/6/css/all.css": {
                body: '@charset "utf-8";@import "base.css" screen;.i{src:url("../webfonts/fa.woff2")}',
              },
              "https://cdnjs.cloudflare.com/ajax/libs/fa/6/css/base.css": {
                body: '@charset "utf-8";.b{color:red}',
              },
              "https://cdnjs.cloudflare.com/ajax/libs/fa/6/webfonts/fa.woff2": {
                body: FONT_BYTES,
                headers: { "content-type": "font/woff2" },
              },
            })
          )
        );
        expect(page.html).toContain('<style media="screen">');
        expect(page.html).toContain("@media screen{.b{color:red}}");
        expect(page.html).toContain("url(data:font/woff2;base64,");
        expect(page.inlinedCount).toBe(3);
      })
  );

  it.effect(
    "turns listed images in srcset and style attributes into data URIs",
    () =>
      Effect.gen(function* () {
        const page = yield* inlinePage(
          '<img srcset="https://unpkg.com/a.png 1x, https://unpkg.com/b.png 2x" src="data:image/png;base64,AA=="><p style="background:url(//unpkg.com/a.png)"></p>'
        ).pipe(
          Effect.provide(
            scriptedCdnHttpClientLayer({
              "https://unpkg.com/a.png": {
                body: new Uint8Array([1]),
                headers: { "content-type": "image/png" },
              },
              "https://unpkg.com/b.png": {
                body: new Uint8Array([2]),
                headers: { "content-type": "image/png" },
              },
            })
          )
        );
        expect(page.html).toContain(
          'srcset="data:image/png;base64,AQ== 1x, data:image/png;base64,Ag== 2x"'
        );
        expect(page.html).toContain(
          'style="background:url(data:image/png;base64,AQ==)"'
        );
        expect(page.inlinedCount).toBe(3);
      })
  );

  it.effect("fails naming the address when a CDN answers 404", () =>
    Effect.gen(function* () {
      const refusal = yield* inlinePage(
        '<script src="https://cdn.jsdelivr.net/npm/chartjs@9/missing.js"></script>'
      ).pipe(Effect.provide(scriptedCdnHttpClientLayer({})), Effect.flip);
      expect(refusal.failureCode).toBe(
        "ORI_CLI_ARTIFACT_RESOURCE_DOWNLOAD_FAILED"
      );
      expect(refusal.detail).toContain(
        "https://cdn.jsdelivr.net/npm/chartjs@9/missing.js"
      );
    })
  );
});

const ReferenceSlot = Schema.Literals([
  "<script src=URL></script>",
  '<link rel="stylesheet" href=URL>',
  '<link rel="icon" href=URL>',
  '<link rel="preload" as="font" href=URL>',
  "<img src=URL>",
  '<img srcset="URL 2x">',
  "<video poster=URL></video>",
  "<audio src=URL></audio>",
  "<svg><image href=URL /></svg>",
  "<iframe src=URL></iframe>",
  '<div style="background-image:url(URL)"></div>',
  "<style>@font-face{src:url(URL)}</style>",
  "<style>@import 'URL';</style>",
]);

describe("inlinePage over every resource slot", () => {
  it.effect(
    "never saves a page with a reference to a host off the list, and names that address",
    () =>
      Effect.gen(function* () {
        for (const slot of ReferenceSlot.literals) {
          const host = "unlisted-host.example.net";
          const url = `https://${host}/asset.bin`;
          const requested: string[] = [];
          const refusal = yield* inlinePage(
            `<html><body>${slot.replaceAll("URL", url)}</body></html>`
          ).pipe(
            Effect.provide(scriptedCdnHttpClientLayer({}, requested)),
            Effect.flip
          );
          expect(refusal.detail.includes(url)).toBe(true);
          expect(requested.length).toBe(0);
        }
      })
  );
});
