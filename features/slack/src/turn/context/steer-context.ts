import { sanitizeThreadContent } from "#src/thread/thread.ts";

export const steerContextBlock = (priorAsk?: string): string => {
  const ask = (priorAsk ?? "").trim();
  if (ask === "") {
    return "";
  }
  return [
    "<interrupted_ask>",
    sanitizeThreadContent(ask),
    "</interrupted_ask>",
    "The message below interrupted that ask. Decide what it does to it;",
    "anything it does not touch still stands.",
  ].join("\n");
};
