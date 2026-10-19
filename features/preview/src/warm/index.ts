import { Effect, Option, Schema } from "effect";

import type { PreviewPaths } from "../paths.ts";
import type { ConnectedRepos, PreviewStatus } from "../schemas.ts";
import type { HostEnv } from "./start-server.ts";

import { withRepoLock } from "../lock/index.ts";
import {
  PREVIEW_ENABLED_ENV,
  PREVIEW_MAX_WARM,
  PREVIEW_REPOS_ENV,
} from "../paths.ts";
import { killGroup } from "../process/index.ts";
import { discoverInstallationRepos } from "../repo/discover.ts";
import { prepareSandbox } from "../sandbox/index.ts";
import { ConnectedReposSchema, REPO_NAME_PATTERN } from "../schemas.ts";
import {
  clearAlternate,
  readAllPreviewStatuses,
  readAlternate,
  readPreviewStatus,
  writePreviewStatus,
} from "../status/index.ts";
import { warmRepo } from "./warm-repo.ts";

const decodeRepoList = Schema.decodeUnknownOption(ConnectedReposSchema);

export const previewEnabledInEnv = (env: HostEnv): boolean =>
  env[PREVIEW_ENABLED_ENV]?.trim() === "1" || configuredRepos(env).length > 0;

export const configuredRepos = (env: HostEnv): ConnectedRepos => {
  const entries = (env[PREVIEW_REPOS_ENV] ?? "")
    .split(/[\s,]+/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const unique = [...new Set(entries.map((entry) => entry.toLowerCase()))];
  return Option.getOrElse(
    decodeRepoList(unique.filter((entry) => REPO_NAME_PATTERN.test(entry))),
    () => []
  );
};

const lastUsed = (status: PreviewStatus | undefined): string =>
  status?.lastUsedAt ?? "";

export const pickWarmSet = (
  repos: ConnectedRepos,
  statuses: readonly PreviewStatus[],
  limit = PREVIEW_MAX_WARM
): ConnectedRepos => {
  const byRepo = new Map(statuses.map((status) => [status.repo, status]));
  return repos
    .map((repo, index) => ({ repo, index, used: lastUsed(byRepo.get(repo)) }))
    .toSorted(
      (left, right) =>
        right.used.localeCompare(left.used) || left.index - right.index
    )
    .slice(0, limit)
    .map((entry) => entry.repo);
};

const IN_FLIGHT_PHASES: ReadonlySet<PreviewStatus["phase"]> = new Set([
  "syncing",
  "installing",
  "starting",
  "warm",
]);

export const holdsResources = (status: PreviewStatus): boolean =>
  IN_FLIGHT_PHASES.has(status.phase);

export const PREVIEW_SLOT_LOCK = "__preview__/__slots__";

export const stopAlternate = Effect.fn("Preview.warm.stopAlternate")(function* (
  paths: PreviewPaths,
  repo: string
) {
  const alternate = yield* readAlternate(paths, repo);
  yield* killGroup(Option.getOrUndefined(alternate)?.process);
  yield* clearAlternate(paths, repo);
});

export const park = Effect.fn("Preview.warm.park")(function* (
  paths: PreviewPaths,
  repo: string
) {
  const current = yield* readPreviewStatus(paths, repo);
  if (Option.isNone(current) || !holdsResources(current.value)) {
    return;
  }
  const status = current.value;
  yield* killGroup(status.process);
  yield* stopAlternate(paths, repo);
  yield* writePreviewStatus(paths, {
    repo: status.repo,
    phase: "parked",
    headSha: status.headSha,
    headCheckedAt: status.headCheckedAt,
    installedSha: status.installedSha,
    recipeSource: status.recipeSource,
    lastUsedAt: status.lastUsedAt,
  });
});

export const makeRoom = Effect.fn("Preview.warm.makeRoom")(function* (
  paths: PreviewPaths,
  incoming: string,
  limit = PREVIEW_MAX_WARM
) {
  const statuses = yield* readAllPreviewStatuses(paths);
  const occupying = statuses.filter(
    (status) => holdsResources(status) && status.repo !== incoming
  );
  const surplus = occupying.length - (limit - 1);
  if (surplus <= 0) {
    return;
  }
  const coldest = occupying
    .toSorted((left, right) => lastUsed(left).localeCompare(lastUsed(right)))
    .slice(0, surplus);
  yield* Effect.forEach(coldest, (status) =>
    withRepoLock(paths, status.repo, park(paths, status.repo), "skip")
  );
});

export const connectedRepos = Effect.fn("Preview.warm.connectedRepos")(
  function* (env: HostEnv) {
    const configured = configuredRepos(env);
    if (configured.length > 0) {
      return configured;
    }
    return yield* discoverInstallationRepos();
  }
);

export const sweepCandidates = (
  env: HostEnv,
  statuses: readonly PreviewStatus[]
): ConnectedRepos => {
  const configured = configuredRepos(env);
  if (configured.length > 0) {
    return configured;
  }
  return statuses
    .filter((status) => Option.isSome(Option.fromNullishOr(status.lastUsedAt)))
    .map((status) => status.repo);
};

export const reconcilePreviews = Effect.fn("Preview.warm.reconcile")(function* (
  paths: PreviewPaths,
  env: HostEnv
) {
  const statuses = yield* readAllPreviewStatuses(paths);
  const repos = sweepCandidates(env, statuses);
  const warmSet = new Set(pickWarmSet(repos, statuses));
  if (warmSet.size > 0) {
    yield* prepareSandbox(paths, env).pipe(Effect.ignore);
  }
  yield* Effect.forEach(
    statuses.filter((status) => !warmSet.has(status.repo)),
    (status) =>
      withRepoLock(paths, status.repo, park(paths, status.repo), "wait")
  );
  yield* withRepoLock(
    paths,
    PREVIEW_SLOT_LOCK,
    Effect.forEach([...warmSet], (repo) =>
      withRepoLock(paths, repo, warmRepo(paths, repo, env, "sweep"), "skip")
    ),
    "skip"
  );
  return warmSet.size;
});
