/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively; the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */
/**
 * page.ts — what the surface remembers, on one page.
 *
 * The thread state this feature keeps is otherwise only observable one thread
 * at a time, from inside a turn that already knows which thread it is in.
 * Nothing could answer "which threads is the bot still following, and which
 * did somebody mute three days ago and forget" — so nobody asked, and muted
 * threads accumulated silently.
 *
 * Rendered as a string rather than through a view library on purpose. This
 * feature is linked into other people's workspaces, so every dependency it
 * declares is installed by every consumer of it; a table is not worth putting
 * React into all of them. The ori dashboard scaffold renders with React
 * because it is a standalone feature that costs nobody else anything.
 *
 * Pure, and separated from the route for it: the interesting failure is
 * markup, not HTTP, and this way a test asserts on the markup directly.
 */

import type { ThreadRow } from "../state/store.ts";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** How often the page re-reads itself, in seconds. */
const REFRESH_SECONDS = 10;

/**
 * Everything interpolated goes through this.
 *
 * Slack ids are tame, but they are not this feature's to vouch for: a channel
 * name reaches the store from the workspace, and the one place it is rendered
 * as markup is the one place that matters.
 */
const escapeHtml = (raw: string): string =>
  raw
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

/**
 * Age in the largest unit that still says something true.
 *
 * "4320m" is technically the answer and tells a reader nothing; three days is
 * the fact they are looking for.
 */
export const ago = (from: number, now: number): string => {
  const elapsed = Math.max(0, now - from);
  if (elapsed < MINUTE_MS) {
    return "just now";
  }
  if (elapsed < HOUR_MS) {
    return `${Math.floor(elapsed / MINUTE_MS)}m ago`;
  }
  if (elapsed < DAY_MS) {
    return `${Math.floor(elapsed / HOUR_MS)}h ago`;
  }
  return `${Math.floor(elapsed / DAY_MS)}d ago`;
};

/**
 * The labels a thread carries, in the order an operator scans for them.
 *
 * `muted` first because it is the one that explains silence, which is the
 * question that brings someone to this page.
 */
const badgesOf = (row: ThreadRow): readonly string[] => {
  const badges: string[] = [];
  if (row.listen.muted) {
    badges.push("muted");
  }
  if (row.listen.engaged) {
    badges.push("engaged");
  }
  if (row.listen.suppressed) {
    badges.push("unmuted");
  }
  return badges;
};

/**
 * Newest first, and threads with no session last.
 *
 * A thread the bot has never answered has no `startedAt` to sort by, and
 * putting it at the top would push live conversations off the first screen.
 */
const byRecency = (left: ThreadRow, right: ThreadRow): number =>
  (right.session?.startedAt ?? 0) - (left.session?.startedAt ?? 0);

const rowMarkup = (row: ThreadRow, now: number): string => {
  const badges = badgesOf(row)
    .map((badge) => `<span class="badge ${badge}">${badge}</span>`)
    .join(" ");
  const participants = row.listen.participants.size;
  return `<tr>
      <td class="mono">${escapeHtml(row.instanceId)}</td>
      <td class="mono dim">${
        row.session === undefined
          ? "&mdash;"
          : escapeHtml(row.session.sessionId)
      }</td>
      <td>${
        row.session === undefined
          ? '<span class="dim">never answered</span>'
          : escapeHtml(ago(row.session.startedAt, now))
      }</td>
      <td>${badges === "" ? '<span class="dim">&mdash;</span>' : badges}</td>
      <td class="num">${participants}</td>
    </tr>`;
};

const STYLE = `
  :root { color-scheme: light dark; --fg: #1a1a1a; --dim: #6b6b6b; --line: #e3e3e3; --bg: #fff; --chip: #f0f0f0; }
  @media (prefers-color-scheme: dark) {
    :root { --fg: #e8e8e8; --dim: #8d8d8d; --line: #2c2c2c; --bg: #131313; --chip: #232323; }
  }
  body { background: var(--bg); color: var(--fg); font: 14px/1.5 system-ui, sans-serif; margin: 0; padding: 2rem; }
  h1 { font-size: 1.1rem; margin: 0 0 .25rem; }
  .sub { color: var(--dim); margin: 0 0 1.5rem; }
  .wrap { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; min-width: 40rem; }
  th { text-align: left; font-weight: 600; color: var(--dim); font-size: .75rem;
       text-transform: uppercase; letter-spacing: .04em; padding: 0 .75rem .5rem 0; }
  td { border-top: 1px solid var(--line); padding: .6rem .75rem .6rem 0; vertical-align: top; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .82rem; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .dim { color: var(--dim); }
  .badge { display: inline-block; background: var(--chip); border-radius: 999px;
           padding: .1rem .5rem; font-size: .72rem; }
  .badge.muted { background: #b4331f; color: #fff; }
  .empty { color: var(--dim); padding: 2rem 0; }
`;

/**
 * The whole page.
 *
 * `now` is passed rather than read so the test that pins the ages is not a
 * test of the clock.
 */
export const renderDashboard = (
  rows: readonly ThreadRow[],
  now: number
): string => {
  const sorted = [...rows].sort(byRecency);
  const engaged = sorted.filter((row) => row.listen.engaged).length;
  const muted = sorted.filter((row) => row.listen.muted).length;

  const body =
    sorted.length === 0
      ? `<p class="empty">No threads yet. This fills in once the bot is spoken to.</p>`
      : `<div class="wrap"><table>
      <thead><tr>
        <th>Thread</th><th>Session</th><th>Last started</th><th>State</th><th class="num">People</th>
      </tr></thead>
      <tbody>${sorted.map((row) => rowMarkup(row, now)).join("")}</tbody>
    </table></div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="${REFRESH_SECONDS}">
<title>Slack surface</title>
<style>${STYLE}</style>
</head>
<body>
<h1>Slack surface</h1>
<p class="sub">${sorted.length} thread${sorted.length === 1 ? "" : "s"} &middot; ${engaged} engaged &middot; ${muted} muted</p>
${body}
</body>
</html>
`;
};
