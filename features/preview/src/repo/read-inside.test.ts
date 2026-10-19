import { layer as BunServicesLayer } from "@effect/platform-bun/BunServices";
import { Effect, FileSystem, Option } from "effect";

import { readInside } from "./read-inside.ts";
import { describe, expect, it } from "../effect-bun-test.ts";

describe("readInside", () => {
  it.effect("reads a file that lives inside the checkout", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFileString(`${root}/package.json`, "{}");
      expect(yield* readInside(root, "package.json")).toEqual(
        Option.some("{}")
      );
    }).pipe(Effect.scoped, Effect.provide(BunServicesLayer))
  );

  it.effect(
    "refuses a symlink that points outside the checkout, so a repository cannot make root read another file",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped();
        const outside = yield* fs.makeTempDirectoryScoped();
        yield* fs.writeFileString(`${outside}/secret.json`, "secret");
        yield* fs.makeDirectory(`${root}/.ori`);
        yield* fs.symlink(
          `${outside}/secret.json`,
          `${root}/.ori/preview.json`
        );
        expect(yield* readInside(root, ".ori/preview.json")).toEqual(
          Option.none()
        );
      }).pipe(Effect.scoped, Effect.provide(BunServicesLayer))
  );
});
