---
name: google-sheets
description: Read and update Google Sheets as the person you are talking to, through their own linked Google account. TRIGGER when the user asks about a spreadsheet, a tab, a range, or wants rows added or cells changed ("what's in the budget sheet", "add a row to the tracker", "update the status column", "total the Q3 tab"). DO NOT TRIGGER for finding or sharing the file itself (google-drive), for documents (google-docs), or for spreadsheets outside Google Sheets.
---

# Google Sheets

Calls the Sheets API as the person you are talking to. Authentication is handled for you: you never hold, request, or send a credential. The person the conversation came from is who every request acts as, whether they wrote from Slack or from the dashboard; you name another account with `--account` when the task is about that person's account. The other Google apps have their own skills (gmail, google-calendar, google-drive, google-docs); they all share this command.

## Prerequisites

Both are done in the OpenRouter dashboard, not here. If either is missing the request fails with 401 or 403; relay the message below rather than retrying.

- An admin connected **Google Workspace** on the workspace's Connections tab and included Google Sheets in the products members may grant.
- The person linked their Google account under **Your accounts** on the same tab. Tell them: "Link your Google account under Your accounts on the Interns page, then ask me again."

## Usage

```bash
bun features/google-workspace/src/cli.ts whoami                                   # the linked account that answers
bun features/google-workspace/src/cli.ts whoami --account sam@example.com           # check another person gave you access
bun features/google-workspace/src/cli.ts request GET <sheets url>
bun features/google-workspace/src/cli.ts request POST <sheets url> --json '<body>'
```

`request` accepts `https://*.googleapis.com` URLs only. It acts as the person the conversation came from. Add `--account <email>` when the task is about another person's account ("what's on Sam's calendar tomorrow", "send this from Sam's inbox", a schedule that works through someone's calendar). Name the one account the task is about; never guess an account or try several. An account whose owner turned this intern on for it (Your accounts → Google → Interns in the OpenRouter dashboard) is one they have chosen to share with everyone who can talk to this intern: when anyone in the conversation asks about that person's mail, calendar, or files, or asks you to act in their account, do it with `--account <their email>` and relay the result to whoever asked. Their turning this intern on is the consent; do not ask them to confirm again, and do not refuse because the person asking is someone else. If the account is refused (401 or 403), they have not turned this intern on: say so, and suggest they do. Never add an `Authorization` header or any other credential: the request is authenticated for you, and one that carries its own credential is refused.

API base: `https://sheets.googleapis.com/v4/spreadsheets`. The spreadsheet id is the long token in the sheet's URL. Ranges use A1 notation, `Tab!A1:C10`; a tab name with spaces is quoted and URL-encoded, `'Q3%20plan'!A1:C10`. A read-only grant allows GET; appending, updating, and clearing answer 403.

## Recipes

Read:

```bash
# the tabs, with their sizes
bun features/google-workspace/src/cli.ts request GET 'https://sheets.googleapis.com/v4/spreadsheets/SHEET_ID?fields=properties.title,sheets.properties(sheetId,title,gridProperties)'
# a range; values come back as rows of strings
bun features/google-workspace/src/cli.ts request GET 'https://sheets.googleapis.com/v4/spreadsheets/SHEET_ID/values/Sheet1!A1:F50'
# several ranges in one call
bun features/google-workspace/src/cli.ts request GET 'https://sheets.googleapis.com/v4/spreadsheets/SHEET_ID/values:batchGet?ranges=Sheet1!A1:B10&ranges=Totals!A1:C3'
```

Write. `USER_ENTERED` parses input like typing into a cell (numbers, dates, formulas); `RAW` stores strings verbatim:

```bash
# append rows below the table that starts at A1
bun features/google-workspace/src/cli.ts request POST 'https://sheets.googleapis.com/v4/spreadsheets/SHEET_ID/values/Sheet1!A1:append?valueInputOption=USER_ENTERED' --json '{"values":[["2026-09-16","Acme","1200","open"]]}'
# overwrite a range
bun features/google-workspace/src/cli.ts request PUT 'https://sheets.googleapis.com/v4/spreadsheets/SHEET_ID/values/Sheet1!D2:D2?valueInputOption=USER_ENTERED' --json '{"values":[["closed"]]}'
# clear a range
bun features/google-workspace/src/cli.ts request POST 'https://sheets.googleapis.com/v4/spreadsheets/SHEET_ID/values/Sheet1!A2:F100:clear' --json '{}'
# add a tab
bun features/google-workspace/src/cli.ts request POST https://sheets.googleapis.com/v4/spreadsheets/SHEET_ID:batchUpdate --json '{"requests":[{"addSheet":{"properties":{"title":"Q4"}}}]}'
# a new spreadsheet
bun features/google-workspace/src/cli.ts request POST https://sheets.googleapis.com/v4/spreadsheets --json '{"properties":{"title":"Vendor tracker"}}'
```

## Procedure

1. Run `whoami` once per conversation if you are unsure whose spreadsheets you act on.
2. Read the header row before writing so columns line up, and read back the range after a write when the person will rely on it.
3. Exit 1 prints the status and Google's error on stderr. 401 or 403 means the person has not linked their account or did not grant Google Sheets: relay the prerequisite message. Anything else: report Google's error as is.

## Notes

- Appending is safe; overwriting or clearing existing cells needs the person's go-ahead, and edits show under their name in the version history.
- To create a spreadsheet inside a specific folder, create it through the google-drive skill with `mimeType` `application/vnd.google-apps.spreadsheet`, then fill it here.
