#!/usr/bin/env bun

/**
 * index.ts — the `slack-questions` CLI entry.
 *
 * The composition root: the only module in this skill that touches
 * process.argv, process.exit, stdout or stderr.
 *
 * Questions arrive as JSON because they are a nested shape — a prompt, a kind,
 * a list of choices, each with its own id. Flattening that into flags was the
 * alternative and it reads worse than the thing it encodes.
 */

import { Effect } from "effect";

import type { Question } from "./post-questions.ts";

import { postQuestions } from "./post-questions.ts";

const usage = [
  "usage: slack-questions <intro> '<json>'",
  "   or: slack-questions <intro> <<'JSON'   (use this when a question contains an apostrophe)",
  '       [{"id":"q1","prompt":"Which one?","kind":"single","choices":["a","b"]}]',
  "JSON",
].join("\n");

/** The whole point of the skill: the model must stop after asking. */
const END_YOUR_TURN =
  "Asked. END YOUR TURN now — say what you are blocked on. You will be " +
  "started again on this thread with their answers when they reply.";

const parseQuestions = (raw: string): readonly Question[] | undefined =>
  Effect.runSync(
    Effect.try((): readonly Question[] | undefined => {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as readonly Question[]) : undefined;
    }).pipe(
      // Not JSON and not an array are the same answer to the caller: nothing
      // usable was passed, so it prints usage.
      Effect.orElseSucceed(() => undefined)
    )
  );

if (import.meta.main) {
  const [intro, argvQuestions] = process.argv.slice(2);
  // Read from stdin when no JSON argument is given, as `slack-chart` does.
  // Single-quoting is the only shell form that keeps JSON intact, and it is
  // the one form an apostrophe destroys: "Delete Ahmed's branch?" ends the
  // quote and the model gets a shell parse error it cannot attribute to us.
  // Double quotes are worse than an error — `$HOME` expands silently and a
  // different question reaches the person.
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
