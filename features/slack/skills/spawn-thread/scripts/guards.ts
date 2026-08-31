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
