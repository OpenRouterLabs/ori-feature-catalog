import { layer as BunServicesLayer } from "@effect/platform-bun/BunServices";
import { layerWebSocketConstructor } from "@effect/platform-bun/BunSocket";
import type { ThreadId, ToolCallContext, ToolResult, WorkspaceId } from "ori";
import { Effect, FileSystem, Layer } from "effect";

import type { PreviewServices } from "#src/tools/context.ts";

import { scriptedDaemonCredentialsLayer } from "#src/daemon-credentials/test-support.ts";
import { PreviewError } from "#src/errors.ts";
import { fetchHttpClientLayer } from "#src/http.ts";
import { recordingProcessGroupsLayer } from "#src/process-groups/test-support.ts";
import { scriptedTcpProbeLayer } from "#src/tcp-probe/test-support.ts";
import { previewToolHandler, textResult } from "#src/tools/context.ts";
import { describe, expect, it } from "#src/effect-bun-test.ts";

const services = Layer.mergeAll(
  BunServicesLayer,
  fetchHttpClientLayer,
  layerWebSocketConstructor,
  scriptedDaemonCredentialsLayer,
  recordingProcessGroupsLayer(),
  scriptedTcpProbeLayer()
);

const callContext = (root: string): ToolCallContext => ({
  signal: new AbortController().signal,
  progress: () => undefined,
  thread: {
    harness: "ori",
    id: "preview-thread" as ThreadId,
    input: { attachments: [], config: { env: { SLACK_CHANNEL_ID: "C1" } }, prompt: "preview" },
    model: "test/model",
    parent: undefined,
    session: { id: "preview-session" },
  },
  workspace: {
    id: "preview-workspace" as WorkspaceId,
    root,
    capabilities: ["execute", "network", "read", "write"],
    sandbox: {
      writableRoots: [],
      readOnlyPaths: [],
      externalSandbox: false,
      processIsolation: true,
      networkEgress: "off",
    },
  },
});

const runWith = (
  execute: Parameters<typeof previewToolHandler<{ readonly repo: string }>>[0]
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    const context = yield* Effect.context<PreviewServices>();
    const handler = previewToolHandler(execute, { HOME: "/home/intern" }, context)();
    return yield* Effect.promise(
      (): Promise<ToolResult> => Promise.resolve(handler.run({ ...callContext(root), args: { repo: "acme/web" } }))
    );
  }).pipe(Effect.scoped, Effect.provide(services));

const textOf = (result: ToolResult): string =>
  result.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n");

describe("previewToolHandler", () => {
  it.effect("hands the tool its arguments, the host env, the turn env, and the workspace's preview paths", () =>
    Effect.gen(function* () {
      const result = yield* runWith((context) =>
        Effect.succeed(
          textResult(`${context.args.repo} ${context.env.HOME} ${context.turnEnv.SLACK_CHANNEL_ID} ${context.paths.root === `${context.workspaceRoot}/.ori/preview`}`)
        )
      );
      expect(textOf(result)).toBe("acme/web /home/intern C1 true");
    })
  );

  it.effect("turns a preview failure into a tool result naming its code", () =>
    Effect.gen(function* () {
      const result = yield* runWith(() =>
        Effect.fail(new PreviewError({ code: "not_ready", detail: "acme/web is not warm" }))
      );
      expect(textOf(result)).toBe("Preview failed (not_ready): acme/web is not warm");
    })
  );

  it.effect("turns a filesystem failure into a tool result instead of throwing", () =>
    Effect.gen(function* () {
      const result = yield* runWith((context) =>
        FileSystem.FileSystem.pipe(
          Effect.flatMap((fs) => fs.readFileString(`${context.workspaceRoot}/missing.json`)),
          Effect.map(textResult)
        )
      );
      expect(textOf(result)).toStartWith("Preview failed on the filesystem: ");
    })
  );
});
