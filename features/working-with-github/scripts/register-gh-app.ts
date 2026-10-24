#!/usr/bin/env bun
/**
 * register-gh-app.ts — register (or list) which env-var *names* hold a GitHub
 * App's credentials for an (org, purpose) pair, so `mint-token.ts --repo … [--purpose …]`
 * can route to the right App.
 *
 * The registry stores ONLY key names, never secret values (the values stay in
 * the service env, injected by Ori). `mint-token.ts` reads the named env vars at
 * mint time and discovers the App's installation for the org.
 *
 * # Usage
 *
 *   # Register the App that covers acme-corp for the "reviewer" role:
 *   bun features/working-with-github/scripts/register-gh-app.ts register \
 *     --org acme-corp --purpose reviewer \
 *     --app-id-key TEAM_GH_APP_ID --private-key-key TEAM_GH_APP_PRIVATE_KEY
 *
 *   # --purpose defaults to "default" (the org-level catch-all):
 *   bun features/working-with-github/scripts/register-gh-app.ts register \
 *     --org acme-corp --app-id-key TEAM_GH_APP_ID --private-key-key TEAM_GH_APP_PRIVATE_KEY
 *
 *   # List all registered (org, purpose) → key-name mappings (names only):
 *   bun features/working-with-github/scripts/register-gh-app.ts list
 *
 * `register` refuses to persist a key name that resolves to an empty/undefined
 * env var (a typo fails loudly) — but it never prints the value. The bare
 * default app (`GH_APP_ID` / `GH_APP_PRIVATE_KEY`) needs no registration.
 */

import type { Database } from "bun:sqlite";

import { findJunkArgv } from "@ori-monorepo/working-with-github/commit-api-core.ts";

import {
  DEFAULT_PURPOSE,
  listApps,
  openGhAppRegistryDb,
  orgOf,
  registerApp,
} from "@ori-monorepo/working-with-github/gh-app-registry.ts";

