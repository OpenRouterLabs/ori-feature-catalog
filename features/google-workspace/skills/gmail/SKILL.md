---
name: gmail
description: Read, search, draft, and (with explicit go-ahead) send Gmail as the person you are talking to, through their own linked Google account. TRIGGER when the user asks about their email, inbox, unread mail, a message or thread from someone, drafts, or wants a reply written or sent ("find the email from X", "what's in my inbox", "draft a reply", "send this to Y"). DO NOT TRIGGER for calendar invites (google-calendar), for attachments as files (google-drive), for another mail provider, or when the request is about someone else's mailbox.
---

# Gmail

Calls the Gmail API as the person you are talking to. Authentication is handled for you: you never hold, request, or send a credential. You only say who you act as. The other Google apps have their own skills (google-calendar, google-drive, google-docs, google-sheets); they all share this command.

## Prerequisites

Both are done in the OpenRouter dashboard, not here. If either is missing the request fails with 401 or 403; relay the message below rather than retrying.

- An admin connected **Google Workspace** on the workspace's Connections tab and included Gmail in the products members may grant.
- The person linked their Google account under **Your accounts** on the same tab. Tell them: "Link your Google account under Your accounts on the Interns page, then ask me again."

## Usage

```bash
bun features/google-workspace/src/cli.ts whoami                                   # the account you act as
bun features/google-workspace/src/cli.ts request GET <gmail url>
bun features/google-workspace/src/cli.ts request POST <gmail url> --json '<body>'
```

`request` accepts `https://*.googleapis.com` URLs only. It acts as the Slack user the conversation came from (`$SLACK_USER_ID`, resolved to their email); pass `--as someone@example.com` only when the user explicitly asks you to act as a different linked account they own. Never add an `Authorization` header or any other credential: the request is authenticated for you, and one that carries its own credential is refused.

API base: `https://gmail.googleapis.com/gmail/v1/users/me`. A read-only grant allows only the GET calls; the rest answer 403.

## Recipes

Find and read mail:

```bash
# labels (INBOX, UNREAD, STARRED, and the person's own)
bun features/google-workspace/src/cli.ts request GET https://gmail.googleapis.com/gmail/v1/users/me/labels
# search threads with Gmail's own query syntax, newest first
bun features/google-workspace/src/cli.ts request GET 'https://gmail.googleapis.com/gmail/v1/users/me/threads?q=from:alice%20newer_than:7d%20is:unread&maxResults=10'
# one thread, every message in full
bun features/google-workspace/src/cli.ts request GET 'https://gmail.googleapis.com/gmail/v1/users/me/threads/THREAD_ID?format=full'
# one message, headers only, when the body is not needed
bun features/google-workspace/src/cli.ts request GET 'https://gmail.googleapis.com/gmail/v1/users/me/messages/MESSAGE_ID?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date'
```

Message bodies come back base64url-encoded in `payload.parts[].body.data`; decode with `base64 -d` after turning `-_` back into `+/`.

Write mail. The `raw` field is a base64url-encoded RFC 822 message:

```bash
RAW=$(printf 'To: bob@example.com\r\nSubject: Q3 numbers\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nHi Bob,\r\n...' | base64 | tr '+/' '-_' | tr -d '=\n')
# a draft the person can review in Gmail
bun features/google-workspace/src/cli.ts request POST https://gmail.googleapis.com/gmail/v1/users/me/drafts --json "{\"message\":{\"raw\":\"$RAW\"}}"
# a reply draft that stays in its thread: add In-Reply-To and References headers with the original Message-ID, and the threadId
bun features/google-workspace/src/cli.ts request POST https://gmail.googleapis.com/gmail/v1/users/me/drafts --json "{\"message\":{\"raw\":\"$RAW\",\"threadId\":\"THREAD_ID\"}}"
# send, only with the person's explicit go-ahead in this conversation
bun features/google-workspace/src/cli.ts request POST https://gmail.googleapis.com/gmail/v1/users/me/messages/send --json "{\"raw\":\"$RAW\"}"
```

Triage:

```bash
# mark read / archive (remove from the inbox) / star
bun features/google-workspace/src/cli.ts request POST https://gmail.googleapis.com/gmail/v1/users/me/messages/MESSAGE_ID/modify --json '{"removeLabelIds":["UNREAD"]}'
bun features/google-workspace/src/cli.ts request POST https://gmail.googleapis.com/gmail/v1/users/me/messages/MESSAGE_ID/modify --json '{"removeLabelIds":["INBOX"]}'
bun features/google-workspace/src/cli.ts request POST https://gmail.googleapis.com/gmail/v1/users/me/messages/MESSAGE_ID/modify --json '{"addLabelIds":["STARRED"]}'
```

## Procedure

1. Run `whoami` once per conversation if you are unsure whose mailbox you act on.
2. Search, then read only the threads the task needs; relay the parts the user asked for, not whole mailboxes.
3. Exit 1 prints the status and Google's error on stderr. 401 or 403 means the person has not linked their account or did not grant Gmail: relay the prerequisite message. Anything else: report Google's error as is.

## Notes

- Prefer a draft over sending. Sending mail on someone's behalf needs their explicit go-ahead in the same conversation, and the recipients and text should be shown to them first.
- Never move anything to Trash or delete it unless asked to, and say what you did.
