// gh-app-registry.ts — a dedicated bun:sqlite store mapping (org, purpose) to the
// NAMES of the env vars that hold a GitHub App's credentials. It never stores a
// secret value — only which env keys to read at mint time (`gh-app-token.ts`
// resolves the values from `process.env`).
//
// One table in the intern's dedicated gh-app-registry.db (path derived from the
// intern name — see resolveConfigDirName):
//   - `gh_app_registry` — (org, purpose) → {app_id_key, private_key_key}
//
// The default app (bare `GH_APP_ID` / `GH_APP_PRIVATE_KEY`) needs no row; it is
// the final fallback in `resolveApp`.

import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * An env-var override for the registry DB's parent directory — a TEST-ONLY
 * seam. Tests must redirect every production-path registry/cache touch here
 * (e.g. `GH_APP_REGISTRY_DIR=$(mkdtemp -d)`), NOT by reassigning
 * `process.env.HOME`: Bun's `os.homedir()` snapshots the real home at process
 * start and ignores a runtime reassignment, so a HOME-redirected test
 * silently opened its DB under the operator's real `~/.config/<intern>/` —
 * hundreds of stray `wwg-cache-*` registry DBs accumulated that way on this
 * workspace's home. The variable holds an absolute directory path; the DB
 * file is always `gh-app-registry.db` inside it.
 */
const REGISTRY_DIR_ENV = "GH_APP_REGISTRY_DIR";

const DB_DIR_MODE = 0o700;
const DB_FILE_MODE = 0o600;
/**
 * How long (ms) a writer waits for the registry's SQLite write lock before
 * failing. Every user of this DB opens its own short-lived connection (the
 * register CLI, a mint's registry lookup, a mint's installation-cache
 * put/delete/purge), and SQLite's default busy timeout is 0: two overlapping
 * writers — e.g. `register-gh-app` while a concurrent mint lands its cache put —
 * make the second fail immediately with `SQLITE_BUSY: database is locked`
 * (repro: hold `BEGIN IMMEDIATE` on one connection, write from another). The
 * registry/cache seams swallow that as a no-op (a registration silently lost, a
 * cache put silently skipped), so the write just disappears. A bounded wait
 * lets a normal concurrent writer finish instead.
 */
const DB_BUSY_TIMEOUT_MS = 5000;
/** `Date.now()` is milliseconds; `registered_at` is stored in whole seconds. */
const MS_PER_SECOND = 1000;

/** The purpose used for an org's catch-all row and the default when none is given. */
export const DEFAULT_PURPOSE = "default";

/**
 * Extract the org from an `owner/repo`, full `https://` URL, or ssh/scp-style
 * (`git@github.com:owner/repo`) string. Mirrors the sibling normalizers
 * (`resolveRepoFromEnv` in scripts/commit-api-core.ts, `resolveAllowedOrgs`
 * in gh-app-github-api.ts) — all three accept the same spellings — so one
 * repo string routes identically through the registry, the allowlist, and the
 * Git-Data paths. Defined here (above the CRUD section) so `registerApp` can
 * normalize the org it persists.
 */
