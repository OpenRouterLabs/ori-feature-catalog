import { missingEnv, serverEnv, withPort } from "./start-server.ts";
import { describe, expect, it } from "../effect-bun-test.ts";

const recipe = {
  dev: "npm run dev",
  requiredEnv: ["DATABASE_URL", "STRIPE_KEY"],
};

describe("missingEnv", () => {
  it("names every required variable neither an operator binding nor the recipe supplies", () => {
    expect(
      missingEnv(recipe, { PREVIEW_ENV_DATABASE_URL: "postgres://x" })
    ).toEqual(["STRIPE_KEY"]);
  });

  it("never counts the host's own variable as supplied, so a repository cannot ask for the intern's secrets by name", () => {
    expect(
      missingEnv(
        { dev: "x", requiredEnv: ["ANTHROPIC_API_KEY"] },
        { ANTHROPIC_API_KEY: "sk-ant" }
      )
    ).toEqual(["ANTHROPIC_API_KEY"]);
  });

  it("treats a blank value as missing, since an empty secret boots to a broken page", () => {
    expect(
      missingEnv(recipe, {
        PREVIEW_ENV_DATABASE_URL: " ",
        PREVIEW_ENV_STRIPE_KEY: "sk",
      })
    ).toEqual(["DATABASE_URL"]);
  });

  it("counts a value the recipe carries as supplied", () => {
    expect(
      missingEnv(
        { ...recipe, env: { DATABASE_URL: "file:dev.db", STRIPE_KEY: "test" } },
        {}
      )
    ).toEqual([]);
  });

  it("never counts an intern credential as supplied, even when a recipe requires it by name", () => {
    expect(
      missingEnv(
        { dev: "x", requiredEnv: ["SLACK_BOT_TOKEN"] },
        { PREVIEW_ENV_SLACK_BOT_TOKEN: "xoxb" }
      )
    ).toEqual(["SLACK_BOT_TOKEN"]);
  });
});

describe("serverEnv", () => {
  const host = {
    PATH: "/usr/bin",
    PORT: "9999",
    DATABASE_URL: "postgres://host-only",
    PREVIEW_ENV_DATABASE_URL: "postgres://bound",
    ANTHROPIC_API_KEY: "sk-ant",
    GITHUB_TOKEN: "ghs",
    ORI_DAEMON_TOKEN: "secret",
    HTTPS_PROXY: "http://ori:token@127.0.0.1:8080",
  };

  it("builds the environment from an allowlist and operator bindings, so nothing of the intern's reaches repository code", () => {
    const env = serverEnv({
      recipe: {
        dev: "x",
        requiredEnv: ["DATABASE_URL", "ANTHROPIC_API_KEY", "GITHUB_TOKEN"],
      },
      host,
      home: "/w/.ori/preview/home",
      port: 41_000,
    });
    expect(env).toEqual({
      PATH: "/usr/bin",
      LANG: undefined,
      LC_ALL: undefined,
      TZ: undefined,
      TERM: undefined,
      DATABASE_URL: "postgres://bound",
      ANTHROPIC_API_KEY: undefined,
      GITHUB_TOKEN: undefined,
      HOME: "/w/.ori/preview/home",
      XDG_CACHE_HOME: "/w/.ori/preview/home/.cache",
      BROWSER: "none",
      CI: "1",
      HOST: "127.0.0.1",
      PORT: "41000",
    });
  });

  it("lets the recipe's own env override the defaults it sets", () => {
    expect(
      serverEnv({
        recipe: { dev: "x", env: { HOST: "0.0.0.0" } },
        host: {},
        home: "/h",
        port: 41_000,
      }).HOST
    ).toBe("0.0.0.0");
  });
});

describe("serverEnv recipe env", () => {
  it("drops credential and proxy names a recipe tries to set", () => {
    const env = serverEnv({
      recipe: {
        dev: "x",
        env: {
          NODE_ENV: "development",
          HTTPS_PROXY: "http://127.0.0.1:8080",
          SLACK_BOT_TOKEN: "x",
        },
      },
      host: {},
      home: "/h",
      port: 41_000,
    });
    expect(env.NODE_ENV).toBe("development");
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.SLACK_BOT_TOKEN).toBeUndefined();
  });
});

describe("withPort", () => {
  it("fills every {port} with the assigned port", () => {
    expect(withPort("vite --port {port} --strictPort # {port}", 41_002)).toBe(
      "vite --port 41002 --strictPort # 41002"
    );
  });
});
