import {
  applyDevcontainer,
  stripJsonComments,
} from "./devcontainer.ts";
import { describe, expect, it } from "../effect-bun-test.ts";

const base = { install: "npm install", dev: "npm run dev" };

describe("applyDevcontainer", () => {
  it("takes the install step and container env from a commented devcontainer.json, ignoring its forwarded ports", () => {
    const raw = `{
      // VS Code writes comments into this file
      "forwardPorts": [8080, 5432],
      "postCreateCommand": ["pnpm", "install"],
      /* and block comments */
      "containerEnv": { "NODE_ENV": "development" },
    }`;
    expect(applyDevcontainer(raw, base)).toEqual({
      install: "pnpm install",
      dev: "npm run dev",
      env: { NODE_ENV: "development" },
    });
  });

  it("keeps the heuristic recipe when the devcontainer cannot be read, rather than guessing from a broken file", () => {
    expect(applyDevcontainer("{ not json", base)).toEqual(base);
  });

  it("lets env the recipe already carries win over container env", () => {
    const withEnv = { ...base, env: { NODE_ENV: "test" } };
    expect(
      applyDevcontainer(`{"containerEnv":{"NODE_ENV":"development"}}`, withEnv)
        .env
    ).toEqual({ NODE_ENV: "test" });
  });
});

describe("stripJsonComments", () => {
  it("drops trailing commas before a closing bracket or brace", () => {
    expect(stripJsonComments(`{"a":[1,2,],}`)).toBe(`{"a":[1,2]}`);
  });
});
