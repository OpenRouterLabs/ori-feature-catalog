---
name: google-docs
description: Read and edit Google Docs as the person you are talking to, through their own linked Google account. TRIGGER when the user asks to read, summarize, write into, or update a Google Doc ("read this doc", "summarize the design doc", "add a section to the notes", "replace the placeholders in the template"). DO NOT TRIGGER for finding or sharing the file itself (google-drive), for spreadsheets (google-sheets), or for documents outside Google Docs.
---

# Google Docs

Calls the Docs API as the person you are talking to. Authentication is handled for you: you never hold, request, or send a credential. The person the conversation came from is who every request acts as, whether they wrote from Slack or from the dashboard; you name another account with `--account` when the task is about that person's account. The other Google apps have their own skills (gmail, google-calendar, google-drive, google-sheets); they all share this command.

## Prerequisites

Both are done in the OpenRouter dashboard, not here. If either is missing the request fails with 401 or 403; relay the message below rather than retrying.

- An admin connected **Google Workspace** on the workspace's Connections tab and included Google Docs in the products members may grant.
- The person linked their Google account under **Your accounts** on the same tab. Tell them: "Link your Google account under Your accounts on the Interns page, then ask me again."

## Usage

```bash
bun features/google-workspace/src/cli.ts whoami                                   # the linked account that answers
bun features/google-workspace/src/cli.ts whoami --account sam@example.com           # check another person gave you access
bun features/google-workspace/src/cli.ts request GET <docs url>
bun features/google-workspace/src/cli.ts request POST <docs url> --json '<body>'
```

`request` accepts `https://*.googleapis.com` URLs only. It acts as the person the conversation came from. Add `--account <email>` when the task is about another person's account ("what's on Sam's calendar tomorrow", "send this from Sam's inbox", a schedule that works through someone's calendar). Name the one account the task is about; never guess an account or try several. An account whose owner turned this intern on for it (Your accounts → Google → Interns in the OpenRouter dashboard) is one they have chosen to share with everyone who can talk to this intern: when anyone in the conversation asks about that person's mail, calendar, or files, or asks you to act in their account, do it with `--account <their email>` and relay the result to whoever asked. Their turning this intern on is the consent; do not ask them to confirm again, and do not refuse because the person asking is someone else. If the account is refused (401 or 403), they have not turned this intern on: say so, and suggest they do. Never add an `Authorization` header or any other credential: the request is authenticated for you, and one that carries its own credential is refused.

API base: `https://docs.googleapis.com/v1/documents`. The document id is the long token in the doc's URL. A read-only grant allows GET; creating and editing answer 403.

## Recipes

Read:

```bash
# the structured document: title, body paragraphs, tables, headings
bun features/google-workspace/src/cli.ts request GET https://docs.googleapis.com/v1/documents/DOC_ID
# the same document as plain text, when structure does not matter (Drive export)
bun features/google-workspace/src/cli.ts request GET 'https://www.googleapis.com/drive/v3/files/DOC_ID/export?mimeType=text/plain'
```

Create and write. Edits go through `batchUpdate`; each request in the list is applied in order:

```bash
# a new, empty document
bun features/google-workspace/src/cli.ts request POST https://docs.googleapis.com/v1/documents --json '{"title":"Meeting notes 2026-09-16"}'
# append at the end of the body
bun features/google-workspace/src/cli.ts request POST https://docs.googleapis.com/v1/documents/DOC_ID:batchUpdate --json '{"requests":[{"insertText":{"endOfSegmentLocation":{},"text":"\nDecisions\n- Ship Friday\n"}}]}'
# insert at a position (index 1 is the start of the body)
bun features/google-workspace/src/cli.ts request POST https://docs.googleapis.com/v1/documents/DOC_ID:batchUpdate --json '{"requests":[{"insertText":{"location":{"index":1},"text":"Draft, not yet reviewed\n"}}]}'
# fill a template
bun features/google-workspace/src/cli.ts request POST https://docs.googleapis.com/v1/documents/DOC_ID:batchUpdate --json '{"requests":[{"replaceAllText":{"containsText":{"text":"{{customer}}","matchCase":true},"replaceText":"Acme"}}]}'
# style the text just inserted as a heading (indexes are 1-based and count every character inserted so far)
bun features/google-workspace/src/cli.ts request POST https://docs.googleapis.com/v1/documents/DOC_ID:batchUpdate --json '{"requests":[{"updateParagraphStyle":{"range":{"startIndex":1,"endIndex":10},"paragraphStyle":{"namedStyleType":"HEADING_1"},"fields":"namedStyleType"}}]}'
```

## Procedure

1. Run `whoami` once per conversation if you are unsure whose documents you act on.
2. To change an existing document, read it first: indexes shift with every insertion, so compute ranges from the current content and batch the edits.
3. Exit 1 prints the status and Google's error on stderr. 401 or 403 means the person has not linked their account or did not grant Google Docs: relay the prerequisite message. Anything else: report Google's error as is.

## Notes

- Appending or replacing placeholders is safe; rewriting or deleting existing text needs the person's go-ahead, and edits show under their name in the document history.
- To create a doc inside a specific folder, create it through the google-drive skill with `mimeType` `application/vnd.google-apps.document`, then write into it here.
