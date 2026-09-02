/* oxlint-disable typescript/explicit-function-return-type eslint/max-lines-per-function -- typing every local helper buys nothing here, and cases read better whole than split */

import { describe, expect, test } from "#src/test-support/effect-test.ts";

import { Effect, Schema } from "effect";

import { QuestionnairesMemory } from "#src/interactions/questionnaires.ts";
import { makeQuestionsRoute, parseAskBody } from "./questions-route.ts";

const BYTES_PER_KIB = 1024;
const MAX_BODY_KIB = 32;

const QUESTION = {
  id: "strategy",
  prompt: "Rebase them or close them?",
};

const body = (
  overrides: Record<string, unknown> = {}
): Record<string, unknown> => ({
  channel: "C1",
  intro: "Two things before I start.",
  questions: [QUESTION],
  thread_ts: "1700.1",
  ...overrides,
});

const ask = (raw: unknown, headers: Record<string, string> = {}): Request =>
  new Request("http://127.0.0.1/slack/thread/questions", {
    body: JSON.stringify(raw),
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    method: "POST",
  });

const PostedSchema = Schema.Struct({
  blocks: Schema.Array(Schema.Unknown),
  fallback: Schema.String,
});

type Posted = typeof PostedSchema.Type;

const routeWith = (options: { failPost?: boolean; live?: boolean } = {}) =>
  Effect.gen(function* () {
    const forms = yield* QuestionnairesMemory;
    const posts: Posted[] = [];
    let asks = 0;

    const route = makeQuestionsRoute({
      forms,
      isLive: () => Promise.resolve(options.live ?? true),
      newAskId: () => {
        asks += 1;
        return `ask-${asks}`;
      },
      post: (_ref, blocks, fallback) => {
        posts.push({
          blocks,
          fallback,
        });
        return Promise.resolve(
          options.failPost === true ? undefined : "1700.2"
        );
      },
      workspaceTeamId: "T1",
    });

    return {
      forms,
      posts,
      route,
    };
  });

const errorOf = (response: Response): Effect.Effect<string> =>
  Effect.gen(function* () {
    const parsed: unknown = yield* Effect.promise(() => response.json());
    return parsed !== null && typeof parsed === "object" && "error" in parsed
      ? String((parsed as { error: unknown }).error)
      : "";
  });

describe("parseAskBody", () => {
  test("a well-formed batch is accepted, and the intro loses its whitespace", () => {
    const parsed = parseAskBody(
      body({
        intro: "  Two things before I start.  ",
        team: "T9",
      })
    );

    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.request.intro).toBe(
      "Two things before I start."
    );
    expect(parsed.ok && parsed.request.team).toBe("T9");
    expect(parsed.ok && parsed.request.threadTs).toBe("1700.1");
  });

  test("no questions is refused — a form with nothing in it asks nothing", () => {
    const parsed = parseAskBody(body({ questions: [] }));

    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error).toContain("at least one question");
  });

  test("eleven questions is refused, and the count is in the refusal", () => {
    const many = Array.from({ length: 11 }, (_value, index) => ({
      id: `q${index}`,
      prompt: `Question ${index}?`,
    }));

    const parsed = parseAskBody(body({ questions: many }));

    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error).toContain("11 questions");
    expect(!parsed.ok && parsed.error).toContain("max 10");
  });

  test("ten questions is the cap, not one under it", () => {
    const ten = Array.from({ length: 10 }, (_value, index) => ({
      id: `q${index}`,
      prompt: `Question ${index}?`,
    }));

    expect(parseAskBody(body({ questions: ten })).ok).toBe(true);
  });

  test("two questions sharing an id is refused — one answer would be lost", () => {
    const parsed = parseAskBody(
      body({
        questions: [
          QUESTION,
          {
            id: "strategy",
            prompt: "Which one first?",
          },
        ],
      })
    );

    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error).toContain("its own id");
  });

  test("a shape it cannot read is refused rather than guessed at", () => {
    const refusals = [
      parseAskBody(null),
      parseAskBody(body({ questions: ["Rebase or close?"] })),
      parseAskBody(body({ questions: [{ prompt: "No id here" }] })),
      parseAskBody(
        body({
          questions: [
            {
              ...QUESTION,
              kind: "bogus",
            },
          ],
        })
      ),
      parseAskBody(
        body({
          questions: [
            {
              id: "n",
              prompt: 42,
            },
          ],
        })
      ),
      parseAskBody(body({ thread_ts: undefined })),
    ];

    for (const parsed of refusals) {
      expect(parsed.ok).toBe(false);
    }
    expect(
      refusals.every(
        (parsed) => !parsed.ok && parsed.error.includes("questions")
      )
    ).toBe(true);
  });

  test("an empty channel is accepted, which the blocker route refuses", () => {
    expect(
      parseAskBody(
        body({
          channel: "",
          thread_ts: "",
        })
      ).ok
    ).toBe(true);
  });

  test("an empty intro is accepted, and Slack refuses the block it becomes", () => {
    const parsed = parseAskBody(body({ intro: "   " }));

    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.request.intro).toBe("");
  });
});

