import type { PackageJson } from "./heuristic.ts";

import {
  detectPackageManager,
  heuristicRecipe,
  pinnedPort,
  takesPortFlag,
} from "./heuristic.ts";
import {
  describe,
  expect,
  it,
  test,
} from "../effect-bun-test.ts";

const nextApp: PackageJson = {
  scripts: { dev: "next dev", build: "next build" },
  dependencies: { next: "15.0.0", react: "19.0.0" },
};

describe("heuristicRecipe", () => {
  it("runs the dev script through a pinned pnpm the lockfile names, with the assigned port as a flag", () => {
    expect(heuristicRecipe(new Set(["pnpm-lock.yaml"]), nextApp)).toEqual({
      kind: "recipe",
      recipe: {
        install: "npx --yes pnpm@9.15.9 install",
        dev: "npx --yes pnpm@9.15.9 run dev --port {port}",
      },
    });
  });

  it("puts npm's -- before the port flag so npm hands it to the script", () => {
    expect(heuristicRecipe(new Set(["package-lock.json"]), nextApp)).toEqual({
      kind: "recipe",
      recipe: { install: "npm install", dev: "npm run dev -- --port {port}" },
    });
  });

  it("uses the version the repo pins in packageManager instead of the default", () => {
    expect(
      heuristicRecipe(new Set(), {
        ...nextApp,
        packageManager: "yarn@4.5.0+sha512.abc",
      })
    ).toEqual({
      kind: "recipe",
      recipe: {
        install: "npx --yes yarn@4.5.0 install",
        dev: "npx --yes yarn@4.5.0 run dev --port {port}",
      },
    });
  });

  it("leaves the port to PORT for a stack with no known port flag", () => {
    expect(
      heuristicRecipe(new Set(), { scripts: { start: "node server.js" } })
    ).toEqual({
      kind: "recipe",
      recipe: { install: "npm install", dev: "npm run start" },
    });
  });

  it("reports a dev script that pins its own port, since two previews cannot share it", () => {
    expect(
      heuristicRecipe(new Set(), {
        scripts: { dev: "next dev -p 3100" },
        dependencies: { next: "15" },
      })
    ).toEqual({ kind: "pinned_port", script: "next dev -p 3100", port: 3100 });
  });

  it("finds no recipe for a package with nothing to run, so the agent is asked to work it out", () => {
    expect(
      heuristicRecipe(new Set(), { scripts: { build: "tsc", test: "vitest" } })
    ).toEqual({ kind: "none" });
  });
});

describe("detectPackageManager", () => {
  it("prefers the packageManager field over a stale lockfile, since corepack enforces the field", () => {
    expect(
      detectPackageManager(new Set(["package-lock.json"]), {
        packageManager: "bun@1.2.0",
      })
    ).toEqual({ manager: "bun", version: "1.2.0" });
  });

  it("ignores a packageManager field naming a tool it cannot run and falls back to the lockfile", () => {
    expect(
      detectPackageManager(new Set(["yarn.lock"]), { packageManager: "deno@2" })
    ).toEqual({ manager: "yarn" });
  });

  it("drops a version that is not plain semver, so the pinned default is used", () => {
    expect(
      detectPackageManager(new Set(), { packageManager: "pnpm@latest" })
    ).toEqual({ manager: "pnpm", version: undefined });
  });
});

describe("pinnedPort", () => {
  test.each([
    { script: "vite --port 4000", port: 4000 },
    { script: "next dev -p 3100", port: 3100 },
    { script: "astro dev --port=4321", port: 4321 },
    { script: "vite", port: undefined },
  ])("reads $port from `$script`", ({ script, port }) => {
    expect(pinnedPort(script)).toBe(port);
  });
});

describe("takesPortFlag", () => {
  it("is true for a framework whose dev server takes --port", () => {
    expect(takesPortFlag({ devDependencies: { vite: "5" } })).toBe(true);
  });

  it("is false for create-react-app, which only reads PORT", () => {
    expect(takesPortFlag({ dependencies: { "react-scripts": "5" } })).toBe(
      false
    );
  });
});
