import { Effect, Result, Schema } from "effect";

import type { App, Receiver, ReceiverEvent } from "@slack/bolt";

import { verifySlackRequest } from "@slack/bolt";

import { functionSchema, opaqueSchema } from "#src/schema-support.ts";

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

const UrlVerificationSchema = Schema.Struct({
  challenge: Schema.String,
  type: Schema.Literals(["url_verification"]),
});

type UrlVerification = typeof UrlVerificationSchema.Type;

const decodeUrlVerification = Schema.decodeUnknownResult(UrlVerificationSchema);

const isUrlVerification = (body: unknown): body is UrlVerification =>
  Result.isSuccess(decodeUrlVerification(body));

const EventEnvelopeSchema = Schema.Struct({
  event: Schema.optionalKey(
    Schema.Struct({ type: Schema.optionalKey(Schema.String) })
  ),
  event_id: Schema.optionalKey(Schema.String),
  type: Schema.optionalKey(Schema.String),
});

const decodeEventEnvelope = Schema.decodeUnknownResult(EventEnvelopeSchema);

const eventIdOf = (body: unknown): string | undefined => {
  const decoded = decodeEventEnvelope(body);
  return Result.isSuccess(decoded) ? decoded.success.event_id : undefined;
};

/**
 * The inner `event.type` names what happened; the outer `type` names the
 * envelope, and only stands in when there is no inner event to read.
 */
const eventTypeOf = (body: unknown): string | undefined => {
  const decoded = decodeEventEnvelope(body);
  if (Result.isFailure(decoded)) {
    return undefined;
  }
  return decoded.success.event?.type ?? decoded.success.type;
};

const decodeJsonObject = Schema.decodeUnknownResult(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
);

const readJsonObject = (text: string): Record<string, unknown> | undefined => {
  const decoded = decodeJsonObject(text);
  return Result.isFailure(decoded) ? undefined : { ...decoded.success };
};

const parseBody = (raw: string): Record<string, unknown> | undefined => {
  const direct = readJsonObject(raw);
  if (direct !== undefined) {
    return direct;
  }

  const form = new URLSearchParams(raw).get("payload");
  return form === null ? undefined : readJsonObject(form);
};

const SlackRetrySchema = Schema.Struct({
  num: Schema.UndefinedOr(Schema.Number),
  reason: Schema.UndefinedOr(Schema.String),
});

type SlackRetry = typeof SlackRetrySchema.Type;

const retryOf = (request: Request): SlackRetry => ({
  num: Number(request.headers.get("x-slack-retry-num") ?? "") || undefined,
  reason: request.headers.get("x-slack-retry-reason") ?? undefined,
});

const elapsedMsSince = (mark: number): number =>
  Math.round(performance.now() - mark);

const ReceiptOutcomeSchema = Schema.Literals([
  "challenge",
  "deduped",
  "dispatched",
  "errored",
  "listener_failed",
  "not_started",
  "too_large",
  "unparseable",
  "unverified",
]);

type ReceiptOutcome = typeof ReceiptOutcomeSchema.Type;

const AnswerSchema = Schema.Struct({
  deduped: Schema.optionalKey(Schema.UndefinedOr(Schema.Boolean)),
  eventId: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
  eventType: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
  outcome: ReceiptOutcomeSchema,
  response: opaqueSchema<Response>("Answer.response"),
});

type Answer = typeof AnswerSchema.Type;

const ReceiptSchema = Schema.Struct({
  at: Schema.Number,
  mark: Schema.Number,
});

type Receipt = typeof ReceiptSchema.Type;

const logLevelSchema = (level: string) =>
  functionSchema<(message: string, ...rest: readonly unknown[]) => void>(
    `SlackReceiverOptions.logger.${level}`
  );

const SlackReceiverOptionsSchema = Schema.Struct({
  signingSecret: Schema.String,
  logger: Schema.Struct({
    error: logLevelSchema("error"),
    // The per-event receipt line is written here, so `info` joins the levels
    // the receiver already needed.
    info: logLevelSchema("info"),
    warn: logLevelSchema("warn"),
  }),
});

type SlackReceiverOptions = typeof SlackReceiverOptionsSchema.Type;

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
