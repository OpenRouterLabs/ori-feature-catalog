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

import {
  DEFAULT_PURPOSE,
  listApps,
  openGhAppRegistryDb,
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
  // A following token that is itself a flag means the value was omitted
  // (e.g. `--org --app-id-key X`) — treat it as absent so validation fails
  // cleanly instead of registering `--app-id-key` as the org.
  if (value === undefined || value.startsWith("--")) {
    return undefined;
  }
  // Trim so a stray-whitespace value (e.g. `--org "acme-corp "`) doesn't
  // persist a row minting can never match — mint derives its org via orgOf(),
  // which trims. An all-whitespace value trims to "" → treated as absent.
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
};

/** Run `register` (ctx.argv excludes the subcommand). Returns the exit code; never throws. */
const runRegister = (ctx: RegisterCliContext): number => {
  const { argv, db, env, writers } = ctx;
  const org = readFlag(argv, "--org");
  // readFlag trims and maps empty/whitespace → undefined, so a missing OR
  // blank --purpose (e.g. `--purpose "$UNSET"`) coerces to the default rather
  // than persisting a purpose="" row that minting (DEFAULT_PURPOSE) never hits.
  const purpose = readFlag(argv, "--purpose") ?? DEFAULT_PURPOSE;
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
    `registered ${org} (${purpose}) → ${appIdKey} / ${privateKeyKey}\n`
  );
  return 0;
};

/** Run `list`. Returns the intended exit code; never throws. */
const runList = (db: Database, writers: RegisterWriters): number => {
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
    return runList(ctx.db, ctx.writers);
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
