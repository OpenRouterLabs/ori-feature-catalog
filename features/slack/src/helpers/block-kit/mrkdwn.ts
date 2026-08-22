/**
 * mrkdwn.ts — GitHub-flavoured markdown into the dialect a `section` speaks.
 *
 * Slack has three markdown dialects and they disagree. The ANSWER goes out
 * through a `markdown` block, which is GitHub-flavoured, so the per-turn
 * prompt teaches the model to write `**bold**` and `[label](url)`. A
 * `section` block is Slack's own `mrkdwn`, which has neither: `**bold**`
 * arrives with the asterisks showing and the link arrives as its own source.
 *
 * So any model-authored text put into a `section` has to be converted first.
 * The blocker question and the questions intro were not, which is why a form
 * could open with `**Two things** before I rebase — see [PR #12](https://…)`
 * printed exactly like that.
 *
 * The escape comes FIRST and is not about formatting: `<!channel>` in a body
 * broadcasts to the workspace, and this is model-authored text that may quote
 * a message the run just read. `slackify-markdown` passes those through
 * untouched, so escaping after conversion would be too late.
 */

import { slackifyMarkdown } from "slackify-markdown";

export const asMrkdwn = (text: string): string =>
  slackifyMarkdown(
    text
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
  ).trim();
