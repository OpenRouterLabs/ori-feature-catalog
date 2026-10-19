import { layer as BunServicesLayer } from "@effect/platform-bun/BunServices";
import { layerWebSocketConstructor } from "@effect/platform-bun/BunSocket";
import { Arbitrary, Effect, FileSystem, Layer, Predicate } from "effect";

import type { DirectResponse } from "../readiness/direct-get.ts";
import type { PreviewServices } from "./context.ts";
import type { PreviewToolSpec } from "./index.ts";
import type { ThreadId, ToolCallContext, ToolResult, WorkspaceId } from "ori";

import { previewPaths } from "../paths.ts";
import {
  emptyProcessGroupsRecording,
  recordingProcessGroupsLayer,
} from "../process-groups/test-support.ts";
import { ProcessRefSchema } from "../schemas.ts";
import { writePreviewStatus } from "../status/index.ts";
import { TcpProbe } from "../tcp-probe/index.ts";
import { scriptedTcpProbeLayer } from "../tcp-probe/test-support.ts";
import { previewToolHandler, textResult } from "./context.ts";
import { makePreviewTools } from "./index.ts";
import { scriptedDaemonCredentialsLayer } from "../daemon-credentials/test-support.ts";
import { fetchHttpClientLayer } from "../http.ts";
import { describe, expect, it } from "../effect-bun-test.ts";

const callContext = (root: string): ToolCallContext => ({
  signal: new AbortController().signal,
  progress: () => undefined,
  thread: {
    harness: "ori",
    id: "preview-thread" as ThreadId,
    input: { attachments: [], config: {}, prompt: "show me the preview" },
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

const sharedPreviewLayer = Layer.mergeAll(
  BunServicesLayer,
  fetchHttpClientLayer,
  layerWebSocketConstructor,
  scriptedDaemonCredentialsLayer
);

const asSpec = <Args>(spec: PreviewToolSpec<Args>): PreviewToolSpec<unknown> =>
  spec as unknown as PreviewToolSpec<unknown>;

const textOf = (result: ToolResult): string =>
  result.content
    .flatMap((item) => (item.type === "text" ? [item.text] : []))
    .join("\n");

describe("preview tool handlers", () => {
  it.effect(
    "a preview tool handler runs on the captured context, observed through a TcpProbe test double",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped();
        const probed: string[] = [];
        const scripted: DirectResponse = {
          status: 200,
          body: "served by the scripted probe",
        };
        const services = yield* Effect.context<PreviewServices>().pipe(
          Effect.provide(
            scriptedTcpProbeLayer({
              get: (url) =>
                Effect.sync(() => {
                  probed.push(url);
                  return scripted;
                }),
            })
          )
        );
        const handler = previewToolHandler<{ readonly url: string }>(
          (context) =>
            TcpProbe.use((probe) => probe.get(context.args.url)).pipe(
              Effect.map((response) =>
                textResult(`${response.status}: ${response.body}`)
              )
            ),
          {},
          services
        )();
        const url = "http://127.0.0.1:41000/";
        const result = yield* Effect.promise(async () =>
          handler.run({ ...callContext(root), args: { url } })
        );
        expect(result).toEqual(textResult(`200: ${scripted.body}`));
        expect(probed).toEqual([url]);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.merge(sharedPreviewLayer, recordingProcessGroupsLayer())
        )
      )
  );

  it.effect(
    "makePreviewTools builds preview-status on its captured context, so a liveness check signals through the recorded ProcessGroups",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
        const [process] = yield* Arbitrary.sampleEffect(
          Arbitrary.filter(
            Arbitrary.schema(ProcessRefSchema),
            (ref) => ref.pid > 1
          ),
          { count: 1 }
        );
        if (Predicate.isUndefined(process)) {
          return yield* Effect.die("no process ref sampled");
        }
        const recording = emptyProcessGroupsRecording();
        const repo = "acme/web";
        const tools = yield* Effect.gen(function* () {
          yield* writePreviewStatus(previewPaths(root), {
            repo,
            phase: "warm",
            process: { pid: process.pid },
            url: "http://127.0.0.1:41000/",
          });
          return yield* makePreviewTools({ ORI_PREVIEW_REPOS: repo }, asSpec);
        }).pipe(Effect.provide(recordingProcessGroupsLayer(recording)));
        const status = tools.find((tool) => tool.name === "preview-status");
        if (Predicate.isUndefined(status)) {
          return yield* Effect.die("preview-status is missing");
        }
        const context = callContext(root);
        const result = yield* Effect.promise(async () => {
          const handler = await status.init(context);
          return handler.run({ ...context, args: {} });
        });
        expect(recording.signals).toEqual([{ pid: process.pid, signal: 0 }]);
        expect(textOf(result)).toContain(
          `- ${repo}: warm (process gone; run preview-warm)`
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.merge(sharedPreviewLayer, scriptedTcpProbeLayer()))
      )
  );

  it.effect(
    "preview-status lists connected repos that have no status yet beside the warmed ones, so a newly discovered repo stays visible",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
        const tools = yield* Effect.gen(function* () {
          yield* writePreviewStatus(previewPaths(root), {
            repo: "acme/web",
            phase: "not_runnable",
            reason: "no dev script",
          });
          return yield* makePreviewTools(
            { ORI_PREVIEW_REPOS: "acme/web,acme/api" },
            asSpec
          );
        }).pipe(Effect.provide(recordingProcessGroupsLayer()));
        const status = tools.find((tool) => tool.name === "preview-status");
        if (Predicate.isUndefined(status)) {
          return yield* Effect.die("preview-status is missing");
        }
        const context = callContext(root);
        const result = yield* Effect.promise(async () => {
          const handler = await status.init(context);
          return handler.run({ ...context, args: {} });
        });
        expect(textOf(result)).toContain("- acme/web: not_runnable");
        expect(textOf(result)).toContain("Connected, not warmed yet: acme/api");
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.merge(sharedPreviewLayer, scriptedTcpProbeLayer()))
      )
  );
});
