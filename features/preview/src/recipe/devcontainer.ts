import { Option, Predicate, Schema } from "effect";

import type { PreviewRecipe } from "#src/schemas.ts";

const CommandSchema = Schema.Union([
  Schema.String,
  Schema.Array(Schema.String),
]);

const DevcontainerSchema = Schema.Struct({
  postCreateCommand: Schema.optionalKey(CommandSchema),
  postStartCommand: Schema.optionalKey(CommandSchema),
  containerEnv: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
type Devcontainer = typeof DevcontainerSchema.Type;

const LINE_COMMENT = /^\s*\/\/.*$/gmu;
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//gu;
const TRAILING_COMMA = /,(\s*[}\]])/gu;

export const stripJsonComments = (raw: string): string =>
  raw
    .replace(BLOCK_COMMENT, "")
    .replace(LINE_COMMENT, "")
    .replace(TRAILING_COMMA, "$1");

const decodeDevcontainer = Schema.decodeUnknownOption(
  Schema.fromJsonString(DevcontainerSchema)
);

const commandText = (
  command: Devcontainer["postCreateCommand"]
): string | undefined => {
  if (Predicate.isUndefined(command)) {
    return undefined;
  }
  return typeof command === "string" ? command : command.join(" ");
};

export const applyDevcontainer = (
  raw: string,
  base: PreviewRecipe
): PreviewRecipe =>
  decodeDevcontainer(stripJsonComments(raw)).pipe(
    Option.map((devcontainer): PreviewRecipe => {
      const install =
        commandText(devcontainer.postCreateCommand) ?? base.install;
      const recipe: PreviewRecipe = {
        ...base,
        env: { ...devcontainer.containerEnv, ...base.env },
      };
      return Predicate.isUndefined(install) ? recipe : { ...recipe, install };
    }),
    Option.getOrElse(() => base)
  );
