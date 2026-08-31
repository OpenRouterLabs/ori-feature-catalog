import { Result } from "effect";

import { listUsers } from "./list-users.ts";

interface ResolveMentionOpts {
  name: string;
  env?: Record<string, string | undefined> | undefined;
  listUsersImpl?: typeof listUsers | undefined;
}

export const resolveUserMention = async (
  opts: ResolveMentionOpts
): Promise<Result.Result<string, Error>> => {
  const lookupUsers = opts.listUsersImpl ?? listUsers;
  const result = await lookupUsers({
    search: opts.name,
    env: opts.env,
  });
  if (Result.isFailure(result)) {
    return Result.fail(result.failure);
  }
  const matches = result.success;
  if (matches.length === 0) {
    return Result.fail(new Error(`No user found matching "${opts.name}"`));
  }
  const nameLower = opts.name.toLowerCase();
  const exact = matches.find(
    (m) =>
      m.display_name.toLowerCase() === nameLower ||
      m.real_name.toLowerCase() === nameLower
  );
  if (!exact && matches.length > 1) {
    return Result.fail(
      new Error(
        `Ambiguous: "${opts.name}" matched ${matches.length} users. Use a more specific name.`
      )
    );
  }
  const best = exact ?? matches[0];
  return Result.succeed(`<@${best.user_id}>`);
};
