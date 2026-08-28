/**
 * proxy-agent.ts — route Slack calls through the vault sidecar.
 *
 * On an intern VM the agent container never holds real credentials. An
 * `ori vault-tunnel` sidecar runs a local CONNECT listener and the container's
 * `HTTPS_PROXY` points at `127.0.0.1:<port>`; the sidecar holds the vault
 * credentials and substitutes them on the way out. A client that ignores
 * `HTTPS_PROXY` therefore leaves with the PLACEHOLDER token the container was
 * given, and every call comes back `invalid_auth` — the surface boots, Bolt
 * refuses every incoming event at authorization, and the intern is silently
 * unreachable.
 *
 * `NO_PROXY` is not optional. The runtime container runs with `--network
 * host`, so an unqualified proxy would also capture traffic that must not go
 * through the sidecar.
 */

import { Predicate } from "effect";
import { HttpsProxyAgent } from "https-proxy-agent";

const SLACK_API_HOST = "slack.com";
const PROXY_ENV_KEYS = ["https_proxy", "HTTPS_PROXY"] as const;
const NO_PROXY_ENV_KEYS = ["no_proxy", "NO_PROXY"] as const;
const NO_PROXY_WILDCARD = "*";

type ProcessEnv = Readonly<Record<string, string | undefined>>;

const firstPresent = (
  env: ProcessEnv,
  keys: readonly string[]
): string | undefined => {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
};

const matchesNoProxyEntry = (host: string, entry: string): boolean => {
  if (entry === NO_PROXY_WILDCARD) {
    return true;
  }
  const suffix = entry.replace(/^\*?\./u, "");
  return host === suffix || host.endsWith(`.${suffix}`);
};

const bypassesProxy = (host: string, noProxy: string | undefined): boolean =>
  (noProxy ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .some((entry) => matchesNoProxyEntry(host, entry));

export const resolveSlackProxyAgent = (
  env: ProcessEnv = Bun.env
): HttpsProxyAgent<string> | undefined => {
  const proxyUrl = firstPresent(env, PROXY_ENV_KEYS);
  if (Predicate.isUndefined(proxyUrl)) {
    return undefined;
  }
  if (bypassesProxy(SLACK_API_HOST, firstPresent(env, NO_PROXY_ENV_KEYS))) {
    return undefined;
  }
  return new HttpsProxyAgent(proxyUrl);
};
