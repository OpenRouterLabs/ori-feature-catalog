/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively; the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */
/**
 * dispatch.ts — the loopback entry point behind the `spawn-thread` skill.
 *
 * The agent can start a sibling thread by POSTing to `/slack/thread/dispatch`
 * rather than by being mentioned. Same turn path as a real Slack event, just a
 * different way in.
 *
 * Two guards, both load-bearing:
 *
 * The route is loopback-only, enforced in the handler rather than by the bind
 * address, because the daemon serves it on the same port as the public Slack
 * webhook. Without that check anything that could reach the webhook could
 * start arbitrary agent turns.
 *
 * Spawn depth is capped so a thread that spawns a thread that spawns a thread
 * terminates. The skill sends `depth + 1` and this refuses past the ceiling;
 * `MAX_SPAWN_DEPTH` here and in the skill must agree, which
 * `dispatch.test.ts` pins.
 */

import { Result, Schema } from "effect";

/** Must equal the skill's `MAX_SPAWN_DEPTH`. */
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

/** Decode the wire body. Rejects rather than guessing at a malformed shape. */
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
      // Schema.String admits "". An empty channel or thread_ts decodes
      // cleanly and then fails at post time, well past the point where this
      // could have said why.
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

/**
 * Loopback check for the dispatch route.
 *
 * The daemon serves this on the same port as the public Slack webhook, so the
 * bind address proves nothing — the handler has to decide.
 */
export const isLoopback = (remoteAddress: string | undefined): boolean =>
  remoteAddress === "127.0.0.1" ||
  remoteAddress === "::1" ||
  remoteAddress === "::ffff:127.0.0.1";
