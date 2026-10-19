import { Effect, Option, Predicate, Schedule } from "effect";

import { PreviewError } from "../errors.ts";
import { TcpProbe } from "../tcp-probe/index.ts";

const ERROR_OVERLAY_MARKERS = [
  "vite-error-overlay",
  "webpack-dev-server-client-overlay",
  "Unhandled Runtime Error",
  "Failed to compile",
  "Internal Server Error",
];

const PORT_POLL = Schedule.spaced("1 second");

export const DEFAULT_START_BUDGET = "3 minutes";

export const overlayMarker = (html: string): Option.Option<string> =>
  Option.fromNullishOr(
    ERROR_OVERLAY_MARKERS.find((marker) => html.includes(marker))
  );

const PROBE_TIMEOUT = "5 seconds";

const probe = Effect.fn("Preview.readiness.probe")(function* (url: string) {
  const tcpProbe = yield* TcpProbe;
  const response = yield* tcpProbe.get(url).pipe(
    Effect.timeoutOrElse({
      duration: PROBE_TIMEOUT,
      orElse: () =>
        Effect.fail(
          new PreviewError({
            code: "not_ready",
            detail: `${url} did not respond`,
          })
        ),
    })
  );
  return { ...response, url };
});

export const waitForHttp = Effect.fn("Preview.readiness.waitForHttp")(
  function* <R>(
    urls: readonly [string, ...string[]],
    isStillRunning: Effect.Effect<boolean, never, R>
  ) {
    const [url] = urls;
    const attempt = Effect.gen(function* () {
      if (!(yield* isStillRunning)) {
        return yield* new PreviewError({
          code: "start_failed",
          detail: "The dev server exited before it started serving.",
        });
      }
      const answers = yield* Effect.forEach(urls, (candidate) =>
        probe(candidate).pipe(Effect.option)
      );
      const answered = answers.flatMap(Option.toArray);
      const healthy = answered.find((response) =>
        Option.isNone(judgeResponse(response))
      );
      if (Predicate.isUndefined(healthy)) {
        return yield* new PreviewError({
          code: "not_ready",
          detail:
            answered.length === 0
              ? `Nothing is answering on ${url} yet.`
              : `${url} is answering but not with a working page yet.`,
        });
      }
      return healthy;
    });
    return yield* attempt.pipe(
      Effect.retry({
        schedule: PORT_POLL,
        while: (error) => error.code === "not_ready",
      }),
      Effect.timeoutOrElse({
        duration: DEFAULT_START_BUDGET,
        orElse: () =>
          Effect.fail(
            new PreviewError({
              code: "not_ready",
              detail: `${url} did not serve a working page within ${DEFAULT_START_BUDGET}.`,
            })
          ),
      })
    );
  }
);

export const judgeResponse = (response: {
  readonly status: number;
  readonly body: string;
}): Option.Option<string> => {
  if (response.status >= 500) {
    return Option.some(`the page answered HTTP ${response.status}`);
  }
  return overlayMarker(response.body).pipe(
    Option.map((marker) => `the page shows a framework error (${marker})`)
  );
};
