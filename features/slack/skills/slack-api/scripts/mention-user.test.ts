/**
 * The refusal is the point of this module.
 *
 * `resolveUserMention` turns a human-typed name into a `<@USERID>` that Slack
 * will ping for real, so the case that matters most is the one where it
 * declines: a partial match with more than one candidate is refused rather
 * than resolved to whoever happened to sort first. These cases pin that, plus
 * the exact-match preference that lets an unambiguous name through.
 *
 * The lookup is injected via `listUsersImpl`, so nothing here reaches Slack;
 * the fakes stand for what `listUsers` returns for a given search.
 */

import { describe, expect, test } from "bun:test";
import { Result } from "effect";

import type { ListUsersOpts, SlackMember } from "./list-users.ts";

import { resolveUserMention } from "./mention-user.ts";

const member = (
  user_id: string,
  display_name: string,
  real_name: string
): SlackMember => ({
  display_name,
  real_name,
  user_id,
});

/** A lookup that always hands back the same roster, recording what it was asked. */
const lookupReturning = (
  members: readonly SlackMember[],
  searches: string[] = []
): ((opts?: ListUsersOpts) => Promise<Result.Result<SlackMember[], Error>>) => {
  return (opts?: ListUsersOpts) => {
    searches.push(opts?.search ?? "");
    return Promise.resolve(Result.succeed([...members]));
  };
};

const lookupFailing = (
  error: Error
): ((opts?: ListUsersOpts) => Promise<Result.Result<SlackMember[], Error>>) => {
  return () => Promise.resolve(Result.fail(error));
};

const failureMessage = (result: Result.Result<unknown, Error>): string =>
  Result.isFailure(result) ? result.failure.message : "";

const successValue = (result: Result.Result<string, Error>): string =>
  Result.isSuccess(result) ? result.success : "";

describe("resolveUserMention — the ambiguity refusal", () => {
  test("refuses a partial match with more than one candidate", async () => {
    // The whole reason this module exists: two people whose names both contain
    // "chris" and neither is what was typed, so pinging either is a coin flip.
    const result = await resolveUserMention({
      listUsersImpl: lookupReturning([
        member("U1", "chrisp", "Chris Perry"),
        member("U2", "chrisl", "Chris Lattner"),
      ]),
      name: "chris",
    });

    expect(Result.isFailure(result)).toBe(true);
    expect(failureMessage(result)).toContain("Ambiguous");
  });

  test("names the number of candidates so the caller can narrow it", async () => {
    const result = await resolveUserMention({
      listUsersImpl: lookupReturning([
        member("U1", "chrisp", "Chris Perry"),
        member("U2", "chrisl", "Chris Lattner"),
        member("U3", "chrisd", "Chris Doe"),
      ]),
      name: "chris",
    });

    expect(failureMessage(result)).toContain("3 users");
  });

  test("returns no mention at all when it refuses", async () => {
    // A refusal that still leaked a `<@U…>` into the message would defeat the
    // guard, since callers paste failure text into Slack.
    const result = await resolveUserMention({
      listUsersImpl: lookupReturning([
        member("U1", "chrisp", "Chris Perry"),
        member("U2", "chrisl", "Chris Lattner"),
      ]),
      name: "chris",
    });

    expect(Result.isSuccess(result)).toBe(false);
    expect(failureMessage(result)).not.toContain("<@");
  });

  test("does not refuse when one of the several candidates is an exact match", async () => {
    // Ambiguity only blocks a *partial* match; typing someone's exact handle
    // is an unambiguous instruction even in a crowd of near misses.
    const result = await resolveUserMention({
      listUsersImpl: lookupReturning([
        member("U1", "chrisp", "Chris Perry"),
        member("U2", "chris", "Chris Lattner"),
        member("U3", "christina", "Christina Doe"),
      ]),
      name: "chris",
    });

    expect(result).toEqual(Result.succeed("<@U2>"));
  });
});

