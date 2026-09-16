/**
 * feature.ts — the Google Workspace feature's contribution entry.
 *
 * The work is done by the `google-workspace` skill; this module contributes
 * the one standing rule the agent needs before the skill is ever opened: the
 * person's Google account is reached through the skill, never through a
 * credential the agent asks for or holds.
 */

import type { PromptExport, PromptFragment } from "ori";

export const GOOGLE_WORKSPACE_PROMPT: PromptFragment = {
  name: "google-workspace",
  text: [
    "Google Workspace (Gmail, Calendar, Drive, Docs, Sheets) is reachable through the `google-workspace` skill, acting as the person you are talking to through their own linked Google account.",
    "Never ask anyone for Google credentials and never set an Authorization header yourself: requests are authenticated for you.",
    "A 401 or 403 from Google means the person has not linked their account, or not granted that product, under Your accounts on the Interns page of the OpenRouter dashboard; tell them so instead of retrying.",
  ].join(" "),
};

export const prompt: PromptExport = () => GOOGLE_WORKSPACE_PROMPT;
