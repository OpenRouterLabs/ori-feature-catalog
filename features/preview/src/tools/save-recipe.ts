import { Effect, Schema } from "effect";

import type { PreviewRecipe } from "#src/schemas.ts";
import type { PreviewToolContext } from "#src/tools/context.ts";

import { withRepoLock } from "#src/lock/index.ts";
import { recipeCachePath } from "#src/paths.ts";
import { PREVIEW_JSON } from "#src/recipe/index.ts";
import { PreviewRecipeSchema } from "#src/schemas.ts";
import { writeFileAtomic } from "#src/status/index.ts";
import { textResult } from "#src/tools/context.ts";
import { runPreviewWarm } from "#src/tools/warm.ts";
import { park } from "#src/warm/index.ts";

const encodeRecipe = Schema.encodeEffect(
  Schema.fromJsonString(PreviewRecipeSchema, { space: 2 })
);

export interface SaveRecipeArgs extends PreviewRecipe {
  readonly repo: string;
}

export const runPreviewSaveRecipe = Effect.fn("Preview.tool.saveRecipe")(
  function* (context: PreviewToolContext<SaveRecipeArgs>) {
    const { repo, ...recipe } = context.args;
    const normalized = repo.toLowerCase();
    const encoded = yield* encodeRecipe(recipe).pipe(Effect.orDie);
    yield* writeFileAtomic(
      context.paths.recipes,
      recipeCachePath(context.paths, normalized),
      `${encoded}\n`
    );
    yield* withRepoLock(
      context.paths,
      normalized,
      park(context.paths, normalized),
      "wait"
    );
    const warmed = yield* runPreviewWarm({
      ...context,
      args: { repo: normalized },
    });
    return textResult(
      [
        `Saved the recipe for ${normalized}.`,
        ...warmed.content.flatMap((part) =>
          part.type === "text" ? [part.text] : []
        ),
        `To make it permanent for everyone, open a pull request adding ${PREVIEW_JSON} with:\n${encoded}`,
      ].join("\n")
    );
  }
);