describe("the questions route", () => {
  test.effect("posts the form, stores it, and hands back the ask id", () =>
    Effect.gen(function* () {
      const surface = yield* routeWith();

      const response = yield* Effect.promise(() => surface.route(ask(body())));

      expect(response.status).toBe(200);
      expect(yield* Effect.promise(() => response.json())).toEqual({
        ask_id: "ask-1",
        ok: true,
      });
      expect(surface.posts).toHaveLength(1);
      expect(JSON.stringify(surface.posts[0]?.blocks)).toContain(
        "Answer 1 question"
      );
      expect(surface.posts[0]?.fallback).toBe("Two things before I start.");

      const stored = yield* surface.forms.get("ask-1");

      expect(stored?.messageTs).toBe("1700.2");
      expect(stored?.questions).toHaveLength(1);
      expect(stored?.ref.channelId).toBe("C1");
    }));

  test.effect("a body it cannot read is a 400 carrying the reason, and posts nothing", () =>
    Effect.gen(function* () {
      const surface = yield* routeWith();

      const response = yield* Effect.promise(() =>
        surface.route(ask({ nope: true }))
      );

      expect(response.status).toBe(400);
      expect(yield* errorOf(response)).toContain("expected {");
      expect(surface.posts).toHaveLength(0);
    }));

  test.effect("every malformed question shape is a 400 with a message", () =>
    Effect.gen(function* () {
      const bodies = [
        body({ questions: [] }),
        body({ questions: ["Rebase or close?"] }),
        body({ questions: [{ prompt: "No id here" }] }),
        body({
          questions: [
            {
              ...QUESTION,
              kind: "bogus",
            },
          ],
        }),
        body({
          questions: [
            {
              id: "n",
              prompt: 42,
            },
          ],
        }),
        body({
          questions: [
            QUESTION,
            {
              id: "strategy",
              prompt: "Twice?",
            },
          ],
        }),
      ];
      const surface = yield* routeWith();

      for (const raw of bodies) {
        const response = yield* Effect.promise(() => surface.route(ask(raw)));

        expect(response.status).toBe(400);
        expect(yield* errorOf(response)).not.toBe("");
      }
      expect(surface.posts).toHaveLength(0);
    }));

  test.effect("a declared body over the cap is a 413, read before it is parsed", () =>
    Effect.gen(function* () {
      const surface = yield* routeWith();

      const response = yield* Effect.promise(() => surface.route(
        ask(body(), {
          "content-length": String(MAX_BODY_KIB * BYTES_PER_KIB + 1),
        })
      ));

      expect(response.status).toBe(413);
      expect(yield* errorOf(response)).toBe("payload too large");
      expect(surface.posts).toHaveLength(0);
    }));

  test.effect("no live turn in that thread is a 404, and nothing is posted", () =>
    Effect.gen(function* () {
      const surface = yield* routeWith({ live: false });

      const response = yield* Effect.promise(() => surface.route(ask(body())));

      expect(response.status).toBe(404);
      expect(yield* errorOf(response)).toContain("no run is active");
      expect(surface.posts).toHaveLength(0);
      expect(yield* surface.forms.pending()).toBe(0);
    }));

  test("an id carrying the block-id separator is accepted, and the answer is lost", () => {
    expect(
      parseAskBody(
        body({
          questions: [
            {
              id: "scope|deep",
              prompt: "How deep?",
            },
          ],
        })
      ).ok
    ).toBe(true);
  });

  test("an empty id is accepted, and its answer is lost the same way", () => {
    expect(
      parseAskBody(
        body({
          questions: [
            {
              id: "",
              prompt: "Which one?",
            },
          ],
        })
      ).ok
    ).toBe(true);
  });
});

describe("a form Slack never posted", () => {
  test.effect("is not an ask, and must not be reported as one", () =>
    Effect.gen(function* () {
      const surface = yield* routeWith({ failPost: true });

      const response = yield* Effect.promise(() => surface.route(ask(body())));

      expect(response.ok).toBe(false);
      expect(yield* surface.forms.pending()).toBe(0);
    }));
});
