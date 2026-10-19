import { DateTime, Effect, Option, Predicate } from "effect";

import type { PreviewPaths } from "../paths.ts";
import type { PreviewStatus, ResolvedRecipe } from "../schemas.ts";
import type { HostEnv } from "./start-server.ts";

import { capturePage, ensureBrowser } from "../browser/index.ts";
import { PreviewError } from "../errors.ts";
import {
  devLogPath,
  installLogPath,
  PREVIEW_PORT_RANGE,
  repoCheckout,
} from "../paths.ts";
import { assignPort, isAlive, killGroup } from "../process/index.ts";
import { resolveRecipe } from "../recipe/index.ts";
import { resolveHead, syncRepo } from "../repo/index.ts";
import { prepareSandbox } from "../sandbox/index.ts";
import {
  claimedPorts,
  readPreviewStatus,
  writePreviewStatus,
} from "../status/index.ts";
import { TcpProbe } from "../tcp-probe/index.ts";
import { untrusted } from "../untrusted/index.ts";
import { missingEnv, runInstall, startServer } from "./start-server.ts";

const HEAD_CHECK_INTERVAL_MS = 5 * 60 * 1000;

type Previous = Option.Option<PreviewStatus>;

export type WarmTrigger = "sweep" | "request";

const checkedRecently = (status: PreviewStatus, nowMs: number): boolean =>
  Option.fromNullishOr(status.headCheckedAt).pipe(
    Option.flatMap((checked) => Option.fromNullishOr(Date.parse(checked))),
    Option.filter((checked) => !Number.isNaN(checked)),
    Option.exists((checked) => nowMs - checked < HEAD_CHECK_INTERVAL_MS)
  );

const isServingHead = Effect.fn("Preview.warm.isServingHead")(function* (
  previous: Previous,
  sha: string
) {
  if (Option.isNone(previous)) {
    return false;
  }
  const status = previous.value;
  return (
    status.phase === "warm" &&
    status.headSha === sha &&
    (yield* isAlive(status.process))
  );
});

const FAILURE_RETRY_MS = 30 * 60 * 1000;

export const failedRecentlyAtHead = (
  previous: Previous,
  sha: string,
  nowMs: number
): boolean =>
  Option.exists(
    previous,
    (status) =>
      status.phase === "not_runnable" &&
      status.headSha === sha &&
      nowMs - Date.parse(status.updatedAt) < FAILURE_RETRY_MS
  );

export const needsInstall = (
  previous: Previous,
  synced: {
    readonly changedFiles: readonly string[];
    readonly isFresh: boolean;
  }
): boolean =>
  synced.isFresh ||
  synced.changedFiles.length > 0 ||
  Option.match(previous, {
    onNone: () => true,
    onSome: (status) =>
      Option.isNone(Option.fromNullishOr(status.installedSha)),
  });

const inRange = (port: number | undefined): port is number =>
  Predicate.isNotUndefined(port) &&
  port >= PREVIEW_PORT_RANGE.first &&
  port <= PREVIEW_PORT_RANGE.last;

const previewPort = Effect.fn("Preview.warm.port")(function* (
  paths: PreviewPaths,
  repo: string,
  previous: number | undefined
) {
  const claimed = yield* claimedPorts(paths, repo);
  const tcpProbe = yield* TcpProbe;
  if (
    inRange(previous) &&
    !claimed.has(previous) &&
    (yield* tcpProbe.isPortFree(previous))
  ) {
    return previous;
  }
  return yield* assignPort(PREVIEW_PORT_RANGE, claimed);
});

const precompile = (url: string) =>
  capturePage(url, { fullPage: false }).pipe(Effect.ignore);

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

interface BringUpInput {
  readonly paths: PreviewPaths;
  readonly repo: string;
  readonly sha: string;
  readonly resolved: ResolvedRecipe;
  readonly env: HostEnv;
  readonly install: boolean;
  readonly previous: Previous;
  readonly headCheckedAt: string;
}

const bringUp = Effect.fn("Preview.warm.bringUp")(function* (
  input: BringUpInput
) {
  const { paths, repo, sha, resolved, env } = input;
  const checkout = repoCheckout(paths, repo);
  const kept = Option.getOrUndefined(input.previous);
  const base = {
    repo,
    headSha: sha,
    headCheckedAt: input.headCheckedAt,
    recipeSource: resolved.source,
    lastUsedAt: kept?.lastUsedAt,
  };
  const outgoing = kept?.process;
  const servingOld = kept?.phase === "warm" && (yield* isAlive(outgoing));
  const port = yield* previewPort(paths, repo, kept?.port);
  if (input.install) {
    yield* runInstall({
      recipe: resolved.recipe,
      checkout,
      env,
      home: paths.home,
      port,
      logPath: installLogPath(paths, repo),
    });
  }
  if (servingOld) {
    yield* killGroup(outgoing);
  }
  yield* writePreviewStatus(paths, {
    ...base,
    installedSha: input.install ? sha : kept?.installedSha,
    phase: "starting",
  });
  const server = yield* startServer({
    recipe: resolved.recipe,
    directory: checkout,
    env,
    home: paths.home,
    port,
    logPath: devLogPath(paths, repo),
  });
  yield* ensureBrowser(paths, env).pipe(Effect.ignore);
  yield* precompile(server.url);
  yield* writePreviewStatus(paths, {
    ...base,
    installedSha: input.install ? sha : kept?.installedSha,
    phase: "warm",
    process: server.process,
    port,
    url: server.url,
  });
});

