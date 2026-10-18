import { PREVIEW_UID } from "#src/paths.ts";
import {
  chownTree,
  isWithheld,
  sandboxed,
  sandboxEnv,
} from "#src/sandbox/index.ts";
import {
  describe,
  expect,
  it,
  test,
} from "#src/effect-bun-test.ts";

describe("sandboxed", () => {
  it("drops to the preview uid with no groups, no capabilities, and no way back up before the command runs", () => {
    expect(sandboxed(["npm", "install"])).toEqual([
      "setpriv",
      `--reuid=${PREVIEW_UID}`,
      `--regid=${PREVIEW_UID}`,
      "--clear-groups",
      "--inh-caps=-all",
      "--bounding-set=-all",
      "--no-new-privs",
      "npm",
      "install",
    ]);
  });
});

describe("isWithheld", () => {
  test.each([
    "ORI_DAEMON_TOKEN",
    "SLACK_BOT_TOKEN",
    "OPENROUTER_API_KEY",
    "OTEL_EXPORTER_OTLP_HEADERS",
    "VAULT_TOKEN",
    "HTTPS_PROXY",
    "http_proxy",
    "ALL_PROXY",
    "NO_PROXY",
  ])("withholds %s", (name) => {
    expect(isWithheld(name)).toBe(true);
  });

  test.each(["DATABASE_URL", "NEXT_PUBLIC_API", "PATH"])(
    "passes %s",
    (name) => {
      expect(isWithheld(name)).toBe(false);
    }
  );
});

describe("sandboxEnv", () => {
  it("passes only the basics and the operator-bound values of the names asked for, with its own home", () => {
    expect(
      sandboxEnv({
        host: {
          PATH: "/bin",
          SECRET: "x",
          DATABASE_URL: "pg://host",
          PREVIEW_ENV_DATABASE_URL: "pg://bound",
        },
        home: "/h",
        passNames: ["DATABASE_URL"],
      })
    ).toEqual({
      PATH: "/bin",
      LANG: undefined,
      LC_ALL: undefined,
      TZ: undefined,
      TERM: undefined,
      DATABASE_URL: "pg://bound",
      HOME: "/h",
      XDG_CACHE_HOME: "/h/.cache",
    });
  });
});

describe("chownTree", () => {
  it("re-owns symlinks themselves, never follows them, and never crosses into another mount", () => {
    expect(chownTree("/preview/work/fix")).toEqual([
      "find",
      "/preview/work/fix",
      "-xdev",
      "-exec",
      "chown",
      "-h",
      `${PREVIEW_UID}:${PREVIEW_UID}`,
      "{}",
      "+",
    ]);
  });
});