export const orgOf = (repo: string): string => {
  // Trim trailing slashes as well as whitespace: `acme/widgets/` (a
  // copy-paste from a browser address bar) is the same repo as
  // `acme/widgets`, and the bare-match alternative below keys on exactly
  // two segments — a trailing slash left it unmatchable, so a registered
  // org never resolved and minting silently fell back to the default App.
  // The `.git` strip runs BEFORE a SECOND trailing-slash strip, never after:
  // a `/.git` suffix (separator-then-dot-git — `https://github.com/acme/.git`,
  // `github.com:acme/.git`, `acme/.git`) exposes the interior `/` once the
  // suffix comes off, and every `$`-anchored branch below (the org-URL and
  // two-segment matches) then missed, returning the raw URL as the "org" —
  // a registry key no mint can ever produce, a config dir that silently
  // migrated, and a repo every `repos/{repo}` route 404s on. The prompt's
  // `REPO=` sed recipe already collapses these (`s#\.git$##` then `s#/$##`);
  // the resolvers must agree with it.
  // Strip LEADING slashes first — `/acme/widgets` (a shell-autocomplete
  // paste) is the same repo as `acme/widgets`, and the resolvers below key
  // on anchored two-segment tails: pre-fix the bare-match branch missed the
  // leading slash and `orgOf` returned the WHOLE string as the "org", so a
  // registry row registered from it (and the allowlist derived alongside)
  // was keyed `/acme/widgets` — a key no mint can ever derive from a real
  // repo string. `resolveRepoFromEnv` and the prompt's `REPO=` sed strip
  // the same slash; `orgOf` must agree.
  // A host-case spelling — `https://GitHub.com/acme/widgets`,
  // `git@GitHub.com:acme/widgets`, `GitHub.com:22/acme` (a copy-paste whose
  // host kept the address bar's capitalization, or an ssh config alias) — is
  // the same URL: hosts are case-insensitive (RFC 3986 §3.2.2), and every
  // real git/gh/curl client accepts the mixed-case host. Lower-casing the
  // HOST WORD up front (never the owner/repo path — GitHub logins keep their
  // case) lets every anchored `github.com` branch below see the same string
  // the sibling resolvers see, so one spelling resolves identically through
  // all four. Pre-fix a mixed-case host fell every branch (the regexes match
  // a literal lowercase `github.com`) and the raw URL was returned whole as
  // the "org" — a registry key no mint can ever derive, and every
  // `repos/{repo}` route 404s on (the #159/#169 class, reopened through the
  // host's capitalization).
  const hostLowered = repo.replace(
    /^((?:[a-zA-Z][a-zA-Z0-9+.-]*)?:\/\/)?((?:[^@\/\s]+@)?)([Gg][Ii][Tt][Hh][Uu][Bb]\.[Cc][Oo][Mm])(?=:\d+(?:[\/:]|$)|[\/:]|$)/u,
    (_m: string, scheme: string, user: string, host: string) =>
      `${scheme ?? ""}${user ?? ""}${host.toLowerCase()}`
  );
  const cleaned = hostLowered
    .trim()
    // Strip a QUERY or FRAGMENT suffix — `o/r?tab=readme`, `o/r#anchor`
    // (a browser address-bar copy-paste) — before the anchored branches
    // below: both delimiters are URL-reserved characters a repo or org
    // NAME cannot carry, and pre-fix the `$`-anchored orgs-page branch
    // captured `acme?x` as the org for `https://github.com/orgs/acme?x`
    // (its `[^/]+` segment absorbs the suffix), so a query-suffixed
    // --org/--repo paste registered a dead registry key no mint could
    // ever derive while resolveRepoFromEnv and resolveConfigDirName kept
    // disagreeing about it — the same one-spelling contract the sibling
    // strips below each enforce for their own paste class.
    .replace(/\?.*$/u, "")
    .replace(/#.*$/u, "")
    .replace(/[\/\s]+$/gu, "")
    .replace(/\.git$/u, "")
    .replace(/[\/\s]+$/gu, "")
    // Collapse interior runs of path slashes — `github.com//o/r`, `o//r`
    // (a copy-paste that kept a doubled path slash, the same paste class as
    // the trailing slash the strips above already handle). The `$`-anchored
    // two-segment tails below key on `[^/]+/[^/]+`, which an EMPTY path
    // segment never matches, so pre-fix the whole raw string fell every
    // branch and returned whole — a registry key and allowlist entry no mint
    // can ever derive from a real repo string, and every mint silently fell
    // back to the default App (the #101/#159 class, reopened through the
    // interior double). The prompt's REPO= sed recipe collapses the same
    // paste (its anchored `s#(^[^/]+/[^/]+)(/.*)?$#\1#` keys on the same
    // non-empty segments); the resolvers must agree with it. A scheme's own
    // `://` is guarded and never collapses; the scp host separator is a
    // bare `:`, so `git@github.com://o/r` collapses to the scp form
    // `git@github.com:o/r`. `resolveRepoFromEnv` and `resolveAllowedOrgs`
    // strip the same runs.
    .replace(/(?<!(?:https?|ssh|git\+ssh|ftp)):\/+/gu, ":")
    .replace(/(?<!(?:https?|ssh|git\+ssh|ftp):)\/\/+/gu, "/");
  const leadingSlashStripped = cleaned.replace(/^\/+/u, "");
  // Strip an explicit PORT before any regex runs: with the port left in,
  // the two-segment repo match below can BACKTRACK past the optional
  // `(?::\d+)?` port group — the `:` itself becomes the `[/:]` separator,
  // the port digits become the "owner", and the single segment after it the
  // "repo". A ported ORG spelling (`ssh://git@github.com:22/acme` — the
  // natural `--org`/org-page form) has exactly one segment after the host, so
  // the repo regex fails on the real reading and SUCCEEDS on the backtracked
  // one: `orgOf` returned `"22"`, the exact fake-owner class #186 closed for
  // the two-segment repo form. A port is unambiguous — `:<digits>` right
  // after the `github.com` host, before any separator or end — so removing
  // it up front lets every branch below see the same string the ported repo
  // spellings already resolve through.
  const portStripped = leadingSlashStripped.replace(
    /((?:git@)?github\.com):\d+(?=[\/:]|$)/u,
    "$1"
  );
  // The ORGANIZATIONS page spellings — `https://github.com/orgs/<org>` (the
  // "Your organizations" page) and `/organizations/<org>` — are the same
  // copy-paste class as the org URL below, but they MUST be stripped before
  // the repo match: `github.com/orgs/acme` also parses as owner `orgs` with
  // repo `acme`, so the repo regex would return the host word `orgs` — a
  // dead registry row no mint can ever match, silently bypassing the
  // registered App. `orgs`/`organizations` are reserved host paths on
  // github.com, never an owner login, so the page reading is the only real
  // one.
  // An explicit PORT in the host-separator position — `ssh://git@github.com:22/acme`
  // (a `git remote -v` copy-paste) — makes the bare `[/:]` separator match the
  // port digits as the first path segment, so every resolver below resolved a
  // fake `owner/repo` pair (`22/acme`) from it: the registry row, the allowlist
  // entry, and the Git-Data repo all keyed on the port, and every mint failed
  // closed with no hint the spelling was the cause (#159/#169/#175/#177's
  // class, reopened through the ported form). A port only appears as `:<digits>`
  // immediately after the host; consume it so the separators below see the
  // real path start.
  const orgsPageMatch =
    /(?:git@)?github\.com(?::\d+)?[/:](?:orgs|organizations)[/:]([^/]+)/u.exec(
      portStripped
    );
  if (orgsPageMatch?.[1] !== undefined) {
    return orgsPageMatch[1];
  }
  // A HOSTLESS paste of the same path — bare `orgs/<org>` or
  // `organizations/<org>` (the URL path copied without the host) — carries
  // the same reserved word: pre-fix it fell through to the repo branches
  // below, which read `orgs` as the OWNER, so `registerApp --org orgs/acme`
  // persisted a dead row keyed `orgs` while `resolveConfigDirName` (the only
  // sibling resolver that handled the spelling) keyed the config dir `acme`
  // — four resolvers disagreed on one spelling, violating the README's
  // one-spelling contract (the #169 orgs-page class, reopened through the
  // hostless form). The prompt's own `REPO=` sed strips it to the org; match
  // it. A repo genuinely NAMED `<org>` under an owner called `orgs` is
  // unreachable by this spelling anyway — the reserved word never resolves
  // as an owner login on github.com.
  // The HOSTLESS branches below anchor `^` on the CLEANED string, so a
  // LEADING slash on their spellings (`/orgs/acme`, `/organizations` — the
  // same shell-autocomplete paste #208 closed for the repo spellings, and
  // the prompt's `REPO=` recipe strips first) made every anchor miss and the
  // bare pass-through at the bottom returned the word with its slash shorn
  // off — `orgOf("/organizations")` answered `organizations` while the bare
  // word answered `""`, and the registry key, the allowlist and the config
  // dir all keyed on the reserved word. `leadingSlashStripped` exists for
  // exactly this; read it here, matching every sibling resolver.
  const hostlessOrgsMatch =
    /^(?:orgs|organizations)\/([^/]+?)(?:\/.*)?$/u.exec(leadingSlashStripped);
  if (hostlessOrgsMatch?.[1] !== undefined) {
    return hostlessOrgsMatch[1];
  }
  // The ORGANIZATIONS-page INDEX spelling — `https://github.com/orgs`
  // (also `/organizations`, the scp/ssh host-word form, and the ported
  // spellings) — ends AT the reserved host-path word with no org segment
  // after it: it is the page that LISTS your organizations, not one of
  // them. Pre-fix the org-URL branch below captured the word itself as the
  // org (`orgs`), so a registry row registered from it was keyed on a
  // reserved host path no mint can ever derive a match for (the exact
  // #101/#143 dead-row class the `orgs/<org>` branch above exists to
  // close, reopened through the index spelling), and the sibling resolvers
  // derived the same fake owner for the config dir and the allowlist. The
  // word is never an owner login — return NO org at all so the callers
  // that must fail loudly do (register-gh-app's normalized-org guard) and
  // the fallback paths keep their documented no-owner behavior. A REPO
  // named `orgs` under a real owner never reaches here: the repo branches
  // below capture the owner past the host path first, and the org-naming
  // spellings (`orgs/<org>`) already returned above.
  const orgsIndexMatch =
    /(?:git@)?github\.com(?::\d+)?[/:](?:orgs|organizations)$/u.exec(
      portStripped
    );
  if (orgsIndexMatch !== null) {
    return "";
  }
  // The HOSTLESS index spelling — a bare `organizations` word with no host
  // and no org segment — is the same page and names no org: return the
  // documented no-owner answer so register-gh-app's normalized-org guard
  // fails loudly instead of persisting a dead row keyed on the reserved word.
  // A bare `orgs` word keeps its pass-through (a login spelled `orgs`): the
  // org-NAMING branch above already consumed the reserved-word reading
  // whenever a second segment exists, so the bare word alone is the
  // bare-owner shape, and discovery refuses it honestly.
  if (/^organizations$/u.test(leadingSlashStripped)) {
    return "";
  }
  // A deep GitHub URL — `https://github.com/o/r/tree/main` (a copied
  // blob/tree/PR/releases address) — collapses to its owner, exactly like the
  // two-segment form: the raw URL was returned whole, so a row registered
  // from it could never match the org a mint derives, and every mint
  // silently fell back to the default App (#101 class reopened through the
  // deep path).
  const hostMatch =
    /(?:git@)?github\.com(?::\d+)?[/:]([^/]+)\/[^/]+(?:\/.*)?$/u.exec(
      portStripped
    );
  if (hostMatch?.[1] !== undefined) {
    return hostMatch[1];
  }
  // An ORG URL — `https://github.com/<org>` (a copy-pasted org page, the
  // natural spelling for `--org`) carries no repo segment, so the repo
  // regexes above miss it and the raw URL was returned whole. The mint path
  // derives its registry key from a repo string via this same function, so
  // a row persisted under the raw URL never matched and every mint silently
  // fell back to the default App — the #101 class reopened through the org
  // side. Strip the host down to its org segment.
  const orgUrlMatch =
    /(?:git@)?github\.com(?::\d+)?[/:]([^/]+)$/u.exec(portStripped);
  if (orgUrlMatch?.[1] !== undefined) {
    return orgUrlMatch[1];
  }
  // A BARE-HOST spelling — `https://github.com`, `github.com`, or the
  // scp/ssh form `git@github.com` / `ssh://git@github.com` (a copied landing
  // page or a truncated `git remote -v` paste, with NO owner and NO repo
  // segment at all) — names no owner: pre-fix the bare pass-through at the
  // bottom returned the raw host string whole as the "org", so a registry
  // row or allowlist entry keyed on `github.com` — a login no GitHub
  // account can ever carry — while `resolveRepoFromEnv` resolved the SAME
  // spelling to `""` and the config dir keyed `https-github.com`, so the
  // four resolvers silently disagreed on one spelling (the README's
  // one-spelling contract). `orgOf` is the sibling normalizer every registry
  // key and allowlist entry derive through, so its honest answer for a
  // host string is no owner at all.
  if (
    /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:\/\/)?(?:[^@/\s]+@)?github\.com$/u.test(
      portStripped
    )
  ) {
    return "";
  }
  // A HOSTLESS deep paste — bare `owner/repo/<tail>` (the URL path of a
  // copied blob/tree/PR/releases address, pasted without the host) — is
  // the same deep spelling the `hostMatch` branch above closes for the
  // hosted form: pre-fix it fell every branch (the bare two-segment match
  // below anchors `$`), `orgOf` returned the WHOLE string as the "org",
  // and a registry row registered from a deep `--repo`/`--org` paste
  // could never match the org a mint derives — every mint silently fell
  // back to the default App (#101/#159's class, reopened through the
  // hostless deep path). The prompt's `REPO=` sed recipe collapses the
  // same paste (`s#(^[^/]+/[^/]+)(/.*)?$#\1#`), so this branch keeps
  // `orgOf` on the recipe's contract: one spelling, four resolvers.
  const hostlessDeepMatch = /^([^/]+)\/([^/]+)(?:\/.*)?$/u.exec(
    portStripped
  );
  if (hostlessDeepMatch?.[1] !== undefined) {
    return hostlessDeepMatch[1];
  }
  const bareMatch = /^([^/]+)\/[^/]+$/u.exec(portStripped);
  return bareMatch?.[1] ?? portStripped;
};

