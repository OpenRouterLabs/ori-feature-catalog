import type { Context, FileSystem, Path, PlatformError } from "effect";
import type { HttpClient } from "effect/http";
import type { ChildProcessSpawner } from "effect/process";
import type { Socket } from "effect/socket";

import { Effect } from "effect";

import type { PreviewError } from "../errors.ts";
import type { PreviewPaths } from "../paths.ts";
import type { ProcessGroups } from "../process-groups/index.ts";
import type { TcpProbe } from "../tcp-probe/index.ts";
import type { DaemonCredentials } from "../daemon-credentials/index.ts";
import type { ToolHandler, ToolResult, ToolRunInput } from "ori";

import { previewPaths } from "../paths.ts";

export type PreviewServices =
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
  | HttpClient.HttpClient
  | ProcessGroups
  | DaemonCredentials
  | TcpProbe
  | Socket.WebSocketConstructor;

export interface PreviewToolContext<Args> {
  readonly args: Args;
  readonly paths: PreviewPaths;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly turnEnv: Readonly<Record<string, string | undefined>>;
  readonly workspaceRoot: string;
}

export const textResult = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
});

const failureResult = (error: PreviewError): ToolResult =>
  textResult(`Preview failed (${error.code}): ${error.detail}`);

export const previewToolHandler =
  <Args>(
    execute: (
      context: PreviewToolContext<Args>
    ) => Effect.Effect<
      ToolResult,
      PreviewError | PlatformError.PlatformError,
      PreviewServices
    >,
    env: Readonly<Record<string, string | undefined>>,
    services: Context.Context<PreviewServices>
  ): (() => ToolHandler<Args>) =>
  () => ({
    run: (input: ToolRunInput<Args>) =>
      Effect.runPromiseWith(services)(
        execute({
          args: input.args,
          env,
          turnEnv: input.thread.input.config.env ?? {},
          paths: previewPaths(input.workspace.root),
          workspaceRoot: input.workspace.root,
        }).pipe(
          Effect.catchTags({
            PlatformError: (error) =>
              Effect.succeed(
                textResult(`Preview failed on the filesystem: ${error.message}`)
              ),
            PreviewError: (error) => Effect.succeed(failureResult(error)),
          })
        ),
        { signal: input.signal }
      ),
  });
