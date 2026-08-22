/**
 * mention-user.ts — users.mention
 *
 * Resolve a Slack user by name and output the proper `<@USERID>` mention string.
 * Prefers an exact display_name / real_name match over a partial one; errors on
 * an ambiguous partial match so callers don't notify the wrong person.
 *
 * Usage:
 *   bun features/slack/skills/slack-api/scripts/slack.ts users.mention --name "lab"
 *   # → <@U05AJSRUVPT>
 */

import { Result } from "effect";

import { listUsers } from "./list-users.ts";

export interface ResolveMentionOpts {
  name: string;
  /** Env map for SLACK_* configuration; defaults to Bun.env. */
  env?: Record<string, string | undefined> | undefined;
}

/** Resolve a Slack user name to a `<@USERID>` mention string. */
export const resolveUserMention = async (
  opts: ResolveMentionOpts
): Promise<Result.Result<string, Error>> => {
  const result = await listUsers({
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
