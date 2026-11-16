import { Option } from "effect";

const ORI_INTERN_DASHBOARD_URL_ENV = "ORI_INTERN_DASHBOARD_URL";

const parseUrl = Option.liftThrowable((value: string) => new URL(value.trim()));

export const artifactDashboardLink = (
  env: Readonly<Record<string, string | undefined>>,
  name: string
): Option.Option<string> =>
  Option.fromNullishOr(env[ORI_INTERN_DASHBOARD_URL_ENV]).pipe(
    Option.flatMap(parseUrl),
    Option.filter((url) => /^https?:$/.test(url.protocol)),
    Option.map(
      (url) =>
        `${url.origin}${url.pathname.replace(/\/+$/, "")}?tab=artifacts&artifact=${encodeURIComponent(name)}`
    )
  );