describe("resolveUserMention — exact match preference", () => {
  test("an exact display_name beats a partial that sorts first", async () => {
    const result = await resolveUserMention({
      listUsersImpl: lookupReturning([
        member("U1", "labrador", "Some Body"),
        member("U2", "lab", "Lab Person"),
      ]),
      name: "lab",
    });

    expect(result).toEqual(Result.succeed("<@U2>"));
  });

  test("an exact real_name beats a partial that sorts first", async () => {
    const result = await resolveUserMention({
      listUsersImpl: lookupReturning([
        member("U1", "cperry", "Chris Perryman"),
        member("U2", "cp", "Chris Perry"),
      ]),
      name: "Chris Perry",
    });

    expect(result).toEqual(Result.succeed("<@U2>"));
  });

  test("matches the exact name case-insensitively", async () => {
    // Nobody types a handle with the same capitalisation Slack stores, and a
    // case-sensitive compare would demote this to an ambiguous partial.
    const result = await resolveUserMention({
      listUsersImpl: lookupReturning([
        member("U1", "labrador", "Some Body"),
        member("U2", "LAB", "Lab Person"),
      ]),
      name: "lab",
    });

    expect(result).toEqual(Result.succeed("<@U2>"));
  });

  test("matches an exact real_name case-insensitively", async () => {
    const result = await resolveUserMention({
      listUsersImpl: lookupReturning([
        member("U1", "cperry", "Chris Perryman"),
        member("U2", "cp", "CHRIS PERRY"),
      ]),
      name: "chris perry",
    });

    expect(result).toEqual(Result.succeed("<@U2>"));
  });
});

describe("resolveUserMention", () => {
  test("resolves a single partial match", async () => {
    const result = await resolveUserMention({
      listUsersImpl: lookupReturning([member("U9", "labrador", "Some Body")]),
      name: "lab",
    });

    expect(result).toEqual(Result.succeed("<@U9>"));
  });

  test("outputs exactly the `<@USERID>` mention Slack expects", async () => {
    // Slack renders the mention only for this literal shape — no spaces, no
    // surrounding punctuation, no display name.
    const result = await resolveUserMention({
      listUsersImpl: lookupReturning([
        member("U05AJSRUVPT", "lab", "Lab Person"),
      ]),
      name: "lab",
    });

    expect(successValue(result)).toBe("<@U05AJSRUVPT>");
  });

  test("says no user was found when the roster is empty", async () => {
    const result = await resolveUserMention({
      listUsersImpl: lookupReturning([]),
      name: "nobody",
    });

    expect(Result.isFailure(result)).toBe(true);
    expect(failureMessage(result)).toContain('No user found matching "nobody"');
  });

  test("propagates a lookup failure instead of reporting no user found", async () => {
    // A revoked token or a rate limit is not the same answer as "that person
    // does not exist", and reporting it as the latter sends callers hunting
    // for a typo in a name that is spelled correctly.
    const result = await resolveUserMention({
      listUsersImpl: lookupFailing(new Error("ratelimited")),
      name: "lab",
    });

    expect(Result.isFailure(result)).toBe(true);
    expect(failureMessage(result)).toContain("ratelimited");
    expect(failureMessage(result)).not.toContain("No user found");
  });

  test("asks the lookup for the name it was given", async () => {
    const searches: string[] = [];
    await resolveUserMention({
      listUsersImpl: lookupReturning([member("U1", "lab", "Lab")], searches),
      name: "lab",
    });

    expect(searches).toEqual(["lab"]);
  });

  test("uses the real lookup when no impl is injected", async () => {
    // The seam is additive: with it absent the module still builds its own
    // client, which with no token fails before any socket is opened.
    const result = await resolveUserMention({
      env: {},
      name: "lab",
    });

    expect(Result.isFailure(result)).toBe(true);
    expect(failureMessage(result)).toContain("SLACK_BOT_TOKEN");
  });
});
