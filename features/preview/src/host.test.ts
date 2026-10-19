import { describe, expect, it } from "bun:test";

import { scriptedDaemonCredentials } from "./daemon-credentials/test-support.ts";
import { PREVIEW_SCHEDULE_CRON } from "./feature.ts";
import {
  makePreviewContributions,
  previewEnabled,
  previewHosted,
  previewHostLayer,
  previewWorkspaceRoot,
} from "./host.ts";

const hostedEnv = { ORI_INTERN_PACKED: "1", ORI_PREVIEW_ENABLED: "1" };

describe("previewHosted", () => {
  it("calls a packed intern hosted", () => {
    expect(previewHosted({ ORI_INTERN_PACKED: "1" })).toBe(true);
  });

  it("calls a daemon with a credential hosted", () => {
    expect(previewHosted({ ORI_DAEMON_TOKEN: "token" })).toBe(true);
  });

  it("does not call a local run with a blank credential hosted", () => {
    expect(previewHosted({ ORI_DAEMON_TOKEN: "  " })).toBe(false);
  });
});

describe("previewEnabled", () => {
  it("stays off on a local run even with the enable flag, so a laptop never runs repository code", () => {
    expect(previewEnabled({ ORI_PREVIEW_ENABLED: "1" })).toBe(false);
  });

  it("stays off on a hosted intern the platform has not opted in", () => {
    expect(previewEnabled({ ORI_INTERN_PACKED: "1" })).toBe(false);
  });

  it("turns on for a hosted intern with the enable flag", () => {
    expect(previewEnabled(hostedEnv)).toBe(true);
  });
});

describe("previewWorkspaceRoot", () => {
  it("prefers the intern workspace root", () => {
    expect(
      previewWorkspaceRoot({ ORI_INTERN_WORKSPACE_ROOT: "/workspace" }, "/cwd")
    ).toBe("/workspace");
  });

  it("falls back to the working directory", () => {
    expect(previewWorkspaceRoot({ ORI_INTERN_WORKSPACE_ROOT: "" }, "/cwd")).toBe(
      "/cwd"
    );
  });
});

describe("makePreviewContributions", () => {
  const layer = previewHostLayer(scriptedDaemonCredentials);

  it("contributes nothing when previews are off", async () => {
    const contributions = await makePreviewContributions({
      cwd: "/cwd",
      defineTool: (spec) => spec.name,
      env: {},
      layer,
    });
    expect(contributions).toEqual({ schedule: undefined, tools: [] });
  });

  it("contributes the four tools and the warm-up schedule when previews are on", async () => {
    const contributions = await makePreviewContributions({
      cwd: "/cwd",
      defineTool: (spec) => spec.name,
      env: hostedEnv,
      layer,
    });
    expect(contributions.tools).toEqual([
      "preview-status",
      "preview-warm",
      "preview-screenshot",
      "preview-save-recipe",
    ]);
    expect(contributions.schedule?.cron).toBe(PREVIEW_SCHEDULE_CRON);
  });
});
