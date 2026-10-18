import { Effect, Option, Predicate } from "effect";

import type { PreviewStatus } from "#src/schemas.ts";
import type { PreviewToolContext } from "#src/tools/context.ts";

import { devLogPath } from "#src/paths.ts";
import { isAlive, tailLog } from "#src/process/index.ts";
import { readAlternate, readAllPreviewStatuses } from "#src/status/index.ts";
import { textResult } from "#src/tools/context.ts";
import { untrusted } from "#src/untrusted/index.ts";
import { connectedRepos } from "#src/warm/index.ts";

const describeStatus = (status: PreviewStatus, alive: boolean): string => {
  const phase = alive ? status.phase : "warm (process gone; run preview-warm)";
  const parts = [
    `- ${status.repo}: ${phase}`,
    status.url ? `url ${status.url}` : undefined,
    status.recipeSource ? `recipe from ${status.recipeSource}` : undefined,
    status.headSha ? `at ${status.headSha.slice(0, 7)}` : undefined,
  ].filter(Predicate.isNotUndefined);
  const reason = status.reason ? `\n  reason: ${status.reason}` : "";
  return `${parts.join(", ")}${reason}`;
};

const NO_REPOS =
  "No repositories were found for previews: GitHub is not connected for this intern, or its installation grants no repositories. Pass a repo to preview-warm to warm one anyway.";

export const runPreviewStatus = Effect.fn("Preview.tool.status")(function* (
  context: PreviewToolContext<{ readonly repo?: string | undefined }>
) {
  const statuses = yield* readAllPreviewStatuses(context.paths);
  const repos = yield* connectedRepos(context.env);
  const filter = context.args.repo?.toLowerCase();
  const shown = statuses.filter(
    (status) => Predicate.isUndefined(filter) || status.repo === filter
  );
  if (shown.length === 0) {
    return textResult(
      repos.length === 0
        ? NO_REPOS
        : `Connected: ${repos.join(", ")}. None has been warmed yet.`
    );
  }
  const lines = yield* Effect.forEach(shown, (status) =>
    (status.phase === "warm"
      ? isAlive(status.process)
      : Effect.succeed(true)
    ).pipe(Effect.map((alive) => describeStatus(status, alive)))
  );
  const notWarmed = repos.filter(
    (repo) => !statuses.some((status) => status.repo === repo)
  );
  if (Predicate.isUndefined(filter) && notWarmed.length > 0) {
    lines.push(`Connected, not warmed yet: ${notWarmed.join(", ")}`);
  }
  if (Predicate.isNotUndefined(filter)) {
    const alternate = yield* readAlternate(context.paths, filter);
    if (Option.isSome(alternate) && (yield* isAlive(alternate.value.process))) {
      lines.push(
        `  changed copy: ${alternate.value.url} from ${alternate.value.directory}`
      );
    }
    lines.push(
      `\nLast dev-server output:\n${untrusted(yield* tailLog(devLogPath(context.paths, filter), 20))}`
    );
  }
  return textResult(lines.join("\n"));
});
