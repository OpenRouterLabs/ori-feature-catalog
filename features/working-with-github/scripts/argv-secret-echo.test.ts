import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  displayArgvToken,
  openGhAppRegistryDb,
} from "@ori-monorepo/working-with-github/gh-app-registry.ts";

import { runRegisterCli } from "./register-gh-app.ts";

// Regression: every CLI's usage errors quoted the refused argv token whole.
// A secret pasted where a flag value belongs reaches those errors before
// any guard that withholds values: a PEM private key starts with dashes, so
// it is refused as a single-dash token, and a `--flag=<secret>` paste is
// refused as the equals form. register-gh-app's #356 guard only covered a
// value that reached its env-var check, so
//   register-gh-app register ... --private-key-key "$(cat key.pem)"
// printed the whole private key into stderr. The token is now quoted with
// its URL userinfo masked, or by its length when it spans lines or is
// longer than any flag spelling.

const PEM = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "MIIEowIBAAKCAQEAsecretSECRETsecret",
  "-----END RSA PRIVATE KEY-----",
].join("\n");
const GHP = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
const URL_TOKEN = "ghs_SECRETSECRETSECRET";

const SCRIPTS = join(import.meta.dir);

const run = (script: string, argv: readonly string[]) => {
  const registryDir = mkdtempSync(join(tmpdir(), "wwg-argv-echo-"));
  try {
    const proc = Bun.spawnSync(["bun", join(SCRIPTS, script), ...argv], {
      env: {
        ...process.env,
        GH_APP_ID: "",
        GH_APP_REGISTRY_DIR: registryDir,
        GITHUB_REPO: "acme/widgets",
        TEAM_GH_APP_ID: "1",
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    return {
      code: proc.exitCode,
      output: `${proc.stdout.toString()}${proc.stderr.toString()}`,
    };
  } finally {
    rmSync(registryDir, { force: true, recursive: true });
  }
};

const registerArgv = (privateKeyArgv: readonly string[]) => [
  "register",
  "--org",
  "acme",
  "--app-id-key",
  "TEAM_GH_APP_ID",
  ...privateKeyArgv,
];

describe("no CLI echoes a secret pasted into its argv", () => {
  test("register-gh-app: a PEM key passed as --private-key-key is withheld", () => {
    const result = run("register-gh-app.ts", registerArgv(["--private-key-key", PEM]));
    expect(result.code).toBe(1);
    expect(result.output).not.toContain("secretSECRETsecret");
    expect(result.output).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(result.output).toContain(`${PEM.length}-character argument, withheld`);
  });

  test("register-gh-app: a PEM key without padding, refused as an unknown flag, is withheld", () => {
    const pem = PEM.replace("-----BEGIN", "--BEGIN");
    const result = run("register-gh-app.ts", registerArgv(["--private-key-key", pem]));
    expect(result.code).toBe(1);
    expect(result.output).not.toContain("secretSECRETsecret");
  });

  test("register-gh-app: a token in the equals form of a key flag is withheld at any length", () => {
    const result = run("register-gh-app.ts", registerArgv([`--private-key-key=${GHP}`]));
    expect(result.code).toBe(1);
    expect(result.output).not.toContain(GHP);
    expect(result.output).toContain(`--private-key-key=<a ${GHP.length}-character value, withheld>`);
  });

  test("register-gh-app: an env var NAME in the equals form is still quoted as typed", () => {
    const result = run("register-gh-app.ts", registerArgv(["--private-key-key=TEAM_KEY"]));
    expect(result.code).toBe(1);
    expect(result.output).toContain('unrecognized argument "--private-key-key=TEAM_KEY"');
  });

  for (const script of ["mint-token.ts", "cleanup-worktrees.ts", "commit-via-api.ts"]) {
    test(`${script}: a credentialed --repo= URL is masked`, () => {
      const result = run(script, [`--repo=https://x-access-token:${URL_TOKEN}@github.com/o/r`]);
      expect(result.code).toBe(1);
      expect(result.output).toContain("unrecognized argument");
      expect(result.output).not.toContain(URL_TOKEN);
      expect(result.output).toContain("***@github.com/o/r");
    });

    test(`${script}: a multi-line paste is named by its length only`, () => {
      const result = run(script, ["--repo", "acme/widgets", PEM]);
      expect(result.code).toBe(1);
      expect(result.output).not.toContain("secretSECRETsecret");
    });
  }

  test("a short typo is still quoted as typed", () => {
    const result = run("mint-token.ts", ["-repo", "acme/widgets"]);
    expect(result.code).toBe(1);
    expect(result.output).toContain('unrecognized argument "-repo"');
  });
});

describe("the argv display rules, in process", () => {
  const registerErr = (argv: readonly string[]): string => {
    const db = openGhAppRegistryDb(":memory:");
    const err: string[] = [];
    try {
      runRegisterCli({
        argv,
        db,
        env: { TEAM_GH_APP_ID: "1" },
        writers: {
          err: (text) => {
            err.push(text);
          },
          out: () => {},
        },
      });
    } finally {
      db.close();
    }
    return err.join("");
  };

  test("displayArgvToken masks userinfo, withholds long or multi-line tokens, keeps typos", () => {
    expect(displayArgvToken("-repo")).toBe("-repo");
    expect(displayArgvToken("--repo=https://u:p@github.com/o/r")).toBe("--repo=https://***@github.com/o/r");
    expect(displayArgvToken(PEM)).toBe(`<a ${PEM.length}-character argument, withheld>`);
    expect(displayArgvToken(`--x=${"a".repeat(80)}`)).toContain("withheld");
  });

  test("register-gh-app withholds a PEM and an equals-form token on both paths", () => {
    expect(registerErr(registerArgv(["--private-key-key", PEM]))).not.toContain("secretSECRETsecret");
    expect(registerErr(registerArgv([`--app-id-key=${GHP}`]))).not.toContain(GHP);
    expect(registerErr(["list", PEM])).not.toContain("secretSECRETsecret");
    expect(registerErr(["list", `--private-key-key=${GHP}`])).not.toContain(GHP);
  });
});
