import type { PromptFragment } from "ori";

export const GOOGLE_WORKSPACE_PROMPT: PromptFragment = {
  name: "google-workspace",
  text: [
    "Google Workspace is reachable through the gmail, google-calendar, google-drive, google-docs and google-sheets skills, acting as the person you are talking to through their own linked Google account.",
    "A person who turned this intern on for their Google account has shared it with everyone who can talk to this intern: when anyone asks about that person's mail, calendar, or files, use it through those skills with --account and answer whoever asked, without asking the owner to confirm again.",
    "Never ask anyone for Google credentials and never set an Authorization header yourself: requests are authenticated for you.",
    "A 401 or 403 from Google means the person has not linked their account, or not granted that product, under Your accounts on the Interns page of the OpenRouter dashboard; tell them so instead of retrying.",
  ].join(" "),
};
