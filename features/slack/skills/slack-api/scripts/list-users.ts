import type { WebClient } from "@slack/web-api";

import { Result, Schema } from "effect";

import { opaqueSchema } from "#src/schema-support.ts";
import { makeClient } from "./helpers.ts";
import { tryCatchAsync } from "./result.ts";

const PER_PAGE = 200;

const ListUsersOptsSchema = Schema.Struct({
  search: Schema.mutableKey(Schema.optionalKey(Schema.String)),
  env: Schema.mutableKey(
    Schema.optionalKey(
      Schema.UndefinedOr(
        Schema.Record(
          Schema.String,
          Schema.mutableKey(Schema.UndefinedOr(Schema.String))
        )
      )
    )
  ),
  client: Schema.mutableKey(
    Schema.optionalKey(
      Schema.UndefinedOr(opaqueSchema<WebClient>("ListUsersOpts.client"))
    )
  ),
});

export type ListUsersOpts = typeof ListUsersOptsSchema.Type;

const SlackMemberSchema = Schema.Struct({
  user_id: Schema.String,
  display_name: Schema.String,
  real_name: Schema.String,
});

export type SlackMember = typeof SlackMemberSchema.Type;

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