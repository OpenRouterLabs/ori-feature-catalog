import { Effect, Predicate } from "effect";
import { Base64 } from "effect/encoding";
import { decodeHTMLAttribute } from "entities";

import type {
  PageElement,
  ResourceRefusal,
} from "#src/inline-page/plan.ts";

import {
  ElementAction,
  cssRefusals,
  foreignStyleImportRefusals,
  moduleImportRefusals,
  planElement,
} from "#src/inline-page/plan.ts";
import { serializeSrcset } from "#src/inline-page/srcset.ts";
import { CliFailureError } from "#src/failures.ts";
import { ARTIFACT_CONTENT_SECURITY_POLICY } from "#src/store/index.ts";
import { formatUnknownError } from "#src/format-unknown.ts";

export interface PageScan {
  readonly actions: readonly ElementAction[];
  readonly refusals: readonly ResourceRefusal[];
  readonly styleTexts: readonly string[];
}

export interface ResolvedPage {
  readonly css: ReadonlyMap<
    string,
    { readonly count: number; readonly text: string }
  >;
  readonly dataUris: ReadonlyMap<string, string>;
  readonly scripts: ReadonlyMap<string, string>;
  readonly stylesheets: ReadonlyMap<
    string,
    { readonly count: number; readonly text: string }
  >;
}

export interface RewrittenPage {
  readonly html: string;
  readonly inlinedCount: number;
}

const SCRIPT_ATTRIBUTES_AFTER_INLINING = [
  "async",
  "crossorigin",
  "defer",
  "fetchpriority",
  "href",
  "integrity",
  "referrerpolicy",
  "src",
  "xlink:href",
] as const;

const POLICY_META = `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CONTENT_SECURITY_POLICY}">`;

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const SCRIPT_TEXT_THAT_MOVES_THE_END_TAG = /<!--|<\/script/iu;
const CLOSING_STYLE = /<\/(style)/giu;

const encodeForeignText = (text: string): string =>
  `<![CDATA[${text.replaceAll("]]>", "]]]]><![CDATA[>")}]]>`;

const encodeStyleText = (namespaceURI: string, text: string): string =>
  namespaceURI === HTML_NAMESPACE
    ? text.replace(CLOSING_STYLE, "<\\/$1")
    : encodeForeignText(text);

const scriptDataUri = (source: string): string =>
  `data:text/javascript;charset=utf-8;base64,${Base64.encode(source)}`;

const fitsInlineScript = (source: string): boolean =>
  !SCRIPT_TEXT_THAT_MOVES_THE_END_TAG.test(source);

const escapeAttribute = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;");

const encodeAttributeText = (value: string): string =>
  value.replaceAll("&", "&amp;");

const asPageElement = (element: HTMLRewriterTypes.Element): PageElement => ({
  getAttribute: (name) => {
    const raw = element.getAttribute(name);
    return raw === null ? null : decodeHTMLAttribute(raw);
  },
  tagName: element.tagName.toLowerCase(),
});

const isInlineModule = (element: HTMLRewriterTypes.Element): boolean =>
  !element.hasAttribute("src") &&
  (element.getAttribute("type") ?? "").trim().toLowerCase() === "module";

const runRewriter = (
  build: () => HTMLRewriter,
  html: string
): Effect.Effect<string, CliFailureError> =>
  Effect.try({
    catch: (cause) =>
      new CliFailureError({
        cause,
        detail: `Saving could not read the page as HTML: ${formatUnknownError(cause)}`,
        failureCode: "ORI_CLI_ARTIFACT_PAGE_UNPARSEABLE",
      }),
    try: () => build().transform(html),
  });

interface OpenForeignStyle {
  text: string | undefined;
}

const closeForeignStyle = (
  style: OpenForeignStyle
): readonly ResourceRefusal[] => {
  const { text } = style;
  style.text = undefined;
  return Predicate.isUndefined(text) ? [] : foreignStyleImportRefusals(text);
};

export const scanPage = (
  html: string
): Effect.Effect<PageScan, CliFailureError> => {
  const actions: ElementAction[] = [];
  const refusals: ResourceRefusal[] = [];
  const styleTexts: string[] = [];
  let styleText = "";
  let styleIsForeign = false;
  const foreignStyle: OpenForeignStyle = { text: undefined };
  let moduleText: string | undefined;
  return runRewriter(
    () =>
      new HTMLRewriter()
        .on("*", {
          element: (element) => {
            for (const action of planElement(asPageElement(element))) {
              if (ElementAction.$is("Refuse")(action)) {
                refusals.push(action.refusal);
              } else {
                actions.push(action);
              }
            }
          },
        })
        .on("script", {
          element: (element) => {
            moduleText = isInlineModule(element) ? "" : undefined;
          },
          text: (chunk) => {
            if (Predicate.isUndefined(moduleText)) {
              return;
            }
            moduleText += chunk.text;
            if (chunk.lastInTextNode) {
              refusals.push(
                ...moduleImportRefusals(moduleText, "<script type=module>")
              );
              moduleText = undefined;
            }
          },
        })
        .on("style", {
          element: (element) => {
            styleIsForeign = element.namespaceURI !== HTML_NAMESPACE;
            if (styleIsForeign && !element.selfClosing) {
              refusals.push(...closeForeignStyle(foreignStyle));
              foreignStyle.text = "";
              element.onEndTag(() => {
                refusals.push(...closeForeignStyle(foreignStyle));
              });
            }
          },
          text: (chunk) => {
            styleText += chunk.text;
            if (styleIsForeign) {
              foreignStyle.text = (foreignStyle.text ?? "") + chunk.text;
            }
            if (chunk.lastInTextNode) {
              refusals.push(...cssRefusals(styleText, undefined, "<style>"));
              styleTexts.push(styleText);
              styleText = "";
            }
          },
        })
        .onDocument({
          end: () => {
            refusals.push(...closeForeignStyle(foreignStyle));
          },
        }),
    html
  ).pipe(Effect.as({ actions, refusals, styleTexts }));
};

