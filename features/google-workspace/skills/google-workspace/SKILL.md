---
name: google-workspace
description: Read and act on Gmail, Google Calendar, Drive, Docs, and Sheets as the person you are talking to, through their own linked Google account. TRIGGER when the user asks about their email, inbox, drafts, calendar, meetings, availability, or a Google Doc, Sheet, or Drive file ("what's my next meeting", "find the email from X", "read this doc", "add a row to the sheet", "draft a reply"). DO NOT TRIGGER for a different mail or calendar provider, or when the request is about someone else's account.
---

# Google Workspace

Calls Google's REST APIs as the person you are talking to, through their own linked Google account. Authentication is handled for you: you never hold, request, or send a credential. You only say who you act as.

## Prerequisites

Both are done in the OpenRouter dashboard, not here. If either is missing the request fails with 401 or 403; relay the message below rather than retrying.

- An admin connected **Google Workspace** on the workspace's Connections tab and chose the products members may grant.
- The person linked their Google account under **Your accounts** on the same tab. Tell them: "Link your Google account under Your accounts on the Interns page, then ask me again."

## Usage

```bash
bun features/google-workspace/skills/google-workspace/scripts/cli.ts help
bun features/google-workspace/skills/google-workspace/scripts/cli.ts whoami                                 # the account you act as
bun features/google-workspace/skills/google-workspace/scripts/cli.ts request GET <googleapis url>
bun features/google-workspace/skills/google-workspace/scripts/cli.ts request POST <googleapis url> --json '<body>'
bun features/google-workspace/skills/google-workspace/scripts/cli.ts request PUT <googleapis url> --json @/path/to/body.json
```

`request` accepts `https://*.googleapis.com` URLs only. It acts as the Slack user the conversation came from (`$SLACK_USER_ID`, resolved to their email); pass `--as someone@example.com` only when the user explicitly asks you to act as a different linked account they own. Never add an `Authorization` header or any other credential: the request is authenticated for you, and one that carries its own credential is refused.

## Recipes

Gmail (API base `https://gmail.googleapis.com/gmail/v1/users/me`):

```bash
# search threads, then read one
bun features/google-workspace/skills/google-workspace/scripts/cli.ts request GET 'https://gmail.googleapis.com/gmail/v1/users/me/threads?q=from:alice%20newer_than:7d&maxResults=10'
bun features/google-workspace/skills/google-workspace/scripts/cli.ts request GET 'https://gmail.googleapis.com/gmail/v1/users/me/threads/THREAD_ID?format=full'
# create a draft (raw = base64url RFC 822 message)
bun features/google-workspace/skills/google-workspace/scripts/cli.ts request POST https://gmail.googleapis.com/gmail/v1/users/me/drafts --json '{"message":{"raw":"..."}}'
```

Calendar (API base `https://www.googleapis.com/calendar/v3`):

```bash
bun features/google-workspace/skills/google-workspace/scripts/cli.ts request GET 'https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=2026-09-15T00:00:00Z&timeMax=2026-09-16T00:00:00Z&singleEvents=true&orderBy=startTime'
bun features/google-workspace/skills/google-workspace/scripts/cli.ts request POST https://www.googleapis.com/calendar/v3/freeBusy --json '{"timeMin":"...","timeMax":"...","items":[{"id":"primary"},{"id":"bob@example.com"}]}'
bun features/google-workspace/skills/google-workspace/scripts/cli.ts request POST 'https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all' --json '{"summary":"...","start":{"dateTime":"..."},"end":{"dateTime":"..."},"attendees":[{"email":"..."}]}'
```

Drive, Docs, Sheets:

```bash
bun features/google-workspace/skills/google-workspace/scripts/cli.ts request GET 'https://www.googleapis.com/drive/v3/files?q=name%20contains%20%27invoice%27&pageSize=20&fields=files(id,name,mimeType,modifiedTime)'
bun features/google-workspace/skills/google-workspace/scripts/cli.ts request GET 'https://www.googleapis.com/drive/v3/files/FILE_ID/export?mimeType=text/plain'
bun features/google-workspace/skills/google-workspace/scripts/cli.ts request GET https://docs.googleapis.com/v1/documents/DOC_ID
bun features/google-workspace/skills/google-workspace/scripts/cli.ts request GET 'https://sheets.googleapis.com/v4/spreadsheets/SHEET_ID/values/Sheet1!A1:Z50'
bun features/google-workspace/skills/google-workspace/scripts/cli.ts request POST 'https://sheets.googleapis.com/v4/spreadsheets/SHEET_ID/values/Sheet1!A1:append?valueInputOption=USER_ENTERED' --json '{"values":[["a","b"]]}'
```

## Procedure

1. Run `whoami` once per conversation if you are unsure whose account you act as.
2. Run the `request` for the task. Exit 0 prints the JSON body; relay the parts the user asked for.
3. Exit 1 prints the status and Google's error on stderr. 401 or 403 means the person has not linked their account or did not grant that product: relay the prerequisite message. Anything else: report Google's error as is.

## Notes

- Availability across several people: always call `freeBusy` for every participant before proposing times.
- Prefer read-only endpoints unless the user asked for a change. Creating events, drafts, or sheet rows is fine when asked; sending mail on someone's behalf needs their explicit go-ahead in the same conversation.
