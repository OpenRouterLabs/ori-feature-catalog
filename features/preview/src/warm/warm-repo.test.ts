import { Option } from "effect";

import type { PreviewStatus } from "#src/schemas.ts";

import { failedRecentlyAtHead, needsInstall } from "#src/warm/warm-repo.ts";
import { describe, expect, it } from "#src/effect-bun-test.ts";

const installed = Option.some<PreviewStatus>({
  repo: "acme/web",
  phase: "parked",
  installedSha: "abc",
  updatedAt: "2026-09-26T00:00:00.000Z",
});

describe("needsInstall", () => {
  it("installs a checkout downloaded from scratch even when an install is on record, since that install went with the lost tree", () => {
    expect(needsInstall(installed, { changedFiles: [], isFresh: true })).toBe(
      true
    );
  });

  it("installs when a lockfile changed", () => {
    expect(
      needsInstall(installed, {
        changedFiles: ["package-lock.json"],
        isFresh: false,
      })
    ).toBe(true);
  });

  it("skips the install for an unchanged checkout that was installed before", () => {
    expect(needsInstall(installed, { changedFiles: [], isFresh: false })).toBe(
      false
    );
  });

  it("installs a repo that has never been installed", () => {
    expect(
      needsInstall(Option.none(), { changedFiles: [], isFresh: false })
    ).toBe(true);
  });
});

describe("failedRecentlyAtHead", () => {
  const failed = (updatedAt: string) =>
    Option.some<PreviewStatus>({
      repo: "acme/web",
      phase: "not_runnable",
      headSha: "abc",
      updatedAt,
    });
  const now = Date.parse("2026-09-26T12:00:00.000Z");

  it("holds the sweep off a commit that just failed, so it does not loop", () => {
    expect(
      failedRecentlyAtHead(failed("2026-09-26T11:50:00.000Z"), "abc", now)
    ).toBe(true);
  });

  it("lets the sweep retry after half an hour, so a transient failure does not stick until the next push", () => {
    expect(
      failedRecentlyAtHead(failed("2026-09-26T11:00:00.000Z"), "abc", now)
    ).toBe(false);
  });

  it("does not hold off a new commit", () => {
    expect(
      failedRecentlyAtHead(failed("2026-09-26T11:50:00.000Z"), "def", now)
    ).toBe(false);
  });
});
