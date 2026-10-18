import { Effect, Option } from "effect";

import type { PreviewToolContext } from "#src/tools/context.ts";

import { PreviewError } from "#src/errors.ts";
import { withRepoLock } from "#src/lock/index.ts";
import { readPreviewStatus, touchPreview } from "#src/status/index.ts";
import { textResult } from "#src/tools/context.ts";
import { makeRoom, PREVIEW_SLOT_LOCK } from "#src/warm/index.ts";
import { warmRepo } from "#src/warm/warm-repo.ts";

export const WARM_WAIT_NOTE =
  "Warming runs install and the first compile, which can take a few minutes on a cold repo. Post a status in the thread before calling this on one that is not warm yet.";

export const warmAndRead = Effect.fn("Preview.tool.warmAndRead")(function* (
  context: PreviewToolContext<unknown>,
  repo: string
) {
  const normalized = repo.toLowerCase();
  yield* withRepoLock(
    context.paths,
    PREVIEW_SLOT_LOCK,
    makeRoom(context.paths, normalized).pipe(
      Effect.andThen(
        withRepoLock(
          context.paths,
          normalized,
          warmRepo(context.paths, normalized, context.env, "request"),
          "wait"
        )
      )
    ),
    "wait"
  );
  const status = yield* readPreviewStatus(context.paths, normalized);
  if (Option.isNone(status)) {
    return yield* new PreviewError({
      code: "state_unreadable",
      detail: `No preview state was recorded for ${normalized}.`,
    });
  }
  yield* touchPreview(context.paths, status.value);
  return status.value;
});

export const runPreviewWarm = Effect.fn("Preview.tool.warm")(function* (
  context: PreviewToolContext<{ readonly repo: string }>
) {
  const status = yield* warmAndRead(context, context.args.repo);
  if (status.phase !== "warm") {
    return textResult(
      `${status.repo} is not runnable: ${status.reason ?? "unknown reason"}\nFix the recipe with preview-save-recipe, or tell the person what is missing.`
    );
  }
  return textResult(
    `${status.repo} is running. Call preview-screenshot to see it.`
  );
});
