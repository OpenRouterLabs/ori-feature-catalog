import { Effect, FileSystem, Option, Schema } from "effect";

import type { PreviewPaths } from "#src/paths.ts";
import type { ResolvedRecipe } from "#src/schemas.ts";

import { PreviewError } from "#src/errors.ts";
import { PORT_PLACEHOLDER, repoSlug } from "#src/paths.ts";
import { applyDevcontainer } from "#src/recipe/devcontainer.ts";
import { decodePackageJson, heuristicRecipe } from "#src/recipe/heuristic.ts";
import { readInside } from "#src/repo/read-inside.ts";
import { PreviewRecipeSchema } from "#src/schemas.ts";
import { untrusted } from "#src/untrusted/index.ts";

const recipeFileName = (repo: string): string => `${repoSlug(repo)}.json`;

export const PREVIEW_JSON = ".ori/preview.json";

const DEVCONTAINER_JSON = ".devcontainer/devcontainer.json";

const decodeRecipe = Schema.decodeUnknownOption(
  Schema.fromJsonString(PreviewRecipeSchema)
);

const fromFile = Effect.fn("Preview.recipe.fromFile")(function* (
  root: string,
  relative: string,
  source: ResolvedRecipe["source"]
) {
  return (yield* readInside(root, relative)).pipe(
    Option.flatMap(decodeRecipe),
    Option.map((recipe): ResolvedRecipe => ({ recipe, source }))
  );
});

const pinnedPortError = (script: string, port: number): PreviewError =>
  new PreviewError({
    code: "recipe_unresolved",
    detail: `The dev script ${untrusted(script, 400)} pins port ${port}, but previews assign each server its own port. Call preview-save-recipe with a dev command that takes ${PORT_PLACEHOLDER}, such as \`npx next dev -p ${PORT_PLACEHOLDER}\`.`,
  });

const fromHeuristics = Effect.fn("Preview.recipe.fromHeuristics")(function* (
  checkout: string
) {
  const fs = yield* FileSystem.FileSystem;
  const pkg = (yield* readInside(checkout, "package.json")).pipe(
    Option.flatMap(decodePackageJson)
  );
  if (Option.isNone(pkg)) {
    return Option.none<ResolvedRecipe>();
  }
  const files = new Set(
    yield* fs.readDirectory(checkout).pipe(Effect.orElseSucceed(() => []))
  );
  const outcome = heuristicRecipe(files, pkg.value);
  if (outcome.kind === "none") {
    return Option.none<ResolvedRecipe>();
  }
  if (outcome.kind === "pinned_port") {
    return yield* pinnedPortError(outcome.script, outcome.port);
  }
  const devcontainer = yield* readInside(checkout, DEVCONTAINER_JSON);
  return Option.some<ResolvedRecipe>(
    Option.match(devcontainer, {
      onNone: () => ({ recipe: outcome.recipe, source: "heuristic" }),
      onSome: (raw) => ({
        recipe: applyDevcontainer(raw, outcome.recipe),
        source: "devcontainer",
      }),
    })
  );
});

export const resolveRecipe = Effect.fn("Preview.recipe.resolve")(function* (
  paths: PreviewPaths,
  repo: string,
  checkout: string
) {
  const saved = yield* fromFile(paths.recipes, recipeFileName(repo), "cache");
  if (Option.isSome(saved)) {
    return saved.value;
  }
  const committed = yield* fromFile(checkout, PREVIEW_JSON, "preview-json");
  if (Option.isSome(committed)) {
    return committed.value;
  }
  const inferred = yield* fromHeuristics(checkout);
  if (Option.isSome(inferred)) {
    return inferred.value;
  }
  return yield* new PreviewError({
    code: "recipe_unresolved",
    detail: `No way to run ${repo} was found: no ${PREVIEW_JSON}, no cached recipe, and no dev script in package.json. Work out the commands, then call preview-save-recipe.`,
  });
});
