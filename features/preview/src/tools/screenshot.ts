import {
  DateTime,
  Effect,
  Random,
  FileSystem,
  Option,
  Path,
  Predicate,
  Schema,
} from "effect";
import { Base64 } from "effect/encoding";

import type { PageCapture } from "../browser/index.ts";
import type { SlackShot } from "../slack/index.ts";
import type { PreviewToolContext } from "./context.ts";
import type { ToolContent } from "ori";

import { startAlternate } from "../alternate/index.ts";
import { capturePage, ensureBrowser } from "../browser/index.ts";
import { PreviewError } from "../errors.ts";
import { withRepoLock } from "../lock/index.ts";
import { repoSlug } from "../paths.ts";
import { RepoNameSchema } from "../schemas.ts";
import { postShotsToThread, slackThreadFor } from "../slack/index.ts";
import { warmAndRead } from "./warm.ts";
import { untrusted } from "../untrusted/index.ts";
import { stopAlternate } from "../warm/index.ts";

export const RepoField = RepoNameSchema.annotate({
  description: "The GitHub repository as owner/name.",
});

export const ScreenshotParameters = Schema.Struct({
  repo: RepoField,
  path: Schema.optional(
    Schema.String.annotate({
      description:
        "Page path to open, such as /settings. Defaults to the recipe's ready path.",
    })
  ),
  changedDirectory: Schema.optional(
    Schema.String.annotate({
      description:
        "A directory under /preview/work holding your changed copy of the repo. When set, the tool screenshots the warm preview as 'before' and a second server started from this directory as 'after'.",
    })
  ),
  fullPage: Schema.optional(
    Schema.Boolean.annotate({
      description: "Capture the whole scrollable page.",
    })
  ),
});

export type ScreenshotArgs = typeof ScreenshotParameters.Type;

const MAX_CONSOLE_LINES = 8;

const MAX_TITLE_LENGTH = 200;

const LEADING_SLASHES = /^[/\\]+/u;

export const joinUrl = (base: string, path: string | undefined): string => {
  if (Predicate.isUndefined(path)) {
    return base;
  }
  const origin = new URL(base).origin;
  const resolved = new URL(`/${path.replace(LEADING_SLASHES, "")}`, origin);
  return `${origin}${resolved.pathname}${resolved.search}${resolved.hash}`;
};

const writeShot = Effect.fn("Preview.tool.writeShot")(function* (
  context: PreviewToolContext<ScreenshotArgs>,
  label: string,
  capture: PageCapture
) {
  const fs = yield* FileSystem.FileSystem;
  const stamp = DateTime.formatIso(yield* DateTime.now).replace(/[:.]/gu, "-");
  const nonce = (yield* Random.nextIntBetween(0, 1_000_000))
    .toString(36)
    .padStart(4, "0");
  const file = `${context.paths.shots}/${repoSlug(context.args.repo)}-${stamp}-${nonce}-${label}.png`;
  yield* fs.makeDirectory(context.paths.shots, { recursive: true });
  yield* fs.writeFile(file, capture.png);
  return {
    absolute: file,
    relative: file.slice(context.workspaceRoot.length + 1),
  };
});

const consoleNote = (capture: PageCapture): string =>
  capture.consoleErrors.length === 0
    ? ""
    : ` The page logged console errors:\n${untrusted(
        capture.consoleErrors
          .slice(0, MAX_CONSOLE_LINES)
          .map((line) => line.split("\n")[0])
          .join("\n")
      )}`;

const shotContent = (
  label: string,
  file: string,
  capture: PageCapture
): readonly ToolContent[] => [
  {
    type: "text",
    text: `${label} screenshot (saved as ${file}), page title: ${untrusted(capture.title, MAX_TITLE_LENGTH)}${consoleNote(capture)}`,
  },
  {
    type: "image",
    mimeType: "image/png",
    data: Base64.encode(capture.png),
  },
];

const captureTo = Effect.fn("Preview.tool.captureTo")(function* (
  context: PreviewToolContext<ScreenshotArgs>,
  label: string,
  baseUrl: string
) {
  const url = joinUrl(baseUrl, context.args.path);
  const capture = yield* capturePage(url, {
    fullPage: context.args.fullPage ?? false,
  });
  const file = yield* writeShot(context, label, capture);
  return {
    content: shotContent(label, file.relative, capture),
    shot: { path: file.absolute, title: `${context.args.repo} ${label}` },
  };
});