// #region Config dir resolution

/** Reduce an arbitrary string to a safe single path segment. */
const sanitizeSegment = (raw: string): string =>
  raw
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/gu, "-")
    .replaceAll(/^[.-]+|[.-]+$/gu, "");

/**
 * Resolve the intern's config directory name — `INTERN_NAME`, else the repo
 * segment of `GITHUB_REPO`, else `"intern"`. Mirrors the linear feature's
 * resolver so both stores land under the same `~/.config/<name>/` directory.
 */
export const resolveConfigDirName = (
  env: Readonly<Record<string, string | undefined>> = Bun.env
): string => {
  const fromInternName = (env.INTERN_NAME ?? "").trim();
  if (fromInternName !== "") {
    return sanitizeSegment(fromInternName);
  }
  // Trim trailing slashes as well as whitespace — the same normalization every
  // sibling repo-string resolver already applies (orgOf, resolveRepoFromEnv,
  // resolveAllowedOrgs). This resolver is the one that missed it: a trailing
  // slash made the regexes below match the whole URL instead of its
  // `owner/repo` tail, so the config dir name (and with it the registry DB
  // path) silently changed with the spelling of GITHUB_REPO — `acme/widgets/`
  // resolved to `acme-widgets` instead of `widgets`, and the URL spelling
  // became `https-github-com-acme-widgets`.
  // The trailing-slash strip runs AGAIN after the `.git` strip: a `/.git`
  // suffix (`https://github.com/acme/.git` — separator-then-dot-git) exposes
  // an interior `/` the first strip cannot see (the string ends in `t`, not
  // `/`), so every branch below missed and the dir name silently migrated to
  // a sanitized URL (`https-github-com-acme`), orphaning the registry/cache
  // rows the org spelling wrote (#113's class, reopened through the paste).
  // The same host-case class `orgOf` closes above: a host word that kept the
  // address bar's capitalization (`https://GitHub.com/…`, `GitHub.com:…`) is
  // case-insensitive by RFC 3986 §3.2.2 and accepted by every real client, but
  // every anchored `github.com` literal below (the orgs-index guard, the
  // host-word strip, the port strip) matches lowercase only — so a mixed-case
  // host fell every branch and the fallback named the config dir after the
  // raw URL's junk segments (`orgs` for an orgs-page index, a sanitized URL
  // for a repo page), silently migrating the registry/cache DB the moment the
  // env var's spelling changed case (#113's class, reopened through the host).
  const hostLoweredRepo = (env.GITHUB_REPO ?? "").replace(
    /^((?:[a-zA-Z][a-zA-Z0-9+.-]*)?:\/\/)?((?:[^@\/\s]+@)?)([Gg][Ii][Tt][Hh][Uu][Bb]\.[Cc][Oo][Mm])(?=:\d+(?:[\/:]|$)|[\/:]|$)/u,
    (_m: string, scheme: string, user: string, host: string) =>
      `${scheme ?? ""}${user ?? ""}${host.toLowerCase()}`
  );
  const repoRaw = hostLoweredRepo
    .trim()
    // Strip a QUERY or FRAGMENT suffix — `o/r?tab=readme`, `o/r#anchor`
    // (a browser address-bar copy-paste) — before the anchored branches
    // below, the same strip `orgOf`, `resolveRepoFromEnv` and
    // `resolveAllowedOrgs` apply: pre-fix the repo-match fallback below
    // sanitized the suffix into the dir name (`r-tab-readme`, `r-anchor`),
    // a directory no sibling resolver's key ever derives, so the
    // registry/cache DB silently migrated the moment the env var's
    // spelling carried a query or fragment (#113's class).
    .replace(/\?.*$/u, "")
    .replace(/#.*$/u, "")
    .replace(/[\/\s]+$/gu, "")
    .replace(/\.git$/u, "")
    .replace(/[\/\s]+$/gu, "")
    // Strip LEADING slashes before the anchored branches below, the same
    // normalization `orgOf` and `resolveRepoFromEnv` already apply (#208's
    // class): `//organizations` collapsed to `/organizations` one line above,
    // and the `^organizations$` guard below then missed, so the fallback
    // named the config dir after the reserved word — the registry/cache DB
    // silently migrated the moment the env var's spelling gained a leading
    // slash (#113's class, reopened through the leading slash).
    .replace(/^\/+/u, "")
    // Collapse interior runs of path slashes — the same normalization `orgOf`
    // applies (see its own interior-double branch above): `github.com//o/r`,
    // `o//r`. The repo regexes below anchor on the two-segment tail, which an
    // EMPTY path segment never matches, so pre-fix the raw URL flowed through
    // whole and the dir name silently migrated to a sanitized URL
    // (`https-github.com-o-r`), orphaning the registry/cache rows every other
    // spelling had written (#113's class, reopened through the interior
    // double). The scheme's own `://` is guarded and never collapses; the scp
    // host separator is a bare `:`.
    .replace(/(?<!(?:https?|ssh|git\+ssh|ftp)):\/+/gu, ":")
    .replace(/(?<!(?:https?|ssh|git\+ssh|ftp):)\/\/+/gu, "/");
  // Strip an explicit PORT before any regex runs — the same normalization
  // `orgOf` applies (see its own port-stripping above). The host-word strip
  // below carries `(?::\d+)?` as an OPTIONAL group with a REQUIRED `[/:]`
  // after it, so a bare host+PORT spelling that ENDS at the port
  // (`ssh://git@github.com:22`, `https://github.com:443` — truncated `git
  // remote -v` copy-pastes) makes the trailing `[/:]` consume the `:` INSIDE
  // the port instead: the optional port group matched empty, the strip
  // removed everything up to and including that colon, and the surviving
  // PORT DIGITS became the org the `orgOf` branch below resolves — the
  // config dir keyed on `22`/`443` while the same env var spelled without
  // the port (`ssh://git@github.com`) keyed on the sanitized host word, so
  // the registry/cache DB silently migrated the moment the spelling
  // changed, orphaning every row already written (#113's class, reopened
  // through the bare ported spelling — the exact #186/#190 port-digits
  // class the sibling resolvers already close). Stripping an unambiguous
  // `:<digits>` right after the `github.com` host first lets every branch
  // below see the same string `orgOf` resolves through.
  const portStripped = repoRaw.replace(
    /((?:git@)?github\.com):\d+(?=[\/:]|$)/u,
    "$1"
  );
  // The ORGANIZATIONS-page INDEX spelling — `https://github.com/orgs` (also
  // `/organizations`, the scp/ssh host-word form, the ported spellings) —
  // ends AT the reserved host-path word with no org segment after it, so
  // neither an org nor a repo is derivable from it. Pre-fix the
  // host-stripped single-segment branch below captured the word itself
  // (`orgs`/`organizations`) and named the config dir after it, silently
  // migrating the registry/cache DB the moment the env var's spelling
  // changed (#113's class, reopened through the index spelling). The word
  // is never an owner login — fall to the documented no-repo fallback
  // ("intern") instead. `orgOf` and the sibling resolvers return the same
  // no-owner answer for this spelling; a real org page
  // (`https://github.com/acme`) and a repo named `orgs` under a real owner
  // are untouched — they carry a segment past the host word.
  if (
    /(?:git@)?github\.com(?::\d+)?[/:](?:orgs|organizations)$/u.test(
      portStripped
    )
  ) {
    return "intern";
  }
  // The HOSTLESS index spelling — a bare `organizations` word with no host
  // and no org segment — is the same page and names no repo either: `orgOf`
  // and `resolveRepoFromEnv` both answer "no owner" for it, and this
  // resolver must take the same documented no-repo fallback ("intern").
  // Pre-fix the bare pass-through below captured the reserved word itself as
  // the dir name, so `GITHUB_REPO=organizations` silently migrated the
  // registry/cache DB to `~/.config/organizations/` — a directory no
  // sibling resolver's key ever derives — while the hosted spelling of the
  // same page (`https://github.com/orgs`) already keyed `intern` (#113's
  // class, reopened through the hostless bare word). A bare `orgs` word
  // keeps its pass-through, the same split `orgOf` applies (a login spelled
  // `orgs`).
  if (/^organizations$/u.test(portStripped)) {
    return "intern";
  }
  // A host-word spelling with a COLON and no slash — `git@github.com:acme` /
  // `github.com:acme`, the scp/ssh org-page forms — has no repo segment, so
  // the repo regexes below miss it and `match?.[2]` falls back to the RAW
  // string: the config dir (and with it the registry/cache DB path) becomes
  // `git-github.com-acme` instead of `acme` — a different directory than the
  // one every other spelling of the same repo resolves to, silently
  // migrating the DB and orphaning the old rows the moment the env var's
  // spelling changes. `orgOf` already owns this normalization; share it.
  // The ported ORG spellings (`ssh://git@github.com:22/acme`,
  // `github.com:29418/acme`) carry a slash, so the colon-only guard below
  // misses them; strip an optional `github.com`[:port] host word first (the
  // same `orgOf` branch every ported spelling already routes through) so an
  // org-only tail resolves to the org, never a sanitized raw URL.
  // A USER-INFO word before the host — `ssh://deploy@github.com/acme`,
  // `bob@github.com:22/acme` (a deploy-key or CI remote form `git remote -v`
  // produces) — must be stripped with it: pre-fix the `^`-anchored strip
  // only tolerated the literal `git@` user, so a spelling with any other
  // user word kept its prefix, failed the single-segment org branch below,
  // missed the two-segment repo regexes, and the fallback sanitized the
  // WHOLE URL — `ssh-deploy-github.com-acme` — a directory no sibling
  // resolver's key ever derives (`orgOf`, `resolveRepoFromEnv` and
  // `resolveAllowedOrgs` all resolve `acme` here), silently migrating the
  // registry/cache DB the moment the env var's spelling carried a non-`git`
  // user word (#113's class, reopened through the user-info form).
  const hostStripped =
    portStripped !== "" && !portStripped.includes("/")
      ? portStripped
      : portStripped.replace(
          /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@\/\s]+@)?github\.com(?::\d+)?[/:]/u,
          ""
        );
  if (hostStripped !== "" && !hostStripped.includes("/")) {
    const org = orgOf(hostStripped);
    const sanitized = sanitizeSegment(org);
    if (sanitized !== "") {
      return sanitized;
    }
  }
  if (portStripped !== "") {
    // A BARE-HOST spelling — `https://github.com`, `github.com`, the
    // scp/ssh forms (a copied landing page or a truncated `git remote -v`
    // paste, with NO owner and NO repo segment at all) — has no repo
    // segment to name, so the documented no-repo fallback ("intern", the
    // same one the orgs-page INDEX and hostless index spellings above take)
    // applies: pre-fix the repo-match fallback below sanitized the raw
    // host string into the dir name (`https-github.com`, `github.com`,
    // `git-github.com`), a directory no sibling resolver's key ever derives
    // while `orgOf`, `resolveRepoFromEnv` and `resolveAllowedOrgs` resolved
    // the SAME spellings to no owner at all — the registry/cache DB silently
    // migrated the moment the env var's spelling was a bare host (#113's
    // class), orphaning every row already written.
    if (
      /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:\/\/)?(?:[^@/\s]+@)?github\.com$/u.test(
        portStripped
      )
    ) {
      return "intern";
    }
    // A PORT in the host separator (ssh://git@github.com:22/…) must be
    // consumed before the repo regexes below, exactly as `orgOf` does
    // (#186's class): the repo match anchored on the two-segment tail of the
    // raw URL never matched, so the fallback returned the OWNER (or worse,
    // sanitized the whole URL), while every other spelling of the same repo
    // resolved to the repo segment — silently migrating the config dir (and
    // with it the registry/cache DB) whenever the env var's spelling changed.
    // `github.com`/`git@github.com` with an optional `:<port>` host word is
    // stripped down to its `owner/repo` tail so the existing regexes see the
    // real path start.
    const hostPortStripped = portStripped.replace(
      /(?:git@)?github\.com(?::\d+)?[/:]/u,
      ""
    );
    // A deep GitHub URL — `https://github.com/o/r/tree/main` (a copied
    // blob/tree/PR/releases address) — resolved the config-dir name from its
    // LAST segment (`main`, `x.ts`, even `42`), silently migrating the
    // registry/cache DB to a new directory (and orphaning the old one's rows)
    // because the regex anchored to the string's tail. Match the owner/repo
    // pair right after the host (or at the head of a bare string) so a deep
    // path keeps resolving to the repo name, like every other spelling.
    const match =
      /(?:github\.com[/:])?([^/\s]+)\/([^/\s]+)(?:\/.*)?$/u.exec(
        hostPortStripped
      ) ??
      /(?:github\.com[/:])?([^/]+)\/([^/]+)$/u.exec(hostPortStripped);
    // The fallback carries the PORT-STRIPPED string: `repoRaw` still holds
    // the bare host+PORT spelling (`ssh://git@github.com:22`), whose port
    // digits would survive into the sanitized dir name (`…-22`) — a
    // different directory than the same env var spelled without the port
    // resolves to, silently migrating the registry/cache DB.
    const repoName = match?.[2] ?? portStripped;
    const sanitized = sanitizeSegment(repoName);
    if (sanitized !== "") {
      return sanitized;
    }
  }
  return "intern";
};

