# github-access

How an agent reaches GitHub, and how it enumerates every repository the connection can read.

## What it contributes

- `prompt`: one standing rule — GitHub is read through the shell with the credential the egress proxy attaches, never through a credential the agent asks for or holds, and repo discovery is the union of the installation list and a crawl of every readable org, not the installation list alone
- api: none, chat: none, mcp: none, command: none, skill: none

## How access works

The agent's outbound HTTPS goes through an egress proxy that attaches the workspace's GitHub credential to `api.github.com` and `codeload.github.com` requests automatically. The machine holds no local GitHub credentials by design, so missing local tooling (`gh`, tokens, SSH keys) says nothing about access.

Requests act as the workspace's GitHub App. A request carrying `x-openrouter-github-as: member` acts as the person who opened the conversation, from their linked GitHub account, and only as them; a 401 there means the link is missing or expired, and the agent says so instead of retrying.

## Repo discovery

`/installation/repositories` lists only the repos the App installation selected directly; repos reachable through org grants stay invisible to it. So discovery is: list the installation, crawl `GET /orgs/{org}/repos?type=all&per_page=100` (following `Link` headers) for each org the connection can read, union both, de-duplicate by `full_name`, and fall back to a direct `GET /repos/{owner}/{repo}` before concluding a repo does not exist.

## Develop

```sh
bun test features/github-access
```

The prompt contribution is pure data; its test asserts the standing rule is present and whole.