#!/usr/bin/env bun
/**
 * cli.ts — Google Workspace requests as the person you act as.
 *
 * Thin: it names the acting member on the request and forwards it to
 * Google's API host. Authentication happens outside this script; no
 * credential is read, held, or sent here.
 *
 *   bun features/google-workspace/skills/google-workspace/scripts/cli.ts whoami
 *   bun features/google-workspace/skills/google-workspace/scripts/cli.ts request GET https://gmail.googleapis.com/gmail/v1/users/me/labels
 *   bun features/google-workspace/skills/google-workspace/scripts/cli.ts request POST <url> --json '<body>' | --json @file
 *
 * Exit 0 on success (JSON to stdout); exit 1 on failure (error on stderr).
 */

export const ACT_AS_HEADER = "x-openrouter-act-as";
const SCRIPT = "features/google-workspace/skills/google-workspace/scripts/cli.ts";
const SKILL_DOC = "features/google-workspace/skills/google-workspace/SKILL.md";
const LINK_HINT =
  "Ask the person to link their Google account under Your accounts on the Interns page of the OpenRouter dashboard, then try again.";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface CliDeps {
  readonly fetchImpl: FetchLike;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly readFile: (path: string) => Promise<string>;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

const USAGE = `Usage:
  bun ${SCRIPT} whoami [--as email]
  bun ${SCRIPT} request <GET|POST|PUT|PATCH|DELETE> <https://*.googleapis.com/...> [--json '<body>' | --json @file] [--as email]

See ${SKILL_DOC}.`;

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;

interface Parsed {
  readonly command: string;
  readonly positional: string[];
  readonly flags: Record<string, string>;
}

function parseArgv(argv: string[]): Parsed {
  const [command = "help", ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] ?? "";
    if (arg.startsWith("--")) {
      const next = rest[index + 1];
      flags[arg.slice(2)] =
        next === undefined || next.startsWith("--") ? "" : next;
      if (next !== undefined && !next.startsWith("--")) {
        index += 1;
      }
      continue;
    }
    positional.push(arg);
  }
  return { command, positional, flags };
}

/** Google's API hosts only: the skill has no business elsewhere. */
export function isGoogleApiUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    return (
      url.protocol === "https:" &&
      (host === "www.googleapis.com" || host.endsWith(".googleapis.com")) &&
      host !== "oauth2.googleapis.com"
    );
  } catch {
    return false;
  }
}

/** The acting member's email: an explicit --as, else the Slack user this turn came from, resolved through Slack. */
async function resolveActAsEmail(
  deps: CliDeps,
  override: string | undefined
): Promise<string> {
  if (override !== undefined && override !== "") {
    if (!override.includes("@")) {
      throw new Error(`--as must be an email address, got "${override}".`);
    }
    return override.toLowerCase();
  }
  const slackUserId = deps.env.SLACK_USER_ID ?? "";
  const botToken = deps.env.SLACK_BOT_TOKEN ?? "";
  if (slackUserId === "") {
    throw new Error(
      "SLACK_USER_ID is not set. Run this from a Slack-attributed session, or pass --as <email>."
    );
  }
  if (botToken === "") {
    throw new Error(
      "SLACK_BOT_TOKEN is not set, so the Slack user cannot be resolved to an email. Pass --as <email>."
    );
  }
  const res = await deps.fetchImpl(
    `https://slack.com/api/users.info?user=${encodeURIComponent(slackUserId)}`,
    { headers: { authorization: `Bearer ${botToken}` } }
  );
  const body: unknown = await res.json().catch(() => null);
  const email = readEmail(body);
  if (email === null) {
    throw new Error(
      `Could not resolve Slack user ${slackUserId} to an email (users.info needs the users:read.email scope). Pass --as <email>.`
    );
  }
  return email;
}

/** `user.profile.email` from a users.info body, when it is there and looks like an address. */
function readEmail(body: unknown): string | null {
  const user = field(body, "user");
  const profile = field(user, "profile");
  const email = field(profile, "email");
  return typeof email === "string" && email.includes("@")
    ? email.toLowerCase()
    : null;
}

function field(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || !(key in value)) {
    return undefined;
  }
  return Reflect.get(value, key);
}

async function readJsonBody(
  deps: CliDeps,
  flag: string | undefined
): Promise<string | null> {
  if (flag === undefined) {
    return null;
  }
  const raw = flag.startsWith("@") ? await deps.readFile(flag.slice(1)) : flag;
  JSON.parse(raw);
  return raw;
}

async function cmdWhoami(deps: CliDeps, parsed: Parsed): Promise<number> {
  const email = await resolveActAsEmail(deps, parsed.flags.as);
  deps.out(JSON.stringify({ email }));
  return 0;
}

async function cmdRequest(deps: CliDeps, parsed: Parsed): Promise<number> {
  const [rawMethod = "", url = ""] = parsed.positional;
  const method = rawMethod.toUpperCase();
  if (!METHODS.has(method) || url === "") {
    deps.err(USAGE);
    return 1;
  }
  if (!isGoogleApiUrl(url)) {
    deps.err(`request only reaches https://*.googleapis.com; refused ${url}`);
    return 1;
  }
  const email = await resolveActAsEmail(deps, parsed.flags.as);
  const body = await readJsonBody(deps, parsed.flags.json);
  const headers: Record<string, string> = {
    accept: "application/json",
    [ACT_AS_HEADER]: `email:${email}`,
  };
  if (body !== null) {
    headers["content-type"] = "application/json";
  }
  const res = await deps.fetchImpl(url, {
    method,
    headers,
    body: body ?? undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    const hint =
      res.status === HTTP_UNAUTHORIZED || res.status === HTTP_FORBIDDEN
        ? ` ${LINK_HINT}`
        : "";
    deps.err(
      `Google answered ${res.status} for ${method} ${url}.${hint}\n${text}`
    );
    return 1;
  }
  deps.out(prettyJson(text));
  return 0;
}

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

const COMMANDS: Record<
  string,
  (deps: CliDeps, parsed: Parsed) => Promise<number>
> = {
  whoami: cmdWhoami,
  request: cmdRequest,
};

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const parsed = parseArgv(argv);
  if (
    parsed.command === "help" ||
    parsed.command === "--help" ||
    parsed.command === "-h"
  ) {
    deps.out(USAGE);
    return 0;
  }
  const handler = COMMANDS[parsed.command];
  if (handler === undefined) {
    deps.err(`Unknown command "${parsed.command}".\n${USAGE}`);
    return 1;
  }
  try {
    return await handler(deps, parsed);
  } catch (error) {
    deps.err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.main) {
  const code = await runCli(Bun.argv.slice(2), {
    fetchImpl: (url, init) => fetch(url, init),
    env: Bun.env,
    readFile: (path) => Bun.file(path).text(),
    out: (text) => {
      process.stdout.write(`${text}\n`);
    },
    err: (text) => {
      process.stderr.write(`${text}\n`);
    },
  });
  process.exit(code);
}
