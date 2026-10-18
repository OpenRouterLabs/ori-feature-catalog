import { Effect, Layer, Predicate, Result } from "effect";

import type { PreviewError } from "#src/errors.ts";

import {
  type DirectResponse,
  isComplete,
  MAX_BODY_BYTES,
  refusedResponse,
  requestText,
  settledResponse,
  targetOf,
} from "#src/readiness/direct-get.ts";
import { TcpProbe, type TcpProbeShape } from "#src/tcp-probe/index.ts";

const ADDRESS_UNAVAILABLE: ReadonlySet<string> = new Set([
  "EADDRNOTAVAIL",
  "EAFNOSUPPORT",
]);

const listenerCode = (hostname: string, port: number): string | undefined => {
  const attempt = Result.try({
    try: () => {
      Bun.listen({ hostname, port, socket: { data: () => undefined } }).stop(
        true
      );
    },
    catch: (error) =>
      Predicate.hasProperty(error, "code") && typeof error.code === "string"
        ? error.code
        : "unknown",
  });
  return Result.isSuccess(attempt) ? undefined : attempt.failure;
};

const isPortFree = (port: number): boolean =>
  ["127.0.0.1", "::1"].every((hostname) => {
    const code = listenerCode(hostname, port);
    return Predicate.isUndefined(code) || ADDRESS_UNAVAILABLE.has(code);
  });

interface ProbeState {
  raw: string;
  done: boolean;
  readonly url: string;
  readonly decoder: TextDecoder;
  readonly resume: (
    effect: Effect.Effect<DirectResponse, PreviewError>
  ) => void;
}

const settle = (state: ProbeState): void => {
  if (state.done) {
    return;
  }
  state.done = true;
  state.resume(settledResponse(state.raw, state.url));
};

const refuse = (state: ProbeState): void => {
  if (state.done) {
    return;
  }
  state.done = true;
  state.resume(refusedResponse(state.url));
};

const connect = (state: ProbeState): void => {
  const { host, port, path } = targetOf(state.url);
  Bun.connect({
    hostname: host,
    port,
    socket: {
      open: (socket) => {
        socket.write(requestText(path, port));
      },
      data: (socket, chunk) => {
        state.raw += state.decoder.decode(chunk, { stream: true });
        if (state.raw.length > MAX_BODY_BYTES || isComplete(state.raw)) {
          settle(state);
          socket.end();
        }
      },
      close: () => settle(state),
      end: () => settle(state),
      error: () => settle(state),
      connectError: () => refuse(state),
    },
  }).catch(() => refuse(state));
};

export const bunTcpProbe: TcpProbeShape = {
  isPortFree: (port) => Effect.sync(() => isPortFree(port)),
  get: (url) =>
    Effect.callback<DirectResponse, PreviewError>((resume) => {
      connect({
        raw: "",
        done: false,
        url,
        decoder: new TextDecoder(),
        resume,
      });
    }),
};

export const bunTcpProbeLayer = Layer.succeed(TcpProbe)(bunTcpProbe);
