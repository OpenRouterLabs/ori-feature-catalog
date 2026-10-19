import type { HttpClient } from "effect/http";

import { Effect, Predicate } from "effect";

import type { InlinedText } from "./css-inline.ts";
import type { RewrittenPage } from "./page.ts";
import type { CliFailureError } from "../failures.ts";

import {
  dataUri,
  decodeText,
  inlineCss,
  makeInlineSession,
  refusalFailure,
} from "./css-inline.ts";
import {
  rewritePage,
  scanPage,
} from "./page.ts";
import {
  ElementAction,
  moduleImportRefusals,
} from "./plan.ts";

const DOWNLOAD_CONCURRENCY = 6;

const unique = (values: readonly string[]): readonly string[] => [
  ...new Set(values),
];

const resolveAll = <A>(
  keys: readonly string[],
  resolve: (
    key: string
  ) => Effect.Effect<A, CliFailureError, HttpClient.HttpClient>
): Effect.Effect<
  ReadonlyMap<string, A>,
  CliFailureError,
  HttpClient.HttpClient
> =>
  Effect.forEach(
    unique(keys),
    (key) => Effect.map(resolve(key), (value) => [key, value] as const),
    { concurrency: DOWNLOAD_CONCURRENCY }
  ).pipe(Effect.map((entries) => new Map(entries)));

export const inlinePage = Effect.fn("ArtifactInline.page")(function* (
  html: string
) {
  const scan = yield* scanPage(html);
  if (scan.refusals.length > 0) {
    return yield* refusalFailure(scan.refusals);
  }
  const session = makeInlineSession();
  const scriptActions = scan.actions.filter(ElementAction.$is("InlineScript"));
  const moduleUrls: ReadonlySet<string> = new Set(
    scriptActions.filter((action) => action.module).map((action) => action.url)
  );
  const scripts = yield* resolveAll(
    scriptActions.map((action) => action.url),
    (url) =>
      session.download(url).pipe(
        Effect.map(decodeText),
        Effect.tap((source) => {
          const refusals = moduleUrls.has(url)
            ? moduleImportRefusals(source, `<script type=module src=${url}>`)
            : [];
          return refusals.length > 0
            ? Effect.fail(refusalFailure(refusals))
            : Effect.void;
        })
      )
  );
  const stylesheets = yield* resolveAll(
    scan.actions
      .filter(ElementAction.$is("InlineStylesheet"))
      .map((action) => action.url),
    (url) =>
      session
        .download(url)
        .pipe(
          Effect.flatMap(
            (
              resource
            ): Effect.Effect<
              InlinedText,
              CliFailureError,
              HttpClient.HttpClient
            > => inlineCss(session, decodeText(resource), resource.url, 0)
          )
        )
  );
  const dataUris = yield* resolveAll(
    scan.actions.flatMap((action) => {
      if (ElementAction.$is("ToDataUri")(action)) {
        return [action.url];
      }
      if (ElementAction.$is("RewriteSrcset")(action)) {
        return action.entries.flatMap((entry) =>
          Predicate.isUndefined(entry.inlinable) ? [] : [entry.inlinable]
        );
      }
      return [];
    }),
    (url) => session.download(url).pipe(Effect.map(dataUri))
  );
  const css = yield* resolveAll(
    [
      ...scan.styleTexts,
      ...scan.actions
        .filter(ElementAction.$is("RewriteCss"))
        .map((action) => action.css),
    ],
    (text) => inlineCss(session, text, undefined, 0)
  );
  return yield* rewritePage(html, { css, dataUris, scripts, stylesheets });
}) satisfies (
  html: string
) => Effect.Effect<RewrittenPage, CliFailureError, HttpClient.HttpClient>;
