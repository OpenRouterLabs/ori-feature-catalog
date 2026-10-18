import { Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import { discoverInstallationRepos } from "#src/repo/discover.ts";
import { describe, expect, it } from "#src/effect-bun-test.ts";

const github = (route: (url: string) => Response, requested: string[] = []) =>
  Layer.succeed(HttpClient.HttpClient)(
    HttpClient.make((request) =>
      Effect.sync(() => {
        requested.push(request.url);
        return HttpClientResponse.fromWeb(request, route(request.url));
      })
    )
  );

const json = (body: unknown): Response => new Response(JSON.stringify(body));

describe("discoverInstallationRepos", () => {
  it.effect("lists the installation's repositories, then crawls each owner once and merges what it finds", () => {
    const requested: string[] = [];
    return Effect.gen(function* () {
      const repos = yield* discoverInstallationRepos();
      expect(repos).toEqual(["acme/api", "acme/web"]);
      expect(requested).toEqual([
        "https://api.github.com/installation/repositories?per_page=100&page=1",
        "https://api.github.com/orgs/acme/repos?type=all&per_page=100&page=1",
      ]);
    }).pipe(
      Effect.provide(
        github(
          (url) =>
            url.includes("/installation/")
              ? json({
                  repositories: [
                    { full_name: "acme/web", owner: { login: "Acme", type: "Organization" }, pushed_at: "2026-10-01T00:00:00Z" },
                  ],
                })
              : json([{ full_name: "acme/api", pushed_at: "2026-10-02T00:00:00Z" }]),
          requested
        )
      )
    );
  });

  it.effect("offers nothing when GitHub refuses the installation listing", () =>
    Effect.gen(function* () {
      expect(yield* discoverInstallationRepos()).toEqual([]);
    }).pipe(Effect.provide(github(() => new Response("", { status: 401 }))))
  );
});
