---
name: google-calendar
description: Read and manage Google Calendar as the person you are talking to, or as a teammate who shared their Google account with this intern. TRIGGER when the user asks about their own or a teammate's schedule, meetings, availability, free time, or wants an event created, moved, or cancelled ("what's my next meeting", "am I free Thursday afternoon", "find a slot with Bob and Ana", "set up a 30 minute call"). DO NOT TRIGGER for email about meetings (gmail), for a different calendar provider.
---

# Google Calendar

Calls the Calendar API as the person you are talking to. Authentication is handled for you: you never hold, request, or send a credential. The person the conversation came from is who every request acts as, whether they wrote from Slack or from the dashboard; you name another account with `--account` when the task is about that person's account. The other Google apps have their own skills (gmail, google-drive, google-docs, google-sheets); they all share this command.

## Prerequisites

Both are done in the OpenRouter dashboard, not here. If either is missing the request fails with 401 or 403; relay the message below rather than retrying.

- An admin connected **Google Workspace** in the OpenRouter dashboard under Interns → **Shared connections** and included Google Calendar in the products members may grant.
- The person linked their Google account in the OpenRouter dashboard under Interns → **Your accounts** → Google. Tell them: "Link your Google account in the OpenRouter dashboard under Interns → Your accounts → Google, then ask me again."

## Usage

```bash
bun features/google-workspace/src/cli.ts whoami                                   # the linked account that answers
bun features/google-workspace/src/cli.ts whoami --account sam@example.com           # check another person shared it with you
bun features/google-workspace/src/cli.ts request GET <calendar url>
bun features/google-workspace/src/cli.ts request POST <calendar url> --json '<body>'
```

`whoami` prints `{"account", "delegatedToThisIntern", "capabilities"}`. `delegatedToThisIntern: false` means the account is linked but not shared: only its owner can have you act on it. `true` means it is shared with this intern for others, for the `capabilities` listed (for example `gmail.read`, `calendar.edit`). `null` means it could not tell; say you do not know rather than guessing.

`request` accepts `https://*.googleapis.com` URLs only. It acts as the person the conversation came from. Add `--account <email>` when the task is about another person's account ("what's on Sam's calendar tomorrow", "send this from Sam's inbox", a schedule that works through someone's calendar). Name the one account the task is about; never guess an account or try several. A linked account is not a shared one. Linked means its owner can have you act on it in their own conversations, and nobody else can. Shared means its owner also turned on **Use your account for others** for this intern and ticked what it may do; then anyone who can message this intern, and its schedules, can have you use it within those capabilities, with `--account <their email>`, without asking the owner to confirm again. Never assume which one an account is: `whoami` (with `--account` for someone else's) says. If someone asks about another person's account and it is not shared with this intern, or not for what they asked, say so: only its owner can share it, in the OpenRouter dashboard under Interns → Your accounts → Google → Interns. Never add an `Authorization` header or any other credential: the request is authenticated for you, and one that carries its own credential is refused.

API base: `https://www.googleapis.com/calendar/v3`. A read-only grant allows the GET calls and `freeBusy`; creating or changing events answers 403.

## Recipes

Read the schedule:

```bash
# the calendars the person sees, with their ids and time zones
bun features/google-workspace/src/cli.ts request GET https://www.googleapis.com/calendar/v3/users/me/calendarList
# upcoming events on the primary calendar, recurring ones expanded, in order
bun features/google-workspace/src/cli.ts request GET 'https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=2026-09-16T00:00:00Z&timeMax=2026-09-17T00:00:00Z&singleEvents=true&orderBy=startTime&maxResults=20'
# one event
bun features/google-workspace/src/cli.ts request GET https://www.googleapis.com/calendar/v3/calendars/primary/events/EVENT_ID
```

Find a time. Always query every participant before proposing slots:

```bash
bun features/google-workspace/src/cli.ts request POST https://www.googleapis.com/calendar/v3/freeBusy --json '{"timeMin":"2026-09-17T09:00:00-04:00","timeMax":"2026-09-17T18:00:00-04:00","timeZone":"America/New_York","items":[{"id":"primary"},{"id":"bob@example.com"},{"id":"ana@example.com"}]}'
```

Create and change events:

```bash
# invite attendees and email them; add conferenceDataVersion=1 and the createRequest for a Meet link
bun features/google-workspace/src/cli.ts request POST 'https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all&conferenceDataVersion=1' --json '{"summary":"Q3 review","start":{"dateTime":"2026-09-18T15:00:00-04:00","timeZone":"America/New_York"},"end":{"dateTime":"2026-09-18T15:30:00-04:00","timeZone":"America/New_York"},"attendees":[{"email":"bob@example.com"}],"conferenceData":{"createRequest":{"requestId":"q3-review-1"}}}'
# move or retitle: PATCH only the fields that change
bun features/google-workspace/src/cli.ts request PATCH 'https://www.googleapis.com/calendar/v3/calendars/primary/events/EVENT_ID?sendUpdates=all' --json '{"start":{"dateTime":"2026-09-18T16:00:00-04:00","timeZone":"America/New_York"},"end":{"dateTime":"2026-09-18T16:30:00-04:00","timeZone":"America/New_York"}}'
# cancel
bun features/google-workspace/src/cli.ts request DELETE 'https://www.googleapis.com/calendar/v3/calendars/primary/events/EVENT_ID?sendUpdates=all'
```

## Procedure

1. Run `whoami` once per conversation if you are unsure whose calendar you act on.
2. Read the person's time zone from `calendarList` (or the event) and use it in every `dateTime`; relay times in that zone.
3. Exit 1 prints the status and Google's error on stderr. 401 or 403 means the person has not linked their account or did not grant Google Calendar: relay the prerequisite message. Anything else: report Google's error as is.

## Notes

- Confirm attendees, time, and duration with the person before creating an event that emails other people; `sendUpdates=all` notifies every attendee.
- All-day events use `date` (`YYYY-MM-DD`) instead of `dateTime`, and the end date is exclusive.
