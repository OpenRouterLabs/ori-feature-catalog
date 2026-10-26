import { describe, expect, test } from "bun:test";
// discoverInstallationId's empty-org fallback fails with one of two messages,
// and BOTH used to instruct the operator to "set GITHUB_REPO" — a dead end
// whenever the var is already SET to a spelling that resolves to no org (the
// orgs-page INDEX URL, a bare `organizations` word), the exact input that most
// needs the diagnostic. The same "never claim a populated env var is unset"
// discipline #207 pinned for the sibling CLI diagnostics, one layer deeper:
// the library message must name the spelling when the var is set-but-orgless,
// and keep the honest "set GITHUB_REPO" guidance only for the genuinely unset
// case. Message-only — the removal/retry behavior is pinned unchanged below.
import { generateKeyPairSync } from "node:crypto";

import { Effect } from "effect";

import {
  discoverInstallationId,
  GhAppError,
  signAppJwt,
} from "./gh-app-github-api.ts";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
// signAppJwt base64-decodes the key to its PEM text before signing.
const PEM = Buffer.from(
  privateKey.export({ format: "pem", type: "pkcs1" })
).toString("base64");

/** A fetch whose single installations page answers `installations`. */
const pageOf = (
  installations: ReadonlyArray<{ id: number; login: string }>
): ((url: string) => Promise<Response>) =>
  async () => Response.json(installations.map(({ id, login }) => ({ account: { login }, id })));

const discoverError = async (input: {
  readonly envRepo?: string | undefined;
  readonly installations: ReadonlyArray<{ id: number; login: string }>;
  readonly org?: string;
}): Promise<GhAppError | undefined> => {
  const previous = process.env.GITHUB_REPO;
  try {
    if (input.envRepo === undefined) {
      delete process.env.GITHUB_REPO;
    } else {
      process.env.GITHUB_REPO = input.envRepo;
    }
    const jwt = await Effect.runPromise(
      signAppJwt(
        { appId: "111", org: input.org ?? "", privateKeyBase64: PEM },
        Math.floor(Date.now() / 1000)
      )
    );
    const outcome = await Effect.runPromise(
      discoverInstallationId(pageOf(input.installations), jwt, input.org ?? "", new Set(["acme", "other"])).pipe(
        Effect.match({
          onFailure: (error) => error,
          onSuccess: () => undefined,
        })
      )
    );
    return outcome;
  } finally {
    if (previous === undefined) {
      delete process.env.GITHUB_REPO;
    } else {
      process.env.GITHUB_REPO = previous;
    }
  }
};

describe("discoverInstallationId empty-org fallback diagnostics", () => {
  test("an UNSET GITHUB_REPO keeps the honest 'set GITHUB_REPO' guidance", async () => {
    const error = await discoverError({
      envRepo: undefined,
      installations: [],
    });
    expect(error?.message).toContain("set GITHUB_REPO so its org can be matched");
    expect(error?.message).not.toContain("resolves to no GitHub org");
  });

  test("a SET-but-orgless GITHUB_REPO names its spelling, never claims it is unset", async () => {
    const error = await discoverError({
      envRepo: "https://github.com/orgs",
      installations: [],
    });
    expect(error?.message).toContain('GITHUB_REPO "https://github.com/orgs"');
    expect(error?.message).toContain("resolves to no GitHub org");
    expect(error?.message).not.toContain("set GITHUB_REPO");
  });

  test("the ambiguous-installations message names the spelling too", async () => {
    const error = await discoverError({
      envRepo: "organizations",
      installations: [
        { id: 1, login: "acme" },
        { id: 2, login: "other" },
      ],
    });
    expect(error?.message).toContain("GitHub App has 2 installations (acme, other)");
    expect(error?.message).toContain('GITHUB_REPO "organizations"');
    expect(error?.message).toContain("resolves to no GitHub org");
    expect(error?.message).not.toContain("set GITHUB_REPO");
  });

  test("an UNSET GITHUB_REPO keeps the honest ambiguous-installations guidance", async () => {
    const error = await discoverError({
      envRepo: undefined,
      installations: [
        { id: 1, login: "acme" },
        { id: 2, login: "other" },
      ],
    });
    expect(error?.message).toContain("set GITHUB_REPO or target a repo");
    expect(error?.message).not.toContain("resolves to no GitHub org");
  });

  test("behavior unchanged: the sole allowlisted installation still mints", async () => {
    const previous = process.env.GITHUB_REPO;
    try {
      process.env.GITHUB_REPO = "https://github.com/orgs";
      const jwt = await Effect.runPromise(
        signAppJwt(
          { appId: "111", org: "", privateKeyBase64: PEM },
          Math.floor(Date.now() / 1000)
        )
      );
      const id = await Effect.runPromise(
        discoverInstallationId(pageOf([{ id: 7, login: "acme" }]), jwt, "", new Set(["acme"]))
      );
      expect(id).toBe("7");
    } finally {
      if (previous === undefined) {
        delete process.env.GITHUB_REPO;
      } else {
        process.env.GITHUB_REPO = previous;
      }
    }
  });
});
