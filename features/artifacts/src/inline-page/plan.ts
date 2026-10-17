import { Data, Predicate } from "effect";

import type { SrcsetCandidate } from "#src/inline-page/srcset.ts";

import {
  ResourceAddress,
  classifyAddress,
} from "#src/inline-page/address.ts";
import {
  CssReference,
  scanCssReferences,
} from "#src/inline-page/css.ts";
import { parseSrcset } from "#src/inline-page/srcset.ts";

export interface ResourceRefusal {
  readonly reason: string;
  readonly url: string;
  readonly where: string;
}

export interface SrcsetEntry {
  readonly candidate: SrcsetCandidate;
  readonly inlinable: string | undefined;
}

export type ElementAction = Data.TaggedEnum<{
  DropHint: {};
  InlineScript: {
    readonly deferred: boolean;
    readonly module: boolean;
    readonly url: string;
  };
  InlineStylesheet: {
    readonly carried: readonly (readonly [string, string])[];
    readonly url: string;
  };
  Refuse: { readonly refusal: ResourceRefusal };
  RewriteCss: { readonly attribute: string; readonly css: string };
  RewriteSrcset: {
    readonly attribute: string;
    readonly entries: readonly SrcsetEntry[];
  };
  ToDataUri: { readonly attribute: string; readonly url: string };
}>;
export const ElementAction = Data.taggedEnum<ElementAction>();

export interface PageElement {
  readonly getAttribute: (name: string) => string | null;
  readonly tagName: string;
}

const MEDIA_ATTRIBUTES: ReadonlyMap<string, readonly string[]> = new Map([
  ["audio", ["src"]],
  ["body", ["background"]],
  ["feimage", ["href", "xlink:href"]],
  ["image", ["href", "xlink:href"]],
  ["img", ["src"]],
  ["input", ["src"]],
  ["source", ["src"]],
  ["table", ["background"]],
  ["td", ["background"]],
  ["th", ["background"]],
  ["track", ["src"]],
  ["use", ["href", "xlink:href"]],
  ["video", ["src", "poster"]],
]);

const SRCSET_ELEMENTS: ReadonlySet<string> = new Set(["img", "source"]);

const FRAME_ATTRIBUTES: ReadonlyMap<string, readonly string[]> = new Map([
  ["embed", ["src"]],
  ["frame", ["src"]],
  ["iframe", ["src", "srcdoc"]],
  ["object", ["data"]],
  ["portal", ["src"]],
]);

const EMPTY_FRAME_ADDRESSES: ReadonlySet<string> = new Set(["", "about:blank"]);

const STYLESHEET_ATTRIBUTES_KEPT = ["class", "id", "media", "title"] as const;

const CSS_ATTRIBUTES = [
  "clip-path",
  "cursor",
  "fill",
  "filter",
  "marker-end",
  "marker-mid",
  "marker-start",
  "mask",
  "stroke",
  "style",
] as const;

const SCRIPT_SOURCE_ATTRIBUTES = ["src", "href", "xlink:href"] as const;

const HINT_RELS: ReadonlySet<string> = new Set([
  "dns-prefetch",
  "modulepreload",
  "preconnect",
  "prefetch",
  "preload",
  "prerender",
]);

const FILE_RELS: ReadonlySet<string> = new Set([
  "apple-touch-icon",
  "apple-touch-icon-precomposed",
  "icon",
  "manifest",
  "mask-icon",
]);

const WHITESPACE_RUN = /\s+/u;

const refuse = (url: string, reason: string, where: string): ElementAction =>
  ElementAction.Refuse({ refusal: { reason, url, where } });

const fromAddress = (
  address: ResourceAddress,
  where: string,
  onInlinable: (url: string) => ElementAction
): readonly ElementAction[] =>
  ResourceAddress.$match(address, {
    InPage: () => [],
    Inlinable: ({ url }) => [onInlinable(url)],
    Refused: ({ reason, url }) => [refuse(url, reason, where)],
  });

export const cssRefusals = (
  css: string,
  base: string | undefined,
  where: string
): readonly ResourceRefusal[] =>
  scanCssReferences(css).flatMap((reference) => {
    const address = classifyAddress(reference.url, base);
    return ResourceAddress.$is("Refused")(address)
      ? [{ reason: address.reason, url: address.url, where }]
      : [];
  });

const planCssAttributes = (element: PageElement): readonly ElementAction[] =>
  CSS_ATTRIBUTES.flatMap((attribute): readonly ElementAction[] => {
    const css = element.getAttribute(attribute);
    if (css === null || scanCssReferences(css).length === 0) {
      return [];
    }
    const refusals = cssRefusals(
      css,
      undefined,
      `${attribute} attribute of <${element.tagName}>`
    );
    return refusals.length > 0
      ? refusals.map((refusal) => ElementAction.Refuse({ refusal }))
      : [ElementAction.RewriteCss({ attribute, css })];
  });

const planScript = (element: PageElement): readonly ElementAction[] => {
  const attribute = SCRIPT_SOURCE_ATTRIBUTES.find(
    (name) => element.getAttribute(name) !== null
  );
  const source = Predicate.isUndefined(attribute)
    ? null
    : element.getAttribute(attribute);
  if (Predicate.isUndefined(attribute) || source === null) {
    return [];
  }
  const module =
    (element.getAttribute("type") ?? "").trim().toLowerCase() === "module";
  const deferred =
    !module &&
    element.getAttribute("defer") !== null &&
    element.getAttribute("async") === null;
  return fromAddress(
    classifyAddress(source, undefined),
    `<script ${attribute}>`,
    (url) => ElementAction.InlineScript({ deferred, module, url })
  );
};

