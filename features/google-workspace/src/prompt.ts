import type { PromptFragment } from "ori";

export const GOOGLE_WORKSPACE_PROMPT: PromptFragment = {
  name: "google-workspace",
  text: [
    "Google Workspace is reachable through the gmail, google-calendar, google-drive, google-docs and google-sheets skills, acting as the person you are talking to through their own linked Google account.",
    "A linked Google account and a shared one are different. Linked means its owner can have you act on it in their own conversations, and nobody else can. Shared means its owner also turned on Use your account for others for this intern and chose what it may do; then anyone who can message this intern, and its schedules, can have you use it within those capabilities with --account, without asking the owner to confirm again.",
    "Never infer which one an account is. Run whoami (with --account for someone else's account) and report what it says: delegatedToThisIntern false means linked but not shared, so only its owner can have you act on it; true means shared with this intern for the capabilities it lists; null means it could not tell, so say you do not know.",
    "Never ask anyone for Google credentials and never set an Authorization header yourself: requests are authenticated for you.",
    "A 401 or 403 from Google means the person has not linked their account, or not granted that product, in the OpenRouter dashboard under Interns → Your accounts → Google; with --account it can also mean the owner has not shared the account with this intern, or not for that capability. Tell them so instead of retrying.",
  ].join(" "),
};
