import { Effect, FileSystem } from "effect";

import type { PreviewPaths } from "#src/paths.ts";

import { PreviewError } from "#src/errors.ts";
import { PREVIEW_UID } from "#src/paths.ts";
import { runToLog } from "#src/process/index.ts";

export type HostEnv = Readonly<Record<string, string | undefined>>;

const SETPRIV = [
  "setpriv",
  `--reuid=${PREVIEW_UID}`,
  `--regid=${PREVIEW_UID}`,
  "--clear-groups",
  "--inh-caps=-all",
  "--bounding-set=-all",
  "--no-new-privs",
] as const;

export const sandboxed = (command: readonly string[]): readonly string[] => [
  ...SETPRIV,
  ...command,
];

const PASSED_THROUGH = ["PATH", "LANG", "LC_ALL", "TZ", "TERM"] as const;

const WITHHELD_ENV = /^(ORI_|SLACK_|OPENROUTER_|OTEL_|VAULT_)|PROXY$/iu;

export const isWithheld = (name: string): boolean => WITHHELD_ENV.test(name);

export const PREVIEW_ENV_PREFIX = "PREVIEW_ENV_";

export const boundPreviewValue = (
  host: HostEnv,
  name: string
): string | undefined => host[`${PREVIEW_ENV_PREFIX}${name}`];

export const sandboxEnv = (input: {
  readonly host: HostEnv;
  readonly home: string;
  readonly passNames?: readonly string[] | undefined;
}): HostEnv => ({
  ...Object.fromEntries(PASSED_THROUGH.map((name) => [name, input.host[name]])),
  ...Object.fromEntries(
    (input.passNames ?? [])
      .filter((name) => !isWithheld(name))
      .map((name) => [name, boundPreviewValue(input.host, name)])
  ),
  HOME: input.home,
  XDG_CACHE_HOME: `${input.home}/.cache`,
});

export const WORKSPACE_MODE = 0o700;

const ownedDirectory = Effect.fn("Preview.sandbox.ownedDirectory")(function* (
  path: string
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(path, { recursive: true });
  yield* fs.chown(path, PREVIEW_UID, PREVIEW_UID);
});

export const chownTree = (path: string): readonly string[] => [
  "find",
  path,
  "-xdev",
  "-exec",
  "chown",
  "-h",
  `${PREVIEW_UID}:${PREVIEW_UID}`,
  "{}",
  "+",
];
const FENCE_PROBE = `const c=new AbortController();setTimeout(()=>c.abort(),2000);fetch("http://169.254.169.254/",{signal:c.signal}).then(()=>process.exit(1),()=>process.exit(0));`;

export const FENCE_MISSING =
  "the preview sandbox is not fenced off the metadata server on this VM, so repository code will not run here. The platform installs that firewall when it opts the intern into previews.";

const fenceMissing = (): PreviewError =>
  new PreviewError({ code: "sandbox_unavailable", detail: FENCE_MISSING });

export const assertFenced = Effect.fn("Preview.sandbox.assertFenced")(
  function* (paths: PreviewPaths, env: HostEnv) {
    const exitCode = yield* runToLog({
      command: sandboxed(["bun", "-e", FENCE_PROBE]),
      cwd: paths.home,
      env: sandboxEnv({ host: env, home: paths.home }),
      logPath: `${paths.logs}/fence.log`,
    }).pipe(Effect.mapError(fenceMissing));
    if (exitCode !== 0) {
      return yield* fenceMissing();
    }
  }
);

const prepareSandboxUnmapped = Effect.fn("Preview.sandbox.prepare")(function* (
  paths: PreviewPaths,
  env: HostEnv
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(paths.root, { recursive: true });
  yield* fs.chmod(paths.workspace, WORKSPACE_MODE);
  yield* fs.makeDirectory(paths.repos, { recursive: true });
  yield* fs.makeDirectory(paths.scratch, { recursive: true });
  yield* ownedDirectory(paths.work);
  yield* ownedDirectory(paths.home);
  yield* ownedDirectory(paths.browserProfile);
  yield* assertFenced(paths, env);
});

export const prepareSandbox = (paths: PreviewPaths, env: HostEnv) =>
  prepareSandboxUnmapped(paths, env).pipe(
    Effect.catchTag("PlatformError", (error) =>
      Effect.fail(
        new PreviewError({
          code: "sandbox_unavailable",
          detail: `the preview sandbox could not be prepared: ${error.message}`,
        })
      )
    )
  );
