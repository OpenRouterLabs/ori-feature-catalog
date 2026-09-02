#!/usr/bin/env bun

import { postChart } from "./post-chart.ts";

const readStdin = async (): Promise<string> => {
  process.stdin.setEncoding("utf8");
  let text = "";
  for await (const chunk of process.stdin) {
    text += chunk;
  }
  return text;
};

const spec = process.argv.slice(2).join(" ").trim() || (await readStdin());
const outcome = await postChart({
  env: process.env,
  fetch: globalThis.fetch,
  spec,
});

if (outcome.kind === "error") {
  process.stderr.write(`slack-chart: ${outcome.message}\n`);
  process.exit(1);
}
process.stdout.write("posted\n");
