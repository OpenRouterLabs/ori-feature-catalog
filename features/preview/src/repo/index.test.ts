import { layer as BunServicesLayer } from "@effect/platform-bun/BunServices";
import { Effect, FileSystem } from "effect";

import { hasCheckout, isTransientGithubFailure } from "#src/repo/index.ts";
import { describe, expect, it } from "#src/effect-bun-test.ts";

describe("hasCheckout", () => {
  it.effect(
    "is false for a missing checkout, so a surviving sync marker cannot skip the download after /preview was lost",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped();
        expect(yield* hasCheckout(`${root}/repos/acme__web`)).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(BunServicesLayer))
  );

  it.effect("is false for an empty checkout directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(`${root}/acme__web`);
      expect(yield* hasCheckout(`${root}/acme__web`)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(BunServicesLayer))
  );

  it.effect("is true once the tree is in place", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(`${root}/acme__web`);
      yield* fs.writeFileString(`${root}/acme__web/package.json`, "{}");
      expect(yield* hasCheckout(`${root}/acme__web`)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(BunServicesLayer))
  );
});

describe("isTransientGithubFailure", () => {
  it("treats an exhausted rate limit as transient, so a warm preview keeps serving", () => {
    expect(
      isTransientGithubFailure(403, { "x-ratelimit-remaining": "0" })
    ).toBe(true);
  });

  it("treats a GitHub outage as transient", () => {
    expect(isTransientGithubFailure(502, {})).toBe(true);
  });

  it("treats lost access as final, so a disconnected repository stops being served", () => {
    expect(isTransientGithubFailure(404, {})).toBe(false);
    expect(
      isTransientGithubFailure(403, { "x-ratelimit-remaining": "4999" })
    ).toBe(false);
  });
});