// #endregion

// #region Types

/** The env-var key names for one registered app — values are never stored. */
export interface GhAppKeyNames {
  readonly appIdKey: string;
  readonly privateKeyKey: string;
}

export interface RegisterAppInput extends GhAppKeyNames {
  readonly org: string;
  readonly purpose: string;
}

interface RawRow {
  readonly org: string;
  readonly purpose: string;
  readonly app_id_key: string;
  readonly private_key_key: string;
  readonly registered_at: number;
}

export interface GhAppRegistryRow extends GhAppKeyNames {
  readonly org: string;
  readonly purpose: string;
  readonly registeredAt: number;
}

// #endregion

// #region Schema + opener

export const createGhAppRegistrySchema = (db: Database): void => {
  // `org` and `purpose` are COLLATE NOCASE: GitHub org logins are effectively
  // case-insensitive, so registering `acme-corp` must match a mint against
  // `acme-corp/...` rather than silently missing the row and falling back
  // to the default app. NOCASE applies to the PRIMARY KEY uniqueness and to
  // every `WHERE org = ? AND purpose = ?` equality lookup.
  db.run(`
    CREATE TABLE IF NOT EXISTS gh_app_registry (
      org             TEXT    NOT NULL COLLATE NOCASE,
      purpose         TEXT    NOT NULL COLLATE NOCASE,
      app_id_key      TEXT    NOT NULL,
      private_key_key TEXT    NOT NULL,
      registered_at   INTEGER NOT NULL,
      PRIMARY KEY (org, purpose)
    )
  `);
  // Cache of discovered installation ids so a mint skips the `GET /app/installations`
  // pagination on the hot path. Keyed by (app_id, org) — `org` is COLLATE NOCASE
  // to match discovery's case-insensitive login matching. An installation id is a
  // GitHub-stable identifier, so there is no TTL: a stale entry (App reinstalled)
  // is detected by a 401/404 on the token POST and invalidated then. `app_id` is
  // the numeric App id (not a secret); `installation_id` is likewise not a secret.
  db.run(`
    CREATE TABLE IF NOT EXISTS gh_installation_cache (
      app_id          TEXT    NOT NULL,
      org             TEXT    NOT NULL COLLATE NOCASE,
      installation_id TEXT    NOT NULL,
      cached_at       INTEGER NOT NULL,
      PRIMARY KEY (app_id, org)
    )
  `);
};

