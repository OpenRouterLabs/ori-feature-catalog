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

import { describe, expect, test } from "bun:test";

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
  test("answers with the id the agent offered, not the label they read", async () => {
    // The agent branches on this string. Handing back "Rebase them" would have
    // every `case rebase)` in every skill miss.
    const surface = wired();
    const pending = surface.route(ask());
    await asksRegistered(surface.blockers, 1);

    const buttons = buttonsOf(surface.thread(THREAD).posted[0]?.blocks ?? []);

    expect(await stillWaiting(pending)).toBe("still waiting");

    await surface.click(buttons[0]?.value ?? "");
    const response = await pending;

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      answer: "rebase",
      ok: true,
    });
  });

  test("gets one button per choice and no way to answer off-list", async () => {
    const surface = wired();
    const pending = surface.route(ask());
    await asksRegistered(surface.blockers, 1);

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

    await surface.click(buttons[0]?.value ?? "");
    await pending;
  });

  test("sees the question rewritten to what they picked, buttons gone", async () => {
    // Buttons on a closed question invite a second answer to something already
    // decided, and the label is what the reader chose — the id is the agent's.
    const surface = wired();
    const pending = surface.route(ask());
    await asksRegistered(surface.blockers, 1);
    const buttons = buttonsOf(surface.thread(THREAD).posted[0]?.blocks ?? []);
    await surface.click(buttons[1]?.value ?? "");
    await pending;

    const { updated } = surface.thread(THREAD);

    expect(updated).toHaveLength(1);
    expect(rendered(updated)).toContain("Close them");
    expect(rendered(updated)).toContain(QUESTION);
    expect(buttonsOf(updated[0]?.blocks ?? [])).toHaveLength(0);
  });

  test("clicking twice answers once", async () => {
    // A double click, or two people reaching it at the same moment. The second
    // must find nothing waiting rather than rewriting the message again.
    const surface = wired();
    const pending = surface.route(ask());
    await asksRegistered(surface.blockers, 1);
    const buttons = buttonsOf(surface.thread(THREAD).posted[0]?.blocks ?? []);
    await surface.click(buttons[0]?.value ?? "");
    const response = await pending;

    expect(await response.json()).toEqual({
      answer: "rebase",
      ok: true,
    });
    expect(Effect.runSync(surface.blockers.count())).toBe(0);

    await surface.click(buttons[1]?.value ?? "");

    const askId = decodeChoice(buttons[0]?.value)?.askId ?? "";

    expect(Effect.runSync(surface.blockers.answer(askId, "close"))).toBe(false);
    expect(surface.thread(THREAD).updated).toHaveLength(1);
  });
});

describe("two blockers open at once", () => {
  test("a click on one never answers the other", async () => {
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
    await asksRegistered(surface.blockers, 2);

    const firstButtons = buttonsOf(
      surface.thread(THREAD).posted[0]?.blocks ?? []
    );
    const secondButtons = buttonsOf(
      surface.thread(OTHER_THREAD).posted[0]?.blocks ?? []
    );

    expect(decodeChoice(firstButtons[0]?.value)?.askId).not.toBe(
      decodeChoice(secondButtons[0]?.value)?.askId
    );

    await surface.click(firstButtons[0]?.value ?? "");

    const firstResponse = await first;

    expect(await firstResponse.json()).toEqual({
      answer: "rebase",
      ok: true,
    });
    expect(await stillWaiting(second)).toBe("still waiting");
    expect(Effect.runSync(surface.blockers.count())).toBe(1);
    expect(surface.thread(OTHER_THREAD).updated).toHaveLength(0);

    await surface.click(secondButtons[1]?.value ?? "");
    const secondResponse = await second;

    expect(await secondResponse.json()).toEqual({
      answer: "hold",
      ok: true,
    });
  });
});

describe("a blocker nobody answers", () => {
  test("gives up, says so in the thread, and stops waiting", async () => {
    const surface = wired({ timeoutMs: 5 });

    const response = await surface.route(ask());

    expect(response.status).toBe(408);
    expect(await response.json()).toEqual({ error: "nobody answered" });

    const recorder = surface.thread(THREAD);

    expect(rendered(recorder.updated)).toContain("No answer");
    expect(buttonsOf(recorder.updated[0]?.blocks ?? [])).toHaveLength(0);
    // Nothing is left holding the turn's closure once the route has answered.
    expect(Effect.runSync(surface.blockers.count())).toBe(0);
  });

  test("cannot be answered late by someone scrolling back", async () => {
    const surface = wired({ timeoutMs: 5 });
    await surface.route(ask());
    const recorder = surface.thread(THREAD);
    const buttons = buttonsOf(recorder.posted[0]?.blocks ?? []);

    await surface.click(buttons[0]?.value ?? "");

    expect(recorder.updated).toHaveLength(1);
    expect(rendered(recorder.updated)).toContain("No answer");
  });
});

describe("a blocker Slack refused", () => {
  test("is abandoned rather than left pending until the daemon restarts", async () => {
    // Nothing is on screen, so nobody can ever click it. Leaving the ask open
    // would hold the turn's closure for the lifetime of the process.
    const surface = wired({
      failPost: true,
      timeoutMs: 5,
    });

    const response = await surface.route(ask());

    expect(response.status).toBe(502);
    expect(Effect.runSync(surface.blockers.count())).toBe(0);
    // And nothing was rewritten, because nothing was ever posted.
    expect(surface.thread(THREAD).updated).toHaveLength(0);
  });
});
