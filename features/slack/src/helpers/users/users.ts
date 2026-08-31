/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively — the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */

import { Effect, Ref } from "effect";

import { SlackClient } from "../../client/index.ts";

const MAX_CACHED_NAMES = 1000;

export const makeUserDirectory = Effect.gen(function* () {
  const cache = yield* Ref.make(new Map<string, string>());
  const slack = yield* SlackClient;

  const resolve = Effect.fn("Slack.users.resolve")(function* (userId: string) {
    const cached = (yield* Ref.get(cache)).get(userId);
    if (cached !== undefined) {
      return cached;
    }
    const name = yield* slack
      .getUserName(userId)
      .pipe(Effect.catch(() => Effect.succeed(userId)));
    yield* Ref.update(cache, (current) => {
      const next = new Map(current).set(userId, name);
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
}).pipe(Effect.withSpan("Slack.users.openDirectory"));
