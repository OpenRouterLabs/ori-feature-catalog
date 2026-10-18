import { Effect, Layer } from "effect";

import { refusedResponse } from "#src/readiness/direct-get.ts";

import { TcpProbe, type TcpProbeShape } from "./index.ts";

export const scriptedTcpProbeLayer = (
  script: Partial<TcpProbeShape> = {}
): Layer.Layer<TcpProbe> =>
  Layer.succeed(TcpProbe)({
    isPortFree: () => Effect.succeed(true),
    get: refusedResponse,
    ...script,
  });