const resolvedOrThrow = <A>(map: ReadonlyMap<string, A>, key: string): A => {
  const value = map.get(key);
  if (Predicate.isUndefined(value)) {
    throw new Error(`saving resolved no content for ${key}`);
  }
  return value;
};

const countInlinable = (
  entries: readonly { readonly inlinable: string | undefined }[]
): number =>
  entries.filter((entry) => Predicate.isNotUndefined(entry.inlinable)).length;

const applyAction = (
  element: HTMLRewriterTypes.Element,
  action: ElementAction,
  resolved: ResolvedPage,
  deferredScripts: string[]
): number =>
  ElementAction.$match(action, {
    DropHint: () => {
      element.remove();
      return 0;
    },
    InlineScript: ({ deferred, url }) => {
      const source = resolvedOrThrow(resolved.scripts, url);
      if (deferred) {
        element.remove();
        deferredScripts.push(
          fitsInlineScript(source)
            ? `<script>${source}</script>`
            : `<script src="${scriptDataUri(source)}"></script>`
        );
        return 1;
      }
      for (const attribute of SCRIPT_ATTRIBUTES_AFTER_INLINING) {
        element.removeAttribute(attribute);
      }
      if (element.namespaceURI !== HTML_NAMESPACE) {
        element.setInnerContent(encodeForeignText(source), { html: true });
      } else if (fitsInlineScript(source)) {
        element.setInnerContent(source, { html: true });
      } else {
        element.setAttribute("src", scriptDataUri(source));
      }
      return 1;
    },
    InlineStylesheet: ({ carried, url }) => {
      const stylesheet = resolvedOrThrow(resolved.stylesheets, url);
      const attributes = carried
        .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
        .join("");
      element.replace(
        `<style${attributes}>${encodeStyleText(element.namespaceURI, stylesheet.text)}</style>`,
        { html: true }
      );
      return 1 + stylesheet.count;
    },
    Refuse: () => 0,
    RewriteCss: ({ attribute, css }) => {
      const rewritten = resolvedOrThrow(resolved.css, css);
      element.setAttribute(attribute, encodeAttributeText(rewritten.text));
      return rewritten.count;
    },
    RewriteSrcset: ({ attribute, entries }) => {
      element.setAttribute(
        attribute,
        encodeAttributeText(
          serializeSrcset(
            entries.map((entry) =>
              Predicate.isUndefined(entry.inlinable)
                ? entry.candidate
                : {
                    ...entry.candidate,
                    url: resolvedOrThrow(resolved.dataUris, entry.inlinable),
                  }
            )
          )
        )
      );
      return countInlinable(entries);
    },
    ToDataUri: ({ attribute, url }) => {
      element.setAttribute(attribute, resolvedOrThrow(resolved.dataUris, url));
      element.removeAttribute("integrity");
      element.removeAttribute("crossorigin");
      return 1;
    },
  });

interface PolicyPlacement {
  placed: boolean;
  sawHtml: boolean;
}

const placePolicy = (
  placement: PolicyPlacement,
  element: HTMLRewriterTypes.Element
): void => {
  if (placement.placed) {
    return;
  }
  const tag = element.tagName.toLowerCase();
  if (tag === "html") {
    placement.sawHtml = true;
    return;
  }
  placement.placed = true;
  if (tag === "head") {
    element.prepend(POLICY_META, { html: true });
  } else {
    element.before(POLICY_META, { html: true });
  }
};

export const rewritePage = (
  html: string,
  resolved: ResolvedPage
): Effect.Effect<RewrittenPage, CliFailureError> => {
  let inlinedCount = 0;
  let styleText = "";
  let styleIsForeign = false;
  const placement: PolicyPlacement = { placed: false, sawHtml: false };
  const deferredScripts: string[] = [];
  return runRewriter(
    () =>
      new HTMLRewriter()
        .on("*", {
          element: (element) => {
            placePolicy(placement, element);
            for (const action of planElement(asPageElement(element))) {
              inlinedCount += applyAction(
                element,
                action,
                resolved,
                deferredScripts
              );
            }
          },
        })
        .on("style", {
          element: (element) => {
            styleIsForeign = element.namespaceURI !== HTML_NAMESPACE;
          },
          text: (chunk) => {
            styleText += chunk.text;
            if (!chunk.lastInTextNode) {
              chunk.remove();
              return;
            }
            const css = resolvedOrThrow(resolved.css, styleText);
            styleText = "";
            inlinedCount += css.count;
            chunk.replace(
              styleIsForeign
                ? css.text
                : encodeStyleText(HTML_NAMESPACE, css.text),
              { html: true }
            );
          },
        })
        .onDocument({
          end: (end) => {
            end.append(deferredScripts.join(""), { html: true });
          },
        }),
    html
  ).pipe(
    Effect.filterOrElse(
      () => placement.placed,
      (rewritten) =>
        placement.sawHtml
          ? runRewriter(
              () =>
                new HTMLRewriter().on("html", {
                  element: (element) => {
                    element.prepend(POLICY_META, { html: true });
                  },
                }),
              rewritten
            )
          : Effect.succeed(`${POLICY_META}${rewritten}`)
    ),
    Effect.map((rewritten) => ({ html: rewritten, inlinedCount }))
  );
};
