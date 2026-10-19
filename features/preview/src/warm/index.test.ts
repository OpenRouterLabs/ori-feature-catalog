import type { PreviewStatus } from "../schemas.ts";

import { PREVIEW_ENABLED_ENV, PREVIEW_REPOS_ENV } from "../paths.ts";
import {
  configuredRepos,
  pickWarmSet,
  previewEnabledInEnv,
  sweepCandidates,
} from "./index.ts";
import { describe, expect, it } from "../effect-bun-test.ts";

const status = (repo: string, lastUsedAt?: string): PreviewStatus => ({
  repo,
  phase: "parked",
  lastUsedAt,
  updatedAt: "2026-09-26T00:00:00.000Z",
});

describe("configuredRepos", () => {
  it("rejects an owner with underscores, as GitHub does, so two repositories can never share a folder name", () => {
    expect(configuredRepos({ [PREVIEW_REPOS_ENV]: "a__b/c, a/b__c" })).toEqual([
      "a/b__c",
    ]);
  });

  it("accepts commas, spaces, and newlines, lowercases, and drops duplicates", () => {
    expect(
      configuredRepos({
        [PREVIEW_REPOS_ENV]: "Acme/Web, acme/web\nacme/api  acme/docs",
      })
    ).toEqual(["acme/web", "acme/api", "acme/docs"]);
  });

  it("drops entries that are not owner/name so a bad metadata value cannot become a path", () => {
    expect(
      configuredRepos({ [PREVIEW_REPOS_ENV]: "acme/web,../etc,acme/a/b,acme" })
    ).toEqual(["acme/web"]);
  });

  it("is empty when the platform sent no list, so repos come from the GitHub installation instead", () => {
    expect(configuredRepos({})).toEqual([]);
  });
});

describe("previewEnabledInEnv", () => {
  it("is off by default, so an intern the platform has not opted in never runs repository code", () => {
    expect(previewEnabledInEnv({})).toBe(false);
  });

  it("turns on for the platform's enable flag alone", () => {
    expect(previewEnabledInEnv({ [PREVIEW_ENABLED_ENV]: "1" })).toBe(true);
  });

  it("turns on for an explicit repo list, which also pins which repos are warmed", () => {
    expect(previewEnabledInEnv({ [PREVIEW_REPOS_ENV]: "acme/web" })).toBe(true);
  });

  it("stays off for any enable value other than 1", () => {
    expect(previewEnabledInEnv({ [PREVIEW_ENABLED_ENV]: "true" })).toBe(false);
  });
});

describe("pickWarmSet", () => {
  it("keeps the most recently used repos warm, up to the limit", () => {
    expect(
      pickWarmSet(
        ["acme/a", "acme/b", "acme/c"],
        [
          status("acme/a", "2026-09-20T00:00:00.000Z"),
          status("acme/c", "2026-09-25T00:00:00.000Z"),
        ],
        2
      )
    ).toEqual(["acme/c", "acme/a"]);
  });

  it("falls back to the platform's order for repos nobody has used yet, so the first connected repo warms first", () => {
    expect(pickWarmSet(["acme/a", "acme/b", "acme/c"], [], 2)).toEqual([
      "acme/a",
      "acme/b",
    ]);
  });

  it("never warms a repo that is no longer connected, even if it was used most recently", () => {
    expect(
      pickWarmSet(
        ["acme/a"],
        [status("acme/gone", "2026-09-26T00:00:00.000Z")],
        2
      )
    ).toEqual(["acme/a"]);
  });
});

describe("sweepCandidates", () => {
  it("warms nothing a person has not chosen, so a push to an installed repo never runs its code on its own", () => {
    expect(sweepCandidates({}, [status("acme/c")])).toEqual([]);
  });

  it("keeps warm the repos the intern has previewed on request, without asking GitHub for the installation's list every minute", () => {
    expect(
      sweepCandidates({}, [
        status("acme/b", "2026-09-25T00:00:00.000Z"),
        status("acme/c"),
      ])
    ).toEqual(["acme/b"]);
  });

  it("warms the platform's explicit list, since an admin chose those repos", () => {
    expect(sweepCandidates({ [PREVIEW_REPOS_ENV]: "acme/z" }, [])).toEqual([
      "acme/z",
    ]);
  });
});
