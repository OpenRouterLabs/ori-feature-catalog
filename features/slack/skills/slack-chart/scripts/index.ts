#!/usr/bin/env bun
/**
 * slack-chart — upload a chart into the thread you are replying to.
 *
 * Reads the spec as JSON on argv or stdin and posts it to the daemon's
 * loopback chart route, which renders and uploads it. Coordinates come from
 * the per-turn env, so the model never restates them.
 */

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
