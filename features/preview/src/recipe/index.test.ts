import { layer as BunServicesLayer } from "@effect/platform-bun/BunServices";
import { Effect, FileSystem } from "effect";

import { previewPaths, recipeCachePath } from "#src/paths.ts";
import { PREVIEW_JSON, resolveRecipe } from "#src/recipe/index.ts";
import { describe, expect, it } from "#src/effect-bun-test.ts";

const REPO = "acme/web";

const workspace = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "ori-preview-" });
  const paths = previewPaths(root, `${root}/sandbox`);
  const checkout = `${root}/checkout`;
  yield* fs.makeDirectory(`${checkout}/.ori`, { recursive: true });
  yield* fs.makeDirectory(paths.recipes, { recursive: true });
  return { fs, paths, checkout };
});

const nextPackage = `{"scripts":{"dev":"next dev"},"dependencies":{"next":"15.0.0"}}`;

describe("resolveRecipe", () => {
  it.effect(
    "uses the repo's committed preview.json over the heuristic guess",
    () =>
      Effect.gen(function* () {
        const { fs, paths, checkout } = yield* workspace;
        yield* fs.writeFileString(`${checkout}/package.json`, nextPackage);
        yield* fs.writeFileString(
          `${checkout}/${PREVIEW_JSON}`,
          `{"dev":"make serve --port {port}","readyPath":"/health"}`
        );
        const resolved = yield* resolveRecipe(paths, REPO, checkout);
        expect(resolved).toEqual({
          recipe: { dev: "make serve --port {port}", readyPath: "/health" },
          source: "preview-json",
        });
      }).pipe(Effect.scoped, Effect.provide(BunServicesLayer))
  );

  it.effect(
    "uses the recipe the agent saved over a committed one, so the agent can repair a broken preview.json",
    () =>
      Effect.gen(function* () {
        const { fs, paths, checkout } = yield* workspace;
        yield* fs.writeFileString(`${checkout}/package.json`, nextPackage);
        yield* fs.writeFileString(
          `${checkout}/${PREVIEW_JSON}`,
          `{"dev":"broken"}`
        );
        yield* fs.writeFileString(
          recipeCachePath(paths, REPO),
          `{"install":"bun install","dev":"bun run web"}`
        );
        const resolved = yield* resolveRecipe(paths, REPO, checkout);
        expect(resolved.source).toBe("cache");
        expect(resolved.recipe.dev).toBe("bun run web");
      }).pipe(Effect.scoped, Effect.provide(BunServicesLayer))
  );

  it.effect(
    "skips a malformed preview.json instead of failing the whole repo",
    () =>
      Effect.gen(function* () {
        const { fs, paths, checkout } = yield* workspace;
        yield* fs.writeFileString(`${checkout}/package.json`, nextPackage);
        yield* fs.writeFileString(`${checkout}/${PREVIEW_JSON}`, `{"dev": ""}`);
        const resolved = yield* resolveRecipe(paths, REPO, checkout);
        expect(resolved).toEqual({
          recipe: {
            install: "npm install",
            dev: "npm run dev -- --port {port}",
          },
          source: "heuristic",
        });
      }).pipe(Effect.scoped, Effect.provide(BunServicesLayer))
  );

  it.effect(
    "fails with recipe_unresolved when nothing says how to run the repo, so the agent works it out",
    () =>
      Effect.gen(function* () {
        const { paths, checkout } = yield* workspace;
        const failure = yield* resolveRecipe(paths, REPO, checkout).pipe(
          Effect.flip
        );
        expect(failure.code).toBe("recipe_unresolved");
        expect(failure.detail).toContain("preview-save-recipe");
      }).pipe(Effect.scoped, Effect.provide(BunServicesLayer))
  );

  it.effect(
    "tells the agent to save a {port} recipe when the dev script pins its own port",
    () =>
      Effect.gen(function* () {
        const { fs, paths, checkout } = yield* workspace;
        yield* fs.writeFileString(
          `${checkout}/package.json`,
          `{"scripts":{"dev":"next dev -p 3000"},"dependencies":{"next":"15.0.0"}}`
        );
        const failure = yield* resolveRecipe(paths, REPO, checkout).pipe(
          Effect.flip
        );
        expect(failure.code).toBe("recipe_unresolved");
        expect(failure.detail).toContain("pins port 3000");
        expect(failure.detail).toContain("{port}");
      }).pipe(Effect.scoped, Effect.provide(BunServicesLayer))
  );

  it.effect("refuses a dev script that pins its own port, naming the port", () =>
    Effect.gen(function* () {
      const { fs, paths, checkout } = yield* workspace;
      yield* fs.writeFileString(`${checkout}/package.json`, `{"scripts":{"dev":"next dev -p 3000"}}`);
      const failure = yield* resolveRecipe(paths, REPO, checkout).pipe(Effect.flip);
      expect(failure._tag).toBe("PreviewError");
      expect(failure.detail).toContain("3000");
    }).pipe(Effect.scoped, Effect.provide(BunServicesLayer))
  );

  it.effect("finds no recipe in a package without a dev script", () =>
    Effect.gen(function* () {
      const { fs, paths, checkout } = yield* workspace;
      yield* fs.writeFileString(`${checkout}/package.json`, `{"scripts":{"test":"bun test"}}`);
      const failure = yield* resolveRecipe(paths, REPO, checkout).pipe(Effect.flip);
      expect(failure._tag).toBe("PreviewError");
    }).pipe(Effect.scoped, Effect.provide(BunServicesLayer))
  );
});
