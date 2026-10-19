import { joinUrl } from "./screenshot.ts";
import {
  describe,
  expect,
  it,
  test,
} from "../effect-bun-test.ts";

describe("joinUrl", () => {
  it("keeps the warm url when no path is asked for", () => {
    expect(joinUrl("http://127.0.0.1:3000/health", undefined)).toBe(
      "http://127.0.0.1:3000/health"
    );
  });

  it("resolves a path against the origin, not the ready path, so /settings is not /health/settings", () => {
    expect(joinUrl("http://127.0.0.1:3000/health", "/settings?tab=2")).toBe(
      "http://127.0.0.1:3000/settings?tab=2"
    );
  });

  test.each([
    {
      path: "//evil.example/x",
      expected: "http://127.0.0.1:3000/evil.example/x",
    },
    {
      path: "\\\\evil.example/x",
      expected: "http://127.0.0.1:3000/evil.example/x",
    },
    {
      path: "https://evil.example/x",
      expected: "http://127.0.0.1:3000/https://evil.example/x",
    },
  ])(
    "keeps $path on the preview's own origin, because the browser must only ever load localhost",
    ({ path, expected }) => {
      expect(joinUrl("http://127.0.0.1:3000/", path)).toBe(expected);
    }
  );
});
