import * as Ori from "ori";
import type { DaemonCredentialsShape } from "./src/daemon-credentials/index.ts";

const sdk: typeof Ori & {
  readonly daemonAuthorizationOf?: DaemonCredentialsShape["authorizationOf"];
  readonly publishedDaemonCredentialFile?: DaemonCredentialsShape["publishedFile"];
} = Ori;

import { PREVIEW_PROMPT } from "./src/feature.ts";
import {
  makePreviewContributions,
  previewEnabled,
  previewHostLayer,
} from "./src/host.ts";

const loadContributions = async () => {
  if (!previewEnabled(process.env)) {
    return { tools: [], schedule: undefined };
  }
  if (
    typeof sdk.daemonAuthorizationOf !== "function" ||
    typeof sdk.publishedDaemonCredentialFile !== "function"
  ) {
    throw new Error("Preview requires an Ori SDK with daemon credential helpers; upgrade Ori before enabling previews.");
  }
  return makePreviewContributions({
    env: process.env,
    cwd: process.cwd(),
    defineTool: (spec) => Ori.defineTool({ ...spec, outputSchema: Ori.ToolResultSchema }),
    layer: previewHostLayer({
      authorizationOf: sdk.daemonAuthorizationOf,
      publishedFile: sdk.publishedDaemonCredentialFile,
    }),
  });
};

const contributions = await loadContributions();
export const tools = contributions.tools;
export const schedule = contributions.schedule;
export const prompt = contributions.tools.length === 0 ? undefined : PREVIEW_PROMPT;
