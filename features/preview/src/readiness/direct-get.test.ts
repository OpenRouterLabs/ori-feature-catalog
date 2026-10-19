import { isComplete } from "./direct-get.ts";
import { describe, expect, it } from "../effect-bun-test.ts";

describe("isComplete", () => {
  it("is complete once the declared content length has arrived", () => {
    expect(isComplete("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")).toBe(
      true
    );
    expect(isComplete("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nok")).toBe(
      false
    );
  });

  it("is complete at the end of a chunked body", () => {
    expect(
      isComplete(
        "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nok\r\n0\r\n\r\n"
      )
    ).toBe(true);
  });
});
