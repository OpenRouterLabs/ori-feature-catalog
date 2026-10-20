import {
  daemonAuthorizationOf,
  defineTool,
  publishedDaemonCredentialFile,
  ToolResultSchema,
} from "ori";

import { makePreviewContributions, previewHostLayer } from "#src/host.ts";

const contributions = await makePreviewContributions({
  // oxlint-disable-next-line node/no-process-env -- the host decides whether previews run.
  env: process.env,
  cwd: process.cwd(),
  defineTool: (spec) => defineTool({ ...spec, outputSchema: ToolResultSchema }),
  layer: previewHostLayer({
    authorizationOf: daemonAuthorizationOf,
    publishedFile: publishedDaemonCredentialFile,
  }),
});

export const tools = contributions.tools;

export const schedule = contributions.schedule;

export const prompt = contributions.prompt;
