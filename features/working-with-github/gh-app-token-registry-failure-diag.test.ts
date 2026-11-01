import { describe, expect, test } from "bun:test";
// A registry lookup that THROWS (unreadable/unopenable DB) degrades to "no
// registered app" so the default path keeps working, and says so on stderr.
// Since the default App's token became the host-rotated GH_TOKEN, that stderr
// note must not still claim a fallback to "the default GH_APP_*" — the very
// next line routes to GH_TOKEN, so the operator read two contradictory
// routing decisions for one call. The note names the failure and leaves the
// route to the line that actually takes it.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "scripts", "mint-token.ts");

describe("a failed registry lookup on the rotated-token path", () => {
  test("stderr names the failure and the GH_TOKEN route, never a GH_APP_* fallback it does not take", () => {
    const dir = mkdtempSync(join(tmpdir(), "wwg-regdiag-"));
    const file = join(dir, "not-a-dir");
    writeFileSync(file, "");
    const run = Bun.spawnSync(
      ["bun", SCRIPT, "--repo", "owner/x", "--purpose", "reviewer"],
      {
        env: {
          GH_APP_ID: "1",
          GH_APP_REGISTRY_DIR: join(file, "registry"),
          GH_TOKEN: "ghs_rotated",
          GITHUB_REPO: "owner/repo",
          HOME: dir,
          PATH: process.env.PATH ?? "",
        },
      }
    );
    const stderr = run.stderr.toString();
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).toBe("ghs_rotated\n");
    expect(stderr).toContain("registry lookup for owner (reviewer) failed (");
    expect(stderr).toContain("using the host-rotated GH_TOKEN");
    expect(stderr).not.toContain("falling back to the default GH_APP_*");
  });
});
