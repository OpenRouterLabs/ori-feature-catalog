#!/usr/bin/env bun
/**
 * slack-image — generate an image and post it into the thread.
 *
 * For the answer a chart cannot draw: a logo, a mock-up, an illustration of a
 * concept. Coordinates come from the per-turn env the chat surface sets.
 */

import { postImage } from "./post-image.ts";

const args = process.argv.slice(2);
const words: string[] = [];
let title: string | undefined;

for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--title") {
    index += 1;
    title = args[index];
    continue;
  }
  words.push(args[index] ?? "");
}

const outcome = await postImage({
  env: Bun.env,
  fetch: globalThis.fetch,
  prompt: words.join(" "),
  title,
});

if (outcome.kind === "error") {
  process.stderr.write(`slack-image: ${outcome.message}\n`);
  process.exit(1);
}
process.stdout.write("posted\n");
