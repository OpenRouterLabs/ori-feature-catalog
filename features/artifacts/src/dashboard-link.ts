import { Effect, Option, Schema } from "effect";
import type { Layer } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import { CliFailureError } from "#src/failures.ts";
import { isOkStatus } from "#src/http.ts";

const ORI_INTERN_ID_ENV = "ORI_INTERN_ID";
const OPENROUTER_DASHBOARD_ORIGIN = "https://openrouter.ai";
const API_URL = "https://openrouter.ai/api/v1";

const CredentialIdentityFieldsSchema = Schema.Struct({
  creatorUserId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  keyExpiresAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
  limit: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  limitReset: Schema.optionalKey(Schema.NullOr(Schema.String)),
  organizationId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  workspaceId: Schema.optionalKey(Schema.NullOr(Schema.String)),
}).pipe(
  Schema.encodeKeys({
    creatorUserId: "creator_user_id",
    keyExpiresAt: "expires_at",
    limitReset: "limit_reset",
    organizationId: "organization_id",
    workspaceId: "workspace_id",
  })
);

const CredentialIdentityEnvelopeSchema = Schema.Struct({
  data: Schema.Record(Schema.String, Schema.Unknown),
});

const decodeFields = Schema.decodeUnknownEffect(CredentialIdentityFieldsSchema);
const decodeEnvelope = Schema.decodeUnknownEffect(
  CredentialIdentityEnvelopeSchema
);

export const hostedInternId = (
  env: Readonly<Record<string, string | undefined>>
): Option.Option<string> =>
  Option.filter(
    Option.fromNullishOr(env[ORI_INTERN_ID_ENV]),
    (id) => id.trim() !== ""
  );

export const artifactDashboardLink = Effect.fn(
  "Artifacts.dashboardLink"
)(
  function* (
    internId: string,
    name: string,
    clientLayer: Layer.Layer<HttpClient.HttpClient> = FetchHttpClient.layer
  ) {
    const response = yield* HttpClient.HttpClient.pipe(
      Effect.flatMap((client) =>
        client.execute(
          HttpClientRequest.get(`${API_URL}/key`).pipe(
            HttpClientRequest.bearerToken(internId)
          )
        )
      ),
      Effect.provide(clientLayer)
    );
    if (!isOkStatus(response.status)) {
      return yield* new CliFailureError({
        detail: `Looking up the OpenRouter organization and workspace failed with HTTP ${response.status}.`,
        failureCode: "ORI_CLI_INTERN_API_HTTP_ERROR",
      });
    }
    const payload = yield* response.json.pipe(
      Effect.flatMap((body) => decodeEnvelope(body)),
      Effect.mapError(
        () =>
          new CliFailureError({
            detail:
              "OpenRouter did not report the key's organization and workspace.",
            failureCode: "ORI_CLI_INTERN_API_RESPONSE_INVALID",
          })
      )
    );
    const fields = yield* decodeFields(payload.data).pipe(
      Effect.mapError(
        () =>
          new CliFailureError({
            detail:
              "OpenRouter did not report the key's organization and workspace.",
            failureCode: "ORI_CLI_INTERN_API_RESPONSE_INVALID",
          })
      )
    );
    if (fields.workspaceId == null) {
      return yield* new CliFailureError({
        detail:
          "OpenRouter did not report a workspace for this intern's key, so there is no dashboard link to print.",
        failureCode: "ORI_CLI_INTERN_API_RESPONSE_INVALID",
      });
    }
    return `${OPENROUTER_DASHBOARD_ORIGIN}/workspaces/${encodeURIComponent(fields.workspaceId)}/interns/${encodeURIComponent(internId)}?tab=artifacts&artifact=${encodeURIComponent(name)}`;
  }
);
