import { PREVIEW_SANDBOX_ROOT, previewPaths } from "#src/paths.ts";
import { describe, expect, it } from "#src/effect-bun-test.ts";

describe("previewPaths", () => {
  const paths = previewPaths("/workspace");

  it("puts everything repository code touches under the sandbox root, outside the root-only workspace", () => {
    expect(PREVIEW_SANDBOX_ROOT).toBe("/preview");
    expect([
      paths.repos,
      paths.work,
      paths.home,
      paths.browserProfile,
      paths.scratch,
    ]).toEqual([
      "/preview/repos",
      "/preview/work",
      "/preview/home",
      "/preview/chromium-profile",
      "/preview/scratch",
    ]);
  });

  it("keeps state repository code must not rewrite in the workspace", () => {
    expect([
      paths.status,
      paths.logs,
      paths.recipes,
      paths.synced,
      paths.shots,
    ]).toEqual([
      "/workspace/.ori/preview/status",
      "/workspace/.ori/preview/logs",
      "/workspace/.ori/preview/recipes",
      "/workspace/.ori/preview/synced",
      "/workspace/preview-shots",
    ]);
  });
});
