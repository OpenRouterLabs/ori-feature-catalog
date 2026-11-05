import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openGhAppRegistryDb } from "./gh-app-registry.ts";

/**
 * Regression: `openGhAppRegistryDb` ran `PRAGMA journal_mode = WAL` BEFORE it
 * armed `busy_timeout`, so the pragma ran with SQLite's default timeout of 0.
 * A DB file is still in rollback-journal mode until its first opener converts
 * it, and converting needs the other connections to let go of the file: when
 * two processes open a fresh registry at once (a mint's registry lookup
 * beside a cache put, or `register-gh-app` beside a mint), the second failed
 * at once with "database is locked": `register-gh-app` exits with that
 * error, and a mint drops its registry lookup ("treating it as unregistered")
 * or its installation-cache write. Reproduced with 12 concurrent first opens
 * of one fresh registry dir: 22 of 72 threw; with busy_timeout armed first,
 * none did.
 */

const HOLD_MS = 400;

/**
 * Hold a read transaction on `path` from another process, in rollback mode as
 * a fresh DB is: the shared lock a concurrent opener holds while it reads the
 * schema. Converting to WAL needs it released, so the opener must wait.
 */
const holdReadLock = async (path: string) => {
  const holder = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const { Database } = require("bun:sqlite");
       const db = new Database(${JSON.stringify(path)});
       db.run("CREATE TABLE IF NOT EXISTS hold (x)");
       db.run("BEGIN");
       db.query("SELECT count(*) FROM hold").get();
       console.log("holding");
       await Bun.sleep(${HOLD_MS});
       db.run("COMMIT");`,
    ],
    { stdout: "pipe" }
  );
  const reader = holder.stdout.getReader();
  const { value } = await reader.read();
  expect(new TextDecoder().decode(value)).toContain("holding");
  reader.releaseLock();
  return holder;
};

describe("openGhAppRegistryDb on a fresh DB another process is reading", () => {
  let dir = "";
  let previousDir: string | undefined;

  beforeEach(() => {
    previousDir = process.env.GH_APP_REGISTRY_DIR;
    dir = mkdtempSync(join(tmpdir(), "wwg-first-open-"));
  });

  afterEach(() => {
    if (previousDir === undefined) {
      delete process.env.GH_APP_REGISTRY_DIR;
    } else {
      process.env.GH_APP_REGISTRY_DIR = previousDir;
    }
    rmSync(dir, { force: true, recursive: true });
  });

  test("the default registry path waits for the lock and converts to WAL", async () => {
    process.env.GH_APP_REGISTRY_DIR = dir;
    const holder = await holdReadLock(join(dir, "gh-app-registry.db"));
    const db = openGhAppRegistryDb();
    try {
      expect(
        db.query<{ readonly journal_mode: string }, []>("PRAGMA journal_mode").get()
          ?.journal_mode
      ).toBe("wal");
    } finally {
      db.close();
      await holder.exited;
    }
  });

  test("an explicit path waits for the lock too", async () => {
    const path = join(dir, "explicit.db");
    const holder = await holdReadLock(path);
    const db = openGhAppRegistryDb(path);
    try {
      expect(
        db.query<{ readonly journal_mode: string }, []>("PRAGMA journal_mode").get()
          ?.journal_mode
      ).toBe("wal");
    } finally {
      db.close();
      await holder.exited;
    }
  });
});
