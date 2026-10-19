import { Context, type Effect } from "effect";

import type { PreviewError } from "../errors.ts";
import type { DirectResponse } from "../readiness/direct-get.ts";

export interface TcpProbeShape {
  readonly isPortFree: (port: number) => Effect.Effect<boolean>;
  readonly get: (url: string) => Effect.Effect<DirectResponse, PreviewError>;
}

export class TcpProbe extends Context.Service<TcpProbe, TcpProbeShape>()(
  "@ori-catalog/preview/tcp-probe/TcpProbe"
) {}
