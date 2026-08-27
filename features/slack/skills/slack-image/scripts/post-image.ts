/**
 * post-image.ts — the loopback call behind the `slack-image` skill.
 *
 * Split from the CLI entry so it can be exercised without a daemon, and so the
 * entry stays a thin shell that maps outcomes to exit codes.
 */

import { unreadable } from "#skills/slack-api/scripts/result.ts";

const DEFAULT_PORT = "3141";

type PostImageOutcome =
  | { readonly kind: "posted" }
  | { readonly kind: "error"; readonly message: string };

/** Structural so `Bun.env` passes straight through. */
export type PostImageEnv = Readonly<Record<string, string | undefined>>;

export const postImage = async (input: {
  readonly env: PostImageEnv;
  readonly fetch: typeof globalThis.fetch;
  readonly prompt: string;
  readonly title?: string | undefined;
}): Promise<PostImageOutcome> => {
  const prompt = input.prompt.trim();
  if (prompt === "") {
    return {
      kind: "error",
      message: "usage: slack-image <prompt> [--title …]",
    };
  }

  const channel = input.env.SLACK_CHANNEL_ID ?? "";
  const threadTs = input.env.SLACK_THREAD_TS ?? "";
  if (channel === "" || threadTs === "") {
    return {
      kind: "error",
      message:
        "no Slack thread in scope (SLACK_CHANNEL_ID / SLACK_THREAD_TS unset)",
    };
  }

  const port = input.env.ORI_RUNTIME_PORT ?? DEFAULT_PORT;
  const response = await input
    .fetch(`http://127.0.0.1:${port}/slack/thread/image`, {
      body: JSON.stringify({
        channel,
        prompt,
        team: input.env.SLACK_TEAM_ID,
        thread_ts: threadTs,
        title: input.title,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })
    .catch(unreadable);

  if (response === undefined) {
    return {
      kind: "error",
      message: "could not reach the ori daemon",
    };
  }
  return response.ok
    ? { kind: "posted" }
    : {
        kind: "error",
        message: String(response.status),
      };
};
