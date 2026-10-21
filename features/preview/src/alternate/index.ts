import { Effect, Option } from "effect";

import type { PreviewPaths } from "#src/paths.ts";
import type { AlternateServer } from "#src/schemas.ts";
import type { HostEnv } from "#src/warm/start-server.ts";

import { PreviewError } from "#src/errors.ts";
import {
  alternateLogPath,
  PREVIEW_PORT_RANGE,
  repoCheckout,
} from "#src/paths.ts";
import {
  assignPort,
  isAlive,
  killGroup,
  runToLog,
} from "#src/process/index.ts";
import { resolveRecipe } from "#src/recipe/index.ts";
import { chownTree, prepareSandbox } from "#src/sandbox/index.ts";
import {
  claimedPorts,
  readAlternate,
  writeAlternate,
} from "#src/status/index.ts";
import { runInstall, startServer } from "#src/warm/start-server.ts";

const handToSandbox = Effect.fn("Preview.alternate.handToSandbox")(function* (
  paths: PreviewPaths,
  repo: string,
  directory: string
) {
  const exitCode = yield* runToLog({
    command: chownTree(directory),
    cwd: paths.work,
    env: {},
    logPath: alternateLogPath(paths, repo),
  });
  if (exitCode !== 0) {
    return yield* new PreviewError({
      code: "start_failed",
      detail: `The changed copy in ${directory} could not be handed to the preview sandbox.`,
    });
  }
});

const reuseExisting = Effect.fn("Preview.alternate.reuseExisting")(function* (
  existing: Option.Option<AlternateServer>,
  directory: string
) {
  if (Option.isNone(existing) || existing.value.directory !== directory) {
    return Option.none<AlternateServer>();
  }
  return (yield* isAlive(existing.value.process))
    ? existing
    : Option.none<AlternateServer>();
});

export const startAlternate = Effect.fn("Preview.alternate.start")(
  function* (input: {
    readonly paths: PreviewPaths;
    readonly repo: string;
    readonly directory: string;
    readonly env: HostEnv;
  }) {
    const { paths, repo, directory, env } = input;
    const existing = yield* readAlternate(paths, repo);
    const reusable = yield* reuseExisting(existing, directory);
    if (Option.isSome(reusable)) {
      return reusable.value;
    }
    yield* killGroup(Option.getOrUndefined(existing)?.process);
    yield* prepareSandbox(paths, env);
    yield* handToSandbox(paths, repo, directory);
    const resolved = yield* resolveRecipe(
      paths,
      repo,
      repoCheckout(paths, repo)
    );
    const port = yield* assignPort(
      PREVIEW_PORT_RANGE,
      yield* claimedPorts(paths)
    );
    yield* runInstall({
      recipe: resolved.recipe,
      checkout: directory,
      env,
      home: paths.home,
      port,
      logPath: alternateLogPath(paths, repo),
    });
    const server = yield* startServer({
      recipe: resolved.recipe,
      directory,
      env,
      home: paths.home,
      port,
      logPath: alternateLogPath(paths, repo),
    }).pipe(
      Effect.catchTag("PreviewError", (error) =>
        Effect.fail(
          new PreviewError({
            code: error.code,
            detail: `The changed copy in ${directory} did not start on port ${port}. ${error.detail}`,
          })
        )
      )
    );
    const alternate: AlternateServer = {
      repo,
      directory,
      port,
      process: server.process,
      url: server.url,
    };
    yield* writeAlternate(paths, alternate).pipe(
      Effect.tapError(() => killGroup(server.process))
    );
    return alternate;
  }
);
