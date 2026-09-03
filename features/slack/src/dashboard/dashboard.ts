import { Effect } from "effect";

import type { StateStoreShape } from "#src/state/store.ts";

import { interruptModeFrom } from "#src/state/settings.ts";
import { renderDashboard } from "./page.ts";

const PATH = "/slack/dashboard";

const HTTP_SEE_OTHER = 303;

const page = Effect.fn("Slack.dashboard.page")(function* (
  store: StateStoreShape,
  now: number
): Effect.fn.Return<Response> {
  const [rows, mode] = yield* Effect.all([
    store.listThreads(),
    store.getInterruptMode(),
  ]);
  return new Response(renderDashboard(rows, now, mode), {
    headers: {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
    },
  });
});

const save = Effect.fn("Slack.dashboard.save")(function* (
  store: StateStoreShape,
  request: Request
): Effect.fn.Return<Response> {
  const form = yield* Effect.tryPromise(() => request.formData()).pipe(
    Effect.orElseSucceed(() => undefined)
  );
  yield* store.putInterruptMode(interruptModeFrom(form?.get("mode")));
  return new Response(null, {
    headers: { location: PATH },
    status: HTTP_SEE_OTHER,
  });
});

export const dashboardResponse = Effect.fn("Slack.dashboard.handle")(
  function* (
    store: StateStoreShape,
    request: Request,
    now: number = Date.now()
  ): Effect.fn.Return<Response> {
    return request.method === "POST"
      ? yield* save(store, request)
      : yield* page(store, now);
  }
);
