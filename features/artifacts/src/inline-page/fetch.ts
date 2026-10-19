import { Effect, Predicate, Stream } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import {
  classifyAddress,
  ResourceAddress,
} from "./address.ts";
import {
  CliFailureError,
  makeCliFailureFromCause,
} from "../failures.ts";
import { isOkStatus } from "../http.ts";

const NO_REDIRECTS: globalThis.RequestInit = { redirect: "manual" };
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([
  301, 302, 303, 307, 308,
]);
const MEDIA_TYPE = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/iu;
const FALLBACK_MEDIA_TYPE = "application/octet-stream";
const MAX_RESOURCE_BYTES = 16 * 1024 * 1024;
const DOWNLOAD_TIMEOUT = "60 seconds";

interface CollectedBody {
  readonly chunks: Uint8Array[];
  total: number;
}

const tooLarge = (url: string) =>
  new CliFailureError({
    detail: `${url} is over 16 MiB, so it cannot fit inside a saved page.`,
    failureCode: "ORI_CLI_ARTIFACT_TOO_LARGE",
    hint: "Load a smaller build of the library, or drop the file from the page.",
  });

const joinChunks = (body: CollectedBody): Uint8Array => {
  const bytes = new Uint8Array(body.total);
  let offset = 0;
  for (const chunk of body.chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
};

const collectBounded = (
  url: string,
  stream: Stream.Stream<Uint8Array, unknown>
) =>
  stream.pipe(
    Stream.mapError(
      makeCliFailureFromCause({
        detail: `Failed to read ${url}`,
        failureCode: "ORI_CLI_ARTIFACT_RESOURCE_UNREACHABLE",
      })
    ),
    Stream.runFoldEffect(
      (): CollectedBody => ({ chunks: [], total: 0 }),
      (body, chunk) => {
        if (body.total + chunk.length > MAX_RESOURCE_BYTES) {
          return Effect.fail(tooLarge(url));
        }
        body.chunks.push(chunk);
        body.total += chunk.length;
        return Effect.succeed(body);
      }
    ),
    Effect.map(joinChunks)
  );

export interface DownloadedResource {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly url: string;
}

const mediaTypeOf = (contentType: string | undefined): string => {
  const mediaType = (contentType ?? "").split(";")[0]?.trim() ?? "";
  return MEDIA_TYPE.test(mediaType)
    ? mediaType.toLowerCase()
    : FALLBACK_MEDIA_TYPE;
};

const redirectRefused = (from: string, to: string, reason: string) =>
  new CliFailureError({
    detail: `Downloading ${from} redirected to ${to}, which ${reason}.`,
    failureCode: "ORI_CLI_ARTIFACT_RESOURCE_REFUSED",
    hint: "Refer to the file's final address on cdnjs, jsDelivr, unpkg or Google Fonts.",
  });

const downloadFollowingRedirects = Effect.fn("ArtifactInline.download")(
  function* (start: string) {
    const client = yield* HttpClient.HttpClient;
    let current = start;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const response = yield* client
        .execute(HttpClientRequest.get(current))
        .pipe(
          Effect.provideService(FetchHttpClient.RequestInit, NO_REDIRECTS),
          Effect.mapError(
            makeCliFailureFromCause({
              detail: `Failed to download ${current}`,
              failureCode: "ORI_CLI_ARTIFACT_RESOURCE_UNREACHABLE",
            })
          )
        );
      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.location;
        if (Predicate.isUndefined(location)) {
          return yield* redirectRefused(
            start,
            "no address",
            "gives saving nothing to download"
          );
        }
        const next = classifyAddress(location, current);
        if (!ResourceAddress.$is("Inlinable")(next)) {
          return yield* redirectRefused(
            start,
            location,
            ResourceAddress.$is("Refused")(next)
              ? next.reason
              : "is not a file saving can download"
          );
        }
        current = next.url;
        continue;
      }
      if (!isOkStatus(response.status)) {
        return yield* new CliFailureError({
          detail: `Downloading ${current} failed with HTTP ${response.status}.`,
          failureCode: "ORI_CLI_ARTIFACT_RESOURCE_DOWNLOAD_FAILED",
          hint: "Check the address in the page; a CDN answers 404 for a misspelt package, version or file.",
        });
      }
      const declaredLength = Number(response.headers["content-length"] ?? "0");
      if (declaredLength > MAX_RESOURCE_BYTES) {
        return yield* tooLarge(current);
      }
      const bytes = yield* collectBounded(current, response.stream);
      return {
        bytes,
        mediaType: mediaTypeOf(response.headers["content-type"]),
        url: current,
      } satisfies DownloadedResource;
    }
    return yield* new CliFailureError({
      detail: `Downloading ${start} redirected more than ${MAX_REDIRECTS} times.`,
      failureCode: "ORI_CLI_ARTIFACT_RESOURCE_DOWNLOAD_FAILED",
    });
  }
);

export const downloadResource = (url: string) =>
  downloadFollowingRedirects(url).pipe(
    Effect.timeoutOrElse({
      duration: DOWNLOAD_TIMEOUT,
      orElse: () =>
        Effect.fail(
          new CliFailureError({
            detail: `Downloading ${url} took longer than ${DOWNLOAD_TIMEOUT}.`,
            failureCode: "ORI_CLI_ARTIFACT_RESOURCE_UNREACHABLE",
            hint: "Try again; if the CDN keeps stalling, load the library from another of the listed CDNs.",
          })
        ),
    })
  );
