/**
 * feature.ts — the GitHub Access feature's contribution entry.
 *
 * The feature contributes one standing prompt: how the agent reads GitHub,
 * and how it enumerates every repository the connection can read. No
 * command or skill: GitHub is reached through the shell with the
 * credential the egress proxy attaches, never through a credential the
 * agent asks for or holds.
 */

import type { PromptExport, PromptFragment } from "ori";

export const GITHUB_ACCESS_PROMPT: PromptFragment = {
  name: "github-access",
  text: [
    "GitHub is available from the shell. Outbound HTTPS goes through an egress proxy that attaches this workspace's GitHub credential to api.github.com and codeload.github.com requests automatically. This machine holds no local GitHub credentials by design; missing local tooling (gh, tokens, SSH keys) says nothing about your access.",
    "Source on GitHub is the primary evidence for how a system works. When a question touches code, architecture, configuration, or what changed, read the repository before answering. Issue trackers, docs, and chat describe intent; the repository shows what shipped.",
    "Read a file: curl -sL -H 'Accept: application/vnd.github.raw' https://api.github.com/repos/{owner}/{repo}/contents/{path}?ref={ref}. Get a whole tree to grep: mkdir -p {dir} && curl -sL https://api.github.com/repos/{owner}/{repo}/tarball/{ref} | tar xz -C {dir}. Use /search/code, /pulls, and /commits for the rest.",
    "Typical grants when GitHub is connected: repository read and pull request write. Creating branches or commits, and cloning over git, are usually not available; work through the REST API.",
    "To find out whether you can act on a repository, call the GitHub REST API and check the result. When a user asks about GitHub capabilities, verify via the API first, then answer in plain terms without describing this plumbing.",
    "To find every repository this connection can read, never trust one endpoint alone. /installation/repositories only lists repos the GitHub App installation selected directly; it silently omits repos reachable through org grants, so a repo can be fully readable yet invisible there. Crawl org endpoints too: GET /orgs/{org}/repos?type=all&per_page=100 (follow Link headers on pagination) for each org the connection can read, then union the results with the installation list and de-duplicate by full_name. When a user asks about a repo by name and it is not in the union, try GET /repos/{owner}/{repo} directly before concluding it does not exist; a 404 from a listing only means the listing is incomplete.",
    "Requests act as the workspace's GitHub App unless the person asks for something under their own name, such as a pull request or a comment authored as them. For that, add the header x-openrouter-github-as: member to the request, which authenticates it as the person who opened the conversation, from their linked GitHub account. It never authenticates as anyone else, and it works only for the person asking. A 401 on such a request means their linked identity could not complete it: they may not have linked a GitHub account in the dashboard, their link may have expired, or they may have asked from a place that cannot vouch for who they are. Say the request could not be made under their name, suggest checking their GitHub link in the dashboard, and offer to do it as the App instead.",
  ].join(" "),
};

export const prompt: PromptExport = () => GITHUB_ACCESS_PROMPT;