/**
 * dispatch-command.ts — command table and flag-to-options dispatch for the
 * slack-api skill CLI.
 *
 * Split out of slack.ts so the shebanged entry stays a thin shell: this module
 * is pure command routing (no direct platform access) and maps parsed CLI flags
 * onto the typed option objects of the per-command modules. Each command group
 * has its own handler to keep routing functions small.
 */

import { Option, Result } from "effect";

import { fetchChannelHistory } from "./get-history.ts";
import { getThreadReplies } from "./get-replies.ts";
import { requireFlags, resolveChannel } from "./helpers.ts";
import { listUsers } from "./list-users.ts";
import { resolveUserMention } from "./mention-user.ts";
import { openDm } from "./open-dm.ts";

export const COMMANDS = [
  "conversations.replies",
  "conversations.history",
  "conversations.open",
  "users.list",
  "users.mention",
] as const;

export type Command = (typeof COMMANDS)[number];

export const isCommand = (value: string): value is Command =>
  (COMMANDS as readonly string[]).includes(value);

/** One-screen usage text listing every supported command. */
export const usageText = (): string => {
  const commandLines = COMMANDS.map((command) => `  ${command}`).join("\n");
  return `Usage: slack.ts <command> [--flags ...]\n\nCommands:\n${commandLines}\n`;
};

type Flags = Record<string, string>;
/** Threaded from the entrypoint so a command is not pinned to the real `Bun.env`. */
type Env = Record<string, string | undefined>;
type CommandResult = Promise<Result.Result<unknown, Error>>;

/**
 * Parse a positive-integer flag, or fail if present but invalid.
 *
 * Takes the absence as an `Option` rather than `undefined` so "the flag was
 * not passed" is the same shape going in as it is coming out; the caller
 * crosses from the raw `Flags` record with `Option.fromNullable` once.
 */
const parseIntFlag = (
  raw: Option.Option<string>,
  name: string,
  allowZero = false
): Result.Result<Option.Option<number>, Error> => {
  if (Option.isNone(raw)) {
    return Result.succeed(Option.none());
  }
  const n = Number(raw.value);
  if (
    !Number.isFinite(n) ||
    !Number.isInteger(n) ||
    (allowZero ? n < 0 : n <= 0)
  ) {
    return Result.fail(
      new Error(
        `--${name} must be a ${allowZero ? "non-negative" : "positive"} integer`
      )
    );
  }
  return Result.succeed(Option.some(n));
};

const handleConversations = async (
  command: "conversations.replies" | "conversations.history",
  flags: Flags,
  env: Env
): CommandResult => {
  const channelResult = resolveChannel(flags.channel, env);
  if (Result.isFailure(channelResult)) {
    return Result.fail(channelResult.failure);
  }
  if (command === "conversations.replies") {
    const flagsResult = requireFlags(flags, command, "ts");
    if (Result.isFailure(flagsResult)) {
      return flagsResult;
    }
    const limitResult = parseIntFlag(Option.fromUndefinedOr(flags.limit), "limit");
    if (Result.isFailure(limitResult)) {
      return Result.fail(limitResult.failure);
    }
    return await getThreadReplies({
      channel: channelResult.success,
      ts: flags.ts,
      limit: Option.getOrUndefined(limitResult.success),
      env,
    });
  }
  const limitResult = parseIntFlag(Option.fromUndefinedOr(flags.limit), "limit", true);
  if (Result.isFailure(limitResult)) {
    return Result.fail(limitResult.failure);
  }
  return await fetchChannelHistory({
    channel: channelResult.success,
    oldest: flags.oldest,
    latest: flags.latest,
    limit: Option.getOrUndefined(limitResult.success),
    env,
  });
};

const handleUsers = async (
  command: "users.list" | "users.mention",
  flags: Flags,
  env: Env
): CommandResult => {
  if (command === "users.list") {
    return await listUsers({
      search: flags.search,
      env,
    });
  }
  const flagsResult = requireFlags(flags, command, "name");
  if (Result.isFailure(flagsResult)) {
    return flagsResult;
  }
  return await resolveUserMention({
    name: flags.name,
    env,
  });
};

const handleOpenDm = async (flags: Flags, env: Env): CommandResult => {
  const flagsResult = requireFlags(flags, "conversations.open", "users");
  if (Result.isFailure(flagsResult)) {
    return flagsResult;
  }
  return await openDm({
    users: flags.users,
    env,
  });
};

/** Route a validated command plus parsed flags to its handler. */
export const dispatchCommand = (
  command: Command,
  flags: Flags,
  env: Env = Bun.env
): CommandResult => {
  switch (command) {
    case "conversations.replies":
    case "conversations.history": {
      return handleConversations(command, flags, env);
    }
    case "conversations.open": {
      return handleOpenDm(flags, env);
    }
    case "users.list":
    case "users.mention": {
      return handleUsers(command, flags, env);
    }
    default: {
      const exhaustive: never = command;
      return Promise.resolve(
        Result.fail(new Error(`Unknown command: ${String(exhaustive)}`))
      );
    }
  }
};
