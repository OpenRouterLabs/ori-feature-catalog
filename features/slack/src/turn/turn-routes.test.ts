/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively; the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */
/* oxlint-disable typescript/no-unsafe-type-assertion typescript/explicit-function-return-type typescript/no-invalid-void-type eslint/require-await -- test doubles stand in for the composition root's service graph, and a queue barrier has nothing to await */
/**
 * turn-routes.test.ts — the questions route as the daemon actually wires it.
 *
 * `questions-route.test.ts` drives the route through injected dependencies.
 * This drives the real glue in `makeSideRoutes`: a live turn in the registry, a
 * `MessageReply` built over a Slack client, and the `post` closure that turns a
 * refused `chat.postMessage` into a ts — or into nothing at all.
 */

import {
  beforeEach,
  describe,
  expect,
  test,
} from "#src/test-support/effect-test.ts";

import { Effect } from "effect";

import type { SlackServices } from "../layers.ts";
import type { TurnRouteDeps } from "./turn-routes.ts";

import { makeFakeSlackClient } from "../client/client-test-support.ts";
import { QuestionnairesMemory } from "../interactions/questionnaires.ts";
import { deferred } from "../thread/registry-test-support.ts";
import { enqueue, resetRegistry } from "../thread/index.ts";
import { threadInstanceId } from "../thread/index.ts";
import { makeTurnRoutes } from "./turn-routes.ts";

const REF = {
  channelId: "C1",
  teamId: "T1",
  threadTs: "1700.1",
};

const BODY = {
  channel: REF.channelId,
  intro: "Two things before I start.",
  questions: [
    {
      choices: ["Rebase", "Close"],
      id: "strategy",
      prompt: "Rebase them or close them?",
    },
  ],
  thread_ts: REF.threadTs,
};

const ask = (): Request =>
  new Request("http://127.0.0.1/slack/thread/questions", {
    body: JSON.stringify(BODY),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

/** The graph the questions route touches, and nothing else. */
const surface = (options: { refusePost?: boolean } = {}) =>
  Effect.gen(function* () {
    const fake = makeFakeSlackClient(
      options.refusePost === true
        ? { postMessage: () => Effect.fail(new Error("ratelimited") as never) }
        : {}
    );
    const forms = yield* QuestionnairesMemory;

    const routes = makeTurnRoutes({
      config: { imageModel: "unused" },
      forms,
      // `runWith` is the deps contract itself — `turn-routes.ts` calls it for a
      // promise — so this run stays: it is the boundary under test.
      runWith: <A>(effect: Effect.Effect<A, never, SlackServices>): Promise<A> =>
        Effect.runPromise(
          effect.pipe(Effect.provide(fake.layer)) as Effect.Effect<A>
        ),
      workspaceTeamId: REF.teamId,
    } as unknown as TurnRouteDeps);

    return {
      fake,
      forms,
      routes,
    };
  });

/** Ask while a turn owns the thread, which is the only time the route posts. */
const askDuringATurn = async (
  routes: Effect.Success<ReturnType<typeof surface>>["routes"]
): Promise<Response> => {
  const gate = deferred<void>();
  let response: Response | undefined;

  const running = enqueue(
    threadInstanceId(REF),
    async () => {},
    async () => {
      response = await routes.handleQuestions(ask());
      gate.resolve();
    }
  );

  await gate.promise;
  await running;
  if (response === undefined) {
    throw new Error("the route never answered");
  }
  return response;
};

describe("the questions route inside the daemon", () => {
  beforeEach(() => {
    resetRegistry();
  });

  test.effect("posts the form to the thread and remembers where it landed", () =>
    Effect.gen(function* () {
      const built = yield* surface();

      const response = yield* Effect.promise(() =>
        askDuringATurn(built.routes)
      );

      expect(response.status).toBe(200);
      const posted = built.fake.calls.filter(
        (call) => call.op === "chat.postMessage"
      );

      expect(posted).toHaveLength(1);
      expect(JSON.stringify(posted[0]?.args)).toContain("Answer 1 question");

      const askId = (
        (yield* Effect.promise(() => response.json())) as { ask_id: string }
      ).ask_id;
      const stored = yield* built.forms.get(askId);

      expect(stored?.messageTs).toBe("1700000000.000100");
    }));

  test.effect("a thread with no live turn is a 404 before anything is posted", () =>
    Effect.gen(function* () {
      const built = yield* surface();

      const response = yield* Effect.promise(() =>
        built.routes.handleQuestions(ask())
      );

      expect(response.status).toBe(404);
      expect(built.fake.calls).toHaveLength(0);
    }));

  test.effect("a post Slack refused leaves a form with no message behind it", () =>
    Effect.gen(function* () {
      // `makeSideRoutes` swallows the failure with `Effect.orElseSucceed`, so
      // `post` resolves undefined and the stored form has no `messageTs` — which
      // is what `questions-handler.ts` needs to retire the message on submit.
      const built = yield* surface({ refusePost: true });

      const response = yield* Effect.promise(() =>
        askDuringATurn(built.routes)
      );
      const askId = (
        (yield* Effect.promise(() => response.json())) as { ask_id?: string }
      ).ask_id;
      const stored =
        askId === undefined ? undefined : yield* built.forms.get(askId);

      expect(stored?.messageTs).toBeUndefined();
    }));

  test.effect("and must not come back as an ask the model can end its turn on", () =>
    Effect.gen(function* () {
      // KNOWN DEFECT — this test fails today. See the same case in
      // `turn/questions-route.test.ts`: nothing was posted, so there is no
      // message and no button, and no answer can ever start the next turn. The
      // skill still prints END YOUR TURN.
      const built = yield* surface({ refusePost: true });

      const response = yield* Effect.promise(() =>
        askDuringATurn(built.routes)
      );

      expect(response.ok).toBe(false);
    }));
});
