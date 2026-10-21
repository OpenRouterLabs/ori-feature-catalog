import { Schema } from "effect";

const UnknownJsonString = Schema.fromJsonString(Schema.Unknown);

export const encodeUnknownJson = Schema.encodeSync(UnknownJsonString);

export const decodeUnknownJson = Schema.decodeUnknownSync(UnknownJsonString);

export const jsonResponse = (body: unknown, init?: ResponseInit): Response => {
  const headers = new Headers(init?.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return new Response(encodeUnknownJson(body), { ...init, headers });
};
