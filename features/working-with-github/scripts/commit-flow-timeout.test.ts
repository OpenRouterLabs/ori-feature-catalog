import { describe, expect, test } from "bun:test";
// commit-flow-timeout.test.ts — every Git-Data-API HTTP call of the commit
// flow (the ref read, the head-commit read, each blob POST, the tree POST, the
// commit POST, the ref PATCH) must carry a request deadline. Pre-fix NONE of
// them had one: a hung connection to api.github.com left `commit-via-api.ts`
// pending forever — after it had already minted a token (and possibly created
// blobs), with no diagnostic, no exit, and no way for the caller to tell a
// slow-but-working commit from a wedged one. Every sibling network path in
// this feature bounds its wait (the sweep's `PR_LOOKUP_TIMEOUT_MS`, the mint's
// `MINT_HTTP_TIMEOUT_MS`, the health check's two deadlines, the Slack alert
// post's `POST_ALERT_TIMEOUT_MS`); the commit flow is the feature's primary
// WRITE path and was the last unbounded one. The suite pins the wedge shape
// against a REAL clock (a fetch that never settles must FAIL the flow within
// the deadline) and the honest 4xx channel (a settled 404 keeps reporting its
// own status, which a deadline must never replace).
import { Effect } from "effect";

import type { RunGit } from "./commit-api-core.ts";
import { COMMIT_HTTP_TIMEOUT_MS } from "./commit-api-core.ts";
import { commitViaApi } from "./commit-flow.ts";

/** A fetch seam whose promise NEVER settles — the hung-connection shape. */
const neverFetch = (): Promise<Response> => new Promise<Response>(() => {});

const fakeRunGit: RunGit = (args) => {
  const key = args.slice(0, 2).join(" ");
  if (key === "status --porcelain=v1") {
    return { ok: true, stdout: "?? f.ts\0", stderr: "" };
  }
  return { ok: true, stdout: "", stderr: "" };
};

const WEDGE_MARGIN_MS = 5_000;

describe("the commit flow bounds every HTTP wait", () => {
  test(
    "a wedged ref read fails the flow within the deadline, never hangs",
    async () => {
      const startedAt = Date.now();
      const label = await Effect.runPromise(
        commitViaApi(
          { worktree: "/wt", branch: "b", message: "m", repo: "o/r" },
          {
            fetchImpl: neverFetch,
            readFile: async () => new ArrayBuffer(4),
            runGit: fakeRunGit,
            token: "tok",
          }
        ).pipe(
          Effect.match({
            onFailure: (error) => `stage=${error.stage} msg=${error.message}`,
            onSuccess: () => "succeeded",
          })
        )
      );
      const ms = Date.now() - startedAt;
      expect(label).toContain("stage=http");
      expect(label).toContain("did not answer within");
      expect(ms).toBeLessThan(COMMIT_HTTP_TIMEOUT_MS + WEDGE_MARGIN_MS);
    },
    (COMMIT_HTTP_TIMEOUT_MS + WEDGE_MARGIN_MS + 5_000) as never
  );

  test("the deadline preserves the honest failure channels", async () => {
    // A settled non-2xx keeps its own status in the message — the caller's
    // remediation (a 404 means a wrong repo/branch, a 422 a non-fast-forward)
    // must not be replaced by a timeout complaint.
    const label = await Effect.runPromise(
      commitViaApi(
        { worktree: "/wt", branch: "b", message: "m", repo: "o/r" },
        {
          fetchImpl: () =>
            Promise.resolve(
              new Response(JSON.stringify({ message: "Not Found" }), {
                status: 404,
              })
            ) as Promise<Response>,
          readFile: async () => new ArrayBuffer(4),
          runGit: fakeRunGit,
          token: "tok",
        }
      ).pipe(
        Effect.match({
          onFailure: (error) => `stage=${error.stage} msg=${error.message}`,
          onSuccess: () => "succeeded",
        })
      )
    );
    expect(label).toContain("stage=http");
    expect(label).toContain("Not Found");
    expect(label).not.toContain("did not answer within");
  });
});
