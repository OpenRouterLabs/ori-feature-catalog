import { Option } from "effect";

import { describe, expect, it } from "#src/effect-bun-test.ts";

import { artifactDashboardLink } from "./dashboard-link.ts";

const PAGE = "https://openrouter.ai/workspaces/workspace-1/interns/intern-1";

const link = (pageUrl: string | undefined, name = "vendor-comparison") =>
  artifactDashboardLink({ ORI_INTERN_DASHBOARD_URL: pageUrl }, name);

describe("artifactDashboardLink", () => {
  it("opens the artifact on the intern's page, with or without a trailing slash", () => {
    const expected = Option.some(
      `${PAGE}?tab=artifacts&artifact=vendor-comparison`
    );
    expect(link(`${PAGE}/`)).toEqual(expected);
    expect(link(PAGE)).toEqual(expected);
  });

  it("encodes the artifact name", () => {
    expect(link(`${PAGE}/`, "q3 report&notes")).toEqual(
      Option.some(`${PAGE}?tab=artifacts&artifact=q3%20report%26notes`)
    );
  });

  it("gives no link when the page URL is absent, blank or not an http(s) URL", () => {
    for (const pageUrl of [undefined, "  ", "not a url", "ftp://host/x"]) {
      expect(link(pageUrl)).toEqual(Option.none());
    }
  });
});
