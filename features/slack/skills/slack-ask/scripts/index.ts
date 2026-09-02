#!/usr/bin/env bun

import { type AskChoice, parseChoice, postAsk } from "./post-ask.ts";


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
