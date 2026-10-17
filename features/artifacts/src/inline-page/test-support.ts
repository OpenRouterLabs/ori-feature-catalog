import { Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import { ARTIFACT_CONTENT_SECURITY_POLICY } from "#src/store/index.ts";

export const POLICY_META = `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CONTENT_SECURITY_POLICY}">`;

export interface CdnFile {
  readonly body: string | Uint8Array<ArrayBuffer>;
  readonly headers?: Record<string, string>;
  readonly status?: number;
}

export const scriptedCdnHttpClientLayer = (
  files: Record<string, CdnFile>,
  requested: string[] = []
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(HttpClient.HttpClient)(
    HttpClient.make((request) =>
      Effect.sync(() => {
        requested.push(request.url);
        const file = files[request.url];
        return HttpClientResponse.fromWeb(
          request,
          file === undefined
            ? new Response("missing", { status: 404 })
            : new Response(file.body, {
                headers: file.headers ?? {},
                status: file.status ?? 200,
              })
        );
      })
    )
  );