/**
 * Open the intern's dedicated GitHub-App registry DB and ensure the schema
 * exists. Pass `":memory:"` in tests. Mirrors the linear feature's opener
 * (0o700 dir / 0o600 file / WAL) so the store lands beside the others under
 * `~/.config/<resolveConfigDirName()>/`.
 */
export const openGhAppRegistryDb = (path?: string): Database => {
  if (path !== undefined) {
    const memDb = new Database(path);
    memDb.run("PRAGMA journal_mode = WAL;");
    memDb.run(`PRAGMA busy_timeout = ${DB_BUSY_TIMEOUT_MS};`);
    createGhAppRegistrySchema(memDb);
    return memDb;
  }
  // A test redirects the whole registry directory via GH_APP_REGISTRY_DIR
  // (see REGISTRY_DIR_ENV) — the only reliable seam, because `homedir()`
  // ignores a runtime-reassigned HOME.
  const override = (Bun.env[REGISTRY_DIR_ENV] ?? "").trim();
  const dir =
    override !== ""
      ? override
      : join(homedir(), ".config", resolveConfigDirName());
  mkdirSync(dir, {
    mode: DB_DIR_MODE,
    recursive: true,
  });
  const dbPath = join(dir, "gh-app-registry.db");
  const db = new Database(dbPath);
  try {
    // Non-fatal — some filesystems (e.g. Docker volumes) ignore chmod.
    chmodSync(dbPath, DB_FILE_MODE);
  } catch {
    // ignore
  }
  db.run("PRAGMA journal_mode = WAL;");
  db.run(`PRAGMA busy_timeout = ${DB_BUSY_TIMEOUT_MS};`);
  createGhAppRegistrySchema(db);
  return db;
};

