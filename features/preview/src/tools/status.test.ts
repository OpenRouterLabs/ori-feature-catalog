import { layer as BunServicesLayer } from "@effect/platform-bun/BunServices";
import { Effect, FileSystem, Layer } from "effect";

import { devLogPath, previewPaths, PREVIEW_REPOS_ENV } from "#src/paths.ts";
import { recordingProcessGroupsLayer } from "#src/process-groups/test-support.ts";
import { writeAlternate, writePreviewStatus } from "#src/status/index.ts";
import { runPreviewStatus } from "#src/tools/status.ts";
import { fetchHttpClientLayer } from "#src/http.ts";
import { describe, expect, it } from "#src/effect-bun-test.ts";

const LIVE_PID = 601;

const fixture = Layer.mergeAll(
  BunServicesLayer,
  fetchHttpClientLayer,
  recordingProcessGroupsLayer(undefined, { ownPid: 1, alive: (pid) => pid === LIVE_PID })
);

const env = { [PREVIEW_REPOS_ENV]: "acme/web,acme/api" };

const statusText = (root: string, repo?: string) =>
  runPreviewStatus({ args: { repo }, paths: previewPaths(root), env, turnEnv: {}, workspaceRoot: root }).pipe(
    Effect.map((result) => result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"))
  );

describe("preview-status", () => {
  it.effect("lists the connected repositories when none was warmed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      expect(yield* statusText(root)).toBe("Connected: acme/web, acme/api. None has been warmed yet.");
    }).pipe(Effect.scoped, Effect.provide(fixture))
  );

  it.effect("describes each preview, flags a dead server, and lists repos not warmed yet", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const paths = previewPaths(root);
      yield* writePreviewStatus(paths, {
        repo: "acme/web",
        phase: "warm",
        process: { pid: 999 },
        url: "http://127.0.0.1:41000/",
        recipeSource: "preview-json",
        headSha: "0123456789abcdef",
        reason: "compiled with warnings",
      });
      const text = yield* statusText(root);
      expect(text).toContain("- acme/web: warm (process gone; run preview-warm), url http://127.0.0.1:41000/, recipe from preview-json, at 0123456");
      expect(text).toContain("reason: compiled with warnings");
      expect(text).toContain("Connected, not warmed yet: acme/api");
    }).pipe(Effect.scoped, Effect.provide(fixture))
  );

  it.effect("for one repository, adds its running changed copy and the dev server's last output", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const paths = previewPaths(root);
      yield* writePreviewStatus(paths, { repo: "acme/web", phase: "warm", process: { pid: LIVE_PID } });
      yield* writeAlternate(paths, {
        repo: "acme/web",
        directory: "/preview/work/web",
        port: 41_001,
        process: { pid: LIVE_PID },
        url: "http://127.0.0.1:41001/",
      });
      yield* fs.makeDirectory(paths.logs, { recursive: true });
      yield* fs.writeFileString(devLogPath(paths, "acme/web"), "ready in 2s\n");
      const text = yield* statusText(root, "Acme/Web");
      expect(text).toContain("- acme/web: warm");
      expect(text).toContain("changed copy: http://127.0.0.1:41001/ from /preview/work/web");
      expect(text).toContain("ready in 2s");
    }).pipe(Effect.scoped, Effect.provide(fixture))
  );
});
