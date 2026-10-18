import type { daemonAuthorizationOf, publishedDaemonCredentialFile } from "ori";

import { Context } from "effect";

export interface DaemonCredentialsShape {
  readonly authorizationOf: typeof daemonAuthorizationOf;
  readonly publishedFile: typeof publishedDaemonCredentialFile;
}

export class DaemonCredentials extends Context.Service<
  DaemonCredentials,
  DaemonCredentialsShape
>()("@ori-catalog/preview/DaemonCredentials") {}
