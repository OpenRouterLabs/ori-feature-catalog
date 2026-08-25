/**
 * Two seams, no network.
 *
 * `filterMembersBySearch` is pure and is tested directly. The rest —
 * who survives the bot/deleted/USLACKBOT cull, and how the cursor loop walks
 * pages — is driven through an injected client typed to the sliver of
 * `WebClient` this module actually calls (`users.list`), cast once at the seam.
 */

import { describe, expect, test } from "#src/test-support/effect-test.ts";
import { Result } from "effect";

import type { WebClient } from "@slack/web-api";

import type { SlackMember } from "./list-users.ts";

import { filterMembersBySearch, listUsers } from "./list-users.ts";

interface UsersListArgs {
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

interface FakeMember {
  readonly deleted?: boolean;
  readonly id?: string;
  readonly is_bot?: boolean;
  readonly profile?: {
    readonly display_name?: string;
    readonly real_name?: string;
  };
  readonly real_name?: string;
}

interface FakePage {
  readonly members?: readonly FakeMember[];
  readonly response_metadata?: {
    readonly next_cursor?: string;
  };
}

/**
 * A Slack that serves the given pages in order. The cast is the seam: only
 * `users.list` is ever reached, so only `users.list` is modelled.
 */
const clientServing = (
  pages: readonly FakePage[],
  calls: UsersListArgs[] = []
): WebClient =>
  ({
    users: {
      list: (args: UsersListArgs) => {
        calls.push(args);
        return Promise.resolve(pages[calls.length - 1] ?? {});
      },
    },
  }) as unknown as WebClient;

const throwingClient = (error: Error): WebClient =>
  ({
    users: {
      list: () => Promise.reject(error),
    },
  }) as unknown as WebClient;

const human = (
  id: string,
  display_name: string,
  real_name: string
): FakeMember => ({
  id,
  profile: {
    display_name,
    real_name,
  },
});

const member = (
  user_id: string,
  display_name: string,
  real_name: string
): SlackMember => ({
  display_name,
  real_name,
  user_id,
});

const successValue = (
  result: Result.Result<SlackMember[], Error>
): SlackMember[] => (Result.isSuccess(result) ? result.success : []);

const failureMessage = (result: Result.Result<unknown, Error>): string =>
  Result.isFailure(result) ? result.failure.message : "";

const idsOf = (result: Result.Result<SlackMember[], Error>): string[] =>
  successValue(result).map((m) => m.user_id);

describe("filterMembersBySearch", () => {
  const roster = [
    member("U1", "chrisp", "Chris Perry"),
    member("U2", "labrador", "Some Body"),
    member("U3", "", "Ada Lovelace"),
  ];

  test("returns everyone when there is no search", () => {
    expect(filterMembersBySearch(roster, undefined)).toEqual(roster);
  });

  test("treats a blank or whitespace search as no search", () => {
    // `--search ""` from the CLI must not silently return an empty workspace.
    expect(filterMembersBySearch(roster, "")).toEqual(roster);
    expect(filterMembersBySearch(roster, "   ")).toEqual(roster);
  });

  test("matches a display_name substring case-insensitively", () => {
    expect(filterMembersBySearch(roster, "LAB")).toEqual([roster[1]]);
  });

  test("matches a real_name substring case-insensitively", () => {
    expect(filterMembersBySearch(roster, "lovelace")).toEqual([roster[2]]);
  });

  test("trims the search before matching", () => {
    expect(filterMembersBySearch(roster, "  chris  ")).toEqual([roster[0]]);
  });

  test("returns nothing when nobody matches", () => {
    expect(filterMembersBySearch(roster, "zzz")).toEqual([]);
  });
});

describe("listUsers — who gets filtered out", () => {
  test("drops bots, deleted accounts, and USLACKBOT", async () => {
    // Any of these three in the roster is a name the agent could try to
    // mention, and none of them can read a message.
    const result = await listUsers({
      client: clientServing([
        {
          members: [
            human("U1", "chrisp", "Chris Perry"),
            { id: "B1", is_bot: true, profile: { display_name: "buildbot" } },
            { deleted: true, id: "U2", profile: { display_name: "gone" } },
            { id: "USLACKBOT", profile: { display_name: "slackbot" } },
          ],
        },
      ]),
    });

    expect(idsOf(result)).toEqual(["U1"]);
  });

  test("drops a member with no id", async () => {
    const result = await listUsers({
      client: clientServing([
        {
          members: [
            { profile: { display_name: "ghost" } },
            human("U1", "chrisp", "Chris Perry"),
          ],
        },
      ]),
    });

    expect(idsOf(result)).toEqual(["U1"]);
  });

  test("returns an empty list when Slack sends no members at all", async () => {
    const result = await listUsers({
      client: clientServing([{}]),
    });

    expect(result).toEqual(Result.succeed([]));
  });
});

describe("listUsers — the fields it projects", () => {
  test("reads display_name and real_name off the profile", async () => {
    const result = await listUsers({
      client: clientServing([
        { members: [human("U1", "chrisp", "Chris Perry")] },
      ]),
    });

    expect(successValue(result)).toEqual([
      member("U1", "chrisp", "Chris Perry"),
    ]);
  });

  test("falls back to the top-level real_name when the profile has none", async () => {
    const result = await listUsers({
      client: clientServing([
        {
          members: [
            { id: "U1", profile: { display_name: "cp" }, real_name: "Chris P" },
          ],
        },
      ]),
    });

    expect(successValue(result)).toEqual([member("U1", "cp", "Chris P")]);
  });

  test("uses empty strings rather than undefined for a nameless member", async () => {
    // Downstream both fields get `.toLowerCase()` called on them, so an
    // undefined that slipped through would throw at match time.
    const result = await listUsers({
      client: clientServing([{ members: [{ id: "U1" }] }]),
    });

    expect(successValue(result)).toEqual([member("U1", "", "")]);
  });
});

describe("listUsers — cursor pagination", () => {
  test("follows next_cursor and concatenates the pages", async () => {
    const calls: UsersListArgs[] = [];
    const result = await listUsers({
      client: clientServing(
        [
          {
            members: [human("U1", "a", "A")],
            response_metadata: { next_cursor: "page2" },
          },
          { members: [human("U2", "b", "B")] },
        ],
        calls
      ),
    });

    expect(idsOf(result)).toEqual(["U1", "U2"]);
    expect(calls).toHaveLength(2);
  });

  test("sends no cursor on the first page and the cursor on the next", async () => {
    const calls: UsersListArgs[] = [];
    await listUsers({
      client: clientServing(
        [
          {
            members: [human("U1", "a", "A")],
            response_metadata: { next_cursor: "page2" },
          },
          { members: [human("U2", "b", "B")] },
        ],
        calls
      ),
    });

    expect(calls[0]?.cursor).toBeUndefined();
    expect(calls[1]?.cursor).toBe("page2");
  });

  test("asks for a full page each time", async () => {
    const calls: UsersListArgs[] = [];
    await listUsers({
      client: clientServing([{ members: [] }], calls),
    });

    expect(calls[0]?.limit).toBe(200);
  });

  test("stops on the empty-string cursor Slack sends for the last page", async () => {
    // Slack returns `next_cursor: ""` rather than omitting it, and treating
    // that as a cursor would loop forever against the same page.
    const calls: UsersListArgs[] = [];
    const result = await listUsers({
      client: clientServing(
        [
          {
            members: [human("U1", "a", "A")],
            response_metadata: { next_cursor: "" },
          },
        ],
        calls
      ),
    });

    expect(calls).toHaveLength(1);
    expect(idsOf(result)).toEqual(["U1"]);
  });
});

describe("listUsers — search and failure", () => {
  test("applies the search across every page it collected", async () => {
    const result = await listUsers({
      client: clientServing([
        {
          members: [human("U1", "chrisp", "Chris Perry")],
          response_metadata: { next_cursor: "page2" },
        },
        { members: [human("U2", "labrador", "Some Body")] },
      ]),
      search: "chris",
    });

    expect(idsOf(result)).toEqual(["U1"]);
  });

  test("puts a thrown Slack error in the failure channel instead of rejecting", async () => {
    const result = await listUsers({
      client: throwingClient(new Error("ratelimited")),
    });

    expect(Result.isFailure(result)).toBe(true);
    expect(failureMessage(result)).toContain("ratelimited");
  });

  test("still refuses without a token when no client is injected", async () => {
    const result = await listUsers({
      env: {},
    });

    expect(Result.isFailure(result)).toBe(true);
    expect(failureMessage(result)).toContain("SLACK_BOT_TOKEN");
  });
});
