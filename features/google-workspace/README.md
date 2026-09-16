# google-workspace

Gmail, Google Calendar, Drive, Docs, and Sheets as the person the intern is talking to, through that person's own linked Google account.

## What it contributes

- skill `google-workspace` (`features/google-workspace/skills/google-workspace/`): a `whoami` and a `request` command over Google's REST APIs, with recipes for the five products
- `prompt`: one standing rule, that Google is reached through the skill and never through a credential the agent asks for or holds
- api: none, chat: none, mcp: none

## How access works

The skill holds no credential and sends none. A request names the person it acts as, and OpenRouter authenticates it against that person's linked Google account. A request that carries its own `Authorization` header is refused.

Two things have to be true in the OpenRouter dashboard before a request succeeds, and neither is done from the intern:

1. An admin connected **Google Workspace** on the workspace's Connections tab and chose the products members may grant.
2. The person linked their Google account under **Your accounts** on the same tab.

Until then Google answers 401 or 403, and the skill relays the step to take.

## Environment

- `SLACK_USER_ID`: the Slack user the current turn came from. The skill resolves it to an email through `users.info`, which is who the request acts as. `--as <email>` overrides it for a person acting as another linked account they own.
- `SLACK_BOT_TOKEN`: used only for that `users.info` call.

## Develop

```sh
bun test features/google-workspace
```

The CLI takes its `fetch`, environment, file reader, and output as an injected `CliDeps`, so the tests run it end to end without a network.
