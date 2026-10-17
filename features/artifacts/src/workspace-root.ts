import type { FileSystem, Path } from "effect";

import { Effect } from "effect";

const FEATURES_DIR = "features";

const isDirectory = (
  fs: FileSystem.FileSystem,
  targetPath: string
): Effect.Effect<boolean> =>
  fs.exists(targetPath).pipe(
    Effect.flatMap((exists) =>
      exists
        ? fs.stat(targetPath).pipe(
            Effect.map((stat) => stat.type === "Directory"),
            Effect.orElseSucceed(() => false)
          )
        : Effect.succeed(false)
    ),
    Effect.orElseSucceed(() => false)
  );

export const findWorkspaceRootFromCwd = Effect.fn(
  "Artifacts.findWorkspaceRoot"
)(function* (fs: FileSystem.FileSystem, path: Path.Path, startDir: string) {
  let dir = path.resolve(startDir);

  for (;;) {
    const hasFeatures = yield* isDirectory(fs, path.join(dir, FEATURES_DIR));
    if (hasFeatures) {
      return dir;
    }

    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
});
