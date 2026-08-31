import { slackifyMarkdown } from "slackify-markdown";

export const asMrkdwn = (text: string): string =>
  slackifyMarkdown(
    text
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
  ).trim();
