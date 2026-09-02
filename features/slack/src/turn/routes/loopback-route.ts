import { Effect, Result, Schema } from "effect";

import type { ThreadRef } from "#src/thread/thread.ts";

import { functionSchema } from "#src/schema-support.ts";

const BYTES_PER_KIB = 1024;

const HTTP_BAD_REQUEST = 400;
const HTTP_PAYLOAD_TOO_LARGE = 413;

const RefusalSchema = Schema.Struct({
  error: Schema.String,
  status: Schema.Number,
});

export type Refusal = typeof RefusalSchema.Type;

export const refuse = (
  status: number,
  error: string
): Result.Result<never, Refusal> =>
  Result.fail({
    error,
    status,
  });

export const threadFields = {
  channel: Schema.String,
  team: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
  thread_ts: Schema.String,
} as const;

export const AddressedSchema = Schema.Struct({
  channel: Schema.String,
  team: Schema.UndefinedOr(Schema.String),
  threadTs: Schema.String,
});

export type Addressed = typeof AddressedSchema.Type;

const alreadyGone = (): undefined => undefined;

const decodeJson = Schema.decodeUnknownResult(Schema.UnknownFromJsonString);

const jsonOrNull = (raw: string): unknown =>
  Result.getOrElse(decodeJson(raw), () => null);

const readCapped = Effect.fn("Slack.loopback.readBody")(function* (
  request: Request,
  capBytes: number
): Effect.fn.Return<Result.Result<unknown, Refusal>> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > capBytes) {
    return refuse(HTTP_PAYLOAD_TOO_LARGE, "payload too large");
  }

  const { body } = request;
  if (body === null) {
    return Result.succeed(null);
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let raw = "";
  for (;;) {
    const chunk = yield* Effect.promise(() => reader.read());
    if (chunk.done) {
      break;
    }
    size += chunk.value.byteLength;
    if (size > capBytes) {
      yield* Effect.promise(() => reader.cancel().catch(alreadyGone));
      return refuse(HTTP_PAYLOAD_TOO_LARGE, "payload too large");
    }
    raw += decoder.decode(chunk.value, { stream: true });
  }
  raw += decoder.decode();

  return Result.succeed(jsonOrNull(raw));
});

const loopbackSpecSchema = <
  TRequest extends Addressed,
  TOutput extends object,
>() =>
  Schema.Struct({
    capKiB: Schema.Number,
    handle: functionSchema<
      (input: {
        readonly ref: ThreadRef;
        readonly request: TRequest;
      }) => Effect.Effect<Result.Result<TOutput, Refusal>>
    >("LoopbackSpec.handle"),
    parse: functionSchema<(raw: unknown) => Result.Result<TRequest, string>>(
      "LoopbackSpec.parse"
    ),
    workspaceTeamId: Schema.String,
  });

type LoopbackSpec<
  TRequest extends Addressed,
  TOutput extends object,
> = ReturnType<typeof loopbackSpecSchema<TRequest, TOutput>>["Type"];

const refusalResponse = (refusal: Refusal): Response =>
  Response.json({ error: refusal.error }, { status: refusal.status });

const runShell = Effect.fn("Slack.loopback.handle")(function* <
  TRequest extends Addressed,
  TOutput extends object,
>(
  spec: LoopbackSpec<TRequest, TOutput>,
  request: Request
): Effect.fn.Return<Response> {
  const raw = yield* readCapped(request, spec.capKiB * BYTES_PER_KIB);
  if (Result.isFailure(raw)) {
    return refusalResponse(raw.failure);
  }

  const parsed = spec.parse(raw.success);
  if (Result.isFailure(parsed)) {
    return Response.json(
      { error: parsed.failure },
      { status: HTTP_BAD_REQUEST }
    );
  }

  const decoded = parsed.success;
  const outcome = yield* spec.handle({
    ref: {
      channelId: decoded.channel,
      teamId: decoded.team ?? spec.workspaceTeamId,
      threadTs: decoded.threadTs,
    },
    request: decoded,
  });

  return Result.isFailure(outcome)
    ? refusalResponse(outcome.failure)
    : Response.json({
        ok: true,
        ...outcome.success,
      });
});

export const loopbackRoute =
  <TRequest extends Addressed, TOutput extends object>(
    spec: LoopbackSpec<TRequest, TOutput>
  ) =>
  (request: Request): Promise<Response> =>
    Effect.runPromise(runShell(spec, request));
