import { Effect } from "effect";

import type { StateStoreShape } from "#src/state/store.ts";

import { dashboardResponse } from "./dashboard.ts";

export const makeDashboardRoute =
  (store: StateStoreShape) =>
  (request: Request): Promise<Response> =>
    Effect.runPromise(dashboardResponse(store, request));
