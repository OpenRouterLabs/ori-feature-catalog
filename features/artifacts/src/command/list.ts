import { Effect, FileSystem, Path } from "effect";

import { findWorkspaceRootFromCwd } from "../workspace-root.ts";
import { listWorkspaceArtifacts } from "../store/index.ts";
import type { SaveDeps } from "./save.ts";

const workspaceRoot = Effect.fn("Artifacts.listWorkspaceRoot")(function* (
  deps: SaveDeps
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const found = yield* findWorkspaceRootFromCwd(fs, path, deps.cwd);
  return found ?? path.resolve(deps.cwd);
});

export const runArtifactList = Effect.fn("Artifacts.list")(function* (
  deps: SaveDeps
) {
  const root = yield* workspaceRoot(deps);
  const artifacts = yield* listWorkspaceArtifacts(root);
  yield* Effect.sync(() => {
    if (artifacts.length === 0) {
      deps.stdout("This workspace has no artifacts.\n");
      return;
    }
    deps.stdout(
      artifacts
        .map(
          (artifact) =>
            `${artifact.name}  v${artifact.latest_version}  ${artifact.title}  (updated ${artifact.updated_at})\n`
        )
        .join("")
    );
  });
  return { artifacts };
});
