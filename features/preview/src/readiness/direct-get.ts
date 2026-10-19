import { Effect, Predicate } from "effect";

import { PreviewError } from "../errors.ts";

export const MAX_BODY_BYTES = 512 * 1024;

const STATUS_LINE = /^HTTP\/1\.[01] (\d{3})/u;

export interface DirectResponse {
  readonly status: number;
  readonly body: string;
}

export const targetOf = (
  url: string
): { host: string; port: number; path: string } => {
  const parsed = new URL(url);
  return {
    host: parsed.hostname.replace(/^\[|\]$/gu, ""),
    port: Number(parsed.port),
    path: `${parsed.pathname}${parsed.search}`,
  };
};

const parseResponse = (raw: string): DirectResponse | undefined => {
  const status = STATUS_LINE.exec(raw)?.[1];
  if (Predicate.isUndefined(status)) {
    return undefined;
  }
  const split = raw.indexOf("\r\n\r\n");
  return {
    status: Number(status),
    body: split === -1 ? "" : raw.slice(split + 4),
  };
};

const notReady = (detail: string): PreviewError =>
  new PreviewError({ code: "not_ready", detail });

export const requestText = (path: string, port: number): string =>
  `GET ${path} HTTP/1.1\r\nHost: localhost:${port}\r\nAccept: text/html\r\nConnection: close\r\n\r\n`;

const CONTENT_LENGTH = /\r\ncontent-length:\s*(\d+)/iu;

const CHUNKED_END = "\r\n0\r\n\r\n";

export const isComplete = (raw: string): boolean => {
  const split = raw.indexOf("\r\n\r\n");
  if (split === -1) {
    return false;
  }
  const head = raw.slice(0, split);
  const length = CONTENT_LENGTH.exec(head)?.[1];
  if (Predicate.isNotUndefined(length)) {
    return (
      new TextEncoder().encode(raw.slice(split + 4)).length >= Number(length)
    );
  }
  return raw.endsWith(CHUNKED_END);
};

export const settledResponse = (
  raw: string,
  url: string
): Effect.Effect<DirectResponse, PreviewError> => {
  const response = parseResponse(raw);
  return Predicate.isUndefined(response)
    ? Effect.fail(notReady(`no HTTP response from ${url}`))
    : Effect.succeed(response);
};

export const refusedResponse = (
  url: string
): Effect.Effect<DirectResponse, PreviewError> =>
  Effect.fail(notReady(`nothing listening at ${url}`));
