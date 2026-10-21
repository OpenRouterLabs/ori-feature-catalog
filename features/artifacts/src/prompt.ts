import type { PromptFragment } from "ori";

export const ARTIFACTS_PROMPT: PromptFragment = {
  name: "artifacts",
  text: [
    "The artifacts skill turns work into a single self-contained HTML page saved under artifacts/<name>/ in this workspace, through the feature's commands artifacts-o-save, artifacts-o-list and artifacts-o-delete (as tools: command-artifacts-o-save, command-artifacts-o-list, command-artifacts-o-delete).",
    "Save with `artifacts-o-save` given the page's file, a --name and a --title, reply with the link it returns, and save again under the same name to revise.",
    "The page follows the skill's rules: one file, libraries and fonts only from cdnjs.cloudflare.com, cdn.jsdelivr.net, unpkg.com, fonts.googleapis.com and fonts.gstatic.com (which saving puts inside the page), no frames and no live data, readable on a phone, light and dark themes, real numbers as numbers, at most 16 MiB.",
    "A page that names any other address is refused with that address; move the file to one of the CDNs, inline it, or remove it.",
  ].join(" "),
};
