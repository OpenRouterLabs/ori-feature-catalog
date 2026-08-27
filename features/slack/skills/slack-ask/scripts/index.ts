#!/usr/bin/env bun
/**
 * slack-ask — ask the person who asked, and wait for the answer.
 *
 * Posts a question with buttons into the thread and BLOCKS until someone
 * clicks, so the answer can be read straight off stdout. Coordinates come from
 * the per-turn env the chat surface sets.
 *
 * Exits 0 with `unanswered` on stdout when nobody replies in time — a blocker
 * nobody answered is a decision to make, not a run to fail.
 */

import type { AskChoice } from "./post-ask.ts";

import { parseChoice, postAsk } from "./post-ask.ts";

const args = process.argv.slice(2);
const choices: AskChoice[] = [];
const malformed: string[] = [];
const words: string[] = [];

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index] ?? "";
  if (arg === "--choice") {
    index += 1;
    const raw = args[index] ?? "";
    const parsed = parseChoice(raw);
    if (parsed === undefined) {
      malformed.push(raw);
      continue;
    }
    choices.push(parsed);
    continue;
  }
  words.push(arg);
}

// Dropping it silently posts a question missing the button the agent will
// branch on, and the reader cannot supply it — the run then spends the whole
// fifteen minutes finding that out. Worse, if it was the only choice, the
// message goes up with an empty actions block and Slack refuses it outright.
if (malformed.length > 0) {
  const listed = malformed.map((raw) => `"${raw}"`).join(", ");
  process.stderr.write(
    `slack-ask: could not read --choice ${listed} — expected id=Label\n`
  );
  process.exit(1);
}

const outcome = await postAsk({
  choices,
  env: Bun.env,
  fetch: globalThis.fetch,
  question: words.join(" "),
});

if (outcome.kind === "error") {
  process.stderr.write(`slack-ask: ${outcome.message}\n`);
  process.exit(1);
}
if (outcome.kind === "unanswered") {
  process.stderr.write(
    "slack-ask: nobody answered — decide for yourself and say what you assumed\n"
  );
  process.stdout.write("unanswered\n");
  process.exit(0);
}
process.stdout.write(`${outcome.answer}\n`);
