import { Option, Predicate, Schema } from "effect";

import type { PreviewRecipe } from "../schemas.ts";

import { PORT_PLACEHOLDER } from "../paths.ts";

const PackageJsonSchema = Schema.Struct({
  scripts: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  devDependencies: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.String)
  ),
  packageManager: Schema.optionalKey(Schema.String),
});
export type PackageJson = typeof PackageJsonSchema.Type;

export const decodePackageJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(PackageJsonSchema)
);

export const PackageManagerSchema = Schema.Literals([
  "bun",
  "pnpm",
  "yarn",
  "npm",
]);
export type PackageManager = typeof PackageManagerSchema.Type;

const LOCKFILES: readonly (readonly [string, PackageManager])[] = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];

const DEV_SCRIPT_NAMES = ["dev", "start:dev", "develop", "serve", "start"];

const PORT_FLAG_FRAMEWORKS = [
  "next",
  "nuxt",
  "@remix-run/dev",
  "astro",
  "@sveltejs/kit",
  "vite",
  "gatsby",
  "@angular/cli",
];

const PORT_FLAG = /(?:--port|-p)[=\s]+(\d{2,5})/u;

const DEFAULT_VERSIONS: Readonly<Record<"pnpm" | "yarn", string>> = {
  pnpm: "9.15.9",
  yarn: "1.22.22",
};

const VERSION = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/u;

interface ManagerChoice {
  readonly manager: PackageManager;
  readonly version?: string | undefined;
}

const packageManagerFromField = (
  field: string | undefined
): Option.Option<ManagerChoice> => {
  const [name, rawVersion] = (field ?? "").split("@");
  const version = rawVersion?.split("+")[0];
  return Option.some(name).pipe(
    Option.filter(Schema.is(PackageManagerSchema)),
    Option.map((manager) => ({
      manager,
      version: version && VERSION.test(version) ? version : undefined,
    }))
  );
};

export const detectPackageManager = (
  files: ReadonlySet<string>,
  pkg: PackageJson
): ManagerChoice =>
  packageManagerFromField(pkg.packageManager).pipe(
    Option.orElse(() =>
      Option.fromNullishOr(
        LOCKFILES.find(([lockfile]) => files.has(lockfile))?.[1]
      ).pipe(Option.map((manager): ManagerChoice => ({ manager })))
    ),
    Option.getOrElse((): ManagerChoice => ({ manager: "npm" }))
  );

const managerCommand = (choice: ManagerChoice): string => {
  switch (choice.manager) {
    case "bun":
      return "bun";
    case "npm":
      return "npm";
    case "pnpm":
    case "yarn":
      return `npx --yes ${choice.manager}@${choice.version ?? DEFAULT_VERSIONS[choice.manager]}`;
  }
};

const portArgument = (manager: PackageManager): string =>
  manager === "npm"
    ? ` -- --port ${PORT_PLACEHOLDER}`
    : ` --port ${PORT_PLACEHOLDER}`;

const dependencyNames = (pkg: PackageJson): ReadonlySet<string> =>
  new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ]);

export const takesPortFlag = (pkg: PackageJson): boolean => {
  const names = dependencyNames(pkg);
  return PORT_FLAG_FRAMEWORKS.some((framework) => names.has(framework));
};

export const pinnedPort = (script: string): number | undefined => {
  const explicit = PORT_FLAG.exec(script)?.[1];
  return explicit ? Number(explicit) : undefined;
};

export type HeuristicOutcome =
  | { readonly kind: "recipe"; readonly recipe: PreviewRecipe }
  | {
      readonly kind: "pinned_port";
      readonly script: string;
      readonly port: number;
    }
  | { readonly kind: "none" };

export const heuristicRecipe = (
  files: ReadonlySet<string>,
  pkg: PackageJson
): HeuristicOutcome => {
  const scripts = pkg.scripts ?? {};
  const scriptName = DEV_SCRIPT_NAMES.find((name) => name in scripts);
  if (!scriptName) {
    return { kind: "none" };
  }
  const script = scripts[scriptName] ?? "";
  const pinned = pinnedPort(script);
  if (Predicate.isNotUndefined(pinned)) {
    return { kind: "pinned_port", script, port: pinned };
  }
  const choice = detectPackageManager(files, pkg);
  const command = managerCommand(choice);
  const portFlag = takesPortFlag(pkg) ? portArgument(choice.manager) : "";
  return {
    kind: "recipe",
    recipe: {
      install: `${command} install`,
      dev: `${command} run ${scriptName}${portFlag}`,
    },
  };
};