const postedNote = (posted: number, total: number): ToolContent => ({
  type: "text",
  text:
    posted === total
      ? `Posted ${posted === 1 ? "the screenshot" : `all ${total} screenshots`} to this Slack thread. Do not attach ${posted === 1 ? "it" : "them"} again.`
      : `Posted ${posted} of ${total} screenshots to this Slack thread; attach the rest with the attach skill.`,
});

const withSlackPost = Effect.fn("Preview.tool.withSlackPost")(function* (
  context: PreviewToolContext<ScreenshotArgs>,
  captures: readonly {
    readonly content: readonly ToolContent[];
    readonly shot: SlackShot;
  }[]
) {
  const content = captures.flatMap((capture) => capture.content);
  const thread = slackThreadFor(context.turnEnv, context.env);
  if (Option.isNone(thread)) {
    return { content };
  }
  const shots = captures.map((capture) => capture.shot);
  const comment =
    shots.length === 1
      ? `${context.args.repo}, running on localhost`
      : `${context.args.repo}: before and after`;
  const posted = yield* postShotsToThread(thread.value, shots, comment, {
    ...context.env,
    ...context.turnEnv,
  });
  return { content: [...content, postedNote(posted, shots.length)] };
});

const resolveChangedDirectory = Effect.fn("Preview.tool.changedDirectory")(
  function* (context: PreviewToolContext<ScreenshotArgs>) {
    const requested = context.args.changedDirectory;
    if (Predicate.isUndefined(requested)) {
      return Option.none<string>();
    }
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const outside = new PreviewError({
      code: "not_ready",
      detail: `changedDirectory must be an existing directory under ${context.paths.work}, not ${requested}. Copy the repo to ${context.paths.work}/<name> and change it there.`,
    });
    yield* fs.makeDirectory(context.paths.work, { recursive: true });
    const root = yield* fs.realPath(context.paths.work);
    const resolved = yield* fs
      .realPath(path.resolve(context.workspaceRoot, requested))
      .pipe(Effect.mapError(() => outside));
    const info = yield* fs.stat(resolved).pipe(Effect.mapError(() => outside));
    if (info.type !== "Directory") {
      return yield* outside;
    }
    const relative = path.relative(root, resolved);
    if (
      relative === "" ||
      relative.startsWith("..") ||
      path.isAbsolute(relative)
    ) {
      return yield* outside;
    }
    return Option.some(resolved);
  }
);

const captureChangedCopy = Effect.fn("Preview.tool.captureChangedCopy")(
  function* (
    context: PreviewToolContext<ScreenshotArgs>,
    repo: string,
    directory: string
  ) {
    const alternate = yield* startAlternate({
      paths: context.paths,
      repo,
      directory,
      env: context.env,
    });
    return yield* captureTo(context, "after", alternate.url).pipe(
      Effect.ensuring(stopAlternate(context.paths, repo).pipe(Effect.ignore))
    );
  }
);

export const runPreviewScreenshot = Effect.fn("Preview.tool.screenshot")(
  function* (context: PreviewToolContext<ScreenshotArgs>) {
    const status = yield* warmAndRead(context, context.args.repo);
    if (status.phase !== "warm" || !status.url) {
      return yield* new PreviewError({
        code: "not_ready",
        detail: `${status.repo} is not warm: ${status.reason ?? status.phase}`,
      });
    }
    yield* ensureBrowser(context.paths, context.env);
    const changed = yield* resolveChangedDirectory(context);
    const before = yield* captureTo(
      context,
      Option.isSome(changed) ? "before" : "current",
      status.url
    );
    if (Option.isNone(changed)) {
      return yield* withSlackPost(context, [before]);
    }
    const after = yield* withRepoLock(
      context.paths,
      status.repo,
      captureChangedCopy(context, status.repo, changed.value),
      "wait"
    ).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new PreviewError({
                code: "state_unreadable",
                detail: "The changed copy's lock could not be taken.",
              })
            ),
          onSome: Effect.succeed,
        })
      )
    );
    return yield* withSlackPost(context, [before, after]);
  }
);
