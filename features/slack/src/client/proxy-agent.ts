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
  env: ProcessEnv
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
