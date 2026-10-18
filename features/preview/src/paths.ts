export const PREVIEW_DIRECTORY = ".ori/preview";

export const PREVIEW_ENABLED_ENV = "ORI_PREVIEW_ENABLED";

export const PREVIEW_REPOS_ENV = "ORI_PREVIEW_REPOS";

export const PREVIEW_CDP_PORT = 9222;

export const PREVIEW_MAX_WARM = 1;

export const PREVIEW_UID = 10001;

export const PREVIEW_PORT_RANGE = { first: 41_000, last: 41_999 } as const;

export const PORT_PLACEHOLDER = "{port}";

export const PREVIEW_SANDBOX_ROOT = "/preview";

export interface PreviewPaths {
  readonly workspace: string;
  readonly sandbox: string;
  readonly root: string;
  readonly repos: string;
  readonly status: string;
  readonly alternates: string;
  readonly recipes: string;
  readonly logs: string;
  readonly scratch: string;
  readonly shots: string;
  readonly work: string;
  readonly home: string;
  readonly synced: string;
  readonly browserState: string;
  readonly browserProfile: string;
}

export const previewPaths = (
  workspaceRoot: string,
  sandboxRoot: string = PREVIEW_SANDBOX_ROOT
): PreviewPaths => {
  const root = `${workspaceRoot}/${PREVIEW_DIRECTORY}`;
  return {
    workspace: workspaceRoot,
    sandbox: sandboxRoot,
    root,
    repos: `${sandboxRoot}/repos`,
    status: `${root}/status`,
    alternates: `${root}/alternates`,
    recipes: `${root}/recipes`,
    logs: `${root}/logs`,
    scratch: `${sandboxRoot}/scratch`,
    shots: `${workspaceRoot}/preview-shots`,
    work: `${sandboxRoot}/work`,
    home: `${sandboxRoot}/home`,
    synced: `${root}/synced`,
    browserState: `${root}/browser.json`,
    browserProfile: `${sandboxRoot}/chromium-profile`,
  };
};

export const repoSlug = (repo: string): string =>
  repo.toLowerCase().replace("/", "__");

export const repoCheckout = (paths: PreviewPaths, repo: string): string =>
  `${paths.repos}/${repoSlug(repo)}`;

export const syncMarkerPath = (paths: PreviewPaths, repo: string): string =>
  `${paths.synced}/${repoSlug(repo)}`;

export const recipeCachePath = (paths: PreviewPaths, repo: string): string =>
  `${paths.recipes}/${repoSlug(repo)}.json`;

export const statusPath = (paths: PreviewPaths, repo: string): string =>
  `${paths.status}/${repoSlug(repo)}.json`;

export const alternatePath = (paths: PreviewPaths, repo: string): string =>
  `${paths.alternates}/${repoSlug(repo)}.json`;

export const devLogPath = (paths: PreviewPaths, repo: string): string =>
  `${paths.logs}/${repoSlug(repo)}.log`;

export const alternateLogPath = (paths: PreviewPaths, repo: string): string =>
  `${paths.logs}/${repoSlug(repo)}.alternate.log`;

export const installLogPath = (paths: PreviewPaths, repo: string): string =>
  `${paths.logs}/${repoSlug(repo)}.install.log`;

export const LOOPBACK_HOSTS = ["127.0.0.1", "[::1]"] as const;

export type LoopbackHost = (typeof LOOPBACK_HOSTS)[number];

export const localUrl = (
  port: number,
  path = "/",
  host: LoopbackHost = "127.0.0.1"
): string =>
  `http://${host}:${port}${path.startsWith("/") ? path : `/${path}`}`;
