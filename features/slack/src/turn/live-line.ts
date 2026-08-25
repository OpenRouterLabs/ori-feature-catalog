/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively; the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */
/**
 * live-line.ts — the last thing the agent said, where the beat can find it.
 *
 * The agent writes the indicator itself, from its own process, and Slack wipes
 * that indicator every time the app posts anything to the thread. So something
 * has to put it back, and the only thing running for the whole turn is the
 * daemon — which does not otherwise know what the agent said.
 *
 * One file per thread is the whole channel. It is deliberately not the service
 * and loopback route this replaced: nothing is registered, nothing is awaited,
 * and a turn that never reads it costs nothing. Same host by construction —
 * the skill is a child of the agent, which is a child of this daemon.
 *
 * Stale lines are ignored rather than deleted. A line older than the window is
 * from a turn that has ended, and re-asserting it would put a finished run's
 * words back on a live thread.
 */

import { Effect } from "effect";

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Old enough that it belongs to a turn that has stopped speaking. */
const STALE_MS = 120_000;

const DIR = join(tmpdir(), "ori-slack", "live");

/** Thread keys carry colons; a filename may not. */
const fileFor = (threadKey: string): string =>
  join(DIR, `${threadKey.replaceAll(/[^\w.-]/gu, "_")}.txt`);

export const recordLiveLine = (
  threadKey: string,
  line: string,
  now: number = Date.now()
): Promise<void> =>
  Effect.runPromise(
    Effect.tryPromise(async () => {
      await mkdir(DIR, { recursive: true });
      await writeFile(fileFor(threadKey), `${now}\n${line}`, "utf-8");
    }).pipe(
      // The beat falls back to its own line. An unwritable temp dir must not
      // cost the agent the update it was making.
      Effect.ignore
    )
  );

/** What the agent last said in this thread, if it was recent enough to mean it. */
export const readLiveLine = (
  threadKey: string,
  now: number = Date.now()
): Promise<string | undefined> =>
  Effect.runPromise(
    Effect.tryPromise(() => readFile(fileFor(threadKey), "utf-8")).pipe(
      Effect.map((raw) => {
        const at = Number(raw.slice(0, raw.indexOf("\n")));
        const line = raw.slice(raw.indexOf("\n") + 1).trim();
        return Number.isFinite(at) && now - at < STALE_MS && line !== ""
          ? line
          : undefined;
      }),
      // No file, or an unreadable one, means nothing was said recently —
      // which is the same answer as a line too stale to mean it.
      Effect.orElseSucceed(() => undefined)
    )
  );
