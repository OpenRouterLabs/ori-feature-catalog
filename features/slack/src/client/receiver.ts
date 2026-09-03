import { Effect, Result, Schema } from "effect";

import type { App, Receiver, ReceiverEvent } from "@slack/bolt";

import { verifySlackRequest } from "@slack/bolt";

import { functionSchema } from "#src/schema-support.ts";

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
  event_id: Schema.optionalKey(Schema.String),
});

const decodeEventEnvelope = Schema.decodeUnknownResult(EventEnvelopeSchema);

const eventIdOf = (body: unknown): string | undefined => {
  const decoded = decodeEventEnvelope(body);
  return Result.isSuccess(decoded) ? decoded.success.event_id : undefined;
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

const SlackReceiverOptionsSchema = Schema.Struct({
  signingSecret: Schema.String,
  logger: Schema.Struct({
    error:
      functionSchema<(message: string, ...rest: readonly unknown[]) => void>(
        "SlackReceiverOptions.logger.error"
      ),
    warn:
      functionSchema<(message: string, ...rest: readonly unknown[]) => void>(
        "SlackReceiverOptions.logger.warn"
      ),
  }),
});

type SlackReceiverOptions = typeof SlackReceiverOptionsSchema.Type;

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
    this.#seen.set(eventId, Date.now());
    return true;
  }

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
      return new Response("", { status: HTTP_OK });
    }

    const event: ReceiverEvent = {
      ack: () => Promise.resolve(),
      body,
      retryNum:
        Number(request.headers.get("x-slack-retry-num") ?? "") || undefined,
      retryReason: request.headers.get("x-slack-retry-reason") ?? undefined,
    };

    await Effect.runPromise(
      Effect.tryPromise(() => app.processEvent(event)).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            this.#release(eventId);
            this.#options.logger.error("[slack] listener failed", error);
          })
        )
      )
    );

    return new Response("", { status: HTTP_OK });
  }
}
