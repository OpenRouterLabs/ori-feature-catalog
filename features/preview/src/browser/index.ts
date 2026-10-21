import {
  Effect,
  FileSystem,
  Option,
  Result,
  Schedule,
  Schema,
  Semaphore,
} from "effect";
import { Base64 } from "effect/encoding";

import type { CdpSession } from "#src/browser/cdp.ts";
import type { PreviewPaths } from "#src/paths.ts";

import {
  attach,
  closeTarget,
  createTarget,
  listTargets,
} from "#src/browser/cdp.ts";
import { PreviewError } from "#src/errors.ts";
import { PREVIEW_CDP_PORT } from "#src/paths.ts";
import { ensurePortFree, isAlive, spawnDetached } from "#src/process/index.ts";
import { prepareSandbox, sandboxed, sandboxEnv } from "#src/sandbox/index.ts";
import { ProcessRefJson } from "#src/schemas.ts";
import { readJsonFile, writeFileAtomic } from "#src/status/index.ts";
import { untrusted } from "#src/untrusted/index.ts";

export const CHROMIUM_BIN_ENV = "ORI_PREVIEW_CHROMIUM";

const DEFAULT_CHROMIUM = "chromium";

const VIEWPORT = { width: 1440, height: 900 };

const SETTLE_MS = 600;

const NAVIGATION_TIMEOUT = "45 seconds";

const decodeBrowserState = Schema.decodeUnknownEffect(ProcessRefJson);
const encodeBrowserState = Schema.encodeEffect(ProcessRefJson);

const chromiumArgs = (paths: PreviewPaths): readonly string[] => [
  "--headless=new",
  `--remote-debugging-port=${PREVIEW_CDP_PORT}`,
  "--remote-debugging-address=127.0.0.1",
  `--user-data-dir=${paths.browserProfile}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--disable-background-networking",
  "--no-sandbox",
  `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
  "about:blank",
];

export const browserEnv = (
  env: Readonly<Record<string, string | undefined>>,
  home: string
): Readonly<Record<string, string | undefined>> =>
  sandboxEnv({ host: env, home });

const waitForDebugPort = listTargets().pipe(
  Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 80 })
);

const PROFILE_LOCKS = ["SingletonLock", "SingletonSocket", "SingletonCookie"];

const clearStaleProfileLocks = Effect.fn("Preview.browser.clearProfileLocks")(
  function* (paths: PreviewPaths) {
    const fs = yield* FileSystem.FileSystem;
    yield* Effect.forEach(PROFILE_LOCKS, (name) =>
      fs
        .remove(`${paths.browserProfile}/${name}`, { force: true })
        .pipe(Effect.ignore)
    );
  }
);

const launchLock = Semaphore.makeUnsafe(1);

const launchBrowser = Effect.fn("Preview.browser.launch")(function* (
  paths: PreviewPaths,
  env: Readonly<Record<string, string | undefined>>
) {
  const recorded = yield* readJsonFile(paths.browserState, decodeBrowserState);
  if (Option.isSome(recorded) && (yield* isAlive(recorded.value))) {
    return yield* waitForDebugPort;
  }
  yield* ensurePortFree(PREVIEW_CDP_PORT).pipe(
    Effect.mapError(
      () =>
        new PreviewError({
          code: "browser_unavailable",
          detail: `Something other than the preview browser is listening on port ${PREVIEW_CDP_PORT}, so previews cannot be screenshotted.`,
        })
    )
  );
  yield* clearStaleProfileLocks(paths);
  yield* prepareSandbox(paths, env);
  const process = yield* spawnDetached({
    command: sandboxed([
      env[CHROMIUM_BIN_ENV] ?? DEFAULT_CHROMIUM,
      ...chromiumArgs(paths),
    ]),
    cwd: paths.home,
    env: browserEnv(env, paths.home),
    logPath: `${paths.logs}/chromium.log`,
  }).pipe(
    Effect.mapError(
      () =>
        new PreviewError({
          code: "browser_unavailable",
          detail:
            "Chromium is not installed in this runtime, so previews cannot be screenshotted.",
        })
    )
  );
  yield* writeFileAtomic(
    paths.root,
    paths.browserState,
    yield* encodeBrowserState(process).pipe(Effect.orDie)
  );
  return yield* waitForDebugPort;
});

const isOwnBrowserAlive = Effect.fn("Preview.browser.isOwnAlive")(function* (
  paths: PreviewPaths
) {
  const recorded = yield* readJsonFile(paths.browserState, decodeBrowserState);
  return Option.isSome(recorded) && (yield* isAlive(recorded.value));
});

export const ensureBrowser = Effect.fn("Preview.browser.ensure")(function* (
  paths: PreviewPaths,
  env: Readonly<Record<string, string | undefined>>
) {
  const running = yield* listTargets().pipe(Effect.option);
  if (Option.isSome(running) && (yield* isOwnBrowserAlive(paths))) {
    return;
  }
  yield* launchLock.withPermits(1)(launchBrowser(paths, env));
});

const sameOrigin = (left: string, right: string): boolean =>
  Result.getOrElse(
    Result.try(() => new URL(left).origin === new URL(right).origin),
    () => false
  );

const freshTab = createTarget("about:blank").pipe(
  Effect.flatMap((target) =>
    Effect.acquireRelease(Effect.succeed(target), (tab) =>
      closeTarget(tab.id).pipe(Effect.ignore)
    )
  )
);

