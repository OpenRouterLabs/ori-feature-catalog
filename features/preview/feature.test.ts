import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";

test("preview imports need no package import alias in the compiled runtime", () => {
  const root = new URL("./", import.meta.url);
  const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter(
    (file) => file.endsWith(".ts") && !file.includes("node_modules")
  );
  expect(files.filter((file) =>
    /from ["']#/u.test(readFileSync(new URL(file, root), "utf8"))
  )).toEqual([]);
});

test("disabled previews do not need the newer SDK credential helpers", () => {
  const result = Bun.spawnSync([process.execPath, "-e",
    'const x = await import("./feature.ts"); console.log(JSON.stringify({ tools: x.tools, schedule: x.schedule }));'
  ], {
    cwd: new URL("./", import.meta.url).pathname,
    env: { ...process.env, ORI_PREVIEW_ENABLED: "0", ORI_PREVIEW_REPOS: "" },
  });
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toEqual({ tools: [] });
});
