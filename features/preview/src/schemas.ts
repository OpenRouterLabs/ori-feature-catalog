import { Schema } from "effect";

const PortSchema = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 65_535 })
);

const PidSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

export const ProcessRefSchema = Schema.Struct({
  pid: PidSchema,
  startedAt: Schema.optional(Schema.String),
});
export const ProcessRefJson = Schema.fromJsonString(ProcessRefSchema);

export const PreviewRecipeSchema = Schema.Struct({
  install: Schema.optionalKey(Schema.NonEmptyString),
  dev: Schema.NonEmptyString,
  readyPath: Schema.optionalKey(Schema.String),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  requiredEnv: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
});
export type PreviewRecipe = typeof PreviewRecipeSchema.Type;

export const RecipeSourceSchema = Schema.Literals([
  "preview-json",
  "cache",
  "devcontainer",
  "heuristic",
]);

export const ResolvedRecipeSchema = Schema.Struct({
  recipe: PreviewRecipeSchema,
  source: RecipeSourceSchema,
});
export type ResolvedRecipe = typeof ResolvedRecipeSchema.Type;

export const PreviewPhaseSchema = Schema.Literals([
  "syncing",
  "installing",
  "starting",
  "warm",
  "not_runnable",
  "parked",
]);

export const PreviewStatusSchema = Schema.Struct({
  repo: Schema.NonEmptyString,
  phase: PreviewPhaseSchema,
  url: Schema.optional(Schema.String),
  port: Schema.optional(PortSchema),
  process: Schema.optional(ProcessRefSchema),
  recipeSource: Schema.optional(RecipeSourceSchema),
  reason: Schema.optional(Schema.String),
  headSha: Schema.optional(Schema.String),
  headCheckedAt: Schema.optional(Schema.String),
  installedSha: Schema.optional(Schema.String),
  lastUsedAt: Schema.optional(Schema.String),
  updatedAt: Schema.String,
});
export type PreviewStatus = typeof PreviewStatusSchema.Type;

export const AlternateServerSchema = Schema.Struct({
  repo: Schema.NonEmptyString,
  directory: Schema.NonEmptyString,
  port: PortSchema,
  process: ProcessRefSchema,
  url: Schema.String,
});
export type AlternateServer = typeof AlternateServerSchema.Type;

export const REPO_NAME_PATTERN = /^[A-Za-z0-9-]+\/(?!\.+$)[\w.-]+$/u;

export const RepoNameSchema = Schema.NonEmptyString.check(
  Schema.isPattern(REPO_NAME_PATTERN)
);

export const ConnectedReposSchema = Schema.Array(RepoNameSchema);
export type ConnectedRepos = typeof ConnectedReposSchema.Type;
