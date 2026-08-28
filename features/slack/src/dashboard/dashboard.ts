/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively; the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */
/**
 * dashboard.ts — the operator's page, served over HTTP.
 *
 * A page rather than an API because the reader is a person deciding something,
 * not a program. The daemon already publishes the machine-readable view of a
 * run — `/api/sessions`, `/api/events` — and none of it knows which Slack
 * thread a session belongs to, or how this surface should behave when two
 * messages arrive at once. That is what this serves.
 *
 * Nothing here can fail. Every read answers with a default when the store is
 * unreachable, the same way the rest of this feature does: an operator opening
 * a dashboard mid-incident should see an empty table and a working form, not a
 * stack trace.
 */

import { Effect } from "effect";

import type { StateStoreShape } from "../state/index.ts";

import { interruptModeFrom } from "../state/index.ts";
import { renderDashboard } from "./page.ts";

/** Where the form posts to, and where a save sends the browser back to. */
const PATH = "/slack/dashboard";

/** See Other: the browser re-GETs, so a refresh does not re-submit the form. */
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
      // The page carries live state; a cached copy would show a setting the
      // operator has already changed.
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
    },
  });
});

/**
 * Save the setting, then send the browser back to the page.
 *
 * A body that will not parse is not an error worth showing anyone: the field
 * is a radio with two values, so anything else is a malformed request rather
 * than a decision, and `interruptModeFrom` resolves it to the default.
 */
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

/**
 * One entry for both methods.
 *
 * The route table names them separately, but they are the same page: a GET
 * renders it and a POST changes one field on it, so splitting the runtime
 * surface in two would only mean two names for one thing.
 */
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

/** The Promise edge, for the route table. HTTP is a Promise; nothing under it is. */
export const makeDashboardRoute =
  (store: StateStoreShape) =>
  (request: Request): Promise<Response> =>
    Effect.runPromise(dashboardResponse(store, request));
