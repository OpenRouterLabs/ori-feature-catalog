/**
 * open-dm.ts — conversations.open
 *
 * Open (or return an existing) DM conversation. Response includes `channel.id`.
 *
 * Usage:
 *   bun features/slack/skills/slack-api/scripts/slack.ts conversations.open --users U123,U456
 */

import type { WebClient } from "@slack/web-api";

import { Result } from "effect";

import { makeClient } from "./helpers.ts";
import { tryCatchAsync } from "./result.ts";

export interface OpenDmOpts {
  users: string;
  /** Env map for SLACK_* configuration; defaults to Bun.env. */
  env?: Record<string, string | undefined> | undefined;
  /** Injected Slack client; defaults to one built from `env`. */
  client?: WebClient | undefined;
}

/** Open a DM with user(s). Returns the Slack API conversations.open response. */
export const openDm = async (
  opts: OpenDmOpts
): Promise<Result.Result<unknown, Error>> => {
  const clientResult = opts.client
    ? Result.succeed(opts.client)
    : makeClient(opts.env);
  if (Result.isFailure(clientResult)) {
    return Result.fail(clientResult.failure);
  }
  return await tryCatchAsync(() =>
    clientResult.success.conversations.open({
      users: opts.users,
    })
  );
};
