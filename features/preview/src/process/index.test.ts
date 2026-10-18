import { Effect, Option } from "effect";

import { assignPort, parseStartTime } from "#src/process/index.ts";
import { scriptedTcpProbeLayer } from "#src/tcp-probe/test-support.ts";
import { describe, expect, it } from "#src/effect-bun-test.ts";

const statLine = (comm: string, start: string): string =>
  `4242 (${comm}) S 1 4242 4242 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 ${start} 1000 50 18446744073709551615`;

describe("parseStartTime", () => {
  it("reads field 22 of /proc/<pid>/stat, the start time that tells a live process from a reused pid", () => {
    expect(parseStartTime(statLine("node", "987654"))).toEqual(
      Option.some("987654")
    );
  });

  it("is not fooled by spaces and parentheses inside the command name", () => {
    expect(parseStartTime(statLine("next-server (v15) dev", "31337"))).toEqual(
      Option.some("31337")
    );
  });

  it("finds nothing in a truncated stat line rather than guessing", () => {
    expect(parseStartTime("4242 (node) S 1")).toEqual(Option.none());
  });
});

describe("assignPort", () => {
  const first = 0;
  const second = first + 1;
  const third = first + 2;
  const range = { first, last: third };

  const probeWithBusy = (busy: ReadonlySet<number>) =>
    scriptedTcpProbeLayer({
      isPortFree: (port) => Effect.succeed(!busy.has(port)),
    });

  it.effect("skips ports another preview has claimed", () =>
    Effect.gen(function* () {
      expect(yield* assignPort(range, new Set([first]))).toBe(second);
    }).pipe(Effect.provide(probeWithBusy(new Set())))
  );

  it.effect(
    "skips a port something is already listening on, so a server is never mistaken for another",
    () =>
      Effect.gen(function* () {
        expect(yield* assignPort(range, new Set())).toBe(second);
      }).pipe(Effect.provide(probeWithBusy(new Set([first]))))
  );

  it.effect("skips a claimed port and a busy port together", () =>
    Effect.gen(function* () {
      expect(yield* assignPort(range, new Set([first]))).toBe(third);
    }).pipe(Effect.provide(probeWithBusy(new Set([second]))))
  );

  it.effect("fails once every port in the range is taken", () =>
    Effect.gen(function* () {
      const failure = yield* assignPort(range, new Set([first, second])).pipe(
        Effect.flip
      );
      expect(failure.code).toBe("start_failed");
    }).pipe(Effect.provide(probeWithBusy(new Set([third]))))
  );
});
