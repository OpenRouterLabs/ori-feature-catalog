/* oxlint-disable import/no-relative-parent-imports eslint/max-lines-per-function -- siblings are imported relatively, and these cases read better whole than split */
/**
 * blocker-round-trip.test.ts — the blocking ask, from POST to click to answer.
 *
 * `blocker-route.test.ts` reaches into `Blockers.answer` to unblock the route;
 * `blocker-handler.test.ts` clicks an ask it opened itself. Neither joins the
 * two, so the wire that carries the answer — the button `value` the route
 * encodes, decoded by the handler the dispatcher found — was never exercised
 * whole. Nothing here invents an ask id or a button value: every click is made
 * from the bytes the route put on screen, which is all a reader has.
 */

import { describe, expect, test } from "#src/test-support/effect-test.ts";

import { Effect } from "effect";

import { decodeChoice, encodeChoice } from "../helpers/blockers/blockers.ts";
import {
  ask,
  asksRegistered,
  buttonsOf,
  OTHER_THREAD,
  QUESTION,
  rendered,
  stillWaiting,
  THREAD,
  wired,
} from "./blocker-test-support.ts";

describe("a reader clicking a blocker", () => {
  test.effect("answers with the id the agent offered, not the label they read", () =>
    Effect.gen(function* () {
      // The agent branches on this string. Handing back "Rebase them" would have
      // every `case rebase)` in every skill miss.
      const surface = wired();
      const pending = surface.route(ask());
      yield* Effect.promise(() => asksRegistered(surface.blockers, 1));

      const buttons = buttonsOf(surface.thread(THREAD).posted[0]?.blocks ?? []);

      expect(yield* Effect.promise(() => stillWaiting(pending))).toBe(
        "still waiting"
      );

      yield* Effect.promise(() => surface.click(buttons[0]?.value ?? ""));
      const response = yield* Effect.promise(() => pending);

      expect(response.status).toBe(200);
      expect(yield* Effect.promise(() => response.json())).toEqual({
        answer: "rebase",
        ok: true,
      });
    }));

  test.effect("gets one button per choice and no way to answer off-list", () =>
    Effect.gen(function* () {
      const surface = wired();
      const pending = surface.route(ask());
      yield* Effect.promise(() => asksRegistered(surface.blockers, 1));

      const { posted } = surface.thread(THREAD);
      const buttons = buttonsOf(posted[0]?.blocks ?? []);

      expect(buttons.map((seen) => seen.label)).toEqual([
        "Rebase them",
        "Close them",
      ]);
      // The freeform modal is gone: a reader with an unlisted answer says so in
      // the thread, where it reaches the agent as a message like any other.
      expect(rendered(posted)).not.toContain("Something else");

      // Every value is the same ask paired with its own choice, and survives the
      // round trip the handler will put it through.
      const decoded = buttons.map((seen) => decodeChoice(seen.value));
      const askIds = new Set(decoded.map((one) => one?.askId));

      expect(askIds.size).toBe(1);
      expect(decoded.map((one) => one?.choiceId)).toEqual(["rebase", "close"]);
      const askId = decoded[0]?.askId ?? "";

      expect(buttons.map((seen) => seen.value)).toEqual([
        encodeChoice(askId, "rebase"),
        encodeChoice(askId, "close"),
      ]);

      yield* Effect.promise(() => surface.click(buttons[0]?.value ?? ""));
      yield* Effect.promise(() => pending);
    }));

  test.effect("sees the question rewritten to what they picked, buttons gone", () =>
    Effect.gen(function* () {
      // Buttons on a closed question invite a second answer to something already
      // decided, and the label is what the reader chose — the id is the agent's.
      const surface = wired();
      const pending = surface.route(ask());
      yield* Effect.promise(() => asksRegistered(surface.blockers, 1));
      const buttons = buttonsOf(surface.thread(THREAD).posted[0]?.blocks ?? []);
      yield* Effect.promise(() => surface.click(buttons[1]?.value ?? ""));
      yield* Effect.promise(() => pending);

      const { updated } = surface.thread(THREAD);

      expect(updated).toHaveLength(1);
      expect(rendered(updated)).toContain("Close them");
      expect(rendered(updated)).toContain(QUESTION);
      expect(buttonsOf(updated[0]?.blocks ?? [])).toHaveLength(0);
    }));

  test.effect("clicking twice answers once", () =>
    Effect.gen(function* () {
      // A double click, or two people reaching it at the same moment. The second
      // must find nothing waiting rather than rewriting the message again.
      const surface = wired();
      const pending = surface.route(ask());
      yield* Effect.promise(() => asksRegistered(surface.blockers, 1));
      const buttons = buttonsOf(surface.thread(THREAD).posted[0]?.blocks ?? []);
      yield* Effect.promise(() => surface.click(buttons[0]?.value ?? ""));
      const response = yield* Effect.promise(() => pending);

      expect(yield* Effect.promise(() => response.json())).toEqual({
        answer: "rebase",
        ok: true,
      });
      expect(yield* surface.blockers.count()).toBe(0);

      yield* Effect.promise(() => surface.click(buttons[1]?.value ?? ""));

      const askId = decodeChoice(buttons[0]?.value)?.askId ?? "";

      expect(yield* surface.blockers.answer(askId, "close")).toBe(false);
      expect(surface.thread(THREAD).updated).toHaveLength(1);
    }));
});

