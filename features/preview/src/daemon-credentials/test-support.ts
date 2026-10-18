import type { DaemonAuthorization } from "ori";

import { Layer } from "effect";

import {
  DaemonCredentials,
  type DaemonCredentialsShape,
} from "#src/daemon-credentials/index.ts";

const nonBlank = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
};

export const scriptedDaemonCredentials: DaemonCredentialsShape = {
  publishedFile: (env, port, homeDirectory) => {
    const home = nonBlank(env.HOME) ?? nonBlank(homeDirectory);
    return home === undefined ? undefined : `${home}/.ori/daemon/${port}.token`;
  },
  authorizationOf: ({ env, published }): DaemonAuthorization => {
    const token = nonBlank(env.ORI_DAEMON_TOKEN) ?? nonBlank(published);
    return token === undefined
      ? { kind: "unavailable", reason: "no daemon credential" }
      : { kind: "bearer", headers: { authorization: `Bearer ${token}` } };
  },
};

export const scriptedDaemonCredentialsLayer = Layer.succeed(DaemonCredentials)(
  scriptedDaemonCredentials
);
