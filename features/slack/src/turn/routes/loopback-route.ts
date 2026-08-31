/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively; the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */
/**
 * loopback-route.ts — the shell every `POST /slack/thread/*` route shares.
 *
 * Five routes were five copies of the same four steps: cap the body, decode
 * it, address the thread, map the outcome to a status. Only the work in the
 * middle differs, so only the work in the middle is written per route.
 */

import { Effect, Result, Schema } from "effect";

import type { ThreadRef } from "../../thread/thread.ts";

const BYTES_PER_KIB = 1024;

const HTTP_BAD_REQUEST = 400;
const HTTP_PAYLOAD_TOO_LARGE = 413;

/** The sentence a caller reads, and the status it reads it from. */
export interface Refusal {
  readonly error: string;
  readonly status: number;
}

export const refuse = (
  status: number,
  error: string
): Result.Result<never, Refusal> =>
  Result.fail({
    error,
    status,
  });

/** The three wire fields every loopback skill sends, before decoding. */
export const threadFields = {
  channel: Schema.String,
  team: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
  thread_ts: Schema.String,
} as const;

/** The same three after decoding — what the shell needs to address a thread. */
export interface Addressed {
  readonly channel: string;
  readonly team: string | undefined;
  readonly threadTs: string;
}

/**
 * `cancel()` rejects when the peer has already torn the socket down, which is
 * the common way an oversized upload ends. There is nothing left to do about
 * it, and the refusal below is still the right answer.
 */
const alreadyGone = (): undefined => undefined;

const decodeJson = Schema.decodeUnknownResult(Schema.UnknownFromJsonString);

/** A body that is not JSON reads as `null`, which every `parse` refuses. */
const jsonOrNull = (raw: string): unknown =>
  Result.getOrElse(decodeJson(raw), () => null);

/**
 * Read the body under a ceiling that actually holds.
 *
 * The header is checked first, then the stream is counted as it arrives and
 * cancelled the moment it passes the cap. Checking `content-length` alone was
 * advisory: it is optional, a chunked request carries none, `Number("")` is 0,
 * and the request went straight through to an unbounded `json()`.
 */
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
      // The `catch` stays inside the thunk: a peer that has already gone is
      // handled here, where it happens, rather than travelling as a failure
      // that this route would only swallow again.
      yield* Effect.promise(() => reader.cancel().catch(alreadyGone));
      return refuse(HTTP_PAYLOAD_TOO_LARGE, "payload too large");
    }
    raw += decoder.decode(chunk.value, { stream: true });
  }
  raw += decoder.decode();

  return Result.succeed(jsonOrNull(raw));
});

interface LoopbackSpec<
  TRequest extends Addressed,
  TOutput extends object,
> {
  /** Body ceiling in KiB. Not advisory: the read stops at it. */
  readonly capKiB: number;
  /**
   * Do the work. Free to take as long as it likes — a blocker holds here.
   *
   * An Effect rather than a Promise. When this was a Promise every route
   * opened its own `Effect.runPromise` to get back in, which meant a second
   * runtime per request and a span detached from the one this shell already
   * owns. Worse, taking it back in through `Effect.promise` made a rejection a
   * DEFECT: a handler that threw escaped every handler here and surfaced at
   * the HTTP edge as an unhandled rejection rather than a refusal.
   */
  readonly handle: (input: {
    readonly ref: ThreadRef;
    readonly request: TRequest;
  }) => Effect.Effect<Result.Result<TOutput, Refusal>>;
  /** Decode the wire body; a failure is the sentence the 400 carries. */
  readonly parse: (raw: unknown) => Result.Result<TRequest, string>;
  /** The team a body that omits one belongs to. */
  readonly workspaceTeamId: string;
}

const refusalResponse = (refusal: Refusal): Response =>
  Response.json({ error: refusal.error }, { status: refusal.status });

/**
 * The whole request, in one fiber: the read, the decode and the work.
 *
 * One boundary for the whole route, owned here. `loopbackRoute` below is the
 * only place this feature's loopback routes leave Effect, so a handler's spans
 * are children of this one and a handler's failure is still a failure.
 */
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
  // The one boundary the shell owns: HTTP is a Promise, everything under it
  // is not.
  (request: Request): Promise<Response> =>
    Effect.runPromise(runShell(spec, request));
