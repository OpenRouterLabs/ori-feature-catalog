/**
 * post-questions.ts — the loopback call behind the `slack-questions` skill.
 *
 * Posts a form and RETURNS. Nothing here waits: the turn ends, and the answers
 * arrive later as a NEW turn on the same thread, which resumes the same
 * session. That is the whole difference from `slack-ask`, which holds the run
 * for up to fifteen minutes.
 *
 * A question no longer costs a held run. A form left over a weekend costs what
 * an unread message costs, and the thread's queue is free the moment the turn
 * ends.
 *
 * Split from the CLI entry so it can be exercised without a daemon, and so the
 * entry stays a thin shell mapping outcomes to exit codes.
 */

/** A daemon that is not there is reported, not thrown. */
const unreachable = (): undefined => undefined;

const DEFAULT_PORT = "3141";

export interface Question {
  readonly choices?: readonly string[];
  readonly id: string;
  readonly kind?: "single" | "multi" | "text";
  readonly optional?: boolean;
  readonly prompt: string;
}

export type PostQuestionsOutcome =
  | { readonly kind: "asked" }
  | { readonly kind: "error"; readonly message: string };

/** Structural so `Bun.env` passes straight through. */
export type QuestionsEnv = Readonly<Record<string, string | undefined>>;

/**
 * Treat the literal string "undefined" and the empty string as absent.
 *
 * A harness that expands a variable it does not have hands over a blank rather
 * than leaving it unset, and `??` does not catch a blank.
 */
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
    .catch(unreachable);

  if (response === undefined) {
    return {
      kind: "error",
      message: "could not reach the ori daemon",
    };
  }
  if (response.ok) {
    return { kind: "asked" };
  }
  // The route rejects rather than guessing, and its reason is written for a
  // model to act on: hand it back verbatim so the next call can be corrected
  // rather than the words being thrown away.
  const reason = await response.text().catch(unreachable);
  return {
    kind: "error",
    message:
      reason === undefined || reason === ""
        ? `slack refused the form (${response.status})`
        : reason,
  };
};
