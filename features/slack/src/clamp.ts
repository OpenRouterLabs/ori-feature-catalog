/**
 * clamp.ts — shortening text for a slot that will not fold.
 *
 * Cutting mid-word reads as a rendering bug, while a whole clause reads as a
 * summary. Slack's own assistant does the same. Two slots need this — the
 * thread title and the indicator's rotating entry — and they had it once each,
 * one word-aware and one not, which is why the indicator was showing lines
 * like `cloning OpenRouterIncubator/ori to revi…`.
 */

/**
 * Shorten to at most `budget` characters, ellipsis included, on a word
 * boundary where there is one. A single unbroken word is cut anyway: over the
 * budget is not an option, and one long token has no boundary to find.
 */
export const clampToWord = (text: string, budget: number): string => {
  if (text.length <= budget) {
    return text;
  }
  const cut = text.slice(0, budget - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
};
