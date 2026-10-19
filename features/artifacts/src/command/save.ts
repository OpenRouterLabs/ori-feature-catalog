import { Effect, FileSystem, Option, Path } from "effect";

import { CliFailureError } from "../failures.ts";
import { artifactDashboardLink, hostedInternId } from "../dashboard-link.ts";
import { findWorkspaceRootFromCwd } from "../workspace-root.ts";
import { inlinePage } from "../inline-page/index.ts";
import { isArtifactName, saveWorkspaceArtifact } from "../store/index.ts";

export interface SaveDeps {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly readFileString: (path: string) => Promise<string>;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

const ARTIFACT_MAX_BYTES = 16 * 1024 * 1024;

const utf8 = new TextEncoder();

const byteLength = (html: string): number => utf8.encode(html).byteLength;

const workspaceRoot = Effect.fn("Artifacts.workspaceRoot")(function* (
  deps: SaveDeps
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const found = yield* findWorkspaceRootFromCwd(fs, path, deps.cwd);
  return found ?? path.resolve(deps.cwd);
});

export const preparePage = Effect.fn("Artifacts.preparePage")(function* (
  source: string
) {
  const bytes = byteLength(source);
  if (bytes > ARTIFACT_MAX_BYTES) {
    return yield* new CliFailureError({
      detail: `The page is ${bytes} bytes as written, over the 16 MiB (${ARTIFACT_MAX_BYTES}-byte) limit.`,
      failureCode: "ORI_CLI_ARTIFACT_TOO_LARGE",
      hint: "Drop large images or libraries the page does not use, or split it into several pages.",
    });
  }
  const { FetchHttpClient } = yield* Effect.promise(() =>
    import("effect/http")
  );
  const page = yield* inlinePage(source).pipe(
    Effect.provide(FetchHttpClient.layer)
  );
  const inlinedBytes = byteLength(page.html);
  if (inlinedBytes > ARTIFACT_MAX_BYTES) {
    return yield* new CliFailureError({
      detail: `The page is ${inlinedBytes} bytes after putting its CDN files inside it, over the 16 MiB (${ARTIFACT_MAX_BYTES}-byte) limit.`,
      failureCode: "ORI_CLI_ARTIFACT_TOO_LARGE",
      hint: "Drop large images or libraries the page does not use, or split it into several pages.",
    });
  }
  return { ...page, bytes: inlinedBytes };
});

export const runArtifactSave = Effect.fn("Artifacts.save")(function* (
  deps: SaveDeps,
  config: {
    readonly file: string;
    readonly name: string;
    readonly title: Option.Option<string>;
  }
) {
  if (!isArtifactName(config.name)) {
    return yield* new CliFailureError({
      detail: `"${config.name}" is not an artifact name: a name starts with a lowercase letter or digit, then up to 62 more lowercase letters, digits or hyphens.`,
      failureCode: "ORI_CLI_ARTIFACT_NAME_INVALID",
      hint: "Use a name such as vendor-comparison. Saving the same name again adds a version behind the same link.",
    });
  }
  const path = yield* Path.Path;
  const root = yield* workspaceRoot(deps);
  const source = yield* Effect.tryPromise({
    try: () => deps.readFileString(path.resolve(deps.cwd, config.file)),
    catch: (cause) =>
      new CliFailureError({
        cause,
        detail: `Failed to read ${config.file}`,
        failureCode: "ORI_CLI_ARTIFACT_FILE_UNREADABLE",
      }),
  });
  const page = yield* preparePage(source);
  const internId = hostedInternId(deps.env);
  const saved = yield* saveWorkspaceArtifact(root, {
    html: page.html,
    name: config.name,
    title: config.title,
  }).pipe(
    Effect.mapError(
      (error) =>
        new CliFailureError({
          cause: error,
          detail: error.detail,
          failureCode: "ORI_CLI_ARTIFACT_STORE_FAILED",
        })
    )
  );
  const link = Option.isSome(internId)
    ? yield* artifactDashboardLink(internId.value, config.name)
    : saved.file;
  yield* Effect.sync(() =>
    deps.stderr(
      `Saved ${config.name} as version ${saved.entry.version} in ${saved.file} (${page.bytes} bytes, ${page.inlinedCount} CDN ${page.inlinedCount === 1 ? "file" : "files"} put inside the page).\n`
    )
  );
  yield* Effect.sync(() => deps.stdout(`${link}\n`));
  return {
    bytes: page.bytes,
    file: saved.file,
    inlined: page.inlinedCount,
    link,
    name: config.name,
    version: saved.entry.version,
  };
});
