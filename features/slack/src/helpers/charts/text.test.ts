import { describe, expect, test } from "#src/test-support/effect-test.ts";

import { charsThatFit, wrapText } from "./text.ts";

describe("wrapText", () => {
  test("a string that fits stays one line", () => {
    expect(wrapText("short enough", 40)).toEqual(["short enough"]);
  });

  test("words stay whole across the break", () => {
    const lines = wrapText("alpha bravo charlie delta", 12);

    expect(lines.every((line) => line.length <= 12)).toBe(true);
    expect(lines.join(" ")).toBe("alpha bravo charlie delta");
  });

  test("a word longer than the line is cut rather than allowed to overrun", () => {
    const lines = wrapText("supercalifragilistic", 8);

    expect(lines.every((line) => line.length <= 8)).toBe(true);
    expect(lines.join("")).toBe("supercalifragilistic");
  });

  test("nothing is dropped, whatever the width", () => {
    const text = "Stage 2.5 research pipeline CRM audit segment spend signal";

    for (const width of [6, 11, 23, 40, 200]) {
      expect(wrapText(text, width).join(" ").replaceAll(/\s+/gu, " ")).toContain(
        "spend signal"
      );
    }
  });

  test("an empty string is one empty line, not zero lines", () => {
    expect(wrapText("", 10)).toEqual([""]);
  });

  test("runs of whitespace collapse rather than becoming empty lines", () => {
    expect(wrapText("a    b", 40)).toEqual(["a b"]);
  });
});

describe("charsThatFit", () => {
  test("a wider box fits more", () => {
    expect(charsThatFit(700, 14)).toBeGreaterThan(charsThatFit(170, 14));
  });

  test("a larger font fits fewer", () => {
    expect(charsThatFit(400, 20)).toBeLessThan(charsThatFit(400, 10));
  });

  test("never zero, so a wrap always makes progress", () => {
    expect(charsThatFit(1, 40)).toBeGreaterThanOrEqual(1);
  });
});
