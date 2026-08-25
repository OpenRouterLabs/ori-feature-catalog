/**
 * post-ask.ts — the loopback call behind the `slack-ask` skill.
 *
 * Split from the CLI entry so it can be exercised without a daemon, and so the
 * entry stays a thin shell that maps outcomes to exit codes.
 *
 * This call BLOCKS. The route holds the response until someone clicks, which is
 * what lets the agent treat a blocker as a function that returns an answer.
 */

import { Option, Schema } from "effect";

import { unreadable } from "#skills/slack-api/scripts/result.ts";

const DEFAULT_PORT = "3141";
const HTTP_TIMEOUT = 408;

export interface AskChoice {
  readonly id: string;
  readonly label: string;
}

export type PostAskOutcome =
  | { readonly kind: "answered"; readonly answer: string }
  | { readonly kind: "unanswered" }
  | { readonly kind: "error"; readonly message: string };

/** Structural so `Bun.env` passes straight through. */
export type PostAskEnv = Readonly<Record<string, string | undefined>>;

/**
 * Parse `id=Label` pairs into choices.
 *
 * The id is what comes back to the agent, and the label is what the reader
 * sees. A bare word is both, so `rebase` and `rebase=Rebase them` both work.
 */
export const parseChoice = (raw: string): AskChoice | undefined => {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return undefined;
  }
  // -1 is "no separator, so the word is both". 0 is "=Label", which names no
  // id at all and would post a button whose answer means nothing.
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
  // Nobody answered in time. The agent is told to decide for itself, which is
  // better than hanging and better than silently guessing.
  if (response.status === HTTP_TIMEOUT) {
    return { kind: "unanswered" };
  }
  if (response.ok) {
    return await readAnswer(response);
  }
  // The route writes its reason for a model to act on — "a blocker needs at
  // least one choice", "more than Slack lays out in a row". Reporting the bare
  // status threw that away and left the agent with `slack-ask: 502`.
  const reason = await response.text().catch(() => "");
  return {
    kind: "error",
    message: reason === "" ? String(response.status) : reason,
  };
};
