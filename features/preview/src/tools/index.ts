import { Effect, Schema } from "effect";

import type { PreviewServices } from "#src/tools/context.ts";
import type { ToolDefinition, ToolHandler, ToolInitContext } from "ori";

import { PreviewRecipeSchema } from "#src/schemas.ts";
import { previewToolHandler } from "#src/tools/context.ts";
import { runPreviewSaveRecipe } from "#src/tools/save-recipe.ts";
import {
  RepoField,
  runPreviewScreenshot,
  ScreenshotParameters,
} from "#src/tools/screenshot.ts";
import { runPreviewStatus } from "#src/tools/status.ts";
import { runPreviewWarm, WARM_WAIT_NOTE } from "#src/tools/warm.ts";

type HostEnv = Readonly<Record<string, string | undefined>>;

const StatusParameters = Schema.Struct({
  repo: Schema.optional(RepoField),
});

const WarmParameters = Schema.Struct({ repo: RepoField });

const SaveRecipeParameters = Schema.Struct({
  repo: RepoField,
  ...PreviewRecipeSchema.fields,
});

export interface PreviewToolSpec<Args> {
  readonly name: string;
  readonly description: string;
  readonly capabilities: ToolDefinition<Args>["capabilities"];
  readonly inputSchema: Schema.Codec<Args, unknown>;
  readonly init: (context: ToolInitContext) => ToolHandler<Args>;
}

export type DefinePreviewTool<Tool> = <Args>(spec: PreviewToolSpec<Args>) => Tool;

export const makePreviewTools = <Tool>(
  env: HostEnv,
  defineTool: DefinePreviewTool<Tool>
): Effect.Effect<readonly Tool[], never, PreviewServices> =>
  Effect.gen(function* () {
  const services = yield* Effect.context<PreviewServices>();
  const tools: readonly Tool[] = [
    defineTool({
      name: "preview-status",
      description:
        "Lists the localhost previews this intern keeps warm for its connected repositories: which are warm and at what URL, which are not runnable and why. Pass a repo for its recent dev-server output.",
      capabilities: ["read"],
      inputSchema: StatusParameters,
      init: previewToolHandler(runPreviewStatus, env, services),
    }),
    defineTool({
      name: "preview-warm",
      description: `Brings a repository's dev server up on localhost: syncs the default branch, installs, starts it, and waits until a page loads without a framework error. ${WARM_WAIT_NOTE}`,
      capabilities: ["execute", "network", "read", "write"],
      inputSchema: WarmParameters,
      init: previewToolHandler(runPreviewWarm, env, services),
    }),
    defineTool({
      name: "preview-screenshot",
      description:
        "Screenshots a page of a repository's warm localhost preview in the intern's own Chromium and returns the image with any console errors. Pass changedDirectory to get a before/after pair for a fix. Screenshots are saved under preview-shots/ so they can be attached to a reply.",
      capabilities: ["execute", "network", "read", "write"],
      inputSchema: ScreenshotParameters,
      init: previewToolHandler(runPreviewScreenshot, env, services),
    }),
    defineTool({
      name: "preview-save-recipe",
      description:
        "Records how to run a repository when previews could not work it out (install command, dev command with {port} where the port goes, ready path, env, required env), then warms it with that recipe in the preview sandbox. Use after reading the repo's README.",
      capabilities: ["execute", "network", "read", "write"],
      inputSchema: SaveRecipeParameters,
      init: previewToolHandler(runPreviewSaveRecipe, env, services),
    }),
  ];
  return tools;
});
