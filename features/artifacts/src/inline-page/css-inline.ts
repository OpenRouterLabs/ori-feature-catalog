import type { HttpClient } from "effect/http";

import { Effect, Option, Predicate } from "effect";
import { Base64 } from "effect/encoding";

import type { DownloadedResource } from "./fetch.ts";
import type { ResourceRefusal } from "./plan.ts";

import {
  ResourceAddress,
  classifyAddress,
} from "./address.ts";
import {
  CssReference,
  replaceCssReferences,
  scanCssReferences,
  wrapImportedCss,
} from "./css.ts";
import { downloadResource } from "./fetch.ts";
import { CliFailureError } from "../failures.ts";

const MAX_IMPORT_DEPTH = 8;
const DOWNLOAD_CONCURRENCY = 6;

export interface InlineSession {
  readonly download: (
    url: string
  ) => Effect.Effect<
    DownloadedResource,
    CliFailureError,
    HttpClient.HttpClient
  >;
}

export interface InlinedText {
  readonly count: number;
  readonly text: string;
}

export const makeInlineSession = (): InlineSession => {
  const downloads = new Map<
    string,
    Effect.Effect<DownloadedResource, CliFailureError, HttpClient.HttpClient>
  >();
  return {
    download: (url) =>
      Effect.suspend(() => {
        const known = downloads.get(url);
        if (Predicate.isNotUndefined(known)) {
          return known;
        }
        return Effect.cached(downloadResource(url)).pipe(
          Effect.tap((once) => Effect.sync(() => downloads.set(url, once))),
          Effect.flatten
        );
      }),
  };
};

const textDecoder = new TextDecoder();

export const decodeText = (resource: DownloadedResource): string =>
  textDecoder.decode(resource.bytes);

export const dataUri = (resource: DownloadedResource): string =>
  `data:${resource.mediaType};base64,${Base64.encode(resource.bytes)}`;

const LISTED_HOSTS_HINT =
  "Load scripts, styles, fonts and images only from cdnjs.cloudflare.com, cdn.jsdelivr.net, unpkg.com, fonts.googleapis.com or fonts.gstatic.com, which saving puts inside the page, or put the file in the page yourself as an inline <script>, an inline <style> or a data: URI.";

export const refusalFailure = (
  refusals: readonly ResourceRefusal[]
): CliFailureError =>
  new CliFailureError({
    detail: [
      `Saving refused the page: it refers to ${refusals.length === 1 ? "a resource" : `${refusals.length} resources`} no viewer could load.`,
      ...refusals.map(
        (refusal) => `- ${refusal.url} (${refusal.where}) ${refusal.reason}.`
      ),
    ].join("\n"),
    failureCode: "ORI_CLI_ARTIFACT_RESOURCE_REFUSED",
    hint: LISTED_HOSTS_HINT,
  });

const importTooDeep = (url: string) =>
  new CliFailureError({
    detail: `The stylesheet ${url} nests @import more than ${MAX_IMPORT_DEPTH} levels deep.`,
    failureCode: "ORI_CLI_ARTIFACT_RESOURCE_REFUSED",
    hint: LISTED_HOSTS_HINT,
  });

export const inlineCss: (
  session: InlineSession,
  css: string,
  base: string | undefined,
  depth: number
) => Effect.Effect<InlinedText, CliFailureError, HttpClient.HttpClient> =
  Effect.fn("ArtifactInline.css")(function* (
    session: InlineSession,
    css: string,
    base: string | undefined,
    depth: number
  ) {
    const references = scanCssReferences(css);
    const addresses = references.map((reference) =>
      classifyAddress(reference.url, base)
    );
    const where = Predicate.isUndefined(base)
      ? "CSS in the page"
      : `a stylesheet from ${base}`;
    const refusals = addresses.flatMap((address) =>
      ResourceAddress.$is("Refused")(address)
        ? [{ reason: address.reason, url: address.url, where }]
        : []
    );
    if (refusals.length > 0) {
      return yield* refusalFailure(refusals);
    }
    const inlined = yield* Effect.forEach(
      references,
      (reference, position) => {
        const address = addresses[position];
        if (
          Predicate.isUndefined(address) ||
          !ResourceAddress.$is("Inlinable")(address)
        ) {
          return Effect.succeed(Option.none<InlinedText>());
        }
        return CssReference.$match(reference, {
          Import: ({ condition }) =>
            depth >= MAX_IMPORT_DEPTH
              ? Effect.fail(importTooDeep(address.url))
              : session.download(address.url).pipe(
                  Effect.flatMap((resource) =>
                    inlineCss(
                      session,
                      decodeText(resource),
                      resource.url,
                      depth + 1
                    )
                  ),
                  Effect.map((inner) =>
                    Option.some<InlinedText>({
                      count: inner.count + 1,
                      text: wrapImportedCss(inner.text, condition),
                    })
                  )
                ),
          Url: () =>
            session.download(address.url).pipe(
              Effect.map((resource) =>
                Option.some<InlinedText>({
                  count: 1,
                  text: `url(${dataUri(resource)})`,
                })
              )
            ),
        });
      },
      { concurrency: DOWNLOAD_CONCURRENCY }
    );
    return {
      count: inlined.reduce(
        (sum, entry) =>
          sum +
          Option.getOrElse(
            Option.map(entry, (found) => found.count),
            () => 0
          ),
        0
      ),
      text: replaceCssReferences(
        css,
        references,
        inlined.map((entry) =>
          Option.getOrUndefined(Option.map(entry, (found) => found.text))
        )
      ),
    } satisfies InlinedText;
  });
