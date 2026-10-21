import { layer as BunServicesLayer } from "@effect/platform-bun/BunServices";
import { layerWebSocketConstructor } from "@effect/platform-bun/BunSocket";
import { Effect, Layer } from "effect";

import type { PreviewServices } from "#src/tools/context.ts";

import {
  DaemonCredentials,
  type DaemonCredentialsShape,
} from "#src/daemon-credentials/index.ts";
import {
  makePreviewSchedule,
  PREVIEW_DISABLED_SCHEDULE,
  PREVIEW_PROMPT,
  type PreviewSchedule,
} from "#src/feature.ts";
import { fetchHttpClientLayer } from "#src/http.ts";
import { bunProcessGroupsLayer } from "#src/process-groups/bun/index.ts";
import { bunTcpProbeLayer } from "#src/tcp-probe/bun/index.ts";
import { type DefinePreviewTool, makePreviewTools } from "#src/tools/index.ts";
import { previewEnabledInEnv } from "#src/warm/index.ts";

type HostEnv = Readonly<Record<string, string | undefined>>;

export interface PreviewContributions<Tool> {
  readonly prompt: readonly (() => string)[];
  readonly schedule: PreviewSchedule;
  readonly tools: readonly Tool[];
}

const previewPrompt = (): string => PREVIEW_PROMPT;

export interface MakePreviewContributionsInput<Tool> {
  readonly cwd: string;
  readonly defineTool: DefinePreviewTool<Tool>;
  readonly env: HostEnv;
  readonly layer: Layer.Layer<PreviewServices>;
}

const nonBlank = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
};

export const previewHosted = (env: HostEnv): boolean =>
  env.ORI_INTERN_PACKED === "1" || nonBlank(env.ORI_DAEMON_TOKEN) !== undefined;

export const previewEnabled = (env: HostEnv): boolean =>
  previewHosted(env) && previewEnabledInEnv(env);

export const previewWorkspaceRoot = (env: HostEnv, cwd: string): string =>
  nonBlank(env.ORI_INTERN_WORKSPACE_ROOT) ?? cwd;

export const previewHostLayer = (
  credentials: DaemonCredentialsShape
): Layer.Layer<PreviewServices> =>
  Layer.mergeAll(
    BunServicesLayer,
    fetchHttpClientLayer,
    bunProcessGroupsLayer,
    bunTcpProbeLayer,
    layerWebSocketConstructor,
    Layer.succeed(DaemonCredentials)(credentials)
  );

export const makePreviewContributions = <Tool>(
  input: MakePreviewContributionsInput<Tool>
): Promise<PreviewContributions<Tool>> =>
  previewEnabled(input.env)
    ? Effect.runPromise(
        Effect.all({
          prompt: Effect.succeed([previewPrompt]),
          schedule: makePreviewSchedule({
            env: input.env,
            workspaceRoot: previewWorkspaceRoot(input.env, input.cwd),
          }),
          tools: makePreviewTools(input.env, input.defineTool),
        }).pipe(Effect.provide(input.layer))
      )
    : Promise.resolve({
        prompt: [],
        schedule: PREVIEW_DISABLED_SCHEDULE,
        tools: [],
      });
