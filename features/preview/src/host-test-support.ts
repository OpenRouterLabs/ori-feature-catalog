import { layerWebSocketConstructor } from "@effect/platform-bun/BunSocket";
import { Layer } from "effect";

import { scriptedDaemonCredentialsLayer } from "#src/daemon-credentials/test-support.ts";
import { recordingProcessGroupsLayer } from "#src/process-groups/test-support.ts";
import { scriptedTcpProbeLayer } from "#src/tcp-probe/test-support.ts";

export const scriptedPreviewHostLayer = Layer.mergeAll(
  recordingProcessGroupsLayer(),
  scriptedTcpProbeLayer(),
  layerWebSocketConstructor,
  scriptedDaemonCredentialsLayer
);
