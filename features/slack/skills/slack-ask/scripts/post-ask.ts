import { Option, Schema } from "effect";

import { unreadable } from "#skills/slack-api/scripts/result.ts";

const DEFAULT_PORT = "3141";
const HTTP_TIMEOUT = 408;

export interface AskChoice {
  readonly id: string;
  readonly label: string;
}

type PostAskOutcome =
  | { readonly kind: "answered"; readonly answer: string }
  | { readonly kind: "unanswered" }
  | { readonly kind: "error"; readonly message: string };

type PostAskEnv = Readonly<Record<string, string | undefined>>;

export const parseChoice = (raw: string): AskChoice | undefined => {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return undefined;
  }
  const split = trimmed.indexOf("=");
  if (split === -1) {
    return {
      id: trimmed,
      label: trimmed,
    };
  }
  const id = trimmed.slice(0, split).trim();
  const label = trimmed.slice(split + 1).trim();
  return id === "" || label === ""
    ? undefined
    : {
        id,
        label,
      };
};

const AnswerBody = Schema.Struct({
  answer: Schema.NonEmptyString,
});
const decodeAnswer = Schema.decodeUnknownOption(AnswerBody);

const readAnswer = async (response: Response): Promise<PostAskOutcome> => {
  const body: unknown = await response.json().catch(() => null);
  return Option.match(decodeAnswer(body), {
    onNone: (): PostAskOutcome => ({
      kind: "error",
      message: "the daemon answered without an answer",
    }),
    onSome: (decoded): PostAskOutcome => ({
      answer: decoded.answer,
      kind: "answered",
    }),
  });
};

export const postAsk = async (input: {
  readonly choices: readonly AskChoice[];
  readonly env: PostAskEnv;
  readonly fetch: typeof globalThis.fetch;
  readonly question: string;
}): Promise<PostAskOutcome> => {
  const question = input.question.trim();
  if (question === "") {
    return {
      kind: "error",
      message: "usage: slack-ask <question> [--choice id=Label ...]",
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
    .fetch(`http://127.0.0.1:${port}/slack/thread/ask`, {
      body: JSON.stringify({
        channel,
        choices: input.choices,
        question,
        team: input.env.SLACK_TEAM_ID,
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
  if (response.status === HTTP_TIMEOUT) {
    return { kind: "unanswered" };
  }
  if (response.ok) {
    return await readAnswer(response);
  }
  const reason = await response.text().catch(() => "");
  return {
    kind: "error",
    message: reason === "" ? String(response.status) : reason,
  };
};