const ConsoleEventSchema = Schema.Struct({
  method: Schema.Literals([
    "Runtime.exceptionThrown",
    "Runtime.consoleAPICalled",
  ]),
  params: Schema.Unknown,
});

const ExceptionParamsSchema = Schema.Struct({
  exceptionDetails: Schema.Struct({
    text: Schema.String,
    exception: Schema.optionalKey(
      Schema.Struct({ description: Schema.optionalKey(Schema.String) })
    ),
  }),
});

const ConsoleParamsSchema = Schema.Struct({
  type: Schema.String,
  args: Schema.Array(
    Schema.Struct({
      value: Schema.optionalKey(
        Schema.Union([Schema.String, Schema.Finite, Schema.Boolean])
      ),
      description: Schema.optionalKey(Schema.String),
    })
  ),
});

const describeEvent = (event: unknown): Option.Option<string> => {
  const decoded = Schema.decodeUnknownOption(ConsoleEventSchema)(event);
  if (Option.isNone(decoded)) {
    return Option.none();
  }
  if (decoded.value.method === "Runtime.exceptionThrown") {
    return Schema.decodeUnknownOption(ExceptionParamsSchema)(
      decoded.value.params
    ).pipe(
      Option.map(
        ({ exceptionDetails }) =>
          exceptionDetails.exception?.description ?? exceptionDetails.text
      )
    );
  }
  return Schema.decodeUnknownOption(ConsoleParamsSchema)(
    decoded.value.params
  ).pipe(
    Option.filter((params) => params.type === "error"),
    Option.map((params) =>
      params.args
        .map((arg) => arg.description ?? String(arg.value ?? ""))
        .join(" ")
    )
  );
};

export const consoleErrors = (session: CdpSession): readonly string[] =>
  session.events.flatMap((event) => Option.toArray(describeEvent(event)));

const ScreenshotSchema = Schema.Struct({ data: Schema.String });

const EvaluateSchema = Schema.Struct({
  result: Schema.Struct({ value: Schema.optionalKey(Schema.Unknown) }),
});

export const evaluate = Effect.fn("Preview.browser.evaluate")(function* (
  session: CdpSession,
  expression: string
) {
  const raw = yield* session.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  return Schema.decodeUnknownOption(EvaluateSchema)(raw).pipe(
    Option.flatMap((reply) => Option.fromNullishOr(reply.result.value))
  );
});

const LOAD_POLL = Schedule.spaced("250 millis");

const LocationSchema = Schema.Tuple([Schema.String, Schema.String]);

const readLocation = (session: CdpSession) =>
  evaluate(session, "[location.href, document.readyState]").pipe(
    Effect.map(Option.flatMap(Schema.decodeUnknownOption(LocationSchema))),
    Effect.map(Option.getOrElse((): readonly [string, string] => ["", ""]))
  );

const offOriginError = (href: string): PreviewError =>
  new PreviewError({
    code: "capture_failed",
    detail: `The page redirected away from the preview, so it was not captured. It went to ${untrusted(href, 300)}`,
  });

const loadedAt = Effect.fn("Preview.browser.loadedAt")(function* (
  session: CdpSession,
  url: string
) {
  const [href, readyState] = yield* readLocation(session);
  if (href === "" || href === "about:blank" || readyState !== "complete") {
    return false;
  }
  if (!sameOrigin(href, url)) {
    return yield* offOriginError(href);
  }
  return true;
});

const waitForLoad = Effect.fn("Preview.browser.waitForLoad")(function* (
  session: CdpSession,
  url: string
) {
  yield* loadedAt(session, url).pipe(
    Effect.repeat({ schedule: LOAD_POLL, until: (loaded) => loaded }),
    Effect.timeoutOrElse({
      duration: NAVIGATION_TIMEOUT,
      orElse: () =>
        Effect.fail(
          new PreviewError({
            code: "not_ready",
            detail: "The page did not finish loading in 45 seconds.",
          })
        ),
    })
  );
  yield* Effect.sleep(SETTLE_MS);
});

export interface PageCapture {
  readonly png: Uint8Array;
  readonly consoleErrors: readonly string[];
  readonly title: string;
}

export const capturePage = Effect.fn("Preview.browser.capture")(function* (
  url: string,
  options: { readonly fullPage: boolean }
) {
  const target = yield* freshTab;
  const session = yield* attach(target.webSocketDebuggerUrl ?? "");
  yield* session.send("Runtime.enable");
  yield* session.send("Page.enable");
  yield* session.send("Emulation.setDeviceMetricsOverride", {
    ...VIEWPORT,
    deviceScaleFactor: 1,
    mobile: false,
  });
  yield* session.send("Page.navigate", { url });
  yield* waitForLoad(session, url);
  const title = yield* evaluate(session, "document.title").pipe(
    Effect.map(Option.getOrElse(() => "")),
    Effect.map(String)
  );
  const shot = yield* session.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: options.fullPage,
  });
  const data = Schema.decodeUnknownOption(ScreenshotSchema)(shot);
  if (Option.isNone(data)) {
    return yield* new PreviewError({
      code: "capture_failed",
      detail: "The preview browser returned no screenshot.",
    });
  }
  const png = Base64.decode(data.value.data);
  if (Result.isFailure(png)) {
    return yield* new PreviewError({
      code: "capture_failed",
      detail: "The preview browser returned an unreadable screenshot.",
    });
  }
  const capture: PageCapture = {
    png: png.success,
    consoleErrors: consoleErrors(session),
    title,
  };
  return capture;
}, Effect.scoped);
