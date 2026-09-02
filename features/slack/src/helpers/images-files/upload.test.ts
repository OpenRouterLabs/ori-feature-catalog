/* oxlint-disable typescript/no-unsafe-type-assertion typescript/explicit-function-return-type eslint/max-lines-per-function eslint/require-await eslint/no-unsafe-optional-chaining typescript/no-invalid-void-type promise/avoid-new promise/param-names unicorn/consistent-function-scoping -- test doubles assert on recorded `unknown` args and stand in for Slack SDK shapes; cases read better whole than split */
import { afterEach, describe, expect, test } from "#src/test-support/effect-test.ts";

import { Effect } from "effect";

import type { RawStubs } from "#src/client/client-test-support.ts";

import { makeFakeSlackClient } from "#src/client/client-test-support.ts";
import { uploadFile } from "./upload.ts";

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

const stubFetch = (response: Response | Error): void => {
  globalThis.fetch = ((): Promise<Response> =>
    response instanceof Error
      ? Promise.reject(response)
      : Promise.resolve(response)) as unknown as typeof fetch;
};

const happyStubs: RawStubs = {
  "files.completeUploadExternal": () => ({
    files: [
      {
        id: "F1",
        permalink: "https://slack.test/F1",
      },
    ],
  }),
  "files.getUploadURLExternal": () => ({
    file_id: "F1",
    upload_url: "https://upload.test/put",
  }),
};

const run = (stubs: RawStubs = happyStubs) => {
  const fake = makeFakeSlackClient({}, stubs);
  return {
    fake,
    result: uploadFile({
      channel: "C1",
      file: {
        content: "diff --git",
        filename: "a.patch",
      },
      threadTs: "1700.1",
    }).pipe(Effect.provide(fake.layer), Effect.result),
  };
};

describe("uploadFile", () => {
  test.effect("walks reserve -> upload -> complete in order", () =>
    Effect.gen(function* () {
      stubFetch(new Response("", { status: 200 }));
      const { fake, result } = run();

      yield* result;

      expect(fake.calls.map((call) => call.op)).toEqual([
        "files.getUploadURLExternal",
        "files.completeUploadExternal",
      ]);
    })
  );

  test.effect("reserves the byte length Slack requires up front", () =>
    Effect.gen(function* () {
      stubFetch(new Response("", { status: 200 }));
      const { fake, result } = run();

      yield* result;

      const reserve = fake.calls[0]?.args as {
        filename?: string;
        length?: number;
      };
      expect(reserve.filename).toBe("a.patch");
      expect(reserve.length).toBe("diff --git".length);
    })
  );

  test.effect("returns the file id and permalink", () =>
    Effect.gen(function* () {
      stubFetch(new Response("", { status: 200 }));
      const { result } = run();

      const either = yield* result;
      expect(either._tag).toBe("Success");
      expect(either._tag === "Success" && either.success).toEqual({
        fileId: "F1",
        permalink: "https://slack.test/F1",
      });
    })
  );

  test.effect("defaults the title to the filename", () =>
    Effect.gen(function* () {
      stubFetch(new Response("", { status: 200 }));
      const { fake, result } = run();

      yield* result;

      const complete = fake.calls[1]?.args as {
        files?: readonly { title?: string }[];
      };
      expect(complete.files?.[0]?.title).toBe("a.patch");
    })
  );

  test.effect("fails when the reserve step is rejected", () =>
    Effect.gen(function* () {
      stubFetch(new Response("", { status: 200 }));
      const { result } = run({
        ...happyStubs,
        "files.getUploadURLExternal": () => {
          throw new Error("missing_scope");
        },
      });

      const either = yield* result;
      expect(either._tag).toBe("Failure");
      expect(either._tag === "Failure" && either.failure.op).toBe(
        "files.getUploadURLExternal"
      );
    })
  );

  test.effect("fails when the reserve response is missing its fields", () =>
    Effect.gen(function* () {
      stubFetch(new Response("", { status: 200 }));
      const { result } = run({
        ...happyStubs,
        "files.getUploadURLExternal": () => ({ ok: true }),
      });

      const either = yield* result;
      expect(either._tag).toBe("Failure");
    })
  );

  test.effect("fails when the byte upload is rejected by status", () =>
    Effect.gen(function* () {
      stubFetch(new Response("nope", { status: 500 }));
      const { result } = run();

      const either = yield* result;
      expect(either._tag).toBe("Failure");
      expect(either._tag === "Failure" && either.failure.op).toBe(
        "files.upload.post"
      );
    })
  );

  test.effect("fails when the byte upload cannot connect", () =>
    Effect.gen(function* () {
      stubFetch(new Error("network down"));
      const { result } = run();

      const either = yield* result;
      expect(either._tag).toBe("Failure");
      expect(either._tag === "Failure" && either.failure.op).toBe(
        "files.upload.post"
      );
    })
  );

  test.effect("fails when the complete step is rejected", () =>
    Effect.gen(function* () {
      stubFetch(new Response("", { status: 200 }));
      const { result } = run({
        ...happyStubs,
        "files.completeUploadExternal": () => {
          throw new Error("channel_not_found");
        },
      });

      const either = yield* result;
      expect(either._tag).toBe("Failure");
      expect(either._tag === "Failure" && either.failure.op).toBe(
        "files.completeUploadExternal"
      );
    })
  );

  test.effect("falls back to the reserved id when complete returns no files", () =>
    Effect.gen(function* () {
      stubFetch(new Response("", { status: 200 }));
      const { result } = run({
        ...happyStubs,
        "files.completeUploadExternal": () => ({ files: [] }),
      });

      const either = yield* result;
      expect(either._tag === "Success" && either.success.fileId).toBe("F1");
      expect(
        either._tag === "Success" && either.success.permalink
      ).toBeUndefined();
    })
  );

  test.effect("omits thread_ts for a channel-level upload", () =>
    Effect.gen(function* () {
      stubFetch(new Response("", { status: 200 }));
      const fake = makeFakeSlackClient({}, happyStubs);

      yield* uploadFile({
        channel: "C1",
        file: {
          content: "x",
          filename: "a.txt",
        },
      }).pipe(Effect.provide(fake.layer), Effect.result);

      expect(Object.keys(fake.calls[1]?.args as object)).not.toContain(
        "thread_ts"
      );
    })
  );
});
