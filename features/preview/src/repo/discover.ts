import { Effect, Option, Schema } from "effect";
import { HttpClient } from "effect/http";

import type { ConnectedRepos } from "#src/schemas.ts";

import { RepoNameSchema } from "#src/schemas.ts";
import { isOkStatus } from "#src/http.ts";

const INSTALLATION_REPOS_URL =
  "https://api.github.com/installation/repositories?per_page=100";

const PAGE_SIZE = 100;

const MAX_PAGES_PER_LISTING = 100;

const GitHubRepoSchema = Schema.Struct({
  full_name: Schema.String,
  archived: Schema.optionalKey(Schema.Boolean),
  pushed_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
  owner: Schema.optionalKey(
    Schema.Struct({
      login: Schema.String,
      type: Schema.optionalKey(Schema.String),
    })
  ),
});
type GitHubRepo = typeof GitHubRepoSchema.Type;

const InstallationReposSchema = Schema.Struct({
  repositories: Schema.Array(GitHubRepoSchema),
});
type InstallationRepos = typeof InstallationReposSchema.Type;

const OwnerReposSchema = Schema.Array(GitHubRepoSchema);
type OwnerRepos = typeof OwnerReposSchema.Type;

export type RepoOwner = {
  readonly login: string;
  readonly kind: "organization" | "user";
};

const isRepoName = Schema.is(RepoNameSchema);

export const rankInstallationRepos = (
  body: InstallationRepos
): ConnectedRepos =>
  body.repositories
    .filter((repo) => repo.archived !== true && isRepoName(repo.full_name))
    .toSorted((left, right) =>
      (right.pushed_at ?? "").localeCompare(left.pushed_at ?? "")
    )
    .map((repo) => repo.full_name.toLowerCase());

const fetchGitHubJson = Effect.fn("Preview.repo.discoverPage")(function* (
  url: string
) {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client
    .get(url, { headers: { accept: "application/vnd.github+json" } })
    .pipe(Effect.option);
  if (Option.isNone(response) || !isOkStatus(response.value.status)) {
    return Option.none<unknown>();
  }
  return yield* response.value.json.pipe(Effect.option);
});

export const ownerReposUrl = (owner: RepoOwner, page: number): string =>
  owner.kind === "organization"
    ? `https://api.github.com/orgs/${owner.login}/repos?type=all&per_page=${PAGE_SIZE}&page=${page}`
    : `https://api.github.com/users/${owner.login}/repos?type=owner&per_page=${PAGE_SIZE}&page=${page}`;

const ownerOf = (repo: GitHubRepo): Option.Option<RepoOwner> => {
  const login = (repo.owner?.login ?? repo.full_name.split("/")[0] ?? "")
    .trim()
    .toLowerCase();
  if (login.length === 0 || !repo.full_name.includes("/")) {
    return Option.none();
  }
  return Option.some({
    login,
    kind: repo.owner?.type === "User" ? "user" : "organization",
  });
};

export const installationOwners = (
  body: InstallationRepos
): readonly RepoOwner[] => [
  ...new Map(
    body.repositories
      .map(ownerOf)
      .filter(Option.isSome)
      .map((owner) => [owner.value.login, owner.value] as const)
  ).values(),
];

export const unionInstallationAndOwnerRepos = (
  installation: InstallationRepos,
  ownerRepos: readonly OwnerRepos[]
): ConnectedRepos =>
  rankInstallationRepos({
    repositories: [
      ...new Map(
        [...installation.repositories, ...ownerRepos.flat()].map(
          (repo) => [repo.full_name.toLowerCase(), repo] as const
        )
      ).values(),
    ],
  });

export type ListingCrawl = {
  readonly repositories: readonly GitHubRepo[];
  readonly truncated: boolean;
};

export const collectPages = Effect.fn("Preview.repo.discoverPages")(function* (
  listing: string,
  maxPages: number,
  fetchPage: (
    page: number
  ) => Effect.Effect<Option.Option<OwnerRepos>, never, HttpClient.HttpClient>
) {
  const collected: GitHubRepo[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const body = yield* fetchPage(page);
    if (Option.isNone(body) || body.value.length === 0) {
      return { repositories: collected, truncated: false };
    }
    collected.push(...body.value);
    if (body.value.length < PAGE_SIZE) {
      return { repositories: collected, truncated: false };
    }
  }
  yield* Effect.logWarning(
    `Preview repo discovery stopped listing ${listing} at its ${maxPages}-page limit; repositories past ${collected.length} are not offered for previews.`
  );
  return { repositories: collected, truncated: true } satisfies ListingCrawl;
});

const fetchInstallationPage = (page: number) =>
  fetchGitHubJson(`${INSTALLATION_REPOS_URL}&page=${page}`).pipe(
    Effect.map((body) =>
      Option.flatMap(body, Schema.decodeUnknownOption(InstallationReposSchema))
    ),
    Effect.map(Option.map((body) => body.repositories))
  );

const fetchOwnerPage = (owner: RepoOwner) => (page: number) =>
  fetchGitHubJson(ownerReposUrl(owner, page)).pipe(
    Effect.map((body) =>
      Option.flatMap(body, Schema.decodeUnknownOption(OwnerReposSchema))
    )
  );

export const discoverInstallationRepos = Effect.fn(
  "Preview.repo.discoverInstallation"
)(function* () {
  const installation = yield* collectPages(
    "the installation's repositories",
    MAX_PAGES_PER_LISTING,
    fetchInstallationPage
  );
  const ownerRepos = yield* Effect.forEach(
    installationOwners(installation),
    (owner) =>
      collectPages(
        `${owner.login}'s repositories`,
        MAX_PAGES_PER_LISTING,
        fetchOwnerPage(owner)
      ).pipe(Effect.map((crawl) => crawl.repositories)),
    { concurrency: "unbounded" }
  );
  return unionInstallationAndOwnerRepos(installation, ownerRepos);
});
