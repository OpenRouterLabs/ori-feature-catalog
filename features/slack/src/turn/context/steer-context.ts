/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively; the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */
/**
 * steer-context.ts — telling a steered turn what it is amending.
 *
 * A second message interrupts the running turn and its replacement carries
 * `priorPartial`, the work that got done. That was the whole handover, and it
 * left out the only thing the correction needs to be understood against: the
 * original request. So "find p0 issues" followed by "not issues, investigate
 * the repo" produced a repo audit with the p0 half silently dropped — the
 * model had no way to know a p0 half existed.
 *
 * A correction amends. It replaces only what it contradicts.
 *
 * The prior ask is another person's message and is fenced like any other
 * external text.
 */

import { sanitizeThreadContent } from "../../thread/thread.ts";

export const steerContextBlock = (priorAsk?: string): string => {
  const ask = (priorAsk ?? "").trim();
  if (ask === "") {
    return "";
  }
  return [
    "<amends_this_ask>",
    sanitizeThreadContent(ask),
    "</amends_this_ask>",
    "The message below CORRECTS the ask above rather than replacing it. Keep",
    "every part of it the correction does not contradict, and carry on from the",
    "work you have already done.",
  ].join("\n");
};
