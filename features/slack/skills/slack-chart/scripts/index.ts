#!/usr/bin/env bun

import { postChart } from "./post-chart.ts";

const spec = process.argv.slice(2).join(" ").trim() || (await Bun.stdin.text());
const outcome = await postChart({
  env: Bun.env,
  fetch: globalThis.fetch,
  spec,
});

if (outcome.kind === "error") {
  process.stderr.write(`slack-chart: ${outcome.message}\n`);
  process.exit(1);
}
process.stdout.write("posted\n");
