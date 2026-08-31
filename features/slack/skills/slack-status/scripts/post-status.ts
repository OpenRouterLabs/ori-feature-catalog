import { Effect } from "effect";

const MAX_LINE_CHARS = 120;
const MAX_MESSAGE_CHARS = 300;

export type PostStatusOutcome =
  | {
      readonly kind: "posted";
      readonly notified: boolean;
      readonly text: string;
    }
  | { readonly kind: "error"; readonly message: string };

export type StatusEnv = Readonly<Record<string, string | undefined>>;

export interface StatusPane {
  readonly channelId: string;
  readonly threadTs: string;
}

const present = (raw: string | undefined): string | undefined =>
  raw !== undefined && raw !== "" && raw !== "undefined" ? raw : undefined;

const threadFrom = (env: StatusEnv): StatusPane | undefined => {
  const channelId = present(env.SLACK_CHANNEL_ID);
  const threadTs = present(env.SLACK_THREAD_TS);
  return channelId === undefined || threadTs === undefined
    ? undefined
    : {
        channelId,
        threadTs,
      };
};

const overCap = (text: string, notify: boolean): string | undefined => {
  const cap = notify ? MAX_MESSAGE_CHARS : MAX_LINE_CHARS;
  if (text.length <= cap) {
    return undefined;
  }
  return notify
    ? `a message is one short paragraph; ${text.length} characters is too long (max ${cap}) — shorten it and send again`
    : `the indicator is one line Slack never folds; ${text.length} characters is too long (max ${cap}) — trim it, or pass --notify to post the detail as a message`;
};

export const postStatus = async (input: {
  readonly env: StatusEnv;
  readonly notify: boolean;
  readonly postMessage: (input: {
    readonly pane: StatusPane;
    readonly text: string;
  }) => Promise<void>;
  readonly setLine: (input: {
    readonly pane: StatusPane;
    readonly text: string;
  }) => Promise<void>;
  readonly text: string;
}): Promise<PostStatusOutcome> => {
  const text = input.text.trim();
  if (text === "") {
    return {
      kind: "error",
      message: "usage: slack-status <what you found>",
    };
  }

  const thread = threadFrom(input.env);
  if (thread === undefined) {
    return {
      kind: "error",
      message:
        "no Slack thread in scope (SLACK_CHANNEL_ID / SLACK_THREAD_TS unset)",
    };
  }

  const tooLong = overCap(text, input.notify);
  if (tooLong !== undefined) {
    return {
      kind: "error",
      message: tooLong,
    };
  }

  return await Effect.runPromise(
    Effect.tryPromise(async () => {
      if (input.notify) {
        await input.postMessage({
          pane: thread,
          text,
        });
      }
      await input.setLine({
        pane: thread,
        text,
      });
    }).pipe(
      Effect.match({
        onFailure: (error): PostStatusOutcome => ({
          kind: "error",
          message:
            error.cause instanceof Error
              ? error.cause.message
              : String(error.cause),
        }),
        onSuccess: (): PostStatusOutcome => ({
          kind: "posted",
          notified: input.notify,
          text,
        }),
      })
    )
  );
};
