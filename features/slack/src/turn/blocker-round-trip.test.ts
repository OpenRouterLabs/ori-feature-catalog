/* oxlint-disable eslint/max-lines-per-function -- these cases read better whole than split */

import { describe, expect, test } from "#src/test-support/index.ts";

import { Effect } from "effect";

import { decodeChoice, encodeChoice } from "#src/helpers/blockers/index.ts";
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
      expect(rendered(posted)).not.toContain("Something else");

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
      const surface = wired({
        failPost: true,
        timeoutMs: 5,
      });

      const response = yield* Effect.promise(() => surface.route(ask()));

      expect(response.status).toBe(502);
      expect(yield* surface.blockers.count()).toBe(0);
      expect(surface.thread(THREAD).updated).toHaveLength(0);
    }));
});
