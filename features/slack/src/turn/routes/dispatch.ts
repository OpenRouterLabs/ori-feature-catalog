import { Result, Schema } from "effect";

export const MAX_SPAWN_DEPTH = 3;

const DispatchBodySchema = Schema.Struct({
  channel: Schema.String,
  message: Schema.String,
  spawn_thread_depth: Schema.optionalKey(Schema.UndefinedOr(Schema.Number)),
  thread_ts: Schema.String,
  user_id: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
});

const decodeBody = Schema.decodeUnknownResult(DispatchBodySchema);

export interface DispatchRequest {
  readonly channel: string;
  readonly depth: number;
  readonly message: string;
  readonly threadTs: string;
  readonly userId: string | undefined;
}

type DispatchParse =
  | { readonly ok: true; readonly request: DispatchRequest }
  | { readonly ok: false; readonly error: string };

const present = (value: string | undefined): string | undefined =>
  value === undefined || value === "" ? undefined : value;

export const parseDispatchBody = (raw: unknown): DispatchParse =>
  Result.match(decodeBody(raw), {
    onFailure: (): DispatchParse => ({
      error:
        "expected { channel, thread_ts, message, user_id?, spawn_thread_depth? }",
      ok: false,
    }),
    onSuccess: (decoded): DispatchParse => {
      const depth = decoded.spawn_thread_depth ?? 0;
      if (depth > MAX_SPAWN_DEPTH) {
        return {
          error: `spawn depth ${depth} exceeds the maximum of ${MAX_SPAWN_DEPTH}`,
          ok: false,
        };
      }
      if (present(decoded.message) === undefined) {
        return {
          error: "message must not be empty",
          ok: false,
        };
      }
      if (
        present(decoded.channel) === undefined ||
        present(decoded.thread_ts) === undefined
      ) {
        return {
          error: "channel and thread_ts must not be empty",
          ok: false,
        };
      }
      return {
        ok: true,
        request: {
          channel: decoded.channel,
          depth,
          message: decoded.message,
          threadTs: decoded.thread_ts,
          userId: present(decoded.user_id),
        },
      };
    },
  });

export const isLoopback = (remoteAddress: string | undefined): boolean =>
  remoteAddress === "127.0.0.1" ||
  remoteAddress === "::1" ||
  remoteAddress === "::ffff:127.0.0.1";