// #endregion

// #region CRUD + resolution

const rowToKeyNames = (row: RawRow): GhAppKeyNames => ({
  appIdKey: row.app_id_key,
  privateKeyKey: row.private_key_key,
});

/** Upsert the (org, purpose) → key-names mapping. */
export const registerApp = (db: Database, input: RegisterAppInput): void => {
  // Normalize the org to the owner segment the mint path looks up: the CLI
  // accepts (and the feature prompt documents) the same spellings for
  // `--org` that `mint-token.ts --repo` accepts, so `acme-corp/widgets` /
  // `https://github.com/acme-corp/widgets.git` / `git@github.com:…` must all
  // persist as `acme-corp` — `mintInstallationToken` derives its registry key
  // via `orgOf(targetRepo)` and a raw repo-shaped org never matches, silently
  // falling back to the default App instead of the registered one.
  const org = orgOf(input.org);
  db.run(
    `INSERT OR REPLACE INTO gh_app_registry
       (org, purpose, app_id_key, private_key_key, registered_at)
     VALUES (?, ?, ?, ?, ?)`,
    [
      org,
      input.purpose,
      input.appIdKey,
      input.privateKeyKey,
      Math.floor(Date.now() / MS_PER_SECOND),
    ]
  );
};

/** Look up the exact (org, purpose) row, or null when absent. */
export const lookupApp = (
  db: Database,
  org: string,
  purpose: string
): GhAppKeyNames | null => {
  const row = db
    .query<RawRow, [string, string]>(
      "SELECT * FROM gh_app_registry WHERE org = ? AND purpose = ?"
    )
    .get(org, purpose);
  return row ? rowToKeyNames(row) : null;
};

