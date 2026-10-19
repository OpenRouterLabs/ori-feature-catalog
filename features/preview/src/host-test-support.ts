import { layerWebSocketConstructor } from "@effect/platform-bun/BunSocket";
import { Layer } from "effect";

import { scriptedDaemonCredentialsLayer } from "./daemon-credentials/test-support.ts";
import { recordingProcessGroupsLayer } from "./process-groups/test-support.ts";
import { scriptedTcpProbeLayer } from "./tcp-probe/test-support.ts";

export const scriptedPreviewHostLayer = Layer.mergeAll(
  recordingProcessGroupsLayer(),
  scriptedTcpProbeLayer(),
  layerWebSocketConstructor,
  scriptedDaemonCredentialsLayer
);
