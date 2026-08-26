/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively; the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */
/**
 * dashboard.ts — the read side, served over HTTP.
 *
 * A page rather than a JSON endpoint because the reader is a person looking
 * for one fact ("why is this thread quiet"), not a program. The daemon already
 * publishes the machine-readable view of a run — `/api/sessions`,
 * `/api/events` — and none of it knows which Slack thread a session belongs
 * to. That mapping is the only thing this feature can add, so it is all this
 * serves.
 *
 * Nothing here can fail: `listThreads` answers with an empty list when the
 * store is unreachable, the same way every other read in this feature does. An
 * operator opening a dashboard during an outage should see an empty table, not
 * a stack trace.
 */

import { Effect } from "effect";

import type { StateStoreShape } from "../state/store.ts";

import { renderDashboard } from "./page.ts";

export const dashboardResponse = Effect.fn("Slack.dashboard.render")(
  function* (
    store: StateStoreShape,
    now: number = Date.now()
  ): Effect.fn.Return<Response> {
    const rows = yield* store.listThreads();
    return new Response(renderDashboard(rows, now), {
      headers: {
        // The page carries live state and re-reads itself on a meta refresh;
        // a cached copy would show a thread that has since gone quiet.
        "cache-control": "no-store",
        "content-type": "text/html; charset=utf-8",
      },
    });
  }
);

/** The Promise edge, for the route table. HTTP is a Promise; nothing under it is. */
export const makeDashboardRoute =
  (store: StateStoreShape) => (): Promise<Response> =>
    Effect.runPromise(dashboardResponse(store));