/**
 * Resolve the key names for (org, purpose) via the fallback chain:
 *   (org, purpose) → (org, DEFAULT_PURPOSE) → null.
 * A null result means the caller should fall back to the bare default app
 * (`GH_APP_ID` / `GH_APP_PRIVATE_KEY`) — that final step lives in gh-app-token.
 */
export const resolveApp = (
  db: Database,
  org: string,
  purpose: string
): GhAppKeyNames | null => {
  const exact = lookupApp(db, org, purpose);
  if (exact !== null) {
    return exact;
  }
  if (purpose !== DEFAULT_PURPOSE) {
    return lookupApp(db, org, DEFAULT_PURPOSE);
  }
  return null;
};

/** List every registered row (org + purpose + key names — never values). */
export const listApps = (db: Database): GhAppRegistryRow[] => {
  const rows = db
    .query<RawRow, []>("SELECT * FROM gh_app_registry ORDER BY org, purpose")
    .all();
  return rows.map((row) => ({
    appIdKey: row.app_id_key,
    org: row.org,
    privateKeyKey: row.private_key_key,
    purpose: row.purpose,
    registeredAt: row.registered_at,
  }));
};

// #endregion

// #region Installation-id cache

interface CacheRow {
  readonly app_id: string;
  readonly org: string;
  readonly installation_id: string;
  readonly cached_at: number;
}

