import { Effect } from "effect";

import {
  collectPages,
  installationOwners,
  ownerReposUrl,
  rankInstallationRepos,
  unionInstallationAndOwnerRepos,
} from "./discover.ts";
import { fetchHttpClientLayer } from "../http.ts";
import { describe, expect, it } from "../effect-bun-test.ts";

describe("rankInstallationRepos", () => {
  it("orders the installation's repos by most recent push, so the repo people are working in warms first", () => {
    expect(
      rankInstallationRepos({
        repositories: [
          { full_name: "Acme/Docs", pushed_at: "2026-01-01T00:00:00Z" },
          { full_name: "acme/web", pushed_at: "2026-09-25T00:00:00Z" },
          { full_name: "acme/api", pushed_at: "2026-09-20T00:00:00Z" },
        ],
      })
    ).toEqual(["acme/web", "acme/api", "acme/docs"]);
  });

  it("skips archived repos, which nobody is changing", () => {
    expect(
      rankInstallationRepos({
        repositories: [
          {
            full_name: "acme/old",
            archived: true,
            pushed_at: "2026-09-26T00:00:00Z",
          },
          { full_name: "acme/web", pushed_at: null },
        ],
      })
    ).toEqual(["acme/web"]);
  });
});

describe("installationOwners", () => {
  it("derives one lowercase owner per login, so each owner is crawled once", () => {
    expect(
      installationOwners({
        repositories: [
          { full_name: "OpenRouterInterns/tally" },
          { full_name: "openrouterinterns/redberry" },
          { full_name: "acme/api" },
        ],
      })
    ).toEqual([
      { login: "openrouterinterns", kind: "organization" },
      { login: "acme", kind: "organization" },
    ]);
  });

  it("marks a personal-account owner as a user, so its repos are crawled through the user endpoint", () => {
    expect(
      installationOwners({
        repositories: [
          {
            full_name: "Alice/project-a",
            owner: { login: "Alice", type: "User" },
          },
          {
            full_name: "acme/api",
            owner: { login: "acme", type: "Organization" },
          },
        ],
      })
    ).toEqual([
      { login: "alice", kind: "user" },
      { login: "acme", kind: "organization" },
    ]);
  });

  it("drops a malformed name without an owner segment", () => {
    expect(
      installationOwners({ repositories: [{ full_name: "tally" }] })
    ).toEqual([]);
  });
});

describe("ownerReposUrl", () => {
  it("lists every readable repo of an organization", () => {
    expect(ownerReposUrl({ login: "acme", kind: "organization" }, 11)).toBe(
      "https://api.github.com/orgs/acme/repos?type=all&per_page=100&page=11"
    );
  });

  it("lists a personal account's own repos through the user endpoint, which GitHub's org endpoint 404s on", () => {
    expect(ownerReposUrl({ login: "alice", kind: "user" }, 1)).toBe(
      "https://api.github.com/users/alice/repos?type=owner&per_page=100&page=1"
    );
  });
});

describe("unionInstallationAndOwnerRepos", () => {
  it("merges owner-crawled repos with the installation list, deduplicated and re-ranked by push", () => {
    expect(
      unionInstallationAndOwnerRepos(
        {
          repositories: [
            { full_name: "acme/web", pushed_at: "2026-09-25T00:00:00Z" },
          ],
        },
        [
          [
            {
              full_name: "Acme/Secret-Tool",
              pushed_at: "2026-10-01T00:00:00Z",
            },
            { full_name: "other/cli", pushed_at: "2026-08-01T00:00:00Z" },
          ],
        ]
      )
    ).toEqual(["acme/secret-tool", "acme/web", "other/cli"]);
  });

  it("keeps the later owner-crawl entry for a repo both lists name, so a push or archive between the two requests wins", () => {
    expect(
      unionInstallationAndOwnerRepos(
        {
          repositories: [
            { full_name: "acme/app", pushed_at: "2026-10-05T00:00:00Z" },
            { full_name: "acme/web", pushed_at: "2026-10-06T00:00:00Z" },
            { full_name: "acme/old", pushed_at: "2026-10-07T00:00:00Z" },
          ],
        },
        [
          [
            { full_name: "Acme/App", pushed_at: "2026-10-08T00:00:00Z" },
            {
              full_name: "acme/old",
              archived: true,
              pushed_at: "2026-10-07T00:00:00Z",
            },
          ],
        ]
      )
    ).toEqual(["acme/app", "acme/web"]);
  });

  it("keeps the installation list when every owner crawl fails, so a proxy that authenticates only installation listing still warms repos", () => {
    expect(
      unionInstallationAndOwnerRepos(
        {
          repositories: [
            { full_name: "acme/web", pushed_at: "2026-09-25T00:00:00Z" },
          ],
        },
        []
      )
    ).toEqual(["acme/web"]);
  });
});

const fullPage = (page: number) =>
  Array.from({ length: 100 }, (_, index) => ({
    full_name: `acme/repo-${page}-${index}`,
  }));

describe("collectPages", () => {
  it.effect(
    "follows a listing past ten pages until a short page, so owners beyond the first thousand repos are still found",
    () =>
      Effect.gen(function* () {
        const crawl = yield* collectPages("acme", 100, (page) =>
          Effect.succeedSome(
            page < 12 ? fullPage(page) : [{ full_name: "acme/last" }]
          )
        );
        expect(crawl.repositories).toHaveLength(1101);
        expect(crawl.truncated).toBe(false);
      }).pipe(Effect.provide(fetchHttpClientLayer))
  );

  it.effect(
    "reports a listing still full at its page limit as truncated instead of returning it as complete",
    () =>
      Effect.gen(function* () {
        const crawl = yield* collectPages("acme", 3, (page) =>
          Effect.succeedSome(fullPage(page))
        );
        expect(crawl.repositories).toHaveLength(300);
        expect(crawl.truncated).toBe(true);
      }).pipe(Effect.provide(fetchHttpClientLayer))
  );
});
