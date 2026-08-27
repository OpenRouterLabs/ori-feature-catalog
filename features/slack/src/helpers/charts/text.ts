/**
 * text.ts — the two string guards every chart shares.
 *
 * Split out so `flow.ts` can use them without importing the bar/table module
 * it has nothing else in common with.
 */

/** Text lands in markup, so anything that could close a tag must not. */
export const escape = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

export const truncate = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`;
