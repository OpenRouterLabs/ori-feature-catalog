/**
 * receiver.ts — Slack Events API ingress on Bun.
 *
 * Bolt's own receivers assume a Node HTTP server; the daemon already owns one,
 * so this implements Bolt's `Receiver` interface instead and hands events to
 * `App.processEvent`. That is Bolt's documented extension point — everything
 * downstream (listener registration, middleware, routing) is unchanged.
 *
 * Three things this owns, all of them required by Slack's delivery contract:
 *
 *   - Signature verification over the EXACT request bytes. Parsing first and
 *     re-serialising changes them, so the body is read once as text.
 *   - The 3-second acknowledgement. An agent turn takes far longer, so the
 *     handler resolves the ack as soon as the event is admitted and lets the
 *     work continue on its own fiber.
 *   - Deduplication by `event_id`. Slack retries anything it considers failed
 *     or slow, so at-least-once delivery is the contract; without this a retry
 *     starts a second agent run.
 */

import type { App, Receiver, ReceiverEvent } from "@slack/bolt";

import { verifySlackRequest } from "@slack/bolt";

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MS_PER_MINUTE = SECONDS_PER_MINUTE * MS_PER_SECOND;
const DEDUP_WINDOW_MINUTES = 5;

/** Slack's own replay window. Matches the timestamp check it enforces. */
const DEDUP_TTL_MS = DEDUP_WINDOW_MINUTES * MS_PER_MINUTE;
const PRUNE_INTERVAL_MS = MS_PER_MINUTE;
/** Slack payloads are far smaller; this caps a hostile body. */
const MAX_BODY_BYTES = 1_000_000;

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const HTTP_SERVICE_UNAVAILABLE = 503;

interface UrlVerification {
  readonly challenge: string;
  readonly type: "url_verification";
}

const isUrlVerification = (body: unknown): body is UrlVerification =>
  typeof body === "object" &&
  body !== null &&
  (body as { type?: unknown }).type === "url_verification" &&
  typeof (body as { challenge?: unknown }).challenge === "string";

const eventIdOf = (body: unknown): string | undefined => {
  if (typeof body !== "object" || body === null) {
    return undefined;
  }
  const id = (body as { event_id?: unknown }).event_id;
  return typeof id === "string" ? id : undefined;
};

/**
 * `JSON.parse` is typed `any`, so its result is taken as `unknown` and narrowed
 * once here rather than asserted at each use.
 */
