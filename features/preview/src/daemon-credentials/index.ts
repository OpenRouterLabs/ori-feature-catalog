import { Context } from "effect";

type HostEnv = Readonly<Record<string, string | undefined>>;
export type DaemonAuthorization =
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "bearer"; readonly headers: { readonly authorization: string } };

export interface DaemonCredentialsShape {
  readonly authorizationOf: (input: {
    readonly env: HostEnv;
    readonly port: number;
    readonly homeDirectory: string | undefined;
    readonly published: string | undefined;
  }) => DaemonAuthorization;
  readonly publishedFile: (
    env: HostEnv, port: number, homeDirectory: string | undefined
  ) => string | undefined;
}

export class DaemonCredentials extends Context.Service<
  DaemonCredentials, DaemonCredentialsShape
>()("@ori-catalog/preview/DaemonCredentials") {}
