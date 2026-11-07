/**
 * post-alert.ts — outbound Slack posting for the gh-auth-health schedule.
 *
 * The built-in `slack` chat surface drives interactive turns; it exposes no
 * public posting API to project features. Scheduled features that need to *push*
 * a top-level message call Slack's `chat.postMessage` directly with the bot
 * token. This is one HTTPS request, so it uses `fetch` rather than
 * `@slack/web-api`: the SDK's dependency tree (axios, form-data, get-intrinsic)
 * reaches packages whose `package.json` declares `"main": false`, which Ori's
 * fresh-build package resolver rejected, so the schedule could not be imported
 * at all (ORI-4790).
 */

export interface PostAlertInput {
  /** Channel id to post into. */
  readonly channel: string;
  /** Plain-text / mrkdwn message body. */
  readonly text: string;
}

/**
 * How long one HTTP attempt of the alert post may wait for `slack.com` before it
 * is aborted. Without a deadline a dropped route or wedged proxy to slack.com
 * leaves the post pending forever: the `Effect.catch` that swallows an alert
 * failure (see schedules/gh-auth-health/alert-escape.test.ts) only runs on a
 * SETTLED failure, so the fire stays pending, the runtime skips every later
 * fire, and the schedule whose job is to surface broken GitHub access goes
 * silent in exactly the state it exists to catch. It is a per-attempt bound,
 * not the budget for the whole retry ladder: up to 4 attempts each wait up to
 * this long, plus 200+400+800ms of backoff, so one wedged post settles at about
 * 4 × POST_ALERT_TIMEOUT_MS + 1.4s, while a transient 5xx gets its retries.
 */
export const POST_ALERT_TIMEOUT_MS = 15_000;

/**
 * Network failures, timeouts, 5xx and 429 are retried up to 3 times with
 * exponential backoff (200ms base, factor 2), honouring Slack's `Retry-After`
 * on a 429. A `Retry-After` longer than MAX_RETRY_AFTER_MS ends the post at
 * once rather than retrying inside the window Slack asked us to wait out; the
 * schedule's next fire tries again. A non-ok platform result (`ok: false`,
 * e.g. `invalid_auth`) is Slack's final answer and is never retried, and
 * neither is a 2xx whose body cannot be read: Slack has accepted the request,
 * so a retry could post the alert twice.
 */
const RETRIES = 3;

const BACKOFF_BASE_MS = 200;

const MAX_RETRY_AFTER_MS = 30_000;

const SLACK_API_URL = "https://slack.com/api/";

class RetryableSlackFailure extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number | undefined
  ) {
    super(message);
  }
}

const retryAfterMs = (response: Response): number | undefined => {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
};

const slackError = (body: unknown): string | undefined => {
  if (typeof body !== "object" || body === null) {
    return "the response was not a JSON object";
  }
  if ("ok" in body && body.ok === true) {
    return undefined;
  }
  return "error" in body && typeof body.error === "string"
    ? body.error
    : "unknown error";
};

/**
 * A non-2xx answer that is not retried (a 4xx: a proxy refusing slack.com, a
 * wrong URL, a bad request) is a refusal, never an accepted post, so it reports
 * its HTTP status, plus Slack's `error` when the body carries one.
 */
const refusal = async (response: Response): Promise<Error> => {
  const body: unknown = await response.json().catch(() => undefined);
  const error =
    typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
      ? `: ${body.error}`
      : "";
  return new Error(`Slack chat.postMessage answered HTTP ${response.status}${error}`);
};

const attempt = async (
  url: string,
  token: string,
  input: PostAlertInput,
  timeoutMs: number
): Promise<void> => {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel: input.channel,
        text: input.text,
        unfurl_links: false,
        unfurl_media: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error: unknown) {
    throw new RetryableSlackFailure(
      `Slack chat.postMessage request failed: ${error instanceof Error ? error.message : String(error)}`,
      undefined
    );
  }
  if (response.status === 429 || response.status >= 500) {
    await response.body?.cancel().catch(() => undefined);
    throw new RetryableSlackFailure(
      `Slack chat.postMessage answered HTTP ${response.status}`,
      retryAfterMs(response)
    );
  }
  if (!response.ok) {
    throw await refusal(response);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error: unknown) {
    throw new Error(
      `Slack accepted chat.postMessage (HTTP ${response.status}) but its reply could not be read, so the alert may have been posted: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const error = slackError(body);
  if (error !== undefined) {
    throw new Error(`Slack chat.postMessage failed: ${error}`);
  }
};

/**
 * The bot token, or undefined when `SLACK_BOT_TOKEN` is unset or blank. A
 * whitespace-only value is the same unset shape as "" (an env-file line that
 * kept its padding, a compose interpolation of an unset variable), the way
 * config.ts reads the alert channel: it would send a bare `Bearer` and come
 * back `not_authed`, so the operator chased a Slack auth failure instead of
 * the missing token. The schedule's guards and `postAlert` read it here, so
 * both agree on what "unset" means.
 */
export const readSlackBotToken = (
  // oxlint-disable-next-line node/no-process-env -- SLACK_BOT_TOKEN is systemd-injected service config; callers pass a fake env in tests.
  env: Readonly<Record<string, string | undefined>> = process.env
): string | undefined => {
  const token = env.SLACK_BOT_TOKEN?.trim();
  return token === undefined || token === "" ? undefined : token;
};

/**
 * Post a single top-level (non-threaded) message to a channel. Rejects when
 * `SLACK_BOT_TOKEN` is unset or the Slack API responds with a non-ok result,
 * so callers can decide whether to retry.
 */
export const postAlert = async (
  input: PostAlertInput,
  options: {
    /** Overrides for tests — never set in production. */
    readonly slackApiUrl?: string | undefined;
    readonly requestTimeoutMs?: number | undefined;
  } = {}
): Promise<void> => {
  const token = readSlackBotToken();
  if (token === undefined) {
    throw new Error("SLACK_BOT_TOKEN is not set");
  }
  const url = `${options.slackApiUrl ?? SLACK_API_URL}chat.postMessage`;
  for (let retry = 0; ; retry += 1) {
    try {
      await attempt(url, token, input, options.requestTimeoutMs ?? POST_ALERT_TIMEOUT_MS);
      return;
    } catch (error: unknown) {
      if (!(error instanceof RetryableSlackFailure) || retry >= RETRIES) {
        throw error;
      }
      if (error.retryAfterMs !== undefined && error.retryAfterMs > MAX_RETRY_AFTER_MS) {
        throw new Error(
          `${error.message}: Slack asked to wait ${Math.round(error.retryAfterMs / 1000)}s, longer than this post waits, so it was not retried`
        );
      }
      await Bun.sleep(error.retryAfterMs ?? BACKOFF_BASE_MS * 2 ** retry);
    }
  }
};
