# google-workspace

Gmail, Google Calendar, Drive, Docs, and Sheets as the person the intern is talking to, through that person's own linked Google account.

## What it contributes

- five skills, one per Google app, each with its own triggers and recipes: `gmail`, `google-calendar`, `google-drive`, `google-docs`, `google-sheets`
- one shared command behind them, `src/cli.ts`: `whoami` says which linked account answers, and `request <GET|POST|PUT|PATCH|DELETE> <https://*.googleapis.com/...> [--json <body>|@file]` calls Google's REST APIs
- `prompt`: one standing rule, that Google is reached through those skills and never through a credential the agent asks for or holds
- api: none, chat: none, mcp: none

## How access works

The skills hold no credential and send none, and they choose no account. OpenRouter authenticates each request as the person the conversation came from, whether they wrote from Slack or from the dashboard, against that person's own linked Google account. There is no way to act as anyone else from the intern; a request that carries its own `Authorization` header is refused.

Two things have to be true in the OpenRouter dashboard before a request succeeds, and neither is done from the intern:

1. An admin connected **Google Workspace** on the workspace's Connections tab and chose the products members may grant.
2. The person linked their Google account under **Your accounts** on the same tab.

Until then Google answers 401 or 403, and every skill relays the step to take. A product the admin left out, or the person granted read-only, answers 403 on the calls it does not cover.

## Environment

Nothing is required. When a turn came from Slack, `SLACK_USER_ID` and `SLACK_BOT_TOKEN` let the command note the Slack user's email on the request through `users.info`; a turn from the dashboard has neither and is attributed all the same.

## Develop

```sh
bun test features/google-workspace
```

The command takes its `fetch`, environment, file reader, and output as an injected `CliDeps`, so the tests run it end to end without a network.
