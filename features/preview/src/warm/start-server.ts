import { Effect, FileSystem, Option } from "effect";

import type { ProcessRef } from "#src/process/index.ts";
import type { HostEnv } from "#src/sandbox/index.ts";
import type { PreviewRecipe } from "#src/schemas.ts";

import { PreviewError } from "#src/errors.ts";
import { localUrl, LOOPBACK_HOSTS, PORT_PLACEHOLDER } from "#src/paths.ts";
import {
  ensurePortFree,
  isAlive,
  killGroup,
  runToLog,
  shellCommand,
  spawnDetached,
  tailLog,
} from "#src/process/index.ts";
import { judgeResponse, waitForHttp } from "#src/readiness/index.ts";
import {
  boundPreviewValue,
  isWithheld,
  sandboxed,
  sandboxEnv,
} from "#src/sandbox/index.ts";
import { untrusted } from "#src/untrusted/index.ts";

export type { HostEnv } from "#src/sandbox/index.ts";

export const missingEnv = (
  recipe: PreviewRecipe,
  env: HostEnv
): readonly string[] =>
  (recipe.requiredEnv ?? []).filter(
    (name) =>
      !(
        recipe.env?.[name] ??
        (isWithheld(name) ? undefined : boundPreviewValue(env, name))
      )?.trim()
  );

export const withPort = (command: string, port: number): string =>
  command.replaceAll(PORT_PLACEHOLDER, String(port));

export const serverEnv = (input: {
  readonly recipe: PreviewRecipe;
  readonly host: HostEnv;
  readonly home: string;
  readonly port: number;
}): HostEnv => ({
  ...sandboxEnv({
    host: input.host,
    home: input.home,
    passNames: input.recipe.requiredEnv,
  }),
  BROWSER: "none",
  CI: "1",
  HOST: "127.0.0.1",
  PORT: String(input.port),
  ...Object.fromEntries(
    Object.entries(input.recipe.env ?? {}).filter(([name]) => !isWithheld(name))
  ),
});

export const runInstall = Effect.fn("Preview.warm.install")(function* (input: {
  readonly recipe: PreviewRecipe;
  readonly checkout: string;
  readonly env: HostEnv;
  readonly home: string;
  readonly port: number;
  readonly logPath: string;
}) {
  if (Option.isNone(Option.fromNullishOr(input.recipe.install))) {
    return;
  }
  const exitCode = yield* runToLog({
    command: sandboxed(
      shellCommand(withPort(input.recipe.install ?? "", input.port))
    ),
    cwd: input.checkout,
    env: serverEnv({
      recipe: input.recipe,
      host: input.env,
      home: input.home,
      port: input.port,
    }),
    logPath: input.logPath,
  });
  if (exitCode !== 0) {
    return yield* new PreviewError({
      code: "install_failed",
      detail: `The install command ${untrusted(input.recipe.install ?? "", 400)} exited ${exitCode}.\n${untrusted(yield* tailLog(input.logPath))}`,
    });
  }
});

export interface StartedServer {
  readonly process: ProcessRef;
  readonly url: string;
}

export const startServer = Effect.fn("Preview.warm.startServer")(
  function* (input: {
    readonly recipe: PreviewRecipe;
    readonly directory: string;
    readonly env: HostEnv;
    readonly home: string;
    readonly port: number;
    readonly logPath: string;
  }) {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(input.logPath, "").pipe(Effect.ignore);
    yield* ensurePortFree(input.port);
    const process = yield* spawnDetached({
      command: sandboxed(shellCommand(withPort(input.recipe.dev, input.port))),
      cwd: input.directory,
      env: serverEnv({
        recipe: input.recipe,
        host: input.env,
        home: input.home,
        port: input.port,
      }),
      logPath: input.logPath,
    });
    const readyPath = input.recipe.readyPath ?? "/";
    const [first, ...rest] = LOOPBACK_HOSTS.map((host) =>
      localUrl(input.port, readyPath, host)
    );
    const response = yield* waitForHttp(
      [first, ...rest],
      isAlive(process)
    ).pipe(
      Effect.tapError(() => killGroup(process)),
      Effect.catchTag("PreviewError", (error) =>
        tailLog(input.logPath).pipe(
          Effect.flatMap((tail) =>
            Effect.fail(
              new PreviewError({
                code: error.code,
                detail: `${error.detail}\n${untrusted(tail)}`,
              })
            )
          )
        )
      )
    );
    const problem = judgeResponse(response);
    if (Option.isSome(problem)) {
      yield* killGroup(process);
      return yield* new PreviewError({
        code: "not_ready",
        detail: `The dev server started but ${problem.value}.\n${untrusted(yield* tailLog(input.logPath))}`,
      });
    }
    const started: StartedServer = { process, url: response.url };
    return started;
  }
);
