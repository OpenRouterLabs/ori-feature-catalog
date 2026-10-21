import { Effect } from "effect";

import type { PreviewServices } from "#src/tools/context.ts";
import type {
  ScheduleDefinition,
  ScheduleHandlerArgs,
  ScheduleRunSummary,
} from "ori";

import { previewPaths } from "#src/paths.ts";
import { UNTRUSTED_NOTE } from "#src/untrusted/index.ts";
import { reconcilePreviews } from "#src/warm/index.ts";

export const PREVIEW_SCHEDULE_CRON = "* * * * *";

export const PREVIEW_SKIPPED_SUMMARY: ScheduleRunSummary = {
  skipped: "no_preview_repos",
};

export const PREVIEW_DISABLED_SUMMARY: ScheduleRunSummary = {
  skipped: "previews_disabled",
};

export type PreviewSchedule = Omit<ScheduleDefinition, "run"> & {
  readonly run: (
    args: Pick<ScheduleHandlerArgs, "logger">
  ) => Promise<ScheduleRunSummary>;
};

export const PREVIEW_DISABLED_SCHEDULE: PreviewSchedule = {
  cron: PREVIEW_SCHEDULE_CRON,
  overlap: "skip",
  catchUp: false,
  disabled: true,
  run: () => Promise.resolve(PREVIEW_DISABLED_SUMMARY),
};

export interface MakePreviewScheduleInput {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly workspaceRoot: string;
}

export const PREVIEW_PROMPT = `# Localhost previews

You can run the connected GitHub repositories on localhost and screenshot them in your own headless Chromium.

- When someone asks for a screenshot, call preview-screenshot directly. It warms the repository itself, so do not call preview-status or preview-warm first.
- Reply with the screenshot and at most one short sentence about what it shows. Do not mention URLs, ports, file paths, commits, recipes, preview status, warm-up steps, or console output unless the person asks for them or they explain a failure.
- If it fails, say in one or two sentences why and what would fix it, and nothing else.
- In a Slack thread, preview-screenshot posts the images itself, so never attach them again.
- To show a fix, copy /preview/repos/owner__name into /preview/work/<name>, change it there, then call preview-screenshot with changedDirectory for a before/after pair. Never edit the warm checkout.
- When a repository cannot run because its commands are unknown, read its README and save them with preview-save-recipe, which runs them in the preview sandbox; put {port} where the port goes. Never run a repository's install or dev commands with your own shell: that runs its code with your credentials.
- When it needs environment variables nobody has provided, say which ones instead of inventing values.
- Never present a screenshot of an error page as the result of a fix.
- ${UNTRUSTED_NOTE}
- A repository that needs environment variables gets only ones an operator bound for previews as PREVIEW_ENV_<NAME>; ask for those rather than pointing it at your own.`;

export const makePreviewSchedule = Effect.fnUntraced(function* (
  input: MakePreviewScheduleInput
) {
  const run = Effect.runPromiseWith(yield* Effect.context<PreviewServices>());
  const schedule: PreviewSchedule = {
    cron: PREVIEW_SCHEDULE_CRON,
    overlap: "skip",
    catchUp: false,
    run: ({ logger }): Promise<ScheduleRunSummary> =>
      run(
        reconcilePreviews(previewPaths(input.workspaceRoot), input.env).pipe(
          Effect.map((reconciled) =>
            reconciled === 0
              ? PREVIEW_SKIPPED_SUMMARY
              : { reconciled: String(reconciled) }
          ),
          Effect.tapError((error) =>
            Effect.sync(() => {
              logger.error("The preview warm-up sweep failed.", error);
            })
          )
        )
      ),
  };
  return schedule;
});
