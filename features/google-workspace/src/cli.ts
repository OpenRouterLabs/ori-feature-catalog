#!/usr/bin/env bun
/**
 * cli.ts — Google Workspace requests as the person you are talking to.
 *
 * Thin: it forwards a request to Google's API host, and OpenRouter
 * authenticates it as the person the conversation came from. No
 * credential is read, held, or sent here, and no account is chosen here.
 *
 *   bun features/google-workspace/src/cli.ts whoami
 *   bun features/google-workspace/src/cli.ts request GET https://gmail.googleapis.com/gmail/v1/users/me/labels
 *   bun features/google-workspace/src/cli.ts request POST <url> --json '<body>' | --json @file
 *
 * Exit 0 on success (JSON to stdout); exit 1 on failure (error on stderr).
 */

export const ACT_AS_HEADER = "x-openrouter-act-as";
export const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
const SCRIPT = "features/google-workspace/src/cli.ts";
const SKILL_DOC = "features/google-workspace/README.md";
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
  bun ${SCRIPT} whoami
  bun ${SCRIPT} request <GET|POST|PUT|PATCH|DELETE> <https://*.googleapis.com/...> [--json '<body>' | --json @file]

See ${SKILL_DOC}.`;

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;

interface Parsed {
  readonly command: string;
  readonly positional: string[];
  readonly flags: Record<string, string>;
}

interface GoogleRequest {
  readonly method: string;
  readonly url: string;
  readonly body: string | null;
}

interface GoogleAnswer {
  readonly status: number;
  readonly ok: boolean;
  readonly text: string;
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

/**
 * The email of the Slack user this turn came from, when the turn came from
 * Slack and Slack can say. Null otherwise: a request without it is still
 * attributed to the person the conversation came from.
 */
async function resolveSlackEmail(deps: CliDeps): Promise<string | null> {
  const slackUserId = deps.env.SLACK_USER_ID ?? "";
  const botToken = deps.env.SLACK_BOT_TOKEN ?? "";
  if (slackUserId === "" || botToken === "") {
    return null;
  }
  const res = await deps.fetchImpl(
    `https://slack.com/api/users.info?user=${encodeURIComponent(slackUserId)}`,
    { headers: { authorization: `Bearer ${botToken}` } }
  );
  const body: unknown = await res.json().catch(() => null);
  const email = readEmail(body);
  if (email === null) {
    deps.err(
      `Could not resolve Slack user ${slackUserId} to an email (users.info needs the users:read.email scope); continuing without it.`
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

async function sendGoogleRequest(
  deps: CliDeps,
  request: GoogleRequest
): Promise<GoogleAnswer> {
  const email = await resolveSlackEmail(deps);
  const headers: Record<string, string> = { accept: "application/json" };
  if (email !== null) {
    headers[ACT_AS_HEADER] = `email:${email}`;
  }
  if (request.body !== null) {
    headers["content-type"] = "application/json";
  }
  const res = await deps.fetchImpl(request.url, {
    method: request.method,
    headers,
    body: request.body ?? undefined,
  });
  return { status: res.status, ok: res.ok, text: await res.text() };
}

function reportFailure(
  deps: CliDeps,
  request: GoogleRequest,
  answer: GoogleAnswer
): number {
  const hint =
    answer.status === HTTP_UNAUTHORIZED || answer.status === HTTP_FORBIDDEN
      ? ` ${LINK_HINT}`
      : "";
  deps.err(
    `Google answered ${answer.status} for ${request.method} ${request.url}.${hint}\n${answer.text}`
  );
  return 1;
}

async function cmdWhoami(deps: CliDeps): Promise<number> {
  const request: GoogleRequest = { method: "GET", url: USERINFO_URL, body: null };
  const answer = await sendGoogleRequest(deps, request);
  if (!answer.ok) {
    return reportFailure(deps, request, answer);
  }
  const email = field(parseJson(answer.text), "email");
  if (typeof email !== "string") {
    deps.err(`Google did not name an account.\n${answer.text}`);
    return 1;
  }
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
  const body = await readJsonBody(deps, parsed.flags.json);
  const request: GoogleRequest = { method, url, body };
  const answer = await sendGoogleRequest(deps, request);
  if (!answer.ok) {
    return reportFailure(deps, request, answer);
  }
  deps.out(prettyJson(answer.text));
  return 0;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function prettyJson(text: string): string {
  const parsed = parseJson(text);
  return parsed === null ? text : JSON.stringify(parsed, null, 2);
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
  if (parsed.flags.as !== undefined) {
    deps.err(
      "--as is not supported: every request acts as the person you are talking to, and no other account can be named."
    );
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
