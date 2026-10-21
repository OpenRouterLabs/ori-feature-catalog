---
name: google-sheets
description: Read and update Google Sheets as the person you are talking to, through their own linked Google account. TRIGGER when the user asks about a spreadsheet, a tab, a range, or wants rows added or cells changed ("what's in the budget sheet", "add a row to the tracker", "update the status column", "total the Q3 tab"). DO NOT TRIGGER for finding or sharing the file itself (google-drive), for documents (google-docs), or for spreadsheets outside Google Sheets.
---

# Google Sheets

Calls the Sheets API as the person you are talking to. Authentication is handled for you: you never hold, request, or send a credential. The person the conversation came from is who every request acts as, whether they wrote from Slack or from the dashboard; you name another account with `--account` when the task is about that person's account. The other Google apps have their own skills (gmail, google-calendar, google-drive, google-docs); they all share this command.

## Prerequisites

Both are done in the OpenRouter dashboard, not here. If either is missing the request fails with 401 or 403; relay the message below rather than retrying.

- An admin connected **Google Workspace** in the OpenRouter dashboard under Interns → **Shared connections** and included Google Sheets in the products members may grant.
- The person linked their Google account in the OpenRouter dashboard under Interns → **Your accounts** → Google. Tell them: "Link your Google account in the OpenRouter dashboard under Interns → Your accounts → Google, then ask me again."

## Usage

```bash
bun features/google-workspace/src/cli.ts whoami                                   # the linked account that answers
bun features/google-workspace/src/cli.ts whoami --account sam@example.com           # check another person shared it with you
bun features/google-workspace/src/cli.ts request GET <sheets url>
bun features/google-workspace/src/cli.ts request POST <sheets url> --json '<body>'
```

`whoami` prints `{"account", "delegatedToThisIntern", "capabilities"}`. `delegatedToThisIntern: false` means the account is linked but not shared: only its owner can have you act on it. `true` means it is shared with this intern for others, for the `capabilities` listed (for example `gmail.read`, `calendar.edit`). `null` means it could not tell; say you do not know rather than guessing.

`request` accepts `https://*.googleapis.com` URLs only. It acts as the person the conversation came from. Add `--account <email>` when the task is about another person's account ("what's on Sam's calendar tomorrow", "send this from Sam's inbox", a schedule that works through someone's calendar). Name the one account the task is about; never guess an account or try several. A linked account is not a shared one. Linked means its owner can have you act on it in their own conversations, and nobody else can. Shared means its owner also turned on **Use your account for others** for this intern and ticked what it may do; then anyone who can message this intern, and its schedules, can have you use it within those capabilities, with `--account <their email>`, without asking the owner to confirm again. Never assume which one an account is: `whoami` (with `--account` for someone else's) says. If someone asks about another person's account and it is not shared with this intern, or not for what they asked, say so: only its owner can share it, in the OpenRouter dashboard under Interns → Your accounts → Google → Interns. Never add an `Authorization` header or any other credential: the request is authenticated for you, and one that carries its own credential is refused.

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
