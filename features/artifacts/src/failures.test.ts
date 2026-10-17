import { describe, expect, it } from "bun:test";

import { CliFailureError, makeCliFailureFromCause } from "./failures.ts";
import { formatUnknownError } from "./format-unknown.ts";

describe("formatUnknownError", () => {
  it("renders an Error, a string and a plain object", () => {
    expect(formatUnknownError(new Error("boom"))).toBe("boom");
    expect(formatUnknownError("plain")).toBe("plain");
    expect(formatUnknownError({ a: 1 })).toBe('{"a":1}');
  });
});

describe("makeCliFailureFromCause", () => {
  it("wraps a nested CliFailureError with its detail", () => {
    const inner = new CliFailureError({
      detail: "inner detail",
      failureCode: "ORI_CLI_ARTIFACT_RESOURCE_REFUSED",
      hint: "move it",
    });
    const outer = makeCliFailureFromCause({
      detail: "downloading a file failed",
      failureCode: "ORI_CLI_ARTIFACT_RESOURCE_UNREACHABLE",
    })(inner);
    expect(outer.detail).toBe(
      "downloading a file failed: inner detail"
    );
    expect(outer.hint).toBe("move it");
    expect(outer.failureCode).toBe("ORI_CLI_ARTIFACT_RESOURCE_UNREACHABLE");
  });

  it("formats a non-CliFailure cause", () => {
    const outer = makeCliFailureFromCause({
      detail: "the step failed",
      failureCode: "ORI_CLI_ARTIFACT_STORE_FAILED",
    })(new Error("cause text"));
    expect(outer.detail).toBe("the step failed: cause text");
  });
});
