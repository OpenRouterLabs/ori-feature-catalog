import { Effect, FileSystem, Path } from "effect";

import { CliFailureError } from "../failures.ts";
import { findWorkspaceRootFromCwd } from "../workspace-root.ts";
import { deleteWorkspaceArtifact } from "../store/index.ts";
import type { SaveDeps } from "./save.ts";

const workspaceRoot = Effect.fn("Artifacts.deleteWorkspaceRoot")(function* (
  deps: SaveDeps
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const found = yield* findWorkspaceRootFromCwd(fs, path, deps.cwd);
  return found ?? path.resolve(deps.cwd);
});

export const runArtifactDelete = Effect.fn("Artifacts.delete")(function* (
  deps: SaveDeps,
  name: string
) {
  const root = yield* workspaceRoot(deps);
  const deleted = yield* deleteWorkspaceArtifact(root, name).pipe(
    Effect.mapError(
      (error) =>
        new CliFailureError({
          cause: error,
          detail: error.detail,
          failureCode: "ORI_CLI_ARTIFACT_STORE_FAILED",
        })
    )
  );
  if (!deleted) {
    return yield* new CliFailureError({
      detail: `This workspace has no artifact named ${name}.`,
      failureCode: "ORI_CLI_ARTIFACT_NOT_FOUND",
      hint: "List this workspace's artifacts to see their names.",
    });
  }
  yield* Effect.sync(() =>
    deps.stdout(`Deleted artifact ${name} and every version of it.\n`)
  );
  return { deleted: true, name };
});
