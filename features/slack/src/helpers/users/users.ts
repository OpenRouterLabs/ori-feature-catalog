/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively — the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */
/**
 * users.ts — display names for user ids.
 *
 * `users.info` is a per-message call on the reply path, and names change
 * rarely, so results are cached. A failed lookup falls back to the raw id: a
 * cosmetic label must never fail a turn.
 *
 * The cache is bounded. A daemon lives for weeks in a workspace with thousands
 * of people, so an unbounded map is a slow leak — and an entry that never
 * expires means a display name changed today is still wrong months from now.
 * Oldest-first eviction keeps both in check without pretending to be an LRU.
 */

import { Effect, Ref } from "effect";

import { SlackClient } from "../../client/client.ts";

/** Enough for an active workspace; small enough to stay bounded. */
const MAX_CACHED_NAMES = 1000;

export const makeUserDirectory = Effect.gen(function* () {
  const cache = yield* Ref.make(new Map<string, string>());
  const slack = yield* SlackClient;

  const resolve = Effect.fn("users.resolve")(function* (userId: string) {
    const cached = (yield* Ref.get(cache)).get(userId);
    if (cached !== undefined) {
      return cached;
    }
    const name = yield* slack
      .getUserName(userId)
      .pipe(Effect.catch(() => Effect.succeed(userId)));
    yield* Ref.update(cache, (current) => {
      const next = new Map(current).set(userId, name);
      // Map preserves insertion order, so the first key is the oldest.
      while (next.size > MAX_CACHED_NAMES) {
        const oldest = next.keys().next().value;
        if (oldest === undefined) {
          break;
        }
        next.delete(oldest);
      }
      return next;
    });
    return name;
  });

  return { resolve } as const;
});
