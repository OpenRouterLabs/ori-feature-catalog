import { Effect } from "effect";

import type { App, Receiver, ReceiverEvent } from "@slack/bolt";

import { verifySlackRequest } from "@slack/bolt";

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MS_PER_MINUTE = SECONDS_PER_MINUTE * MS_PER_SECOND;
const DEDUP_WINDOW_MINUTES = 5;

const DEDUP_TTL_MS = DEDUP_WINDOW_MINUTES * MS_PER_MINUTE;
const PRUNE_INTERVAL_MS = MS_PER_MINUTE;
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

const eventTypeOf = (body: unknown): string | undefined => {
  if (typeof body !== "object" || body === null) {
    return undefined;
  }
  const inner = (body as { event?: { type?: unknown } }).event?.type;
  if (typeof inner === "string") {
    return inner;
  }
  const outer = (body as { type?: unknown }).type;
  return typeof outer === "string" ? outer : undefined;
};

const readJsonObject = (text: string): Record<string, unknown> | undefined =>
  Effect.runSync(
    Effect.try((): unknown => JSON.parse(text)).pipe(
      Effect.map((parsed) =>
        typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
          ? { ...parsed }
          : undefined
      ),
      Effect.orElseSucceed(() => undefined)
    )
  );

const parseBody = (raw: string): Record<string, unknown> | undefined => {
  const direct = readJsonObject(raw);
  if (direct !== undefined) {
    return direct;
  }

  const form = new URLSearchParams(raw).get("payload");
  return form === null ? undefined : readJsonObject(form);
};

interface SlackRetry {
  readonly num: number | undefined;
  readonly reason: string | undefined;
}

const retryOf = (request: Request): SlackRetry => ({
  num: Number(request.headers.get("x-slack-retry-num") ?? "") || undefined,
  reason: request.headers.get("x-slack-retry-reason") ?? undefined,
});

const elapsedMsSince = (mark: number): number =>
  Math.round(performance.now() - mark);

type ReceiptOutcome =
  | "challenge"
  | "deduped"
  | "dispatched"
  | "errored"
  | "listener_failed"
  | "not_started"
  | "too_large"
  | "unparseable"
  | "unverified";

interface Answer {
  readonly deduped?: boolean | undefined;
  readonly eventId?: string | undefined;
  readonly eventType?: string | undefined;
  readonly outcome: ReceiptOutcome;
  readonly response: Response;
}

interface Receipt {
  readonly at: number;
  readonly mark: number;
}

interface SlackReceiverOptions {
  readonly signingSecret: string;
  readonly logger: {
    readonly error: (message: string, ...rest: readonly unknown[]) => void;
    readonly info: (message: string, ...rest: readonly unknown[]) => void;
    readonly warn: (message: string, ...rest: readonly unknown[]) => void;
  };
}