const readJsonObject = (text: string): Record<string, unknown> | undefined => {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? { ...parsed }
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Slack sends two encodings on this one endpoint: events arrive as JSON, while
 * interactivity and slash commands arrive form-encoded with the JSON in a
 * `payload` field. Both reduce to one object, or to nothing.
 */
const parseBody = (raw: string): Record<string, unknown> | undefined => {
  const direct = readJsonObject(raw);
  if (direct !== undefined) {
    return direct;
  }

  const form = new URLSearchParams(raw).get("payload");
  return form === null ? undefined : readJsonObject(form);
};

export interface SlackReceiverOptions {
  readonly signingSecret: string;
  readonly logger: {
    readonly error: (message: string, ...rest: readonly unknown[]) => void;
    readonly warn: (message: string, ...rest: readonly unknown[]) => void;
  };
}

/**
 * A Bolt `Receiver` fed by `handleRequest`. The daemon's route handler calls
 * `handleRequest`; Bolt calls `init`/`start`/`stop`.
 */
export class SlackReceiver implements Receiver {
  #app: App | undefined;
  #pruneTimer: ReturnType<typeof setInterval> | undefined;
  readonly #seen = new Map<string, number>();
  readonly #options: SlackReceiverOptions;

  constructor(options: SlackReceiverOptions) {
    this.#options = options;
  }

  init(app: App): void {
    this.#app = app;
  }

  start(): Promise<void> {
    this.#pruneTimer ??= setInterval(() => {
      const cutoff = Date.now() - DEDUP_TTL_MS;
      for (const [id, at] of this.#seen) {
        if (at < cutoff) {
          this.#seen.delete(id);
        }
      }
    }, PRUNE_INTERVAL_MS);
    // Do not hold the process open for a cache sweep.
    this.#pruneTimer.unref?.();
    return Promise.resolve();
  }

  stop(): Promise<void> {
    if (this.#pruneTimer !== undefined) {
      clearInterval(this.#pruneTimer);
      this.#pruneTimer = undefined;
    }
    this.#seen.clear();
    this.#app = undefined;
    return Promise.resolve();
  }

  /** Undo an admission so Slack's retry gets a real second chance. */
  #release(eventId: string | undefined): void {
    if (eventId !== undefined) {
      this.#seen.delete(eventId);
    }
  }

  /** True the first time an id is seen; false for a Slack retry. */
  #admit(eventId: string | undefined): boolean {
    if (eventId === undefined) {
      return true;
    }
    if (this.#seen.has(eventId)) {
      return false;
    }
    this.#seen.set(eventId, Date.now());
    return true;
  }

  /**
   * Read the body and prove it came from Slack, or answer why not.
   *
   * The length is checked from the header BEFORE `request.text()`, which
   * buffers the whole body into memory — validating after reading lets a
   * hostile sender make the daemon allocate however much it likes.
   */
  async #verifiedBody(
    request: Request
  ): Promise<{ readonly raw: string } | { readonly rejected: Response }> {
    const declaredLength = Number(request.headers.get("content-length") ?? "");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      return {
        rejected: new Response("payload too large", {
          status: HTTP_PAYLOAD_TOO_LARGE,
        }),
      };
    }

    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) {
      return {
        rejected: new Response("payload too large", {
          status: HTTP_PAYLOAD_TOO_LARGE,
        }),
      };
    }

    const signature = request.headers.get("x-slack-signature");
    const timestamp = request.headers.get("x-slack-request-timestamp");
    if (signature === null || timestamp === null) {
      return {
        rejected: new Response("missing signature headers", {
          status: HTTP_UNAUTHORIZED,
        }),
      };
    }

    try {
      verifySlackRequest({
        body: raw,
        headers: {
          "x-slack-request-timestamp": Number(timestamp),
          "x-slack-signature": signature,
        },
        signingSecret: this.#options.signingSecret,
      });
    } catch (error) {
      this.#options.logger.warn("[slack] rejected unverified request", error);
      return {
        rejected: new Response("invalid signature", {
          status: HTTP_UNAUTHORIZED,
        }),
      };
    }

    return { raw };
  }

  async handleRequest(request: Request): Promise<Response> {
    const app = this.#app;
    if (app === undefined) {
      return Response.json(
        { error: "slack receiver not started" },
        { status: HTTP_SERVICE_UNAVAILABLE }
      );
    }

    const verified = await this.#verifiedBody(request);
    if ("rejected" in verified) {
      return verified.rejected;
    }

    const body = parseBody(verified.raw);
    if (body === undefined) {
      return new Response("unparseable body", { status: HTTP_BAD_REQUEST });
    }

    if (isUrlVerification(body)) {
      return Response.json({ challenge: body.challenge });
    }

    const eventId = eventIdOf(body);
    if (!this.#admit(eventId)) {
      // Already handled. 200 so Slack stops retrying.
      return new Response("", { status: HTTP_OK });
    }

    // Bolt calls `ack` as soon as it has admitted the event; the listener
    // keeps running well past the 3-second window. Slack only needs the 200,
    // so resolving immediately is the whole contract.
    const event: ReceiverEvent = {
      ack: () => Promise.resolve(),
      body,
      retryNum:
        Number(request.headers.get("x-slack-retry-num") ?? "") || undefined,
      retryReason: request.headers.get("x-slack-retry-reason") ?? undefined,
    };

    try {
      await app.processEvent(event);
    } catch (error) {
      // The id was claimed before dispatch so concurrent duplicates collapse.
      // Keeping it claimed after a failure would make Slack's retry a no-op
      // and lose the message outright, so give the retry a real chance.
      this.#release(eventId);
      this.#options.logger.error("[slack] listener failed", error);
    }

    return new Response("", { status: HTTP_OK });
  }
}
