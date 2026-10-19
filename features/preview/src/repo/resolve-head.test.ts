import { layer as BunServicesLayer } from "@effect/platform-bun/BunServices";
import { Effect, FileSystem, Layer, Option } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import {
  emptyProcessGroupsRecording,
  recordingProcessGroupsLayer,
} from "../process-groups/test-support.ts";
import { previewPaths, syncMarkerPath } from "../paths.ts";
import {
  checkedOutSha,
  hasCheckout,
  isTransientGithubFailure,
  resolveHead,
} from "./index.ts";
import { describe, expect, it } from "../effect-bun-test.ts";

const REPO = "acme/web";
const SHA = "0123456789abcdef0123456789abcdef01234567";

const fixture = (answer: () => Response, requested: string[] = [], recording = emptyProcessGroupsRecording()) =>
  Layer.mergeAll(
    BunServicesLayer,
    recordingProcessGroupsLayer(recording),
    Layer.succeed(HttpClient.HttpClient)(
      HttpClient.make((request) =>
        Effect.sync(() => {
          requested.push(request.url);
          return HttpClientResponse.fromWeb(request, answer());
        })
      )
    )
  );

describe("resolveHead", () => {
  it.effect("reads the default branch and its head commit", () =>
    Effect.gen(function* () {
      const answers = [{ default_branch: "trunk" }, { sha: SHA }];
      const requested: string[] = [];
      const head = yield* resolveHead(REPO).pipe(
        Effect.provide(
          fixture(
            () =>
              new Response(JSON.stringify(answers.shift()), {
                headers: { "content-type": "application/json" },
              }),
            requested
          )
        )
      );
      expect(head).toEqual({ branch: "trunk", sha: SHA });
      expect(requested.at(-1)).toBe(`https://api.github.com/repos/${REPO}/commits/trunk`);
    })
  );

  it.effect("names an unexpected GitHub reply", () =>
    Effect.gen(function* () {
      const error = yield* resolveHead(REPO).pipe(
        Effect.flip,
        Effect.provide(fixture(() => new Response(JSON.stringify({ name: "web" }))))
      );
      expect(error.detail).toContain("GitHub sent an unexpected reply");
    })
  );
});

describe("the synced checkout's markers", () => {
  it.effect("reads the commit the checkout was last synced to, and none before the first sync", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = previewPaths(yield* fs.makeTempDirectoryScoped());
      expect(Option.isNone(yield* checkedOutSha(paths, REPO))).toBe(true);
      yield* fs.makeDirectory(paths.synced, { recursive: true });
      yield* fs.writeFileString(syncMarkerPath(paths, REPO), `${SHA}\n`);
      expect(yield* checkedOutSha(paths, REPO)).toEqual(Option.some(SHA));
    }).pipe(Effect.scoped, Effect.provide(BunServicesLayer))
  );

  it.effect("counts only a non-empty directory as a checkout", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      expect(yield* hasCheckout(`${root}/missing`)).toBe(false);
      expect(yield* hasCheckout(root)).toBe(false);
      yield* fs.writeFileString(`${root}/package.json`, "{}");
      expect(yield* hasCheckout(root)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(BunServicesLayer))
  );
});

describe("isTransientGithubFailure", () => {
  it("treats server errors, 429, and an exhausted rate limit as transient, and other refusals as final", () => {
    expect(isTransientGithubFailure(502, {})).toBe(true);
    expect(isTransientGithubFailure(429, {})).toBe(true);
    expect(isTransientGithubFailure(403, { "x-ratelimit-remaining": "0" })).toBe(true);
    expect(isTransientGithubFailure(403, { "x-ratelimit-remaining": "12" })).toBe(false);
    expect(isTransientGithubFailure(404, {})).toBe(false);
  });
});
