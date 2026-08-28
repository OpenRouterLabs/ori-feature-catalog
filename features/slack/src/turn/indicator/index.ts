/**
 * index.ts — the line under a running turn.
 *
 * `status-beat.ts` renders and re-asserts it from the run state; `live-line.ts`
 * is the file the `slack-status` skill drops the agent's own words into, from
 * its own process, for the beat to pick up.
 */

export { readLine, readLiveLine, recordLine, recordLiveLine } from "./live-line.ts";
export { beatLine, beatStatus, loadingListOf } from "./status-beat.ts";