export class SlackReceiver implements Receiver {
  #app: App | undefined;
  #pruneTimer: ReturnType<typeof setInterval> | undefined;
  readonly #seen = new Map<string, Receipt>();
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
      for (const [id, receipt] of this.#seen) {
        if (receipt.at < cutoff) {
          this.#seen.delete(id);
        }
      }
    }, PRUNE_INTERVAL_MS);
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

  receiptAt(eventId: string): number | undefined {
    return this.#seen.get(eventId)?.mark;
  }

  #release(eventId: string | undefined): void {
    if (eventId !== undefined) {
      this.#seen.delete(eventId);
    }
  }

  #admit(eventId: string | undefined): boolean {
    if (eventId === undefined) {
      return true;
    }
    if (this.#seen.has(eventId)) {
      return false;
    }
    this.#seen.set(eventId, {
      at: Date.now(),
      mark: performance.now(),
    });
    return true;
  }

  async #verifiedBody(
    request: Request
  ): Promise<
    | { readonly raw: string }
    | { readonly outcome: ReceiptOutcome; readonly rejected: Response }
  > {
    const declaredLength = Number(request.headers.get("content-length") ?? "");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      return {
        outcome: "too_large",
        rejected: new Response("payload too large", {
          status: HTTP_PAYLOAD_TOO_LARGE,
        }),
      };
    }

    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) {
      return {
        outcome: "too_large",
        rejected: new Response("payload too large", {
          status: HTTP_PAYLOAD_TOO_LARGE,
        }),
      };
    }

    const signature = request.headers.get("x-slack-signature");
    const timestamp = request.headers.get("x-slack-request-timestamp");
    if (signature === null || timestamp === null) {
      return {
        outcome: "unverified",
        rejected: new Response("missing signature headers", {
          status: HTTP_UNAUTHORIZED,
        }),
      };
    }

    const admitted = Effect.runSync(
      Effect.try(() => {
        verifySlackRequest({
          body: raw,
          headers: {
            "x-slack-request-timestamp": Number(timestamp),
            "x-slack-signature": signature,
          },
          signingSecret: this.#options.signingSecret,
        });
      }).pipe(
        Effect.match({
          onFailure: (error) => {
            this.#options.logger.warn(
              "[slack] rejected unverified request",
              error
            );
            return false;
          },
          onSuccess: () => true,
        })
      )
    );
    if (!admitted) {
      return {
        outcome: "unverified",
        rejected: new Response("invalid signature", {
          status: HTTP_UNAUTHORIZED,
        }),
      };
    }

    return { raw };
  }

  async #answer(request: Request, retry: SlackRetry): Promise<Answer> {
    const app = this.#app;
    if (app === undefined) {
      return {
        outcome: "not_started",
        response: Response.json(
          { error: "slack receiver not started" },
          { status: HTTP_SERVICE_UNAVAILABLE }
        ),
      };
    }

    const verified = await this.#verifiedBody(request);
    if ("rejected" in verified) {
      return {
        outcome: verified.outcome,
        response: verified.rejected,
      };
    }

    const body = parseBody(verified.raw);
    if (body === undefined) {
      return {
        outcome: "unparseable",
        response: new Response("unparseable body", {
          status: HTTP_BAD_REQUEST,
        }),
      };
    }

    if (isUrlVerification(body)) {
      return {
        eventType: body.type,
        outcome: "challenge",
        response: Response.json({ challenge: body.challenge }),
      };
    }

    const eventId = eventIdOf(body);
    const eventType = eventTypeOf(body);
    if (!this.#admit(eventId)) {
      return {
        deduped: true,
        eventId,
        eventType,
        outcome: "deduped",
        response: new Response("", { status: HTTP_OK }),
      };
    }

    const event: ReceiverEvent = {
      ack: () => Promise.resolve(),
      body,
      retryNum: retry.num,
      retryReason: retry.reason,
    };

    const outcome = await Effect.runPromise(
      Effect.tryPromise(() => app.processEvent(event)).pipe(
        Effect.map((): ReceiptOutcome => "dispatched"),
        Effect.catch((error) =>
          Effect.sync((): ReceiptOutcome => {
            this.#release(eventId);
            this.#options.logger.error("[slack] listener failed", error);
            return "listener_failed";
          })
        )
      )
    );

    return {
      eventId,
      eventType,
      outcome,
      response: new Response("", { status: HTTP_OK }),
    };
  }

  async handleRequest(request: Request): Promise<Response> {
    const mark = performance.now();
    const retry = retryOf(request);
    let answer: Answer | undefined;

    try {
      answer = await this.#answer(request, retry);
      return answer.response;
    } finally {
      this.#options.logger.info("[slack] event received", {
        ack_ms: elapsedMsSince(mark),
        deduped: answer?.deduped === true,
        event_id: answer?.eventId,
        event_type: answer?.eventType,
        outcome: answer?.outcome ?? "errored",
        retry_num: retry.num,
        retry_reason: retry.reason,
        status: answer?.response.status,
      });
    }
  }
}