/** Output seam so a test can capture stdout/stderr without touching the process. */
export interface RegisterWriters {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

/** Everything one CLI invocation needs — bundled so helpers stay within arg limits. */
export interface RegisterCliContext {
  readonly db: Database;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly writers: RegisterWriters;
}

const readFlag = (
  argv: readonly string[],
  flag: string
): string | undefined => {
  const i = argv.indexOf(flag);
  if (i === -1 || i + 1 >= argv.length) {
    return undefined;
  }
  const value = argv[i + 1];
  // Trim BEFORE the flag-shape check: a value that is a flag modulo
  // surrounding whitespace (`--org " --purpose "`) is the same omitted
  // value, but the raw token passed the guard first, trimmed to "--purpose",
  // and flowed on as a real org — persisting `org:"--purpose"`, a registry
  // key no mint can ever produce (orgOf of a repo string never yields a
  // `--`-prefixed login), the #101/#140 silent-dead-row class. A following
  // token that is itself a flag means the value was omitted (e.g. `--org
  // --app-id-key X`) — treat it as absent so validation fails cleanly
  // instead of registering `--app-id-key` as the org.
  const trimmed = value === undefined ? undefined : value.trim();
  if (trimmed === undefined || trimmed.startsWith("--")) {
    return undefined;
  }
  // An all-whitespace value trims to "" → treated as absent.
  return trimmed === "" ? undefined : trimmed;
};

/** Run `register` (ctx.argv excludes the subcommand). Returns the exit code; never throws. */
const runRegister = (ctx: RegisterCliContext): number => {
  const { argv, db, env, writers } = ctx;
  const junkArgv = findJunkArgv(argv);
  if (junkArgv !== undefined) {
    // A single-dash token (`-purpose reviewer`) is a typo no CLI accepts, and
    // ignoring it silently coerced the row to the org-level CATCH-ALL purpose —
    // re-routing every future mint without --purpose (the #117 class).
    writers.err(
      `register-gh-app: unrecognized argument "${junkArgv}" — flags are space-separated "--org acme", never "--org=acme" or single-dash\n`
    );
    return 1;
  }
  // A value-taking flag repeated in argv is a usage error, never a silent
  // first-wins: `readFlag` below reads `argv.indexOf(flag)`, so pre-fix
  // `--org acme --org other` silently persisted `acme`, re-routing every
  // future mint for the org the caller may have meant instead.
  const repeatedFlag = [
    "--org",
    "--purpose",
    "--app-id-key",
    "--private-key-key",
  ].find((flag) => argv.filter((token) => token === flag).length > 1);
  if (repeatedFlag !== undefined) {
    writers.err(
      `register-gh-app: ${repeatedFlag} was passed more than once — pass exactly one value\n`
    );
    return 1;
  }
  // An explicitly-passed `--purpose` whose value slot was eaten by the next
  // flag (`--purpose --app-id-key X`) — or is missing entirely (a trailing
  // `--purpose`) — must fail the parse, not silently persist the org-level
  // CATCH-ALL ("default") row: the caller asked for a ROLE App and would
  // silently re-route every future mint without --purpose to the App the
  // other flags named — the same silent-identity-swap class #98/#107 closed
  // in mint-token.ts. A PRESENT-but-blank value (`--purpose "$UNSET"`)
  // keeps its documented coercion to "default"; only the two shapes where
  // no value token exists at all are refused. `--org` needs no marker: an
  // unusable --org already fails the !org validation below.
  const purposeSlotRaw = argv[argv.indexOf("--purpose") + 1];
  // Trim before the flag-shape test, exactly like readFlag below: a purpose
  // slot that is a flag modulo surrounding whitespace (`--purpose
  // " --app-id-key "`) passed this RAW-token guard, then readFlag trimmed it
  // to a flag and returned undefined — so the purpose silently coerced to the
  // org-level CATCH-ALL row with exit 0, re-routing every future mint without
  // --purpose (#117 reopened through padding). A PRESENT-but-blank value
  // (`--purpose "$UNSET"`) still coerces to "default" by design; only the
  // flag-shaped shapes are refused.
  const purposeSlot =
    purposeSlotRaw === undefined ? undefined : purposeSlotRaw.trim();
  const org = readFlag(argv, "--org");
  // readFlag trims and maps empty/whitespace → undefined, so a missing OR
  // blank --purpose (e.g. `--purpose "$UNSET"`) coerces to the default rather
  // than persisting a purpose="" row that minting (DEFAULT_PURPOSE) never hits.
  const purpose = readFlag(argv, "--purpose") ?? DEFAULT_PURPOSE;
  if (
    argv.includes("--purpose") &&
    (purposeSlot === undefined || purposeSlot.startsWith("--"))
  ) {
    writers.err(
      "register-gh-app: register --purpose needs a value (e.g. --purpose reviewer)\n"
    );
    return 1;
  }
  const appIdKey = readFlag(argv, "--app-id-key");
  const privateKeyKey = readFlag(argv, "--private-key-key");

  if (!org || !appIdKey || !privateKeyKey) {
    writers.err(
      "register-gh-app: register requires --org, --app-id-key, and --private-key-key\n"
    );
    return 1;
  }
  // Validate the named env vars are actually present (never print their values),
  // so a typo in a key name fails loudly at registration rather than at mint time.
  const absent = [appIdKey, privateKeyKey].filter((key) => {
    const value = env[key];
    return value === undefined || value === "";
  });
  if (absent.length > 0) {
    writers.err(
      `register-gh-app: named env var(s) not set: ${absent.join(", ")}\n`
    );
    return 1;
  }
  // The row is keyed by `orgOf(org)` — `registerApp` normalizes before it
  // persists — so the confirmation must echo that same normalized org. Echoing
  // the raw `--org` argument (a URL-shaped spelling the CLI accepts) printed a
  // key the registry never holds, and the row `mint-token.ts --repo …` then
  // routed to looked unexplained when it did match.
  const normalizedOrg = orgOf(org);

  // A DB failure (corruption, permissions, locking) must not crash the CLI with
  // a stack trace — render a single-line diagnostic and exit non-zero instead.
  try {
    registerApp(db, {
      appIdKey,
      org,
      privateKeyKey,
      purpose,
    });
  } catch (error) {
    writers.err(
      `register-gh-app: failed to write registry: ${error instanceof Error ? error.message : String(error)}\n`
    );
    return 1;
  }
  writers.out(
    `registered ${normalizedOrg} (${purpose}) → ${appIdKey} / ${privateKeyKey}\n`
  );
  return 0;
};

/**
 * Run `list`. Returns the intended exit code; never throws. `argv` is the
 * FULL argv including the subcommand (the junk guard skips position 0).
 */
const runList = (
  db: Database,
  writers: RegisterWriters,
  argv: readonly string[]
): number => {
  // A single-dash or equals-form token is a usage error on the `list` path
  // too — the #155/#165 uniformity contract every sibling CLI (and this
  // CLI's own `register` path) already enforces. Pre-fix `list` ignored
  // junk argv entirely, so `register-gh-app list -verbose` listed happily
  // and a `--org=acme` paste silently did nothing — the typo'd flag
  // vanished with no diagnostic.
  const junkArgv = findJunkArgv(argv.slice(1));
  if (junkArgv !== undefined) {
    writers.err(
      `register-gh-app: unrecognized argument "${junkArgv}" — flags are space-separated "--org acme", never "--org=acme" or single-dash\n`
    );
    return 1;
  }
  let rows;
  try {
    rows = listApps(db);
  } catch (error) {
    writers.err(
      `register-gh-app: failed to read registry: ${error instanceof Error ? error.message : String(error)}\n`
    );
    return 1;
  }
  if (rows.length === 0) {
    writers.out(
      "(no registered apps — the bare default GH_APP_* is used everywhere)\n"
    );
    return 0;
  }
  for (const row of rows) {
    writers.out(
      `${row.org} (${row.purpose}) → ${row.appIdKey} / ${row.privateKeyKey}\n`
    );
  }
  return 0;
};

/** Dispatch a subcommand against an open DB. Exported for tests. */
export const runRegisterCli = (ctx: RegisterCliContext): number => {
  const [command] = ctx.argv;
  if (command === "register") {
    return runRegister({
      ...ctx,
      argv: ctx.argv.slice(1),
    });
  }
  if (command === "list") {
    return runList(ctx.db, ctx.writers, ctx.argv);
  }
  ctx.writers.err("register-gh-app: expected a subcommand: register | list\n");
  return 1;
};

if (import.meta.main) {
  // Opening the DB can itself throw (permissions, corrupt file, locking). Keep
  // the same "single-line diagnostic + non-zero exit" contract as the read/write
  // failures rather than crashing with a stack trace before the CLI even runs.
  let db: Database;
  try {
    db = openGhAppRegistryDb();
  } catch (error) {
    process.stderr.write(
      `register-gh-app: failed to open registry: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exit(1);
  }
  let code: number;
  try {
    code = runRegisterCli({
      argv: process.argv.slice(2),
      db,
      env: Bun.env,
      writers: {
        err: (text) => {
          process.stderr.write(text);
        },
        out: (text) => {
          process.stdout.write(text);
        },
      },
    });
  } finally {
    // Close inside finally, but only exit AFTER it: `process.exit` terminates
    // immediately and would otherwise skip the close, leaving the WAL/shm state
    // unflushed.
    db.close();
  }
  process.exit(code);
}
