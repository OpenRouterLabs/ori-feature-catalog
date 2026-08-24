/**
 * list-users.ts — users.list
 *
 * List workspace members, optionally filtered by a case-insensitive name
 * substring match against display_name / real_name.
 *
 * Usage:
 *   bun features/slack/skills/slack-api/scripts/slack.ts users.list [--search "Chris"]
 *
 * Output: JSON array of { user_id, display_name, real_name }.
 *
 * NOTE: unlike Perry's slack-render (which caches members in SQLite via the
 * ori-monorepo egg package), this port has no DB dependency and fetches live
 * each call. Bots, deleted users, and USLACKBOT are filtered out.
 */

import type { WebClient } from "@slack/web-api";

import { Result } from "effect";

import { makeClient } from "./helpers.ts";
import { tryCatchAsync } from "./result.ts";

const PER_PAGE = 200;

export interface ListUsersOpts {
  search?: string;
  /** Env map for SLACK_* configuration; defaults to Bun.env. */
  env?: Record<string, string | undefined> | undefined;
  /** Injected Slack client; defaults to one built from `env`. */
  client?: WebClient | undefined;
}

export interface SlackMember {
  user_id: string;
  display_name: string;
  real_name: string;
}

const collectHumanMembers = async (
  client: WebClient
): Promise<SlackMember[]> => {
  const members: SlackMember[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.users.list({
      limit: PER_PAGE,
      ...(cursor
        ? {
            cursor,
          }
        : {}),
    });
    const valid = (page.members ?? []).filter(
      (m) => m.id && !m.deleted && !m.is_bot && m.id !== "USLACKBOT"
    );
    for (const m of valid) {
      members.push({
        user_id: m.id ?? "",
        display_name: m.profile?.display_name ?? "",
        real_name: m.profile?.real_name ?? m.real_name ?? "",
      });
    }
    cursor = page.response_metadata?.next_cursor ?? undefined;
  } while (cursor);
  return members;
};

/** Case-insensitive substring match against display_name / real_name. */
export const filterMembersBySearch = (
  members: SlackMember[],
  rawSearch: string | undefined
): SlackMember[] => {
  const search = (rawSearch ?? "").trim().toLowerCase();
  if (!search) {
    return members;
  }
  return members.filter(
    (m) =>
      m.display_name.toLowerCase().includes(search) ||
      m.real_name.toLowerCase().includes(search)
  );
};

/** List workspace members, optionally filtered by name substring. */
export const listUsers = async (
  opts: ListUsersOpts = {}
): Promise<Result.Result<SlackMember[], Error>> => {
  const clientResult = opts.client
    ? Result.succeed(opts.client)
    : makeClient(opts.env);
  if (Result.isFailure(clientResult)) {
    return Result.fail(clientResult.failure);
  }
  const client = clientResult.success;
  return await tryCatchAsync(async () => {
    const members = await collectHumanMembers(client);
    return filterMembersBySearch(members, opts.search);
  });
};
