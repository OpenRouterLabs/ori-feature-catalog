import { Effect, Option, Schema } from "effect";
import { HttpClient } from "effect/http";
import { Socket } from "effect/socket";

import { PreviewError } from "#src/errors.ts";
import { localUrl, PREVIEW_CDP_PORT } from "#src/paths.ts";

const TargetSchema = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  url: Schema.String,
  webSocketDebuggerUrl: Schema.optionalKey(Schema.String),
});

const decodeTargets = Schema.decodeUnknownEffect(Schema.Array(TargetSchema));

const ReplySchema = Schema.Struct({
  id: Schema.optionalKey(Schema.Finite),
  method: Schema.optionalKey(Schema.String),
  params: Schema.optionalKey(Schema.Unknown),
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.Struct({ message: Schema.String })),
});
type Reply = typeof ReplySchema.Type;

const decodeReply = Schema.decodeUnknownOption(
  Schema.fromJsonString(ReplySchema)
);

const RequestSchema = Schema.Struct({
  id: Schema.Finite,
  method: Schema.String,
  params: Schema.Record(Schema.String, Schema.Unknown),
});
const encodeRequest = Schema.encodeEffect(Schema.fromJsonString(RequestSchema));

const CDP_TIMEOUT = "30 seconds";

const unavailable = (detail: string): PreviewError =>
  new PreviewError({ code: "browser_unavailable", detail });

export const listTargets = Effect.fn("Preview.cdp.listTargets")(function* () {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client
    .get(localUrl(PREVIEW_CDP_PORT, "/json/list"))
    .pipe(
      Effect.mapError(() =>
        unavailable("The preview browser is not answering on its debug port.")
      )
    );
  const body = yield* response.json.pipe(
    Effect.mapError(() =>
      unavailable("The preview browser sent no target list.")
    )
  );
  return yield* decodeTargets(body).pipe(
    Effect.mapError(() =>
      unavailable("The preview browser sent a malformed target list.")
    )
  );
});

export const createTarget = Effect.fn("Preview.cdp.createTarget")(function* (
  url: string
) {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client
    .put(localUrl(PREVIEW_CDP_PORT, `/json/new?${encodeURIComponent(url)}`))
    .pipe(
      Effect.mapError(() =>
        unavailable("The preview browser refused to open a new tab.")
      )
    );
  const body = yield* response.json.pipe(
    Effect.mapError(() => unavailable("The preview browser sent no new tab."))
  );
  return yield* Schema.decodeUnknownEffect(TargetSchema)(body).pipe(
    Effect.mapError(() =>
      unavailable("The preview browser sent a malformed tab.")
    )
  );
});

export const closeTarget = Effect.fn("Preview.cdp.closeTarget")(function* (
  id: string
) {
  const client = yield* HttpClient.HttpClient;
  yield* client
    .get(localUrl(PREVIEW_CDP_PORT, `/json/close/${encodeURIComponent(id)}`))
    .pipe(Effect.ignore);
});

export interface CdpSession {
  readonly send: (
    method: string,
    params?: Readonly<Record<string, unknown>>
  ) => Effect.Effect<unknown, PreviewError>;
  readonly events: readonly Reply[];
}

interface PendingCall {
  readonly resolve: (reply: Reply) => void;
}

interface SessionState {
  nextId: number;
  readonly pending: Map<number, PendingCall>;
  readonly events: Reply[];
}

const dispatchReply = (state: SessionState, reply: Reply): void => {
  if (Option.isNone(Option.fromNullishOr(reply.id))) {
    state.events.push(reply);
    return;
  }
  const id = reply.id ?? 0;
  const call = state.pending.get(id);
  state.pending.delete(id);
  call?.resolve(reply);
};

const openSocket = (
  makeSocket: (url: string) => Socket.WebSocketLike,
  url: string
) =>
  Effect.callback<Socket.WebSocketLike, PreviewError>((resume) => {
    const socket = makeSocket(url);
    socket.addEventListener("open", () => resume(Effect.succeed(socket)), {
      once: true,
    });
    socket.addEventListener(
      "error",
      () =>
        resume(
          Effect.fail(
            unavailable("Could not attach to the preview browser tab.")
          )
        ),
      { once: true }
    );
  });

const CLOSED_REPLY: Reply = {
  error: { message: "the browser tab closed before it answered" },
};

const failPending = (state: SessionState): void => {
  const calls = [...state.pending.values()];
  state.pending.clear();
  calls.forEach((call) => call.resolve(CLOSED_REPLY));
};

const handleMessage = (state: SessionState, data: unknown): void => {
  Option.map(decodeReply(data), (reply) => dispatchReply(state, reply));
};

const sendOn = (socket: Socket.WebSocketLike, state: SessionState) =>
  Effect.fn("Preview.cdp.send")(function* (
    method: string,
    params: Readonly<Record<string, unknown>> = {}
  ) {
    const id = state.nextId;
    state.nextId += 1;
    const payload = yield* encodeRequest({ id, method, params }).pipe(
      Effect.orDie
    );
    const reply = yield* Effect.callback<Reply>((resume) => {
      state.pending.set(id, {
        resolve: (value) => resume(Effect.succeed(value)),
      });
      socket.send(payload);
    }).pipe(
      Effect.timeoutOrElse({
        duration: CDP_TIMEOUT,
        orElse: () =>
          Effect.fail(
            unavailable(`The preview browser did not answer ${method}.`)
          ),
      })
    );
    if (Option.isSome(Option.fromNullishOr(reply.error))) {
      return yield* unavailable(
        `The preview browser rejected ${method}: ${reply.error?.message ?? ""}`
      );
    }
    return reply.result;
  });

export const attach = Effect.fn("Preview.cdp.attach")(function* (
  webSocketUrl: string
) {
  const makeSocket = yield* Socket.WebSocketConstructor;
  const socket = yield* Effect.acquireRelease(
    openSocket(makeSocket, webSocketUrl),
    (open) => Effect.sync(() => open.close())
  );
  const state: SessionState = { nextId: 1, pending: new Map(), events: [] };
  socket.addEventListener("message", (event) =>
    handleMessage(state, event.data)
  );
  socket.addEventListener("close", () => failPending(state));
  socket.addEventListener("error", () => failPending(state));
  const session: CdpSession = {
    send: sendOn(socket, state),
    events: state.events,
  };
  return session;
});
