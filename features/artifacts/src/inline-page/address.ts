import { Data, Predicate } from "effect";

export const INLINABLE_HOSTS: ReadonlySet<string> = new Set([
  "cdnjs.cloudflare.com",
  "cdn.jsdelivr.net",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "unpkg.com",
]);

const PAGE_LOCAL_SCHEMES: ReadonlySet<string> = new Set([
  "about:",
  "blob:",
  "data:",
]);

const WEB_SCHEMES: ReadonlySet<string> = new Set(["http:", "https:"]);

export type ResourceAddress = Data.TaggedEnum<{
  Inlinable: { readonly url: string };
  InPage: {};
  Refused: { readonly reason: string; readonly url: string };
}>;
export const ResourceAddress = Data.taggedEnum<ResourceAddress>();

const withSchemeForProtocolRelative = (
  value: string,
  base: string | undefined
): string =>
  Predicate.isUndefined(base) && value.startsWith("//")
    ? `https:${value}`
    : value;

export const classifyAddress = (
  raw: string,
  base: string | undefined
): ResourceAddress => {
  const value = raw.trim();
  if (value === "" || value.startsWith("#")) {
    return ResourceAddress.InPage();
  }
  const url = URL.parse(withSchemeForProtocolRelative(value, base), base);
  if (url === null) {
    return ResourceAddress.Refused({
      reason: "is a relative address, and a saved page has no files beside it",
      url: value,
    });
  }
  if (PAGE_LOCAL_SCHEMES.has(url.protocol)) {
    return ResourceAddress.InPage();
  }
  if (!WEB_SCHEMES.has(url.protocol)) {
    return ResourceAddress.Refused({
      reason: `uses ${url.protocol}, which no viewer can load`,
      url: value,
    });
  }
  return INLINABLE_HOSTS.has(url.host)
    ? ResourceAddress.Inlinable({ url: url.href })
    : ResourceAddress.Refused({
        reason: "is on a host saving does not put inside the page",
        url: url.href,
      });
};
