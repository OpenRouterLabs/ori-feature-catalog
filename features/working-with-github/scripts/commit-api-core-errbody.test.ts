// Reproduction + fix-proof: a NON-JSON error body on a GitHub API call must
// surface the HTTP status (stage "http" with `status`, message naming the
// code), not fail as a "response was not JSON" complaint. Same bug class fixed
// for the mint path in gh-app-github-api.ts (readBodyJson, upstream #73) —
// ghJson had the identical defect.
import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import type { FetchLike } from "./commit-api-core.ts";
import { ghJson } from "./commit-api-core.ts";

const S = Schema.Struct({ sha: Schema.NonEmptyString });

interface Observed {
  readonly stage?: string;
  readonly status?: number;
  readonly message?: string;
}

/** Fold the Effect failure channel into a plain CommitApiError-shaped object. */
const fold = async (
  input: FetchLike,
  url: string
): Promise<{ ok: boolean; error?: Observed }> => {
  const exit = await Effect.runPromiseExit(
    ghJson({ fetchImpl: input, token: "t", method: "GET", url, schema: S })
  );
  if (exit._tag === "Success") {
    return { ok: true };
  }
  const cause = exit.cause as unknown as {
    reasons?: Array<{ error?: Observed }>;
  };
  const error: Observed | undefined = cause.reasons?.[0]?.error;
  return {
    ok: false,
    error: {
      stage: error?.stage,
      status: error?.status,
      message: error?.message,
    },
  };
};

describe("ghJson error bodies", () => {
  test("a 502 HTML body surfaces status 502, not a JSON parse complaint", async () => {
    const fake: FetchLike = async () =>
      new Response("<html><body>502 Bad Gateway</body></html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      });
    const out = await fold(fake, "https://api.github.com/repos/o/r/git/ref/heads/main");
    expect(out.ok).toBe(false);
    expect(out.error?.stage).toBe("http");
    expect(out.error?.status).toBe(502);
    expect(out.error?.message).toContain("502");
  });

  test("a 404 JSON error body still carries GitHub's own message", async () => {
    const fake: FetchLike = async () =>
      Response.json({ message: "Not Found" }, { status: 404 });
    const out = await fold(fake, "https://api.github.com/repos/o/r/git/ref/heads/main");
    expect(out.ok).toBe(false);
    expect(out.error?.stage).toBe("http");
    expect(out.error?.status).toBe(404);
    expect(out.error?.message).toContain("Not Found");
  });

  test("a 2xx with a non-JSON body still fails with a typed parse stage", async () => {
    const fake: FetchLike = async () =>
      new Response("not json at all", { status: 200 });
    const out = await fold(fake, "https://api.github.com/x");
    expect(out.ok).toBe(false);
    expect(out.error?.stage).toBe("parse");
  });
});
