/* oxlint-disable import/no-relative-parent-imports -- skill scripts live beside siblings under features/slack/skills and cross-import intentionally */
// The generic pieces (ThrownError, tryCatchAsync, isString) live in the
// slack-api skill's guards and are re-exported here so spawn-thread scripts
// keep importing from their local guards module.

// oxlint-disable-next-line import/no-relative-parent-imports -- skills are materialized side by side in the agent workspace; the sibling skill's script is the real runtime path
export { isString, tryCatchAsync } from "../../slack-api/scripts/result.ts";

/**
 * Build a Slack permalink for a thread root message (vendored from Perry's
 * buildSlackThreadUrl in the ori-monorepo egg package).
 *
 * Format: https://{workspace}/archives/{channel}/p{ts_without_dot}?thread_ts={threadTs}&cid={channel}
 *
 * When `messageTs` is supplied it is used as the `p<ts>` path anchor so the URL
 * resolves to a specific reply inside the thread (the form Slack reliably opens
 * as a thread side-panel), while `thread_ts` still points at the thread root.
 */
export const buildSlackThreadUrl = (opts: {
  channel: string;
  threadTs: string;
  workspaceUrl?: string | undefined;
  messageTs?: string | undefined;
}): string => {
  const workspaceUrl = opts.workspaceUrl ?? "https://openrouter.slack.com";
  const targetTs =
    opts.messageTs && opts.messageTs.length > 0
      ? opts.messageTs
      : opts.threadTs;
  const base = `${workspaceUrl.replace(/\/$/u, "")}/archives/${opts.channel}/p${targetTs.replaceAll(".", "")}`;
  return `${base}?thread_ts=${opts.threadTs}&cid=${opts.channel}`;
};
