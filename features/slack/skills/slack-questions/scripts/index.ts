#!/usr/bin/env bun

import { Effect } from "effect";

import type { Question } from "./post-questions.ts";

import { postQuestions } from "./post-questions.ts";

const usage = [
  "usage: slack-questions <intro> '<json>'",
  "   or: slack-questions <intro> <<'JSON'   (use this when a question contains an apostrophe)",
  '       [{"id":"q1","prompt":"Which one?","kind":"single","choices":["a","b"]}]',
  "JSON",
].join("\n");

const END_YOUR_TURN =
  "Asked. END YOUR TURN now — say what you are blocked on. You will be " +
  "started again on this thread with their answers when they reply.";

const parseQuestions = (raw: string): readonly Question[] | undefined =>
  Effect.runSync(
    Effect.try((): readonly Question[] | undefined => {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as readonly Question[]) : undefined;
    }).pipe(
      Effect.orElseSucceed(() => undefined)
    )
  );

if (import.meta.main) {
  const [intro, argvQuestions] = process.argv.slice(2);
  const piped = argvQuestions === undefined ? await Bun.stdin.text() : "";
  const rawQuestions = argvQuestions ?? piped.trim();
  if (intro === undefined || rawQuestions === "") {
    process.stderr.write(`${usage}\n`);
    process.exit(1);
  }

  const questions = parseQuestions(rawQuestions);
  if (questions === undefined) {
    process.stderr.write(
      `slack-questions: questions must be a JSON array\n${usage}\n`
    );
    process.exit(1);
  }

  const outcome = await postQuestions({
    env: Bun.env,
    fetch: globalThis.fetch,
    intro,
    questions,
  });

  if (outcome.kind === "error") {
    process.stderr.write(`slack-questions: ${outcome.message}\n`);
    process.exit(1);
  }
  process.stdout.write(`${END_YOUR_TURN}\n`);
  process.exit(0);
}
