/* oxlint-disable import/no-relative-parent-imports -- modules inside this feature import siblings relatively; the `@ori-monorepo/slack/*` self-specifier does not resolve for the linter */

import { Effect } from "effect";

import { bestEffort } from "../helpers/best-effort.ts";

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STALE_MS = 120_000;

const DIR = join(tmpdir(), "ori-slack", "live");

const fileFor = (threadKey: string): string =>
  join(DIR, `${threadKey.replaceAll(/[^\w.-]/gu, "_")}.txt`);

const recentLine = (raw: string, now: number): string | undefined => {
  const at = Number(raw.slice(0, raw.indexOf("\n")));
  const line = raw.slice(raw.indexOf("\n") + 1).trim();
  return Number.isFinite(at) && now - at < STALE_MS && line !== ""
    ? line
    : undefined;
};

export const recordLine = Effect.fn("Slack.liveLine.record")(function* (
  threadKey: string,
  line: string,
  now: number = Date.now()
): Effect.fn.Return<void> {
  yield* Effect.tryPromise(async () => {
    await mkdir(DIR, { recursive: true });
    await writeFile(fileFor(threadKey), `${now}\n${line}`, "utf-8");
  }).pipe(
    bestEffort
  );
});

export const readLine = Effect.fn("Slack.liveLine.read")(function* (
  threadKey: string,
  now: number = Date.now()
): Effect.fn.Return<string | undefined> {
  const raw = yield* Effect.tryPromise(() =>
    readFile(fileFor(threadKey), "utf-8")
  ).pipe(Effect.orElseSucceed(() => undefined));
  return raw === undefined ? undefined : recentLine(raw, now);
});

export const recordLiveLine = (
  threadKey: string,
  line: string,
  now: number = Date.now()
): Promise<void> => Effect.runPromise(recordLine(threadKey, line, now));

export const readLiveLine = (
  threadKey: string,
  now: number = Date.now()
): Promise<string | undefined> => Effect.runPromise(readLine(threadKey, now));
