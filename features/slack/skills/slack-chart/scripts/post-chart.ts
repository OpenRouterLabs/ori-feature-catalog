import { Result, Schema } from "effect";

import { unreadable } from "#skills/slack-api/scripts/result.ts";

const DEFAULT_PORT = "3141";

const readErrorDetail = async (
  response: Response
): Promise<string | undefined> => {
  const body: unknown = await response.json().catch(unreadable);
  if (typeof body !== "object" || body === null) {
    return undefined;
  }
  const { error } = body as { readonly error?: unknown };
  return typeof error === "string" && error !== "" ? error : undefined;
};

type PostChartOutcome =
  | { readonly kind: "posted" }
  | { readonly kind: "error"; readonly message: string };

export type PostChartEnv = Readonly<Record<string, string | undefined>>;

const decodeSpecJson = Schema.decodeUnknownResult(Schema.UnknownFromJsonString);

const decodeSpecObject = Schema.decodeUnknownResult(
  Schema.Record(Schema.String, Schema.Unknown)
);

export const postChart = async (input: {
  readonly env: PostChartEnv;
  readonly fetch: typeof globalThis.fetch;
  readonly spec: string;
}): Promise<PostChartOutcome> => {
  const channel = input.env.SLACK_CHANNEL_ID ?? "";
  const threadTs = input.env.SLACK_THREAD_TS ?? "";
  if (channel === "" || threadTs === "") {
    return {
      kind: "error",
      message:
        "no Slack thread in scope (SLACK_CHANNEL_ID / SLACK_THREAD_TS unset)",
    };
  }

  const json = decodeSpecJson(input.spec);
  if (Result.isFailure(json)) {
    return {
      kind: "error",
      message: "the spec must be JSON",
    };
  }
  const decodedSpec = decodeSpecObject(json.success);
  if (Result.isFailure(decodedSpec)) {
    return {
      kind: "error",
      message: "the spec must be a JSON object",
    };
  }
  const spec = decodedSpec.success;

  const port = input.env.ORI_RUNTIME_PORT ?? DEFAULT_PORT;
  const response = await input
    .fetch(`http://127.0.0.1:${port}/slack/thread/chart`, {
      body: JSON.stringify({
        ...spec,
        channel,
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
  if (response.ok) {
    return { kind: "posted" };
  }

  const detail = await readErrorDetail(response);
  return {
    kind: "error",
    message:
      detail === undefined
        ? String(response.status)
        : `${response.status} — ${detail}`,
  };
};
