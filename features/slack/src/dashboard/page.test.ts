import type { ThreadRow } from "#src/state/store.ts";

import { describe, expect, test } from "#src/test-support/effect-test.ts";

import { InterruptMode } from "#src/state/settings.ts";
import { UNSEEN_THREAD } from "#src/turn/listening/listen.ts";
import { ago, renderDashboard as render } from "./page.ts";

const renderDashboard = (
  rows: Parameters<typeof render>[0],
  now: number,
  mode: InterruptMode = InterruptMode.Steer
): string => render(rows, now, mode);

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const NOW = 1_000 * DAY;

const thread = (overrides: Partial<ThreadRow> = {}): ThreadRow => ({
  instanceId: "C123:1700000000.000100",
  listen: UNSEEN_THREAD,
  session: { sessionId: "sess-1", startedAt: NOW - MINUTE },
  ...overrides,
});

describe("ago", () => {
  test.each([
    [0, "just now"],
    [30_000, "just now"],
    [3 * MINUTE, "3m ago"],
    [5 * HOUR, "5h ago"],
    [3 * DAY, "3d ago"],
  ])("%s ms reads as %s", (elapsed, expected) => {
    expect(ago(NOW - elapsed, NOW)).toBe(expected);
  });

  test("a clock that went backwards does not render a negative age", () => {
    expect(ago(NOW + MINUTE, NOW)).toBe("just now");
  });
});

describe("what the page reports", () => {
  test("an empty store says so instead of rendering an empty table", () => {
    const html = renderDashboard([], NOW);

    expect(html).toContain("No threads yet");
    expect(html).not.toContain("<tbody></tbody>");
  });

  test("the counts summarise what a reader would otherwise tally by hand", () => {
    const html = renderDashboard(
      [
        thread({ listen: { ...UNSEEN_THREAD, engaged: true } }),
        thread({
          instanceId: "C123:2",
          listen: { ...UNSEEN_THREAD, muted: true },
        }),
        thread({ instanceId: "C123:3" }),
      ],
      NOW
    );

    expect(html).toContain("3 threads");
    expect(html).toContain("1 engaged");
    expect(html).toContain("1 muted");
  });

  test("one thread is not pluralised", () => {
    expect(renderDashboard([thread()], NOW)).toContain("1 thread &middot;");
  });

  test("a muted thread is labelled, because that is why it is quiet", () => {
    const html = renderDashboard(
      [thread({ listen: { ...UNSEEN_THREAD, muted: true } })],
      NOW
    );

    expect(html).toContain(">muted<");
  });

  test("a thread with no session reads as never answered, not as an error", () => {
    const html = renderDashboard(
      [thread({ listen: { ...UNSEEN_THREAD, engaged: true }, session: undefined })],
      NOW
    );

    expect(html).toContain("never answered");
    expect(html).toContain(">engaged<");
  });

  test("newest first, and never-answered threads sink", () => {
    const html = renderDashboard(
      [
        thread({ instanceId: "OLD", session: { sessionId: "s", startedAt: NOW - DAY } }),
        thread({ instanceId: "NEVER", session: undefined }),
        thread({ instanceId: "NEW", session: { sessionId: "s", startedAt: NOW } }),
      ],
      NOW
    );

    expect(html.indexOf("NEW")).toBeLessThan(html.indexOf("OLD"));
    expect(html.indexOf("OLD")).toBeLessThan(html.indexOf("NEVER"));
  });

  test("participants are counted, not listed", () => {
    const html = renderDashboard(
      [
        thread({
          listen: { ...UNSEEN_THREAD, participants: new Set(["U1", "U2"]) },
        }),
      ],
      NOW
    );

    expect(html).toContain(">2<");
    expect(html).not.toContain("U1");
  });

  test("a thread id carrying markup cannot escape its cell", () => {
    const html = renderDashboard(
      [thread({ instanceId: "<script>alert(1)</script>" })],
      NOW
    );

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("the page does not auto-refresh, because it carries a form", () => {
    expect(renderDashboard([], NOW)).not.toContain("http-equiv");
  });

  test("the current mode is the one checked", () => {
    const queueing = renderDashboard([], NOW, InterruptMode.Queue);

    expect(queueing).toContain('value="queue" checked');
    expect(queueing).not.toContain('value="steer" checked');
  });

  test("steering is shown as selected when it is", () => {
    expect(renderDashboard([], NOW, InterruptMode.Steer)).toContain(
      'value="steer" checked'
    );
  });

  test("the form posts back to the page it came from", () => {
    const html = renderDashboard([], NOW);

    expect(html).toContain('method="post"');
    expect(html).toContain('action="/slack/dashboard"');
  });

  test("both modes are described, so neither reads as the safe default", () => {
    const html = renderDashboard([], NOW);

    expect(html).toContain("interrupt the running turn");
    expect(html).toContain("let the running turn finish");
  });
});
