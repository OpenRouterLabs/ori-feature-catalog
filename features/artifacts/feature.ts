/**
 * feature.ts — the artifacts feature's contribution entry.
 *
 * The work is the `artifacts` skill plus three commands the skill drives:
 * `artifact save`, `artifact list`, and `artifact delete`. The skill is the
 * guidance; the commands carry the inlining rules and the workspace store,
 * so an intern can save a page without the `ori` CLI exposing a builtin.
 */

import { Effect, Option } from "effect";
import { layer as BunServicesLayer } from "@effect/platform-bun/BunServices";

import { CommandArgumentType } from "ori";

import type { CommandContribution, PromptFragment } from "ori";

import { defineCommand } from "ori";

import {
  runArtifactDelete,
  runArtifactList,
  runArtifactSave,
  type SaveDeps,
} from "#src/command/index.ts";

const depsOf = (ctx: {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly log: (line: string) => void;
}): SaveDeps => ({
  cwd: ctx.cwd,
  env: ctx.env,
  readFileString: (path) => Bun.file(path).text(),
  stdout: (line) => {
    process.stdout.write(line);
  },
  stderr: (line) => {
    process.stderr.write(line);
  },
});

export const ARTIFACTS_PROMPT: PromptFragment = {
  name: "artifacts",
  text: [
    "The artifacts skill turns work into a single self-contained HTML page saved under artifacts/<name>/ in this workspace, through the artifact commands (artifact save, artifact list, artifact delete).",
    "Save with `artifact save <file> --name <name> --title <title>`, reply with the link it prints, and save again under the same name to revise.",
    "The page follows the skill's rules: one file, libraries and fonts only from cdnjs.cloudflare.com, cdn.jsdelivr.net, unpkg.com, fonts.googleapis.com and fonts.gstatic.com (which saving puts inside the page), no frames and no live data, readable on a phone, light and dark themes, real numbers as numbers, at most 16 MiB.",
    "A page that names any other address is refused with that address; move the file to one of the CDNs, inline it, or remove it.",
  ].join(" "),
};

const describeSave = [
  "Save one HTML page in this workspace and print where to open it.",
  "Scripts, stylesheets, fonts and images the page loads from cdnjs.cloudflare.com, cdn.jsdelivr.net, unpkg.com, fonts.googleapis.com or fonts.gstatic.com are downloaded and put inside the page first, and a Content-Security-Policy that blocks every network request is written into its head. A page that refers to any other address, or to a relative file, is refused with that address. The page is at most 16 MiB after that. Saving a name that already exists adds the next version behind the same link.",
].join(" ");

const describeList =
  "List the pages saved in this workspace, newest first. Each row shows a page's latest version and title from `artifacts/`.";

const describeDelete = [
  "Delete `artifacts/<name>/` from this workspace.",
  "Its link stops working for everyone, and every version is removed; a backup taken before keeps it.",
].join(" ");

const flag = (args: Readonly<Record<string, unknown>>, name: string) =>
  typeof args[name] === "string" ? (args[name] as string) : undefined;

export const commands: readonly CommandContribution[] = [
  defineCommand({
    description: describeSave,
    arguments: {
      file: {
        type: CommandArgumentType.String,
        description: "The HTML page to save",
        required: true,
        positional: true,
      },
      name: {
        type: CommandArgumentType.String,
        description:
          "Name of the page in the workspace: lowercase letters, digits and single hyphens; saving a name that exists adds a version behind the same link",
        required: true,
      },
      title: {
        type: "string",
        description: "Title shown above the page (default: the name)",
      },
    },
    run: async (ctx) => {
      const name = flag(ctx.args, "name");
      const file = flag(ctx.args, "file");
      if (file === undefined || name === undefined) {
        return { ok: false as const, message: "file and name are required" };
      }
      const result = await Effect.runPromise(
        runArtifactSave(depsOf(ctx), {
          file,
          name,
          title: Option.fromNullishOr(flag(ctx.args, "title")),
        }).pipe(
          Effect.provide(BunServicesLayer),
          Effect.match({
            onFailure: (error: unknown) =>
              ({
                ok: false as const,
                message:
                  error instanceof Error ? error.message : String(error),
              }) as const,
            onSuccess: (saved) =>
              ({
                ok: true as const,
                message: saved.link,
                data: saved,
              }) as const,
          })
        )
      ).catch((error: unknown) => ({
        ok: false as const,
        message: error instanceof Error ? error.message : String(error),
      }));
      return result;
    },
  }),
  defineCommand({
    description: describeList,
    run: async (ctx) => {
      const result = await Effect.runPromise(
        runArtifactList(depsOf(ctx)).pipe(
          Effect.provide(BunServicesLayer),
          Effect.match({
            onFailure: (error: unknown) =>
              ({
                ok: false as const,
                message:
                  error instanceof Error ? error.message : String(error),
              }) as const,
            onSuccess: ({ artifacts }) =>
              ({
                ok: true as const,
                message: artifacts
                  .map(
                    (artifact) =>
                      `${artifact.name}  v${artifact.latest_version}  ${artifact.title}`
                  )
                  .join("\n"),
                data: artifacts,
              }) as const,
          })
        )
      ).catch((error: unknown) => ({
        ok: false as const,
        message: error instanceof Error ? error.message : String(error),
      }));
      return result;
    },
  }),
  defineCommand({
    description: describeDelete,
    arguments: {
      name: {
        type: CommandArgumentType.String,
        description: "Name of the artifact to delete",
        required: true,
        positional: true,
      },
    },
    run: async (ctx) => {
      const name = flag(ctx.args, "name");
      if (name === undefined) {
        return { ok: false as const, message: "name is required" };
      }
      const result = await Effect.runPromise(
        runArtifactDelete(depsOf(ctx), name).pipe(
          Effect.provide(BunServicesLayer),
          Effect.match({
            onFailure: (error: unknown) =>
              ({
                ok: false as const,
                message:
                  error instanceof Error ? error.message : String(error),
              }) as const,
            onSuccess: (deleted) =>
              ({ ok: true as const, message: `Deleted ${deleted.name}.` }) as const,
          })
        )
      ).catch((error: unknown) => ({
        ok: false as const,
        message: error instanceof Error ? error.message : String(error),
      }));
      return result;
    },
  }),
];