const recordFailure = Effect.fn("Preview.warm.recordFailure")(function* (
  paths: PreviewPaths,
  repo: string,
  error: PreviewError,
  context: Partial<PreviewStatus>
) {
  yield* killGroup(context.process);
  yield* writePreviewStatus(paths, {
    ...context,
    process: undefined,
    url: undefined,
    repo,
    phase: "not_runnable",
    reason: error.detail,
  });
});

const refreshHead = Effect.fn("Preview.warm.refreshHead")(function* (
  previous: Previous,
  repo: string,
  trigger: WarmTrigger
) {
  const nowMs = yield* DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
  const cached = Option.filter(
    previous,
    (status) =>
      trigger === "sweep" &&
      Option.isSome(Option.fromNullishOr(status.headSha)) &&
      checkedRecently(status, nowMs)
  );
  if (Option.isSome(cached)) {
    return {
      sha: cached.value.headSha ?? "",
      checkedAt: cached.value.headCheckedAt ?? "",
    };
  }
  const head = yield* resolveHead(repo);
  return { sha: head.sha, checkedAt: yield* nowIso };
});

const warmAtHead = Effect.fn("Preview.warm.atHead")(function* (
  paths: PreviewPaths,
  repo: string,
  env: HostEnv,
  previous: Previous,
  head: { readonly sha: string; readonly checkedAt: string }
) {
  yield* prepareSandbox(paths, env);
  const synced = yield* syncRepo(
    paths,
    repo,
    head.sha,
    killGroup(Option.getOrUndefined(previous)?.process)
  );
  const resolved = yield* resolveRecipe(paths, repo, synced.checkout);
  const missing = missingEnv(resolved.recipe, env);
  if (missing.length > 0) {
    return yield* new PreviewError({
      code: "not_ready",
      detail: `needs these environment variables bound as PREVIEW_ENV_<NAME> before it can run: ${untrusted(missing.join(", "), 400)}`,
    });
  }
  yield* bringUp({
    paths,
    repo,
    sha: head.sha,
    resolved,
    env,
    install: needsInstall(previous, synced),
    previous,
    headCheckedAt: head.checkedAt,
  });
});

const isServingAnything = Effect.fn("Preview.warm.isServingAnything")(
  function* (previous: Previous) {
    if (Option.isNone(previous) || previous.value.phase !== "warm") {
      return false;
    }
    return yield* isAlive(previous.value.process);
  }
);

const keepServingOrFail = Effect.fn("Preview.warm.keepServingOrFail")(
  function* (
    paths: PreviewPaths,
    repo: string,
    previous: Previous,
    error: PreviewError
  ) {
    if (
      error.code === "github_unavailable" &&
      (yield* isServingAnything(previous))
    ) {
      return Option.none<{
        readonly sha: string;
        readonly checkedAt: string;
      }>();
    }
    yield* recordFailure(paths, repo, error, {
      ...Option.getOrUndefined(previous),
    });
    return yield* error;
  }
);

const warmRepoUnguarded = Effect.fn("Preview.warm.repo")(function* (
  paths: PreviewPaths,
  repo: string,
  env: HostEnv,
  trigger: WarmTrigger
) {
  const previous = yield* readPreviewStatus(paths, repo);
  const head = yield* refreshHead(previous, repo, trigger).pipe(
    Effect.asSome,
    Effect.catchTag("PreviewError", (error) =>
      keepServingOrFail(paths, repo, previous, error)
    )
  );
  if (Option.isNone(head)) {
    return;
  }
  if (yield* isServingHead(previous, head.value.sha)) {
    return;
  }
  const nowMs = yield* DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
  if (
    trigger === "sweep" &&
    failedRecentlyAtHead(previous, head.value.sha, nowMs)
  ) {
    return;
  }
  yield* warmAtHead(paths, repo, env, previous, head.value).pipe(
    Effect.catchTag("PreviewError", (error) =>
      recordFailure(paths, repo, error, {
        ...Option.getOrUndefined(previous),
        headSha: head.value.sha,
        headCheckedAt: head.value.checkedAt,
        installedSha:
          error.code === "install_failed"
            ? undefined
            : Option.getOrUndefined(previous)?.installedSha,
      })
    )
  );
});

export const warmRepo = (
  paths: PreviewPaths,
  repo: string,
  env: HostEnv,
  trigger: WarmTrigger
) =>
  warmRepoUnguarded(paths, repo, env, trigger).pipe(
    Effect.catchTag("PreviewError", () => Effect.void)
  );
