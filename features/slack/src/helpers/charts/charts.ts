const WIDTH = 720;
const ROW_HEIGHT = 28;
const BAR_HEIGHT = 18;
const LABEL_WIDTH = 180;
const VALUE_GAP = 8;
const PADDING = 16;
const TITLE_HEIGHT = 52;
const VALUE_WIDTH = 52;

const TEXT_BASELINE_LIFT = 4;
const MAX_LABEL_CHARS = 28;
const MAX_TITLE_CHARS = 60;

const BACKGROUND = "#1a1d21";
const CARD_STROKE = "#33383f";
const RULE_FILL = "#2c3138";

const TEXT_FILL = "#9aa1ab";
const TITLE_FILL = "#e8eaed";

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

const cardHead = (title: string, width: number, height: number): string =>
  [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect x="0" y="0" width="${width}" height="${height}" fill="${BACKGROUND}" stroke="${CARD_STROKE}" rx="10"/>`,
    `<text x="${PADDING}" y="26" fill="${TITLE_FILL}" font-family="-apple-system, Segoe UI, Helvetica, Arial, sans-serif" font-size="16" font-weight="600">${escape(truncate(title, MAX_TITLE_CHARS))}</text>`,
    `<rect x="${PADDING}" y="36" width="${width - PADDING * 2}" height="1" fill="${RULE_FILL}"/>`,
  ].join("");

export const barChartSvg = (input: {
  readonly rows: readonly ChartRow[];
  readonly title: string;
}): string => {
  const rows = input.rows.filter((row) => Number.isFinite(row.value));
  const height = TITLE_HEIGHT + rows.length * ROW_HEIGHT + PADDING;

  const largest = Math.max(1, ...rows.map((row) => Math.abs(row.value)));
  const barSpace = WIDTH - LABEL_WIDTH - PADDING - VALUE_WIDTH;

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
      `<rect x="${LABEL_WIDTH}" y="${y}" width="${barSpace}" height="${BAR_HEIGHT}" fill="${RULE_FILL}" rx="4"/>`,
      `<rect class="bar" x="${LABEL_WIDTH}" y="${y}" width="${width}" height="${BAR_HEIGHT}" fill="${fill}" rx="4"/>`,
      `<text x="${LABEL_WIDTH + barSpace + VALUE_GAP}" y="${y + BAR_HEIGHT - TEXT_BASELINE_LIFT}" fill="${TITLE_FILL}" font-family="monospace" font-size="13">${row.value}</text>`,
    ].join("");
  });

  return [cardHead(input.title, WIDTH, height), ...bars, "</svg>"].join("");
};
