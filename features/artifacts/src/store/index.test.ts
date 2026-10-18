import { layer as BunServicesLayer } from "@effect/platform-bun/BunServices";
import { Effect, FileSystem, Option, Schema } from "effect";

import { describe, expect, it } from "../effect-bun-test.ts";

import {
  ArtifactManifestSchema,
  ArtifactNameSchema,
  deleteWorkspaceArtifact,
  isArtifactName,
  listWorkspaceArtifacts,
  readWorkspaceArtifact,
  saveWorkspaceArtifact,
} from "./index.ts";

const workspace = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({ prefix: "ori-workspace-artifacts-" })
  );
});

const save = (root: string, name: string, html: string, title?: string) =>
  saveWorkspaceArtifact(root, {
    html,
    name,
    title: Option.fromNullishOr(title),
  });

describe("workspace artifacts", () => {
  it.effect(
    "adds a version for every save of a name, keeping each one and its manifest",
    () =>
      Effect.gen(function* () {
        const root = yield* workspace;
        const fs = yield* FileSystem.FileSystem;
        const first = yield* save(
          root,
          "vendor-comparison",
          "<p>one</p>",
          "Vendors"
        );
        const second = yield* save(root, "vendor-comparison", "<p>two</p>");
        expect(first.entry.version).toBe(1);
        expect(second.entry.version).toBe(2);
        expect(second.file).toBe(`${root}/artifacts/vendor-comparison/v2.html`);
        expect(
          yield* fs.readFileString(
            `${root}/artifacts/vendor-comparison/v1.html`
          )
        ).toBe("<p>one</p>");
        expect(second.manifest.title).toBe("Vendors");
        expect(second.manifest.versions.map((entry) => entry.version)).toEqual([
          1, 2,
        ]);
        expect(second.entry.size).toBe("<p>two</p>".length);
        expect(second.entry.sha256).toMatch(/^[0-9a-f]{64}$/u);
        const manifest = yield* Schema.decodeEffect(
          Schema.fromJsonString(ArtifactManifestSchema)
        )(
          yield* fs.readFileString(
            `${root}/artifacts/vendor-comparison/artifact.json`
          )
        );
        expect(manifest.versions.length).toBe(2);
      }).pipe(Effect.scoped, Effect.provide(BunServicesLayer))
  );

  it.live("keeps every version when saves of one name overlap", () =>
    Effect.gen(function* () {
      const root = yield* workspace;
      const saved = yield* Effect.forEach(
        [1, 2, 3, 4, 5, 6],
        (index) => save(root, "report", `<p>${index}</p>`),
        { concurrency: "unbounded" }
      );
      const versions = saved
        .map((entry) => entry.entry.version)
        .toSorted((left, right) => left - right);
      expect(versions).toEqual([1, 2, 3, 4, 5, 6]);
      const listed = yield* listWorkspaceArtifacts(root);
      expect(listed[0]?.versions.map((entry) => entry.version)).toEqual([
        1, 2, 3, 4, 5, 6,
      ]);
      const fs = yield* FileSystem.FileSystem;
      expect(yield* fs.exists(`${root}/artifacts/report/.save.lock`)).toBe(
        false
      );
    }).pipe(Effect.scoped, Effect.provide(BunServicesLayer))
  );

  it.effect("never overwrites a version file already on disk", () =>
    Effect.gen(function* () {
      const root = yield* workspace;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(`${root}/artifacts/report`, { recursive: true });
      yield* fs.writeFileString(
        `${root}/artifacts/report/v1.html`,
        "<p>stray</p>"
      );
      const saved = yield* save(root, "report", "<p>new</p>");
      expect(saved.entry.version).toBe(2);
      expect(yield* fs.readFileString(`${root}/artifacts/report/v1.html`)).toBe(
        "<p>stray</p>"
      );
    }).pipe(Effect.scoped, Effect.provide(BunServicesLayer))
  );

  it.effect(
    "reads the newest version or one asked for, and deletes a page",
    () =>
      Effect.gen(function* () {
        const root = yield* workspace;
        yield* save(root, "report", "<p>one</p>");
        yield* save(root, "report", "<p>two</p>");
        const latest = yield* readWorkspaceArtifact(
          root,
          "report",
          Option.none()
        );
        const first = yield* readWorkspaceArtifact(
          root,
          "report",
          Option.some(1)
        );
        const missing = yield* readWorkspaceArtifact(
          root,
          "report",
          Option.some(9)
        );
        expect(Option.getOrUndefined(latest)).toEqual({
          html: "<p>two</p>",
          version: 2,
        });
        expect(Option.getOrUndefined(first)).toEqual({
          html: "<p>one</p>",
          version: 1,
        });
        expect(Option.isNone(missing)).toBe(true);
        expect(yield* deleteWorkspaceArtifact(root, "report")).toBe(true);
        expect(yield* deleteWorkspaceArtifact(root, "report")).toBe(false);
        expect(yield* listWorkspaceArtifacts(root)).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(BunServicesLayer))
  );

  it.effect(
    "lists newest first and skips a page whose manifest does not decode",
    () =>
      Effect.gen(function* () {
        const root = yield* workspace;
        const fs = yield* FileSystem.FileSystem;
        yield* save(root, "alpha", "<p>a</p>");
        yield* Effect.sleep("1 second");
        yield* save(root, "beta", "<p>b</p>");
        yield* fs.makeDirectory(`${root}/artifacts/broken`, {
          recursive: true,
        });
        yield* fs.writeFileString(
          `${root}/artifacts/broken/artifact.json`,
          "{"
        );
        const listed = yield* listWorkspaceArtifacts(root);
        expect(listed.map((artifact) => artifact.name)).toEqual([
          "beta",
          "alpha",
        ]);
      }).pipe(Effect.scoped, Effect.provide(BunServicesLayer))
  );

  it.effect.each([
    "",
    "-leading",
    "Upper",
    "under_score",
    "dot.name",
    "a".repeat(64),
    "../escape",
  ])("refuses the name %p everywhere", (name) =>
    Effect.gen(function* () {
      const root = yield* workspace;
      expect(isArtifactName(name)).toBe(false);
      expect(yield* deleteWorkspaceArtifact(root, name)).toBe(false);
      expect(
        Option.isNone(yield* readWorkspaceArtifact(root, name, Option.none()))
      ).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(BunServicesLayer))
  );

  it.effect.each([
    "a",
    "vendor-comparison",
    "q3-report-2026",
    "a".repeat(63),
  ])("accepts the name %p", (name) =>
    Effect.succeed(
      expect(isArtifactName(name) && name.length <= 63).toBe(true)
    )
  );
});