const planLink = (element: PageElement): readonly ElementAction[] => {
  const href = element.getAttribute("href");
  if (href === null) {
    return [];
  }
  const rels = (element.getAttribute("rel") ?? "")
    .toLowerCase()
    .split(WHITESPACE_RUN)
    .filter((rel) => rel !== "");
  const stylesheet = rels.includes("stylesheet");
  const hint = rels.some((rel) => HINT_RELS.has(rel));
  const file = rels.some((rel) => FILE_RELS.has(rel));
  if (!stylesheet && !hint && !file) {
    return [];
  }
  const where = `<link rel=${rels.join(" ")} href>`;
  return fromAddress(classifyAddress(href, undefined), where, (url) => {
    if (
      stylesheet &&
      (rels.includes("alternate") || element.getAttribute("disabled") !== null)
    ) {
      return refuse(
        url,
        "is a disabled or alternate stylesheet, which putting inside the page would turn on",
        where
      );
    }
    if (stylesheet) {
      return ElementAction.InlineStylesheet({
        carried: STYLESHEET_ATTRIBUTES_KEPT.flatMap((name) => {
          const value = element.getAttribute(name);
          return value === null ? [] : [[name, value] as const];
        }),
        url,
      });
    }
    return file
      ? ElementAction.ToDataUri({ attribute: "href", url })
      : ElementAction.DropHint();
  });
};

const planSrcset = (element: PageElement): readonly ElementAction[] => {
  const srcset = element.getAttribute("srcset");
  if (srcset === null || !SRCSET_ELEMENTS.has(element.tagName)) {
    return [];
  }
  const where = `<${element.tagName} srcset>`;
  const entries: SrcsetEntry[] = [];
  const refusals: ElementAction[] = [];
  for (const candidate of parseSrcset(srcset)) {
    ResourceAddress.$match(classifyAddress(candidate.url, undefined), {
      InPage: () => entries.push({ candidate, inlinable: undefined }),
      Inlinable: ({ url }) => entries.push({ candidate, inlinable: url }),
      Refused: ({ reason, url }) => refusals.push(refuse(url, reason, where)),
    });
  }
  if (refusals.length > 0) {
    return refusals;
  }
  return entries.some((entry) => Predicate.isNotUndefined(entry.inlinable))
    ? [ElementAction.RewriteSrcset({ attribute: "srcset", entries })]
    : [];
};

const planAttributes = (
  element: PageElement,
  attributes: readonly string[],
  onInlinable: (attribute: string, url: string) => ElementAction
): readonly ElementAction[] =>
  attributes.flatMap((attribute): readonly ElementAction[] => {
    const value = element.getAttribute(attribute);
    return value === null
      ? []
      : fromAddress(
          classifyAddress(value, undefined),
          `<${element.tagName} ${attribute}>`,
          (url) => onInlinable(attribute, url)
        );
  });

const planFrame = (element: PageElement): readonly ElementAction[] =>
  (FRAME_ATTRIBUTES.get(element.tagName) ?? []).flatMap((attribute) => {
    const value = (element.getAttribute(attribute) ?? "").trim();
    return EMPTY_FRAME_ADDRESSES.has(value)
      ? []
      : [
          refuse(
            attribute === "srcdoc" ? "an inline document" : value,
            "is a frame or embedded document, which the viewer does not show; put its content in the page itself",
            `<${element.tagName} ${attribute}>`
          ),
        ];
  });

const planManifest = (element: PageElement): readonly ElementAction[] =>
  element.tagName === "html"
    ? planAttributes(element, ["manifest"], (attribute, url) =>
        refuse(
          url,
          "is an application cache manifest, which saving cannot put inside the page",
          `<html ${attribute}>`
        )
      )
    : [];

export const planElement = (element: PageElement): readonly ElementAction[] => [
  ...(element.tagName === "script" ? planScript(element) : []),
  ...(element.tagName === "link" ? planLink(element) : []),
  ...planAttributes(
    element,
    MEDIA_ATTRIBUTES.get(element.tagName) ?? [],
    (attribute, url) => ElementAction.ToDataUri({ attribute, url })
  ),
  ...planSrcset(element),
  ...planFrame(element),
  ...planManifest(element),
  ...planCssAttributes(element),
];

const MODULE_FROM = /\bfrom\s*(["'])([^"'\n]+)\1/gu;
const MODULE_IMPORT = /\bimport\s*\(?\s*(["'])([^"'\n]+)\1/gu;
const DATA_SPECIFIER = /^data:/iu;

export const moduleImportRefusals = (
  source: string,
  where: string
): readonly ResourceRefusal[] =>
  [...source.matchAll(MODULE_FROM), ...source.matchAll(MODULE_IMPORT)]
    .map((match) => match[2] ?? "")
    .filter((specifier) => specifier !== "" && !DATA_SPECIFIER.test(specifier))
    .map((specifier) => ({
      reason:
        "is imported by a module script, and saving cannot put a module's imports inside the page; load the library's classic build with <script src> instead",
      url: specifier,
      where,
    }));

export const foreignStyleImportRefusals = (
  css: string
): readonly ResourceRefusal[] =>
  scanCssReferences(css)
    .filter(CssReference.$is("Import"))
    .map((reference) => ({
      reason:
        "is imported by a <style> inside <svg> or <math>, where saving cannot put a stylesheet's text safely; import it from a <style> outside the SVG instead",
      url: reference.url,
      where: "<svg><style>",
    }));
