import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import type { GhAppError } from "./gh-app-github-api.ts";

import {
  discoverInstallationId,
  requestInstallationToken,
  resolveAllowedOrgs,
} from "./gh-app-github-api.ts";

type Outcome<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: GhAppError };

const runToOutcome = <A>(
  effect: Effect.Effect<A, GhAppError>
): Promise<Outcome<A>> =>
  Effect.runPromise(
    effect.pipe(
      Effect.match({
        onFailure: (error) => ({
          error,
          ok: false as const,
        }),
        onSuccess: (value) => ({
          ok: true as const,
          value,
        }),
      })
    )
  );

/** A `fetch` that always answers with the same JSON body and status. */
const constantFetch =
  (body: unknown, status = 200) =>
  (): Promise<Response> =>
    Promise.resolve(Response.json(body, { status }));

describe("requestInstallationToken response decoding", () => {
  test("a malformed required field fails op:parse and names the field", async () => {
    const outcome = await runToOutcome(
      requestInstallationToken(
        constantFetch(
          {
            expires_at: "2026-01-01T00:00:00Z",
            token: 42,
          },
          201
        ),
        "jwt",
        "1"
      )
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.op).toBe("parse");
      expect(outcome.error.message).toContain("token");
      expect(outcome.error.message).toContain("Expected string");
    }
  });

  test("an empty token is malformed, not a token", async () => {
    const outcome = await runToOutcome(
      requestInstallationToken(
        constantFetch(
          {
            expires_at: "x",
            token: "",
          },
          201
        ),
        "jwt",
        "1"
      )
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.op).toBe("parse");
      expect(outcome.error.message).toContain("token");
    }
  });

  test("a missing required field is named, and every bad field is reported", async () => {
    const outcome = await runToOutcome(
      requestInstallationToken(constantFetch({ token: 7 }, 201), "jwt", "1")
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.message).toContain("token");
      expect(outcome.error.message).toContain("expires_at");
    }
  });

  test("unknown extra fields GitHub adds are tolerated", async () => {
    const outcome = await runToOutcome(
      requestInstallationToken(
        constantFetch(
          {
            expires_at: "2026-01-01T00:00:00Z",
            permissions: { contents: "write" },
            repository_selection: "all",
            some_field_added_next_year: true,
            token: "ghs_ok",
          },
          201
        ),
        "jwt",
        "1"
      )
    );
    expect(outcome).toEqual({
      ok: true,
      value: {
        expiresAt: "2026-01-01T00:00:00Z",
        token: "ghs_ok",
      },
    });
  });

  test("a non-2xx still surfaces GitHub's own message as op:http with its status", async () => {
    const outcome = await runToOutcome(
      requestInstallationToken(
        constantFetch({ message: "Not Found" }, 404),
        "jwt",
        "1"
      )
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.op).toBe("http");
      expect(outcome.error.status).toBe(404);
      expect(outcome.error.message).toContain("Not Found");
    }
  });

  test("a non-2xx whose body is not the error envelope degrades to the status", async () => {
    const outcome = await runToOutcome(
      requestInstallationToken(constantFetch("plain text", 503), "jwt", "1")
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.op).toBe("http");
      expect(outcome.error.message).toContain("HTTP 503");
    }
  });

  test("a non-2xx whose body is not JSON at all degrades to op:http with its status", async () => {
    // The pre-fix body read failed op:parse ("was not JSON"), hiding the very
    // status the stale-installation retry in gh-app-token.ts matches on.
    const outcome = await runToOutcome(
      requestInstallationToken(
        constantFetch("Service Unavailable", 503),
        "jwt",
        "1"
      )
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.op).toBe("http");
      expect(outcome.error.status).toBe(503);
      expect(outcome.error.message).toContain("HTTP 503");
    }
  });

  test("an empty 0-byte 401 body still surfaces op:http 401 for the stale-installation retry", async () => {
    // Exactly the response a reinstalled App answers the cached-id POST with.
    const emptyFetch = (): Promise<Response> =>
      Promise.resolve(new Response("", { status: 401 }));
    const outcome = await runToOutcome(
      requestInstallationToken(emptyFetch, "jwt", "1")
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.op).toBe("http");
      expect(outcome.error.status).toBe(401);
      expect(outcome.error.message).toContain("HTTP 401");
    }
  });
});

describe("discoverInstallationId page decoding", () => {
  const allowed = new Set(["acme-interns"]);

  test("a malformed login fails op:parse naming the path, not the whole page", async () => {
    const outcome = await runToOutcome(
      discoverInstallationId(
        constantFetch([
          {
            account: { login: 7 },
            id: 1,
          },
        ]),
        "jwt",
        "acme-interns",
        allowed
      )
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.op).toBe("parse");
      expect(outcome.error.message).toContain("login");
      expect(outcome.error.message).toContain("account");
    }
  });

  test("unknown extra fields on an installation are tolerated", async () => {
    const outcome = await runToOutcome(
      discoverInstallationId(
        constantFetch([
          {
            account: {
              login: "acme-interns",
              type: "Organization",
            },
            app_slug: "some-app",
            id: 4242,
            target_type: "Organization",
          },
        ]),
        "jwt",
        "acme-interns",
        allowed
      )
    );
    expect(outcome).toEqual({
      ok: true,
      value: "4242",
    });
  });

  test("an account-less installation is skipped, not a decode failure", async () => {
    const outcome = await runToOutcome(
      discoverInstallationId(
        constantFetch([
          {
            account: null,
            id: 1,
          },
          {
            account: { login: "acme-interns" },
            id: 2,
          },
        ]),
        "jwt",
        "acme-interns",
        allowed
      )
    );
    expect(outcome).toEqual({
      ok: true,
      value: "2",
    });
  });

  test("a body that is not a page of installations fails op:parse", async () => {
    const outcome = await runToOutcome(
      discoverInstallationId(
        constantFetch({ message: "Bad credentials" }),
        "jwt",
        "acme-interns",
        allowed
      )
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.op).toBe("parse");
      expect(outcome.error.message).toContain("Expected array");
    }
  });
});

// ─── resolveAllowedOrgs ─────────────────────────────────────────────────────

describe("resolveAllowedOrgs", () => {
  test("derives the allowlist from a bare owner/repo GITHUB_REPO", async () => {
    const allowed = resolveAllowedOrgs(undefined, {
      GITHUB_REPO: "acme-corp/widgets",
    });
    expect(Array.from(allowed)).toEqual(["acme-corp"]);
  });

  test("derives the allowlist from a full https GITHUB_REPO URL", async () => {
    const allowed = resolveAllowedOrgs(undefined, {
      GITHUB_REPO: "https://github.com/acme-corp/widgets.git",
    });
    expect(Array.from(allowed)).toEqual(["acme-corp"]);
  });

  test("a bare organizations word derives no allowlist entry, like every sibling resolver", async () => {
    const allowed = resolveAllowedOrgs(undefined, {
      GITHUB_REPO: "organizations",
    });
    expect(Array.from(allowed)).toEqual([]);
  });

  test("explicit GH_APP_ALLOWED_ORGS still wins", async () => {
    const allowed = resolveAllowedOrgs(undefined, {
      GH_APP_ALLOWED_ORGS: "acme-corp, other-org",
      GITHUB_REPO: "https://github.com/acme-corp/widgets",
    });
    expect(Array.from(allowed)).toEqual(["acme-corp", "other-org"]);
  });
});
