import { describe, expect, test } from "#src/test-support/index.ts";

import { readBotToken, readSlackConfig, SLACK_ENV_VARS } from "./config.ts";

const secrets = {
  SLACK_BOT_TOKEN: "xoxb-test",
  SLACK_SIGNING_SECRET: "secret",
};

describe("the secrets are the only thing worth refusing to boot over", () => {
  test("names the missing one, so the fix is obvious", () => {
    expect(() => readSlackConfig({})).toThrow("SLACK_BOT_TOKEN");
    expect(() => readSlackConfig({ SLACK_BOT_TOKEN: "x" })).toThrow(
      "SLACK_SIGNING_SECRET"
    );
  });

  test("a whitespace token is missing, not present", () => {
    expect(() =>
      readSlackConfig({
        ...secrets,
        SLACK_BOT_TOKEN: "   ",
      })
    ).toThrow("SLACK_BOT_TOKEN");
  });

  test("everything else has a default and never throws", () => {
    const config = readSlackConfig(secrets);

    expect(config.loadingEmoji).toBe(":braille-loader:");
    expect(config.allowedUserIds.size).toBe(0);
    expect(config.openRouterApiKey).toBeUndefined();
  });
});

describe("a misconfigured value degrades rather than breaking the surface", () => {
  test("an empty optional reads as absent, not as an empty value", () => {
    const config = readSlackConfig({
      ...secrets,
      SLACK_IMAGE_MODEL: "  ",
      SLACK_LOADING_EMOJI: "",
    });

    expect(config.loadingEmoji).toBe(":braille-loader:");
    expect(config.imageModel).toBeUndefined();
  });

  test("list values tolerate the spacing people actually write", () => {
    const config = readSlackConfig({
      ...secrets,
      SLACK_ALLOWED_USER_IDS: "U1, U2 ,,U3",
      SLACK_SKIP_PREFIXES: "//,,  ,",
    });

    expect([...config.allowedUserIds]).toEqual(["U1", "U2", "U3"]);
    expect(config.skipPrefixes).toEqual(["//"]);
  });
});

describe("readBotToken", () => {
  test("degrades to undefined where readSlackConfig would throw", () => {
    expect(readBotToken({})).toBeUndefined();
    expect(readBotToken({ SLACK_BOT_TOKEN: "xoxb-test" })).toBe("xoxb-test");
  });
});

describe("SLACK_ENV_VARS", () => {
  test("lists every name the config actually reads", () => {
    const source = new Set(SLACK_ENV_VARS);
    const probe = Object.fromEntries(
      SLACK_ENV_VARS.map((name) => [name, "probe"])
    );

    expect(source.has("SLACK_BOT_TOKEN")).toBe(true);
    expect(() => readSlackConfig(probe)).not.toThrow();
  });
});
