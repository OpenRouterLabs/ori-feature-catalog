---
name: google-drive
description: Find, read, organize, and share files in Google Drive as the person you are talking to, through their own linked Google account. TRIGGER when the user asks about a file, folder, or shared drive ("find the invoice PDF", "what's in the Q3 folder", "share this with Bob", "export that doc as text"). DO NOT TRIGGER for editing the contents of a Doc (google-docs) or a Sheet (google-sheets), for email attachments still in Gmail (gmail), or for files neither the person nor an account they name through `--account` can reach.
---

# Google Drive

Calls the Drive API as the person you are talking to. Authentication is handled for you: you never hold, request, or send a credential. The person the conversation came from is who every request acts as, whether they wrote from Slack or from the dashboard; you name another account with `--account` when the task is about that person's account. The other Google apps have their own skills (gmail, google-calendar, google-docs, google-sheets); they all share this command.

## Prerequisites

Both are done in the OpenRouter dashboard, not here. If either is missing the request fails with 401 or 403; relay the message below rather than retrying.

- An admin connected **Google Workspace** in the OpenRouter dashboard under Interns → **Shared connections** and included Google Drive in the products members may grant.
- The person linked their Google account in the OpenRouter dashboard under Interns → **Your accounts** → Google. Tell them: "Link your Google account in the OpenRouter dashboard under Interns → Your accounts → Google, then ask me again."

## Usage

```bash
bun features/google-workspace/src/cli.ts whoami                                   # the linked account that answers
bun features/google-workspace/src/cli.ts whoami --account sam@example.com           # check another person shared it with you
bun features/google-workspace/src/cli.ts request GET <drive url>
bun features/google-workspace/src/cli.ts request POST <drive url> --json '<body>'
```

`whoami` prints `{"account", "delegatedToThisIntern", "capabilities"}`. `delegatedToThisIntern: false` means the account is linked but not shared: only its owner can have you act on it. `true` means it is shared with this intern for others, for the `capabilities` listed (for example `gmail.read`, `calendar.edit`). `null` means it could not tell; say you do not know rather than guessing.

`request` accepts `https://*.googleapis.com` URLs only. It acts as the person the conversation came from. Add `--account <email>` when the task is about another person's account ("what's on Sam's calendar tomorrow", "send this from Sam's inbox", a schedule that works through someone's calendar). Name the one account the task is about; never guess an account or try several. A linked account is not a shared one. Linked means its owner can have you act on it in their own conversations, and nobody else can. Shared means its owner also turned on **Use your account for others** for this intern and ticked what it may do; then anyone who can message this intern, and its schedules, can have you use it within those capabilities, with `--account <their email>`, without asking the owner to confirm again. Never assume which one an account is: `whoami` (with `--account` for someone else's) says. If someone asks about another person's account and it is not shared with this intern, or not for what they asked, say so: only its owner can share it, in the OpenRouter dashboard under Interns → Your accounts → Google → Interns. Never add an `Authorization` header or any other credential: the request is authenticated for you, and one that carries its own credential is refused.

API base: `https://www.googleapis.com/drive/v3`. A read-only grant allows searching, reading, and exporting; creating, moving, and sharing answer 403.

## Recipes

Find files. Ask for the fields you need, and include shared drives when the person works in them:

```bash
# by name
bun features/google-workspace/src/cli.ts request GET 'https://www.googleapis.com/drive/v3/files?q=name%20contains%20%27invoice%27%20and%20trashed%3Dfalse&pageSize=20&fields=files(id,name,mimeType,modifiedTime,webViewLink,owners(emailAddress))&supportsAllDrives=true&includeItemsFromAllDrives=true'
# by content, recent first
bun features/google-workspace/src/cli.ts request GET 'https://www.googleapis.com/drive/v3/files?q=fullText%20contains%20%27roadmap%27&orderBy=modifiedTime%20desc&pageSize=10&fields=files(id,name,mimeType,modifiedTime,webViewLink)'
# a folder's contents
bun features/google-workspace/src/cli.ts request GET 'https://www.googleapis.com/drive/v3/files?q=%27FOLDER_ID%27%20in%20parents%20and%20trashed%3Dfalse&fields=files(id,name,mimeType,modifiedTime)'
# one file's details
bun features/google-workspace/src/cli.ts request GET 'https://www.googleapis.com/drive/v3/files/FILE_ID?fields=id,name,mimeType,size,modifiedTime,webViewLink,parents,owners(emailAddress)&supportsAllDrives=true'
```

Read contents. Google Docs, Sheets, and Slides are exported; other files are downloaded:

```bash
bun features/google-workspace/src/cli.ts request GET 'https://www.googleapis.com/drive/v3/files/FILE_ID/export?mimeType=text/plain'      # a Doc as text
bun features/google-workspace/src/cli.ts request GET 'https://www.googleapis.com/drive/v3/files/FILE_ID/export?mimeType=text/csv'        # a Sheet's first tab as CSV
bun features/google-workspace/src/cli.ts request GET 'https://www.googleapis.com/drive/v3/files/FILE_ID?alt=media'                       # a text file's bytes
```

The command prints the body as text, so export to a text format rather than downloading a PDF or an image.

Organize and share:

```bash
# a folder
bun features/google-workspace/src/cli.ts request POST https://www.googleapis.com/drive/v3/files --json '{"name":"Q3 review","mimeType":"application/vnd.google-apps.folder","parents":["PARENT_FOLDER_ID"]}'
# an empty Google Doc or Sheet, to fill with the google-docs or google-sheets skill
bun features/google-workspace/src/cli.ts request POST https://www.googleapis.com/drive/v3/files --json '{"name":"Meeting notes","mimeType":"application/vnd.google-apps.document","parents":["PARENT_FOLDER_ID"]}'
# move
bun features/google-workspace/src/cli.ts request PATCH 'https://www.googleapis.com/drive/v3/files/FILE_ID?addParents=NEW_FOLDER_ID&removeParents=OLD_FOLDER_ID'
# rename
bun features/google-workspace/src/cli.ts request PATCH https://www.googleapis.com/drive/v3/files/FILE_ID --json '{"name":"Q3 review (final)"}'
# share with a person, quietly
bun features/google-workspace/src/cli.ts request POST 'https://www.googleapis.com/drive/v3/files/FILE_ID/permissions?sendNotificationEmail=false' --json '{"role":"reader","type":"user","emailAddress":"bob@example.com"}'
```

The command sends JSON bodies only, so it cannot upload file contents; create Google files and fill them with the Docs or Sheets skill instead.

## Procedure

1. Run `whoami` once per conversation if you are unsure whose Drive you act on.
2. Search first and confirm the file with the person when several match; relay the `webViewLink` so they can open it.
3. Exit 1 prints the status and Google's error on stderr. 401 or 403 means the person has not linked their account or did not grant Google Drive: relay the prerequisite message. Anything else: report Google's error as is.

## Notes

- Sharing widens who can see a file: confirm the recipient and the role (`reader`, `commenter`, `writer`) with the person first, and prefer `sendNotificationEmail=false` unless they want the email.
- Never trash or delete a file unless asked to, and say what you did.
