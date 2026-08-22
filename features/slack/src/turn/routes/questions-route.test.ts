/* oxlint-disable typescript/explicit-function-return-type eslint/max-lines-per-function import/no-relative-parent-imports -- typing every local helper buys nothing here, cases read better whole than split, and the services a route calls are siblings of this feature rather than of this directory */
/**
 * questions-route.test.ts — what the route accepts, and what it promises.
 *
 * The skill maps a 2xx to "asked" and then tells the model to END ITS TURN, so
 * every answer this route gives is a promise about a message a person can see.
 * A body it cannot read has to be refused with words a model can act on, and a
 * form that never reached Slack must not come back as an ask.
 */

import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import { QuestionnairesMemory } from "../../interactions/questionnaires.ts";
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

interface Posted {
  readonly blocks: readonly unknown[];
  readonly fallback: string;
}

/** The route with every dependency recorded rather than real. */
const routeWith = (options: { failPost?: boolean; live?: boolean } = {}) => {
  const forms = Effect.runSync(QuestionnairesMemory);
  const posts: Posted[] = [];
  let asks = 0;

  const route = makeQuestionsRoute({
    forms,
    isLive: () => Promise.resolve(options.live ?? true),
    newAskId: () => {
      asks += 1;
      return `ask-${asks}`;
    },
    // Exactly the contract `turn-routes.ts` implements: the ts of the posted
    // message, or undefined when Slack refused it.
    post: (_ref, blocks, fallback) => {
      posts.push({
        blocks,
        fallback,
      });
      return Promise.resolve(options.failPost === true ? undefined : "1700.2");
    },
    workspaceTeamId: "T1",
  });

  return {
    forms,
    posts,
    route,
  };
};

const errorOf = async (response: Response): Promise<string> => {
  const parsed: unknown = await response.json();
  return parsed !== null && typeof parsed === "object" && "error" in parsed
    ? String((parsed as { error: unknown }).error)
    : "";
};

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
    // The model has to know how many it asked for to cut them down.
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
    // One message for every unreadable shape, and it names the shape wanted.
    expect(
      refusals.every(
        (parsed) => !parsed.ok && parsed.error.includes("questions")
      )
    ).toBe(true);
  });

  test("an empty channel is accepted, which the blocker route refuses", () => {
    // Documented rather than endorsed: `blocker-route.ts` rejects an empty
    // channel or thread_ts, this one posts into a ref that cannot resolve.
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
    // The skill refuses this before it calls, so only a direct caller gets
    // here — and a section block with no text is `invalid_blocks`.
    const parsed = parseAskBody(body({ intro: "   " }));

    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.request.intro).toBe("");
  });
});

describe("the questions route", () => {
  test("posts the form, stores it, and hands back the ask id", async () => {
    const surface = routeWith();

    const response = await surface.route(ask(body()));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ask_id: "ask-1",
      ok: true,
    });
    expect(surface.posts).toHaveLength(1);
    // The button names the count, so a reader knows what answering costs.
    expect(JSON.stringify(surface.posts[0]?.blocks)).toContain(
      "Answer 1 question"
    );
    expect(surface.posts[0]?.fallback).toBe("Two things before I start.");

    const stored = await Effect.runPromise(surface.forms.get("ask-1"));

    expect(stored?.messageTs).toBe("1700.2");
    expect(stored?.questions).toHaveLength(1);
    expect(stored?.ref.channelId).toBe("C1");
  });

  test("a body it cannot read is a 400 carrying the reason, and posts nothing", async () => {
    const surface = routeWith();

    const response = await surface.route(ask({ nope: true }));

    expect(response.status).toBe(400);
    expect(await errorOf(response)).toContain("expected {");
    expect(surface.posts).toHaveLength(0);
  });

  test("every malformed question shape is a 400 with a message", async () => {
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
    const surface = routeWith();

    for (const raw of bodies) {
      const response = await surface.route(ask(raw));

      expect(response.status).toBe(400);
      expect(await errorOf(response)).not.toBe("");
    }
    expect(surface.posts).toHaveLength(0);
  });

  test("a declared body over the cap is a 413, read before it is parsed", async () => {
    const surface = routeWith();

    const response = await surface.route(
      ask(body(), {
        "content-length": String(MAX_BODY_KIB * BYTES_PER_KIB + 1),
      })
    );

    expect(response.status).toBe(413);
    expect(await errorOf(response)).toBe("payload too large");
    expect(surface.posts).toHaveLength(0);
  });

  test("no live turn in that thread is a 404, and nothing is posted", async () => {
    // The answers resume a run by starting a NEW turn on the thread; with no
    // run there, the form would be asked on behalf of nobody.
    const surface = routeWith({ live: false });

    const response = await surface.route(ask(body()));

    expect(response.status).toBe(404);
    expect(await errorOf(response)).toContain("no run is active");
    expect(surface.posts).toHaveLength(0);
    expect(await Effect.runPromise(surface.forms.pending())).toBe(0);
  });

  test("an id carrying the block-id separator is accepted, and the answer is lost", () => {
    // `blockIdFor` joins with `|` and `questionIdFromBlock` splits on it, so
    // `a|b` comes back as `a` and matches no question. See
    // `questions.test.ts` and `questions-handler.test.ts` for the loss.
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
  test("is not an ask, and must not be reported as one", async () => {
    // KNOWN DEFECT — this test fails today.
    //
    // On a rate limit or `invalid_blocks` the post is dropped
    // (`turn-routes.ts` swallows it with `Effect.orElseSucceed`) and `post`
    // resolves undefined. The route stores the form anyway and returns
    // `{ ok: true }`, so the skill prints END YOUR TURN and the model finishes
    // promising an answer that cannot arrive: there is no message and no
    // button, and nothing will ever start the next turn.
    //
    // `blocker-route.ts` already answers 502 in exactly this situation.
    const surface = routeWith({ failPost: true });

    const response = await surface.route(ask(body()));

    expect(response.ok).toBe(false);
    expect(await Effect.runPromise(surface.forms.pending())).toBe(0);
  });
});
