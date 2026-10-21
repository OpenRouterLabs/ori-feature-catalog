/**
 * feature.ts — the Google Workspace feature's contribution entry.
 *
 * The work is done by one skill per Google app (gmail, google-calendar,
 * google-drive, google-docs, google-sheets) over a shared command; this
 * module contributes the one standing rule the agent needs before any of
 * them is opened: the person's Google account is reached through those
 * skills, never through a credential the agent asks for or holds, and a
 * linked account is shared with others only when whoami says so.
 */

import type { PromptExport } from "ori";

import { GOOGLE_WORKSPACE_PROMPT } from "./src/prompt.ts";

export const prompt: PromptExport = () => GOOGLE_WORKSPACE_PROMPT;
