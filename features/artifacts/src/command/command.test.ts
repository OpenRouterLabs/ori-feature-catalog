import { layer as BunServicesLayer } from "@effect/platform-bun/BunServices";
import { Effect, FileSystem, Option } from "effect";

import { describe, expect, it } from "#src/effect-bun-test.ts";

import { CliFailureError } from "#src/failures.ts";
import { runArtifactDelete, runArtifactList, runArtifactSave, type SaveDeps } from "./index.ts";

const deps = (root: string): SaveDeps => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    cwd: root,
    env: {},
    readFileString: async (path) => {
      const fs = await import("node:fs/promises");
      return fs.readFile(path, "utf8");
    },
    stdout: (line) => {
      out.push(line);
    },
    stderr: (line) => {
      err.push(line);
    },
  } as SaveDeps & { readonly out: string[] };
};

const workspace = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({ prefix: "ori-artifacts-command-" })
  );
});

describe("artifact commands", () => {
  it.effect(
    "save writes the page under artifacts/<name>/ and list reads it back",
    () =>
      Effect.gen(function* () {
        const root = yield* workspace;
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(
          `${root}/page.html`,
          "<html><head></head><body><p>report</p></body></html>"
        );
        const saveDeps = deps(root);
        const saved = yield* runArtifactSave(saveDeps, {
          file: "page.html",
          name: "vendor-comparison",
          title: Option.some("Vendor comparison"),
        });
        expect(saved.version).toBe(1);
        expect(saved.file).toBe(
          `${root}/artifacts/vendor-comparison/v1.html`
        );
        expect(saved.link).toBe(saved.file);
        const listDeps = deps(root);
        const listed = yield* runArtifactList(listDeps);
        expect(listed.artifacts.map((entry) => entry.name)).toEqual([
          "vendor-comparison",
        ]);
        expect(
          yield* fs.readFileString(
            `${root}/artifacts/vendor-comparison/artifact.json`
          )
        ).toContain("Vendor comparison");
        const deleteDeps = deps(root);
        const deleted = yield* runArtifactDelete(
          deleteDeps,
          "vendor-comparison"
        );
        expect(deleted.deleted).toBe(true);
        const afterDelete = yield* runArtifactList(deps(root));
        expect(afterDelete.artifacts).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(BunServicesLayer))
  );

  it.effect("save refuses a name that breaks the rule", () =>
    Effect.gen(function* () {
      const root = yield* workspace;
      const failure = yield* runArtifactSave(deps(root), {
        file: "page.html",
        name: "Not_A_Name",
        title: Option.none(),
      }).pipe(Effect.flip, Effect.map((failure) => failure as CliFailureError));
      expect(failure).toBeInstanceOf(CliFailureError);
      expect(failure.failureCode).toBe("ORI_CLI_ARTIFACT_NAME_INVALID");
    }).pipe(Effect.scoped, Effect.provide(BunServicesLayer))
  );

  it.effect("delete of a missing name refuses with NOT_FOUND", () =>
    Effect.gen(function* () {
      const root = yield* workspace;
      const failure = yield* runArtifactDelete(
        deps(root),
        "no-such-page"
      ).pipe(Effect.flip, Effect.map((failure) => failure as CliFailureError));
      expect(failure.failureCode).toBe("ORI_CLI_ARTIFACT_NOT_FOUND");
    }).pipe(Effect.scoped, Effect.provide(BunServicesLayer))
  );

  it.effect("save refuses a page naming a host off the CDN list", () =>
    Effect.gen(function* () {
      const root = yield* workspace;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(
        `${root}/page.html`,
        '<html><head><script src="https://evil.example.com/lib.js"></script></head><body></body></html>'
      );
      const failure = yield* runArtifactSave(deps(root), {
        file: "page.html",
        name: "refused",
        title: Option.none(),
      }).pipe(Effect.flip, Effect.map((failure) => failure as CliFailureError));
      expect(failure.failureCode).toBe("ORI_CLI_ARTIFACT_RESOURCE_REFUSED");
      expect(failure.detail).toContain("evil.example.com");
    }).pipe(Effect.scoped, Effect.provide(BunServicesLayer))
  );
});
