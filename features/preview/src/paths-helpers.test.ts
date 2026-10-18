import {
  alternateLogPath,
  devLogPath,
  installLogPath,
  localUrl,
  previewPaths,
  repoCheckout,
  syncMarkerPath,
} from "#src/paths.ts";
import { describe, expect, it } from "#src/effect-bun-test.ts";

describe("per-repository paths", () => {
  const paths = previewPaths("/workspace");

  it("names every file after the lower-cased owner__name slug", () => {
    expect([
      repoCheckout(paths, "Acme/Web"),
      syncMarkerPath(paths, "Acme/Web"),
      devLogPath(paths, "Acme/Web"),
      alternateLogPath(paths, "Acme/Web"),
      installLogPath(paths, "Acme/Web"),
    ]).toEqual([
      `${paths.repos}/acme__web`,
      `${paths.synced}/acme__web`,
      `${paths.logs}/acme__web.log`,
      `${paths.logs}/acme__web.alternate.log`,
      `${paths.logs}/acme__web.install.log`,
    ]);
  });
});

describe("localUrl", () => {
  it("points at the IPv4 loopback root by default", () => {
    expect(localUrl(41_000)).toBe("http://127.0.0.1:41000/");
  });

  it("adds the leading slash a recipe path left out", () => {
    expect(localUrl(41_000, "health", "[::1]")).toBe("http://[::1]:41000/health");
  });
});