describe("two blockers open at once", () => {
  test.effect("a click on one never answers the other", () =>
    Effect.gen(function* () {
      // Ask ids are per-graph and the button carries its own, so this holds even
      // though both routes are in flight against the same registry.
      const surface = wired();
      const first = surface.route(ask());
      const second = surface.route(
        ask({
          choices: [
            {
              id: "ship",
              label: "Ship it",
            },
            {
              id: "hold",
              label: "Hold it",
            },
          ],
          question: "Ship the release or hold it?",
          threadTs: OTHER_THREAD,
        })
      );
      yield* Effect.promise(() => asksRegistered(surface.blockers, 2));

      const firstButtons = buttonsOf(
        surface.thread(THREAD).posted[0]?.blocks ?? []
      );
      const secondButtons = buttonsOf(
        surface.thread(OTHER_THREAD).posted[0]?.blocks ?? []
      );

      expect(decodeChoice(firstButtons[0]?.value)?.askId).not.toBe(
        decodeChoice(secondButtons[0]?.value)?.askId
      );

      yield* Effect.promise(() => surface.click(firstButtons[0]?.value ?? ""));

      const firstResponse = yield* Effect.promise(() => first);

      expect(yield* Effect.promise(() => firstResponse.json())).toEqual({
        answer: "rebase",
        ok: true,
      });
      expect(yield* Effect.promise(() => stillWaiting(second))).toBe(
        "still waiting"
      );
      expect(yield* surface.blockers.count()).toBe(1);
      expect(surface.thread(OTHER_THREAD).updated).toHaveLength(0);

      yield* Effect.promise(() => surface.click(secondButtons[1]?.value ?? ""));
      const secondResponse = yield* Effect.promise(() => second);

      expect(yield* Effect.promise(() => secondResponse.json())).toEqual({
        answer: "hold",
        ok: true,
      });
    }));
});

describe("a blocker nobody answers", () => {
  test.effect("gives up, says so in the thread, and stops waiting", () =>
    Effect.gen(function* () {
      const surface = wired({ timeoutMs: 5 });

      const response = yield* Effect.promise(() => surface.route(ask()));

      expect(response.status).toBe(408);
      expect(yield* Effect.promise(() => response.json())).toEqual({
        error: "nobody answered",
      });

      const recorder = surface.thread(THREAD);

      expect(rendered(recorder.updated)).toContain("No answer");
      expect(buttonsOf(recorder.updated[0]?.blocks ?? [])).toHaveLength(0);
      // Nothing is left holding the turn's closure once the route has answered.
      expect(yield* surface.blockers.count()).toBe(0);
    }));

  test.effect("cannot be answered late by someone scrolling back", () =>
    Effect.gen(function* () {
      const surface = wired({ timeoutMs: 5 });
      yield* Effect.promise(() => surface.route(ask()));
      const recorder = surface.thread(THREAD);
      const buttons = buttonsOf(recorder.posted[0]?.blocks ?? []);

      yield* Effect.promise(() => surface.click(buttons[0]?.value ?? ""));

      expect(recorder.updated).toHaveLength(1);
      expect(rendered(recorder.updated)).toContain("No answer");
    }));
});

describe("a blocker Slack refused", () => {
  test.effect("is abandoned rather than left pending until the daemon restarts", () =>
    Effect.gen(function* () {
      // Nothing is on screen, so nobody can ever click it. Leaving the ask open
      // would hold the turn's closure for the lifetime of the process.
      const surface = wired({
        failPost: true,
        timeoutMs: 5,
      });

      const response = yield* Effect.promise(() => surface.route(ask()));

      expect(response.status).toBe(502);
      expect(yield* surface.blockers.count()).toBe(0);
      // And nothing was rewritten, because nothing was ever posted.
      expect(surface.thread(THREAD).updated).toHaveLength(0);
    }));
});
