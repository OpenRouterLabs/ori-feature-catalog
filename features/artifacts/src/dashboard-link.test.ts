import { Effect, Layer } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { describe, expect, it } from "./effect-bun-test.ts";
import { Option } from "effect";

import { CliFailureError } from "./failures.ts";

import { artifactDashboardLink, hostedInternId } from "./dashboard-link.ts";

const identityLayer =
  (workspaceId: string | null): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(HttpClient.HttpClient)(
    HttpClient.make(() =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          HttpClientRequest.get("https://openrouter.ai/api/v1/key"),
          new Response(
            JSON.stringify({
              data: { workspace_id: workspaceId },
            }),
            { headers: { "content-type": "application/json" } }
          )
        )
      )
    )
  );

describe("dashboard link", () => {
  it.effect("builds the dashboard link for a hosted intern", () =>
    Effect.gen(function* () {
      const link = yield* artifactDashboardLink(
        "intern-1",
        "vendor-comparison",
        identityLayer("workspace-1")
      );
      expect(link).toBe(
        "https://openrouter.ai/workspaces/workspace-1/interns/intern-1?tab=artifacts&artifact=vendor-comparison"
      );
    })
  );

  it.effect("refuses a key with no workspace", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        artifactDashboardLink(
          "intern-1",
          "vendor-comparison",
          identityLayer(null)
        )
      ).pipe(Effect.map((failure) => failure as CliFailureError));
      expect(failure.failureCode).toBe("ORI_CLI_INTERN_API_RESPONSE_INVALID");
    })
  );
});

describe("hostedInternId", () => {
  it("reads a set, nonblank ORI_INTERN_ID and refuses a blank one", () => {
    expect(hostedInternId({ ORI_INTERN_ID: "intern-1" })).toEqual(
      Option.some("intern-1")
    );
    expect(hostedInternId({ ORI_INTERN_ID: "  " })).toEqual(Option.none());
    expect(hostedInternId({})).toEqual(Option.none());
  });
});
