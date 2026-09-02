import { describe, expect, test } from "#src/test-support/effect-test.ts";
import { Result } from "effect";

import { parseFlags, tryCatch, tryCatchAsync } from "./result.ts";

describe("parseFlags", () => {
  test("reads a flag and the word after it", () => {
    expect(parseFlags(["--channel", "C1", "--ts", "1700.1"])).toEqual({
      channel: "C1",
      ts: "1700.1",
    });
  });

  test("reads the joined form as well", () => {
    expect(parseFlags(["--channel=C1"])).toEqual({ channel: "C1" });
  });

  test("keeps everything after the first equals sign", () => {
    expect(parseFlags(["--search=a=b=c"])).toEqual({ search: "a=b=c" });
  });

  test("a flag with nothing usable after it is a boolean", () => {
    expect(parseFlags(["--json"])).toEqual({ json: "true" });
    expect(parseFlags(["--json", "--channel", "C1"])).toEqual({
      channel: "C1",
      json: "true",
    });
  });

  test("a negative number is a value, not the next flag", () => {
    expect(parseFlags(["--oldest", "-1"])).toEqual({ oldest: "-1" });
  });

  test("ignores the words that are not flags", () => {
    expect(parseFlags(["conversations.history", "--channel", "C1"])).toEqual({
      channel: "C1",
    });
  });

  test("an empty joined value stays empty rather than becoming true", () => {
    expect(parseFlags(["--ts="])).toEqual({ ts: "" });
  });
});

describe("tryCatch", () => {
  test("carries the value through on success", () => {
    expect(tryCatch(() => 3)).toEqual(Result.succeed(3));
  });

  test("keeps the thrown error's own name and message", () => {
    const error = new Error("ratelimited");
    error.name = "AbortError";

    const result = tryCatch(() => {
      throw error;
    });

    expect(Result.isFailure(result)).toBe(true);
    expect(Result.isFailure(result) && result.failure.name).toBe("AbortError");
    expect(Result.isFailure(result) && result.failure.message).toBe(
      "ratelimited"
    );
  });

  test("describes a thrown non-error rather than printing [object Object]", () => {
    const result = tryCatch(() => {
      // oxlint-disable-next-line no-throw-literal, typescript/only-throw-error -- a library that throws a string is exactly what this guards
      throw "boom";
    });

    expect(Result.isFailure(result) && result.failure.message).toBe("boom");
    expect(Result.isFailure(result) && result.failure.name).toBe("ThrownError");
  });
});

describe("tryCatchAsync", () => {
  test("carries the value through on success", async () => {
    expect(await tryCatchAsync(() => Promise.resolve("ok"))).toEqual(
      Result.succeed("ok")
    );
  });

  test("never rejects, so every caller can stay on the Result path", async () => {
    const result = await tryCatchAsync(() =>
      Promise.reject(new Error("an API error occurred: ratelimited"))
    );

    expect(Result.isFailure(result)).toBe(true);
    expect(Result.isFailure(result) && result.failure.message).toBe(
      "an API error occurred: ratelimited"
    );
  });

  test("catches a function that throws before it returns a promise", async () => {
    const result = await tryCatchAsync(() => {
      throw new Error("bad argument");
    });

    expect(Result.isFailure(result) && result.failure.message).toBe(
      "bad argument"
    );
  });
});