/**
 * The cache key: the numeric App id plus the target org. An empty `org` (the
 * default app with no derivable org) is stored under the literal empty string,
 * so the "App's sole installation" result is cached too.
 */
export interface InstallationCacheKey {
  readonly appId: string;
  readonly org: string;
}

/** Look up a cached installation id for (appId, org), or null when absent. */
export const getCachedInstallation = (
  db: Database,
  key: InstallationCacheKey
): string | null => {
  const row = db
    .query<CacheRow, [string, string]>(
      "SELECT * FROM gh_installation_cache WHERE app_id = ? AND org = ?"
    )
    .get(key.appId, key.org);
  return row ? row.installation_id : null;
};

/** Upsert the cached installation id for (appId, org). */
export const putCachedInstallation = (
  db: Database,
  key: InstallationCacheKey,
  installationId: string
): void => {
  db.run(
    `INSERT OR REPLACE INTO gh_installation_cache (app_id, org, installation_id, cached_at)
     VALUES (?, ?, ?, ?)`,
    [key.appId, key.org, installationId, Math.floor(Date.now() / MS_PER_SECOND)]
  );
};

/** Drop the cached installation id for (appId, org) — called when it proves stale. */
export const deleteCachedInstallation = (
  db: Database,
  key: InstallationCacheKey
): void => {
  db.run("DELETE FROM gh_installation_cache WHERE app_id = ? AND org = ?", [
    key.appId,
    key.org,
  ]);
};

/**
 * Drop every cached row whose `org` is not in `allowedOrgs` (compared
 * case-insensitively). Poisoned rows from the public-App incident — an
 * installation discovered against a foreign org before the fail-closed
 * allowlist landed — are purged here so they can never be served again. The
 * empty-org (`""`) sole-installation row is also dropped: its key carries no
 * owner identity, so it can never be trusted (the mint flow no longer reads or
 * writes it). Returns the number of rows deleted.
 */
export const purgeNonAllowlistedInstallations = (
  db: Database,
  allowedOrgs: Iterable<string>
): number => {
  const allowed = Array.from(allowedOrgs)
    .map((login) => login.trim().toLowerCase())
    .filter((login) => login !== "");
  // Keep only rows whose org is allowlisted; the empty-org row is untrusted by
  // construction (no owner identity in the key), so it is deleted as well.
  const placeholders = allowed.map(() => "?").join(", ");
  const sql =
    allowed.length > 0
      ? `DELETE FROM gh_installation_cache WHERE org = '' OR lower(org) NOT IN (${placeholders})`
      : "DELETE FROM gh_installation_cache";
  const result = db.run(sql, allowed);
  return result.changes;
};

/**
 * A persistent installation-id cache seam, keyed by (appId, org). The mint flow
 * consults it to skip the `GET /app/installations` round-trip. Injected so tests
 * use an in-memory fake; {@link sqliteInstallationCache} is the production impl.
 */
export interface InstallationCache {
  readonly get: (appId: string, org: string) => string | null;
  readonly put: (appId: string, org: string, installationId: string) => void;
  readonly delete: (appId: string, org: string) => void;
  /**
   * Drop every cached row whose org is not in `allowedOrgs`, plus any empty-org
   * row (fail-closed cleanup of poisoned rows from the public-App incident).
   * Returns the rows removed.
   */
  readonly purge: (allowedOrgs: Iterable<string>) => number;
}

/** Open the registry, run `fn`, always close; return `fallback` on any failure. */
const withDb = <T>(fn: (db: Database) => T, fallback: T): T => {
  try {
    const db = openGhAppRegistryDb();
    try {
      return fn(db);
    } finally {
      db.close();
    }
  } catch {
    return fallback;
  }
};

/**
 * Production installation cache: each operation opens the SQLite registry, does
 * its work, and closes — best-effort, so any failure (DB unavailable, etc.)
 * degrades to a no-op (get → miss → discovery still runs). A short-lived
 * connection per call is fine: a mint does at most one get + one put, dwarfed by
 * the network round-trips it saves. `mint-token.ts` runs as a fresh process per
 * invocation, so only this persistent cache (not an in-memory one) ever hits.
 */
export const sqliteInstallationCache: InstallationCache = {
  delete: (appId, org) => {
    withDb((db) => {
      deleteCachedInstallation(db, {
        appId,
        org,
      });
      return null;
    }, null);
  },
  get: (appId, org) =>
    withDb(
      (db) =>
        getCachedInstallation(db, {
          appId,
          org,
        }),
      null
    ),
  purge: (allowedOrgs) =>
    withDb((db) => purgeNonAllowlistedInstallations(db, allowedOrgs), 0),
  put: (appId, org, installationId) => {
    withDb((db) => {
      putCachedInstallation(
        db,
        {
          appId,
          org,
        },
        installationId
      );
      return null;
    }, null);
  },
};

// #endregion
