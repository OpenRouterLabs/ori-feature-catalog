import { unreadable } from "#skills/slack-api/scripts/result.ts";

const DEFAULT_PORT = "3141";

export interface Question {
  readonly choices?: readonly string[];
  readonly id: string;
  readonly kind?: "single" | "multi" | "text";
  readonly optional?: boolean;
  readonly prompt: string;
}

type PostQuestionsOutcome =
  | { readonly kind: "asked" }
  | { readonly kind: "error"; readonly message: string };

export type QuestionsEnv = Readonly<Record<string, string | undefined>>;

const present = (raw: string | undefined): string | undefined =>
  raw !== undefined && raw !== "" && raw !== "undefined" ? raw : undefined;

export const postQuestions = async (input: {
  readonly env: QuestionsEnv;
  readonly fetch: typeof globalThis.fetch;
  readonly intro: string;
  readonly questions: readonly Question[];
}): Promise<PostQuestionsOutcome> => {
  const intro = input.intro.trim();
  if (intro === "" || input.questions.length === 0) {
    return {
      kind: "error",
      message: "an intro and at least one question are required",
    };
  }

  const channel = present(input.env.SLACK_CHANNEL_ID);
  const threadTs = present(input.env.SLACK_THREAD_TS);
  if (channel === undefined || threadTs === undefined) {
    return {
      kind: "error",
      message:
        "no Slack thread in scope (SLACK_CHANNEL_ID / SLACK_THREAD_TS unset)",
    };
  }

  const port = present(input.env.ORI_RUNTIME_PORT) ?? DEFAULT_PORT;
  const response = await input
    .fetch(`http://127.0.0.1:${port}/slack/thread/questions`, {
      body: JSON.stringify({
        channel,
        intro,
        questions: input.questions,
        team: present(input.env.SLACK_TEAM_ID),
        thread_ts: threadTs,
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
  if (response.ok) {
    return { kind: "asked" };
  }
  const reason = await response.text().catch(unreadable);
  return {
    kind: "error",
    message:
      reason === undefined || reason === ""
        ? `slack refused the form (${response.status})`
        : reason,
  };
};
