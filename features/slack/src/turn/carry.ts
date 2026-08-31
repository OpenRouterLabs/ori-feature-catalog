/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively; the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */

import { Effect } from "effect";

import type { ThreadRef } from "../thread/thread.ts";

import { StateStore } from "../state/store.ts";
import { threadInstanceId } from "../thread/thread.ts";
import { engage, mute } from "./listening/listen.ts";

export const CarryOutcome = {
  Carried: "carried",
  NothingToCarry: "nothing-to-carry",
} as const;

export type CarryOutcome = (typeof CarryOutcome)[keyof typeof CarryOutcome];

export type CarryResult =
  | { readonly kind: typeof CarryOutcome.Carried; readonly sessionId: string }
  | { readonly kind: typeof CarryOutcome.NothingToCarry };

export const carrySession = Effect.fn("Slack.carry.session")(function* (input: {
  readonly from: ThreadRef;
  readonly to: ThreadRef;
}) {
  const store = yield* StateStore;
  const fromId = threadInstanceId(input.from);
  const toId = threadInstanceId(input.to);

  const session = yield* store.getSession(fromId);
  if (session === undefined) {
    return { kind: CarryOutcome.NothingToCarry };
  }

  yield* store.putSession(toId, session);
  yield* store.clearSession(fromId);

  yield* store.updateListen(toId, engage);
  yield* store.updateListen(fromId, mute);

  return {
    kind: CarryOutcome.Carried,
    sessionId: session.sessionId,
  };
});
