/**
 * charts.ts — a bar chart as an SVG, for an answer a paragraph cannot carry.
 *
 * SVG because it is a string. A raster image would mean either a rendering
 * dependency or shipping the workspace's data to an external chart service,
 * and neither is worth it for a bar chart — this is a few hundred bytes of
 * markup built in-process, with nothing to install and nothing sent anywhere.
 *
 * Slack renders no diagram syntax, so a shape across
 * more than a handful of rows has nowhere good to live in a message. Uploading
 * one is the only way to show shape rather than describe it.
 *
 * Deliberately one chart type. A helper that draws everything is a plotting
 * library, and the moment an answer needs a second axis it wants a real one.
 */

const WIDTH = 720;
const ROW_HEIGHT = 28;
const BAR_HEIGHT = 18;
const LABEL_WIDTH = 180;
const VALUE_GAP = 8;
const PADDING = 16;
/** Content starts below the title and the rule under it, never on top of them. */
const TITLE_HEIGHT = 52;
/** Reserved at the right so a full-length bar's value is not clipped off. */
const VALUE_WIDTH = 52;

/** Baseline sits a few px above the bar's bottom edge so text reads centred. */
const TEXT_BASELINE_LIFT = 4;
const MAX_LABEL_CHARS = 28;
const MAX_TITLE_CHARS = 60;

/**
 * A dark card, drawn explicitly.
 *
 * Without a background rect the PNG is transparent, so Slack composites it
 * against whatever the reader's theme is — grey text on white in light mode,
 * and a washed-out plate in dark. Owning the background is what makes a chart
 * look drawn rather than leaked.
 */
const BACKGROUND = "#1a1d21";
const CARD_STROKE = "#33383f";
const RULE_FILL = "#2c3138";

const TEXT_FILL = "#9aa1ab";
const TITLE_FILL = "#e8eaed";

/**
 * Ramped so magnitude reads before any number does — the brightest bar is the
 * biggest, and a stack darkens as it descends. A single flat fill made every
 * chart the same picture with different lengths.
 */
const RAMP = [
  "#5eb0ff",
  "#5aa0f5",
  "#5f8fe8",
  "#6b7edb",
  "#7a6dcd",
  "#8a5dbe",
] as const;

const rampAt = (index: number, total: number): string => {
  if (total <= 1) {
    return RAMP[0];
  }
  const step = Math.round((index / (total - 1)) * (RAMP.length - 1));
  return RAMP[Math.min(RAMP.length - 1, Math.max(0, step))] ?? RAMP[0];
};

import { escape, truncate } from "./text.ts";

interface ChartRow {
  readonly label: string;
  readonly value: number;
}

/** Opening markup every chart shares: the card, its title, and the rule under it. */
const cardHead = (title: string, width: number, height: number): string =>
  [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect x="0" y="0" width="${width}" height="${height}" fill="${BACKGROUND}" stroke="${CARD_STROKE}" rx="10"/>`,
    `<text x="${PADDING}" y="26" fill="${TITLE_FILL}" font-family="-apple-system, Segoe UI, Helvetica, Arial, sans-serif" font-size="16" font-weight="600">${escape(truncate(title, MAX_TITLE_CHARS))}</text>`,
    `<rect x="${PADDING}" y="36" width="${width - PADDING * 2}" height="1" fill="${RULE_FILL}"/>`,
  ].join("");

/**
 * A horizontal bar chart.
 *
 * Bars are scaled to the largest value rather than to a fixed axis, because
 * the question an answer asks of a chart is almost always "which is biggest",
 * not "what is the absolute number" — the number is printed anyway.
 */
export const barChartSvg = (input: {
  readonly rows: readonly ChartRow[];
  readonly title: string;
}): string => {
  const rows = input.rows.filter((row) => Number.isFinite(row.value));
  const height = TITLE_HEIGHT + rows.length * ROW_HEIGHT + PADDING;

  const largest = Math.max(1, ...rows.map((row) => Math.abs(row.value)));
  // The value sits in its own column rather than after the bar: placed at the
  // bar's end, the longest bar pushed its own number off the card.
  const barSpace = WIDTH - LABEL_WIDTH - PADDING - VALUE_WIDTH;

  // Ranked, so colour carries magnitude independently of length.
  const ranked = [...rows]
    .toSorted((left, right) => Math.abs(right.value) - Math.abs(left.value))
    .map((row) => row.label);

  const bars = rows.map((row, index) => {
    const y = TITLE_HEIGHT + index * ROW_HEIGHT;
    const width = Math.max(2, (Math.abs(row.value) / largest) * barSpace);
    const label = escape(truncate(row.label, MAX_LABEL_CHARS));
    const fill = rampAt(ranked.indexOf(row.label), rows.length);
    return [
      `<text x="${PADDING}" y="${y + BAR_HEIGHT - TEXT_BASELINE_LIFT}" fill="${TEXT_FILL}" font-family="monospace" font-size="13">${label}</text>`,
      // The track shows the full span, so a short bar still reads as a share.
      `<rect x="${LABEL_WIDTH}" y="${y}" width="${barSpace}" height="${BAR_HEIGHT}" fill="${RULE_FILL}" rx="4"/>`,
      `<rect class="bar" x="${LABEL_WIDTH}" y="${y}" width="${width}" height="${BAR_HEIGHT}" fill="${fill}" rx="4"/>`,
      `<text x="${LABEL_WIDTH + barSpace + VALUE_GAP}" y="${y + BAR_HEIGHT - TEXT_BASELINE_LIFT}" fill="${TITLE_FILL}" font-family="monospace" font-size="13">${row.value}</text>`,
    ].join("");
  });

  return [cardHead(input.title, WIDTH, height), ...bars, "</svg>"].join("");
};
