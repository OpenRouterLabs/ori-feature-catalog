/**
 * gh-app-github-api.ts — the low-level GitHub App plumbing behind
 * `gh-app-token.ts`: the typed failure, the shared value types, RS256 JWT
 * signing, access-token response parsing, and installation discovery.
 *
 * Kept separate from the Effect service/layer composition so each file stays
 * small and the GitHub-contract details live in one place. Nothing here persists
 * a token or touches disk; every function is a pure transform or an Effect over
 * an injected `fetch`.
 *
 * GitHub App JWT flow:
 * https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app
 */

import { createSign } from "node:crypto";

import { Data, Effect, Option, Schema } from "effect";

import { orgOf } from "./gh-app-registry.ts";

// #region Error

/** Single typed failure for every GitHub App auth operation. */
export class GhAppError extends Data.TaggedError("GhAppError")<{
  /** The failing operation — "config" | "sign" | "request" | "parse" | "http" | "discover". */
  readonly op: string;
  /** Human-readable failure message (safe to surface — never carries a secret). */
  readonly message: string;
  /** HTTP status for "http"/"discover" failures; absent otherwise. */
  readonly status?: number;
  /** Underlying thrown value, when there is one. */
  readonly cause?: unknown;
}> {}

// #endregion

// #region Types

export interface GhAppCredentials {
  readonly appId: string;
  /** Base64-encoded PEM private key, as stored in the service env. */
  readonly privateKeyBase64: string;
  /**
   * Target org for installation discovery (`GET /app/installations` matching
   * `account.login`). Empty/undefined → the App's sole installation is used.
   */
  readonly org?: string;
}

/**
 * A live installation token plus the moment GitHub says it expires. Callers
 * that cache (none today) could honour `expiresAt`; the wrappers ignore it and
 * mint fresh every invocation.
 */
export interface InstallationToken {
  readonly expiresAt: string;
  readonly token: string;
}

/** The subset of `fetch` this module uses — narrow so tests can inject a fake
 *  without satisfying Bun's full `typeof fetch` (which requires `preconnect`). */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

// #endregion

// #region Installation-owner allowlist

/** Env var naming the installation-owner logins a token may be minted against (comma/space-separated). */
const ALLOWED_ORGS_ENV = "GH_APP_ALLOWED_ORGS";

/**
 * Resolve the allowlist of permitted installation-owner logins, lower-cased for
 * comparison. Precedence: explicit `override` (an array, from a caller) → the
 * `GH_APP_ALLOWED_ORGS` env var (comma/space/newline-separated) → the owner of
 * `GITHUB_REPO`. A GitHub App can be installed by anyone once it is public, so
 * discovery FAILS CLOSED: an empty result allows no installation at all.
 */
/**
 * True when the port-stripped repo string is a BARE github.com host —
 * `https://github.com`, `github.com`, the scp/ssh forms (with a user-info
 * word and/or a scheme), with NO owner and NO repo segment after the host.
 * The login-carrying spellings (`github.com:acme`, `github.com:22/acme`)
 * all carry a segment and never match. Used by `resolveAllowedOrgs` so the
 * repo source gives the honest no-owner answer for a copied landing page or
 * a truncated `git remote -v` paste, matching `orgOf` and
 * `resolveRepoFromEnv`.
 */
const isBareGithubHost = (spelling: string): boolean =>
  /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:\/\/)?(?:[^@/\s]+@)?github\.com$/u.test(
    spelling
  );

export const resolveAllowedOrgs = (
  override?: readonly string[],
  env?: Readonly<Record<string, string | undefined>>
): Set<string> => {
  // An empty/whitespace-only var is treated as UNSET, not as an explicit
  // allow-none: a cleared `Environment=GH_APP_ALLOWED_ORGS=` (systemd reset),
  // a compose interpolation of an unset variable, or a blank env-file line
  // must fall back to the documented default (the `GITHUB_REPO` owner), not
  // fail every mint closed. A set var with real logins still wins.
  // Read the env var unconditionally — the chain below, not this read, carries
  // the precedence. Pre-fix the read was gated on `override === undefined`, so
  // a present-but-blank override (a caller passed `["   "]`) suppressed a set
  // `GH_APP_ALLOWED_ORGS` the chain would otherwise have used.
  const rawAllow = env?.[ALLOWED_ORGS_ENV];
  // The FIRST source with real entries wins — never `??`, which stops at ANY
  // present source (an empty array is present) and silently discards the rest
  // of the chain below it. The documented precedence is
  // "explicit `override` (an array, from a caller) → the `GH_APP_ALLOWED_ORGS`
  // env var → the owner of `GITHUB_REPO`", and a source that resolves to NO
  // real logins (an override of blank strings, a set-but-blank env var) must
  // fall through to the next source exactly like an absent one — a mint that
  // failed closed on an empty set while its caller passed an explicit list
  // would be a silent security misconfiguration. `rawAllow` blank/whitespace
  // stays unset (the empty-string-is-unset discipline of the #222/#223 class).
  const firstNonEmpty = (
    entries: readonly string[] | undefined
  ): readonly string[] | undefined => {
    if (entries === undefined) {
      return undefined;
    }
    const real = entries.filter((login) => login.trim() !== "");
    return real.length === 0 ? undefined : real;
  };
  const fromEnv = firstNonEmpty(
    rawAllow !== undefined && rawAllow.trim() !== ""
      ? rawAllow.split(/[\s,]+/u)
      : undefined
  );
  /**
   * The repo source named no owner (a degenerate raw-host/api-index spelling
   * of `GITHUB_REPO`): resolve the allowlist from the sources ABOVE it — the
   * explicit `override` first, then a set `GH_APP_ALLOWED_ORGS` — and only
   * fall back to the honest empty set when neither exists. This is the exact
   * fallthrough the chain's tail already applies; the two degenerate-branch
   * early returns used it, so the helper exists so they cannot drift from
   * the tail's behavior.
   */
  const resolveFromNoOwnerSource = (
    _spelling: string,
    localOverride: readonly string[] | undefined,
    localFromEnv: readonly string[] | undefined
  ): Set<string> => {
    const source = firstNonEmpty(localOverride) ?? localFromEnv;
    return new Set(
      (source ?? [])
        .map((login) => login.trim().toLowerCase())
        .filter((login) => login !== "")
    );
  };
  // Tolerate the same `GITHUB_REPO` spellings the sibling resolvers do (a full
  // https URL with optional .git suffix, or a bare owner/repo) — `split("/")[0]`
  // would reduce a URL to "https:" and fail every mint closed.
  // Trim trailing slashes as well as whitespace (a copy-pasted
  // `https://github.com/acme/widgets.git/`): the repoMatch alternative
  // below fails on the trailing slash, and the repoOwner fallback then
  // reduces the URL to its scheme (`https:`) — a login no installation
  // can ever carry, so every mint fails closed with no hint why.
  // A host-case spelling — `https://GitHub.com/acme/widgets`, a copy-paste
  // that kept the address bar's capitalization — is the same URL: hosts are
  // case-insensitive (RFC 3986 §3.2.2), and git/gh/curl all accept the
  // mixed-case host. Lower-case the HOST WORD up front (never the
  // owner/repo path — GitHub logins keep their case) so every anchored
  // `github.com` branch below sees the same string `orgOf` and
  // `resolveRepoFromEnv` see; pre-fix a mixed-case host fell every branch
  // and the allowlist keyed itself on a raw URL — a login no installation
  // can ever own — so every mint failed closed with no hint the spelling was
  // the cause (#159/#82's class, reopened through the host's capitalization).
  // The rider/suffix strips in the chain below run BEFORE the case-lower
  // keys on the host word — the same order `orgOf`,
  // `resolveConfigDirName` and `resolveRepoFromEnv` now apply: a rider or
  // `.git` suffix PAST a case-variant bare host (`GitHub.com#frag`,
  // `https://GitHub.com.git` — the same address-bar paste class through the
  // host's capitalization) defeated the case-lower's `$`-anchored lookahead,
  // so the host kept its case, fell every anchored branch below, and the
  // raw string flowed on whole as the allowlist entry — a login no
  // installation owner can ever carry, so EVERY mint failed closed with no
  // hint the env var's spelling was the cause — while the sibling resolvers
  // answered the honest "" for the same spelling. The strips are idempotent
  // where the chain below re-runs them.
  // A github.com SUBDOMAIN host — `www.github.com`, `gist.github.com`,
  // `codeload.github.com` (real hosts; the www form and every gist URL
  // redirect to github.com) — is the same URL as `github.com`, and pre-fix
  // the subdomain label defeated every anchored `github.com` branch below,
  // so the allowlist keyed itself on the raw URL (`https://www.github.com/
  // acme/widgets` for the case-variant form) or the host word
  // (`gist.github.com` — a login no installation owner can ever carry), and
  // every mint failed closed with no hint the spelling was the cause — the
  // exact #159/#82 class this resolver exists to keep out, reopened through
  // the subdomain label (#285). Strip it (case-tolerant) before the
  // case-lower below, exactly like `orgOf` and `resolveConfigDirName`; the
  // api. label keeps its own dedicated strip below.
  // The trim + rider strips run BEFORE the subdomain strip below, never after
  // it — the same reorder `orgOf` applies (see gh-app-registry.ts): the
  // strip's lookahead is `$`-or-separator-anchored, so a rider/suffix/padding
  // past a bare subdomain host (`www.github.com#frag`,
  // `gist.github.com?tab=readme`, `https://codeload.github.com.git`) defeated
  // it, the label survived, and the allowlist keyed itself on the raw host
  // word or a sanitized URL — a login no installation owner can ever carry,
  // so every mint failed closed with no hint the spelling was the cause —
  // while its rider-less form answered the healthy no-owner value and the
  // REPO= recipe agreed (the #285 one-spelling contract, reopened through
  // the rider position). The strips are idempotent; `rawRepo` below re-runs
  // them harmlessly.
  // Strip LEADING slashes AND the whitespace they expose, in ONE step
  // (`^[/\s]+`), BEFORE every host-keyed strip below — the same order the
  // sibling resolvers now apply (see gh-app-registry.ts `orgOf`). A leading
  // slash in front of the HOST word (`//api.github.com/repos/…` — a
  // protocol-relative URL, the browser-address-bar form that lost its
  // scheme; `/api.github.com/repos/…` — a shell-autocomplete paste) is the
  // same URL, but this resolver'''s api-host strip is `^`-ANCHORED, so the
  // slash DEFEATED it and the UNANCHORED repo regex below read the REST
  // host-path word `repos` as the OWNER — the allowlist carried `repos` (a
  // login no installation owner can ever carry — verified live:
  // `orgs/repos` 404s), every mint failed closed with no hint the spelling
  // was the cause, and the allowlist silently DISAGREED with `orgOf` and
  // `resolveRepoFromEnv`, which answered the healthy `acme` for the same
  // spelling (the one-spelling contract, reopened through the leading
  // slash). The strip is idempotent and the chain below re-runs its own
  // tail strips harmlessly.
  const subdomainTrimmed = (env?.GITHUB_REPO ?? "")
    .replace(/^[\/\s]+/u, "")
    .trim()
    .replace(/\?.*$/u, "")
    .replace(/#.*$/u, "")
    .replace(/[\/\s]+$/gu, "")
    .replace(/\.git$/u, "")
    .replace(/[\/\s]+$/gu, "");
  // The scheme-separator rewrite runs BEFORE the subdomain strip above —
  // the same hoist `orgOf` applies (see its site in gh-app-registry.ts for
  // the full class): the strip's scheme group spells `://`, so a
  // single-slash scheme on a bare subdomain host (`https:/www.github.com`)
  // missed the strip, the label survived, and the raw URL flowed on whole
  // — a login no installation owner can ever carry, so every mint failed
  // closed with no hint the env var's spelling was the cause — while its
  // `://` sibling allowed no one and `orgOf` answered "" for the same
  // spelling (the one-spelling contract, reopened through the rewrite's
  // position, in the one shape that needs a lost slash, a label, and no
  // path). The rewrite's lookahead already tolerates the label
  // (`(?:[A-Za-z0-9-]+\.)*` ahead of the host word), so hoisting it is
  // behavior-identical for every healthy spelling.
  const schemeSeparatorFixed = subdomainTrimmed.replace(
    /^([a-zA-Z][a-zA-Z0-9+.-]*):\/?(?=(?:[^@\/\s]+@)?(?:[A-Za-z0-9-]+\.)*(?:[Gg][Ii][Tt][Hh][Uu][Bb]\.[Cc][Oo][Mm]|[Rr][Aa][Ww]\.[Gg][Ii][Tt][Hh][Uu][Bb][Uu][Ss][Ee][Rr][Cc][Oo][Nn][Tt][Ee][Nn][Tt]\.[Cc][Oo][Mm])(?:[\/:?#.]|$))/u,
    "$1://"
  );
  const subdomainStripped = schemeSeparatorFixed.replace(
    /^((?:[a-zA-Z][a-zA-Z0-9+.-]*:\/\/)?(?:[^@\/\s]+@)?)(?![Aa][Pp][Ii]\.)([a-zA-Z][a-zA-Z0-9-]*\.)([Gg][Ii][Tt][Hh][Uu][Bb]\.[Cc][Oo][Mm])(?=:\d+(?:[\/:]|$)|[\/:]|$)/u,
    (_m: string, scheme: string, _sub: string, host: string) =>
      `${scheme}${host.toLowerCase()}`
  );
  // `subdomainStripped` (not `schemeSeparatorFixed`): the strip has now run
  // ON the separator-fixed string, so its result is the value every branch
  // below must see — feeding the pre-strip value would re-introduce the
  // label the strip removed.
  const rawRepo = subdomainStripped
    .trim()
    // Strip a QUERY or FRAGMENT rider and the trailing separator/whitespace
    // it may ride past — hoisted above the case-lower below.
    .replace(/\?.*$/u, "")
    .replace(/#.*$/u, "")
    .replace(/[\/\s]+$/gu, "")
    .replace(/\.git$/u, "")
    .replace(/[\/\s]+$/gu, "")
    // Strip a QUERY or FRAGMENT suffix — `o/r?tab=readme`, `o/r#anchor`
    // (a browser address-bar copy-paste) — before the anchored branches
    // below, exactly like `orgOf` and `resolveRepoFromEnv`: the suffix is
    // a URL-reserved delimiter a login or repo name cannot carry, and
    // pre-fix the repo branch's `[^/]+` segment absorbed it, so the
    // allowlist keyed on `o/r?tab=readme` — an entry no installation owner
    // can ever match, and every mint failed closed with no hint the
    // spelling was the cause.
    .replace(/\?.*$/u, "")
    .replace(/#.*$/u, "")
    .replace(
      /^((?:[a-zA-Z][a-zA-Z0-9+.-]*)?:\/\/)?((?:[^@\/\s]+@)?)([Gg][Ii][Tt][Hh][Uu][Bb]\.[Cc][Oo][Mm])(?=:\d+(?:[\/:]|$)|[\/:]|$)/u,
      (_m: string, scheme: string, user: string, host: string) =>
        // Lower-case the SCHEME word too, never just the host — see the
        // matching comment in commit-api-core.ts. Pre-fix an upper-case
        // scheme (`HTTPS://github.com`) fell the case-sensitive interior-
        // slash guard below, its `://` collapsed to `:`, and the junk string
        // `HTTPS:github.com` flowed on whole as the allowlist entry (after
        // the lower-case below: `https:github.com`) — a login no installation
        // owner can ever carry, so EVERY mint failed closed with no hint the
        // env var's spelling was the cause, while `orgOf` and the prompt's
        // `REPO=` recipe answered "" for the same spelling.
        `${(scheme ?? "").toLowerCase()}${user ?? ""}${host.toLowerCase()}`
    )
    .replace(/\/+$/u, "")
    .replace(/\.git$/u, "")
    // A `/.git` suffix (separator-then-dot-git — `https://github.com/acme/.git`,
    // `github.com:acme/.git`) exposes an interior `/` once the suffix comes
    // off; re-strip it or every branch below misses and the raw URL flows
    // through as the allowlist entry — a login no installation owner can
    // carry, so every mint fails closed with no hint the spelling was the
    // cause (the #159/#82 class, reopened through the separator-then-dot-git
    // paste; `orgOf` now strips the same suffix).
    .replace(/\/+$/u, "")
    // Collapse interior runs of path slashes — `github.com//o/r`, `o//r`
    // (a copy-paste that kept a doubled path slash, the same paste class as
    // the trailing slash the strips above already handle). The `$`-anchored
    // tails below key on `[^/]+`-style non-empty segments, which an EMPTY
    // path segment never matches, so pre-fix the raw string fell every
    // branch and flowed through whole as the allowlist entry — a login no
    // installation owner can ever carry, so every mint failed closed with
    // no hint the spelling was the cause (the #159/#82 class, reopened
    // through the interior double). The prompt's REPO= sed recipe collapses
    // the same paste; `orgOf` and `resolveRepoFromEnv` strip the same runs.
    // A scheme's own `://` is guarded and never collapses; the scp host
    // separator is a bare `:`, so `git@github.com://o/r` collapses to the
    // scp form `git@github.com:o/r`.
    // Whitespace AFTER a path separator — `github.com/ acme`, and a
    // PADDING-ONLY segment (`https://github.com/ /widgets` — one path
    // segment carrying nothing but separator-adjacent whitespace, the same
    // paste class) — belongs to no login, and the strip must run BEFORE the
    // collapse below: the space-only segment otherwise blocks it, so `//`
    // never becomes `/`, the anchored branches all miss, and the raw URL
    // flowed through as the allowlist entry while `orgOf` and the REPO=
    // recipe answered the healthy owner — the one-spelling contract broken
    // (the #159/#82 class, reopened through the segment form).
    .replace(/(?<=[\/:])\s+/gu, "")
    // Whitespace BEFORE a path separator — `acme /widgets` — belongs to no
    // login either (the same separator-adjacent paste the lookbehind strip
    // above drops AFTER the separator). This resolver reaches `orgOf` for
    // slash-bearing spellings, so its fix carries most of the class; the
    // twin strip here keeps the chain itself on the one-spelling contract
    // (a colon-bearing, slashless spelling never routes through `orgOf`)
    // — the #249/#257 class, reopened through the space-before-separator
    // form.
    .replace(/\s+(?=[\/:])/gu, "")
    .replace(/(?<!(?:https?|ssh|git\+ssh|git|ftp)):\/+/giu, ":")
    .replace(/(?<!(?:https?|ssh|git\+ssh|git|ftp):)\/\/+/giu, "/");
  // Strip an explicit PORT before any regex runs — the same normalization
  // `orgOf` applies (see gh-app-registry.ts). With the port left in, the
  // `[/:]` host separator below BACKTRACKS past the optional `(?::\d+)?`
  // port group exactly as it does in every sibling resolver: the `:` itself
  // becomes the separator, the port digits become the "owner". A port+org
  // spelling (`github.com:22/acme` — the natural org-page form of a ported
  // remote) then matched the fake owner `22` here, so the allowlist carried a
  // login no installation can ever own and every mint failed closed with no
  // hint the spelling was the cause — the #186 class, reopened through the
  // allowlist resolver (orgOf resolves the same spelling to `acme`, so the
  // registry key and the allowlist key silently disagreed). A port is
  // unambiguous — `:<digits>` right after the `github.com` host, before any
  // separator or end — so removing it up front lets every branch below see
  // the same string every sibling resolver already resolves through.
  const portStripped = rawRepo.replace(
    // The host word is CASE-TOLERANT, exactly like every other github.com
    // strip in this feature: a case-variant api host carrying a port
    // (`https://API.GitHub.com:443/repos/…` — the address bar's
    // capitalization riding on the REST host) is the same URL, and the
    // case-SENSITIVE literal left it unstripped, so the port digits stayed
    // glued to the host and every downstream anchored branch keyed on
    // them — the api-host strip below then missed (its anchor requires
    // the path right after the host), and all four resolvers answered a
    // different dead value while the lowercase and unported forms were
    // healthy (the one-spelling contract, reopened through the
    // case+port combination on the api host).
    /((?:git@)?[Gg][Ii][Tt][Hh][Uu][Bb]\.[Cc][Oo][Mm]|(?:git@)?[Rr][Aa][Ww]\.[Gg][Ii][Tt][Hh][Uu][Bb][Uu][Ss][Ee][Rr][Cc][Oo][Nn][Tt][Ee][Nn][Tt]\.[Cc][Oo][Mm]):\d+(?=[\/:]|$)/u,
    "$1"
  );
  // An api.github.com REST paste — `https://api.github.com/repos/acme/widgets`
  // — is the URL shape this feature's own prompt teaches the operator to
  // curl, so pasting it back into GITHUB_REPO is a realistic spelling. Its
  // path starts with the REST host-path word `repos`, which the repo regex
  // below keys on as the OWNER: pre-fix the allowlist carried `repos` (a
  // login no installation owner can ever carry — verified live:
  // `orgs/repos` 404s), so every mint failed closed with no hint the env
  // var's spelling was the cause, while `orgOf`/`resolveRepoFromEnv` are
  // fixed to answer the real owner. Strip the api host and its `repos`
  // path word up front, exactly like `resolveRepoFromEnv` (see
  // commit-api-core.ts). A bare api host names no owner, the same honest
  // undefined a bare github.com host yields below.
  // The anchor and the strip both accept the FULL separator set the sibling
  // resolvers' api strips tolerate — `[/:]`, never `/` alone: a host word
  // riding a COLON into the path (`API.GitHub.com:acme/widgets`,
  // `https://api.github.com:/acme` — the scp/ssh host:tail shape, an
  // empty-port paste) is the same api host, and pre-fix it fell the
  // `(?:\/|$)` anchor entirely — the case-variant form then flowed on whole
  // as the allowlist entry (a login no installation owner can ever carry, so
  // every mint failed closed with no hint the env var's spelling was the
  // cause), while `orgOf` and `resolveRepoFromEnv` answered the healthy
  // owner for the same spelling (the one-spelling contract, reopened through
  // the separator).
  const apiHostMatch = /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:\/\/)?(?:[^@\/\s]+@)?[Aa][Pp][Ii]\.[Gg][Ii][Tt][Hh][Uu][Bb]\.[Cc][Oo][Mm](?:[\/:]|$)/u.test(
    portStripped
  );
  const apiStripped = apiHostMatch
    ? portStripped.replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)?(?:[^@\/\s]+@)?[Aa][Pp][Ii]\.[Gg][Ii][Tt][Hh][Uu][Bb]\.[Cc][Oo][Mm][\/:]*/u, "")
    : portStripped;
  const apiRepoTail = apiHostMatch
    ? apiStripped.replace(/^repos\//u, "")
    : apiStripped;
  // A raw.githubusercontent.com paste —
  // `https://raw.githubusercontent.com/acme/widgets/main/x.ts` (the host
  // this feature's own ambient-mode recipes teach the operator to read raw
  // file content from) — carries the documented path scheme
  // `/<owner>/<repo>/<ref>/<path>`: the first two segments name the repo
  // whose file is being read (maintainer ruling on #288, Option A; the api
  // host's `repos/<owner>/<repo>` is the same derivability). The raw host
  // is a DIFFERENT domain from github.com, so no generic strip fired and
  // pre-fix this resolver keyed the allowlist on a dead value for the one
  // spelling — the schemed form whole, the bare form's host word
  // (`raw.githubusercontent.com`, a login no installation owner can ever
  // carry, so every mint failed closed with no hint the env var's spelling
  // was the cause), the scp form `git@raw.githubusercontent.com:
  // acme`. Strip the host (case-tolerant, optional scheme/user-info,
  // `[/:]` separator set like the api strip) and let the repo-source chain
  // below see the `owner/repo/...` tail. A bare raw host or a
  // sub-two-segment path names no owner — the honest empty allowlist
  // entry set, matching a bare `api.github.com` (the Option B answer for
  // the degenerate forms).
  const rawHostMatch = /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:\/\/)?(?:[^@\/\s]+@)?[Rr][Aa][Ww]\.[Gg][Ii][Tt][Hh][Uu][Bb][Uu][Ss][Ee][Rr][Cc][Oo][Nn][Tt][Ee][Nn][Tt]\.[Cc][Oo][Mm](?:[\/:]|$)/u.test(
      apiRepoTail
    );
  const apiRepoStripped = rawHostMatch
    ? apiRepoTail.replace(
        /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)?(?:[^@\/\s]+@)?[Rr][Aa][Ww]\.[Gg][Ii][Tt][Hh][Uu][Bb][Uu][Ss][Ee][Rr][Cc][Oo][Nn][Tt][Ee][Nn][Tt]\.[Cc][Oo][Mm][\/:]*/u,
        ""
      )
    : apiRepoTail;
  if (rawHostMatch && !/^[^/]+\/[^/]+/u.test(apiRepoStripped)) {
    // The repo source names no owner — never an early return: the chain's
    // documented precedence ("explicit `override` → `GH_APP_ALLOWED_ORGS` →
    // the owner of `GITHUB_REPO`") is a FALLTHROUGH chain, and the two
    // sources ABOVE the repo source must still be allowed to name the whole
    // allowlist when the repo source names no one. Pre-fix both this branch
    // and the api-index branch below returned an EMPTY set outright, so a
    // raw-host paste with a sub-two-segment tail silently discarded a
    // caller's explicit `allowedOrgs` override and a set
    // `GH_APP_ALLOWED_ORGS` — the exact "one source present never masks
    // another" contract `gh-app-allowlist-sources.test.ts` pins (its
    // override-survives tests cover only the github.com-host degenerate
    // spellings; these two api/raw-host branches were the ones left
    // returning early). The mint then failed closed on every installation
    // with "not in the allowed-orgs allowlist ()" while the caller's own
    // list sat right there — the #159/#82 silent-fail-closed class, reopened
    // through the degenerate raw/api host shapes. An early return is only
    // honest when NO other source exists; `fromRepo` is the LAST source and
    // already carries the honest empty-when-no-owner answer.
    return resolveFromNoOwnerSource(apiRepoStripped, override, fromEnv);
  }
  // An api.github.com paste of the ORGANIZATIONS-page INDEX —
  // `api.github.com/orgs`, `/organizations`, `/users` — is the same
  // no-owner page the orgs-index guard below answers for the github.com host, but the
  // api strip above delivers its tail to these branches as `orgs`, which the `github.com[/:]` anchors below never see: pre-fix
    // the repo-source chain derived the reserved word itself as the owner,
  // so the allowlist carried `orgs` — a login no installation owner can
  // ever carry, every mint failed closed with no hint the env var's
  // spelling was the cause — while `api.github.com/users` and
  // `github.com/orgs` answered the honest no-owner value (#203/#204's
  // index class, reopened through the api host's own INDEX spelling).
  // Keyed on `apiHostMatch` so the org-NAMING spellings
  // (`api.github.com/orgs/acme`) keep deriving their org. The REST
  // COLLECTION INDEX `repos` is the same no-owner page: the api strip's
  // `repos/` word-strip only fires when a path follows it, so the bare
  // `api.github.com/repos` tail survived as `repos` and pre-fix the repo
  // source below derived the reserved REST path word as the owner — a
  // login no installation owner can ever carry (verified live:
  // `orgs/repos` 404s), so EVERY mint failed closed with no hint the env
  // var's spelling was the cause — while the orgs index answered the empty
  // set and the RECIPE's own api rules emptied the same spelling.
  if (apiHostMatch && /^(orgs|organizations|users|repos)\/?$/u.test(apiRepoStripped)) {
    // Same fallthrough as the raw-host branch above: the api-host INDEX
    // spellings name no owner, so the repo source contributes nothing — but
    // an override or a set `GH_APP_ALLOWED_ORGS` must still name the
    // allowlist. `gh-app-allowlist-sources.test.ts` pins this for the
    // github.com "orgs-page index" spelling (`github.com/orgs`) and the
    // bare `organizations` word; this api-host twin was the early return
    // that broke the same contract for `api.github.com/orgs`,
    // `api.github.com/users` and `api.github.com/repos`.
    return resolveFromNoOwnerSource(apiRepoStripped, override, fromEnv);
  }
  // An organizations-page URL — `https://github.com/orgs/acme` (the "Your
  // organizations" page), also `github.com/organizations/…` — is the one
  // spelling whose ORG sits where the repo regex below expects a repo
  // segment: `github.com/orgs/acme` parses as owner `orgs` with repo
  // `acme`, so the repo match returns `orgs` — a host path word no
  // installation owner can ever carry, and every mint fails closed with no
  // hint the spelling was the cause. `orgOf`'s own orgs-page branch exists
  // for exactly this (it runs BEFORE its repo regex for the same reason);
  // check it first here too. `orgs`/`organizations` are reserved host
  // paths on github.com, never an owner login.
  // A port in the host separator (ssh://git@github.com:22/…) must not become
  // the "owner" segment — see gh-app-registry.ts orgOf for the full class.
  const orgsPageMatch =
    /(?:git@)?[Gg][Ii][Tt][Hh][Uu][Bb]\.[Cc][Oo][Mm](?::\d+)?[/:](?:orgs|organizations|users)[/:]([^/]+)/u.exec(
      apiRepoStripped
    );
  // A deep GitHub URL — `https://github.com/o/r/tree/main` (a copied
  // blob/tree/PR/releases address) — resolves to its owner too: the
  // two-segment-only match missed it, and the `split("/")[0]` fallback then
  // reduced the URL to its SCHEME (`https:`), a login no installation can
  // ever carry — so every mint failed closed with no hint why.
  const repoMatch =
    /[Gg][Ii][Tt][Hh][Uu][Bb]\.[Cc][Oo][Mm](?::\d+)?[/:]([^/]+)\/[^/]+(?:\/.*)?$/u.exec(apiRepoStripped);
  // The HOSTLESS index spelling — a bare `organizations` word with no host
  // and no org segment — is the same page the orgs-index branch guards in
  // `orgOf` and `resolveRepoFromEnv`: it names no org, so the REPO source
  // below must derive no login from it either. Pre-fix the bare pass-through
  // at the bottom captured the reserved word itself (`organizations`) as the
  // owner, so the allowlist keyed itself on a host path no installation can
  // ever own — every mint failed closed with no hint the spelling was the
  // cause, while the sibling resolvers already answered "no owner" for it
  // (the #203/#204 index class, reopened through the hostless bare word). A
  // bare `orgs` word keeps its pass-through, the same split every sibling
  // resolver applies (the org-NAMING branches consume the reserved-word
  // reading whenever a second segment exists). Never an early `return`,
  // though: the repo source is the LAST of the chain, and an override array
  // or a set `GH_APP_ALLOWED_ORGS` must still be allowed to name the whole
  // allowlist when the repo source names no one.
  // A host-only URL — an org page (`https://github.com/acme`) or any other
  // `github.com/<word>` address with no repo segment — carries an owner the
  // repo regex (which needs two segments) misses, and the old
  // `rawRepo.split("/")[0]` fallback reduced it to the SCHEME (`https:`) —
  // a login no installation can ever carry, so every mint failed closed
  // with no hint why (the #159/#82 scheme-reduction class, reopened through
  // spellings with no repo segment). Route those through `orgOf` — the
  // sibling normalizer that already owns the org-URL spelling — so the
  // allowlist, the registry key, and the Git-Data paths keep sharing one
  // spelling contract (README: "every resolver in this feature tolerates
  // the other spellings too"). A bare `owner` (no slash at all) keeps its
  // direct pass-through — but a bare owner still routes through `orgOf`
  // when the string carries a COLON: `git@github.com:acme` /
  // `github.com:acme` (the scp/ssh host-word spellings of an org page)
  // contain no slash, so the slash-only guard sent them to the bare
  // pass-through and the allowlist carried the raw `git@github.com:acme` —
  // a login no installation can ever own, so EVERY mint failed closed
  // with no hint why. One shared `orgOf` keeps all four resolvers on one
  // contract; a slash-less, colon-less `owner` still passes through raw.
  const repoOwner = /^(organizations|users)$/u.test(apiRepoStripped)
    ? undefined
    : (orgsPageMatch?.[1] ??
      repoMatch?.[1] ??
      // A BARE-HOST spelling — `https://github.com`, `github.com`, the
      // scp/ssh forms (a copied landing page or a truncated `git remote -v`
      // paste, no owner and no repo segment at all) — names no owner, the
      // same honest no-answer `orgOf` and `resolveRepoFromEnv` now give it:
      // pre-fix the bare pass-through below keyed the allowlist on the raw
      // host string (`github.com`), a login no installation owner can ever
      // carry, so every mint failed closed while the sibling resolvers
      // answered differently — the one-spelling contract the README
      // promises. No early return, though: an override array or a set
      // `GH_APP_ALLOWED_ORGS` must still be allowed to name the whole
      // allowlist when the repo source names no one. The bare-host check
      // applies to BOTH tails: a spelling with a `/` or `:` routes through
      // `orgOf` (which answers "" for a bare host itself), and the bare
      // pass-through below is exactly where `github.com` / `git@github.com`
      // (no slash, no colon) flowed the host word in as the login.
      (apiRepoStripped !== "" &&
      (apiRepoStripped.includes("/") || apiRepoStripped.includes(":"))
        // A TRUNCATED scp/ssh host word (`github.com:`, `git@github.com:`,
        // `ssh://git@github.com:` — a colon after the host with no path, a
        // `git remote -v` paste cut at the colon) carries a `:`, so it
        // routes through `orgOf` here — pre-fix `orgOf` answered the raw
        // string whole as the owner, and the allowlist keyed itself on a
        // login no installation can ever carry, failing every mint closed
        // with no hint the spelling was the cause. `orgOf` now answers ""
        // for the class; the `?? undefined` below then derives no login
        // from the repo source, matching the bare-host answer.
        ? (orgOf(apiRepoStripped) || undefined)
        : isBareGithubHost(apiRepoStripped)
          ? undefined
          : apiRepoStripped));
  const fromOverride = firstNonEmpty(override);
  // `fromRepo` keeps its empty-when-no-owner shape (the fail-closed default
  // the callers already document); the chain's LAST source is `[]`, never
  // `undefined` — `new Set(undefined.map(...))` would throw where the bare
  // call must fail closed with an empty set.
  const fromRepo = repoOwner === undefined ? [] : [repoOwner];
  const source = fromOverride ?? fromEnv ?? fromRepo;
  return new Set(
    source
      .map((login) => login.trim().toLowerCase())
      .filter((login) => login !== "")
  );
};

/** True when `login` is in `allowed` (both compared lower-cased). */
export const isAllowlistedOrg = (
  login: string,
  allowed: Set<string>
): boolean => allowed.has(login.trim().toLowerCase());

/** Terminal `op:"discover"` failure for a non-allowlisted installation owner. */
const rejectForeignInstallation = (
  login: string,
  allowed: Set<string>
): GhAppError =>
  new GhAppError({
    message: `Refusing to mint a token for GitHub App installation owned by "${login}": not in the allowed-orgs allowlist (${Array.from(allowed).join(", ")}). Set ${ALLOWED_ORGS_ENV} to override.`,
    op: "discover",
  });

/** Standard headers for the GitHub App REST endpoints, given a bearer JWT. */
const githubAppHeaders = (jwt: string): Record<string, string> => ({
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${jwt}`,
  "X-GitHub-Api-Version": "2022-11-28",
});

// #endregion

// #region JWT signing

const SECONDS_PER_MINUTE = 60;
/** GitHub caps App JWTs at 10 minutes; leave 1 minute of clock-skew room. */
const JWT_LIFETIME_MINUTES = 9;
/** JWT lifetime in seconds: GitHub caps App JWTs at 10 minutes; 9 leaves skew room. */
const JWT_LIFETIME_SECONDS = JWT_LIFETIME_MINUTES * SECONDS_PER_MINUTE;
/** Backdate `iat` to tolerate minor clock skew against GitHub, per their docs. */
const JWT_BACKDATE_SECONDS = SECONDS_PER_MINUTE;

const base64Url = (input: Buffer | string): string =>
  Buffer.from(input).toString("base64url");

/** Sign a GitHub App JWT (RS256), as an Effect; terminal `sign` GhAppError on failure. */
export const signAppJwt = (
  credentials: GhAppCredentials,
  nowSeconds: number
): Effect.Effect<string, GhAppError> =>
  Effect.suspend(() => {
    // GitHub's JWT `iss` must be the numeric App id. `Number("abc")` is NaN,
    // which `JSON.stringify` serializes as `null` — a silent bad JWT that fails
    // opaquely at GitHub. Fail loudly here with the App id NAME, never a secret.
    const appIdNumber = Number(credentials.appId);
    if (!Number.isInteger(appIdNumber) || appIdNumber <= 0) {
      return Effect.fail(
        new GhAppError({
          message: `GitHub App id must be a positive integer, got "${credentials.appId}" — check GH_APP_ID (or the registered app-id env var).`,
          op: "config",
        })
      );
    }
    const pem = Buffer.from(credentials.privateKeyBase64, "base64").toString(
      "utf-8"
    );
    const header = base64Url(
      JSON.stringify({
        alg: "RS256",
        typ: "JWT",
      })
    );
    const payload = base64Url(
      JSON.stringify({
        exp: nowSeconds + JWT_LIFETIME_SECONDS,
        iat: nowSeconds - JWT_BACKDATE_SECONDS,
        iss: appIdNumber,
      })
    );
    const signingInput = `${header}.${payload}`;
    const signer = createSign("RSA-SHA256");
    signer.update(signingInput);
    return Effect.try({
      catch: (cause) =>
        new GhAppError({
          cause,
          message: `Failed to sign GitHub App JWT: ${cause instanceof Error ? cause.message : String(cause)}`,
          op: "sign",
        }),
      try: () => `${signingInput}.${signer.sign(pem, "base64url")}`,
    });
  });

// #endregion

// #region Response schemas

/**
 * GitHub's error envelope, returned on every non-2xx REST response. `message`
 * is `optional` rather than required because a body that lacks it (or is not an
 * object at all) still has to degrade to the HTTP status, not to a failure.
 */
const GitHubErrorBody = Schema.Struct({
  message: Schema.optional(Schema.String),
});

/**
 * GitHub's non-2xx `message`, falling back to the status when the body is not
 * the error envelope. Decoding is deliberately tolerant here: the request has
 * already failed, and a second failure would replace GitHub's own explanation
 * with a schema complaint.
 */
const githubErrorDetail = (payload: unknown, status: number): string => {
  const decoded = Schema.decodeUnknownOption(GitHubErrorBody)(payload);
  const message = Option.isSome(decoded) ? decoded.value.message : undefined;
  return message ?? `HTTP ${status}`;
};

/**
 * Read a response body as JSON, degrading to `null` when the body is not JSON
 * at all (an HTML error page, a 0-byte body). Used before the `response.ok`
 * branch: a non-2xx must be explained by its own envelope (or degrade to the
 * status), never fail `op:"parse"` — which would both mislabel the failure
 * and hide the 401/404 status `gh-app-token.ts` matches a stale-installation
 * retry on.
 *
 * The read is BOUNDED by the caller: a server that answers the headers and
 * then stalls the body leaves `response.json()` pending forever — the exact
 * wedge `MINT_HTTP_TIMEOUT_MS` exists to close (the deadline the fetch half
 * already carries), reopened through the body read, so every caller wraps
 * this in the same deadline rather than letting the mint hang indefinitely.
 */
const readBodyJson = (response: Response): Promise<unknown> =>
  response.json().catch(() => null);

/**
 * `POST /app/installations/{id}/access_tokens`. Only the two fields the caller
 * reads are declared; `permissions` and `repository_selection` are ignored, as
 * anything GitHub adds later will be. An empty `token` is rejected at decode:
 * it can never authenticate a request, so it is malformed rather than absent.
 */
const AccessTokenResponse = Schema.Struct({
  expires_at: Schema.String,
  token: Schema.NonEmptyString,
});

/**
 * One entry of `GET /app/installations`. `account` is nullable in GitHub's own
 * schema (an enterprise installation has none), so a null account is a shape
 * this endpoint really produces, not a malformed one — the projection below
 * skips those entries because they carry no login to match an org against.
 */
const Installation = Schema.Struct({
  account: Schema.NullOr(Schema.Struct({ login: Schema.String })),
  id: Schema.Union([Schema.Number, Schema.String]),
});

const InstallationsPage = Schema.Array(Installation);

/** Decode options shared by every boundary here: report every bad field, not just the first. */
const ALL_ERRORS = { errors: "all" } as const;

// #endregion

// #region Installation discovery

const INSTALLATIONS_PAGE_SIZE = 100;

/**
 * How long one mint-path HTTP round-trip may wait before the flow stops
 * waiting. Pre-fix BOTH mint fetches — the `GET /app/installations` page walk
 * and the `POST …/access_tokens` call — ran with no bound of their own, so a
 * hung connection to api.github.com (a dropped route, a wedged proxy) left
 * `GH_TOKEN=$(bun mint-token.ts)` pending FOREVER: the command substitution
 * blocks the caller's whole shell, `commit-via-api.ts` never returns, and the
 * `gh-auth-health` fire that should alert on exactly this state is itself
 * wedged behind the same unbounded mint. Every sibling network path in this
 * feature already bounds its wait (`PR_LOOKUP_TIMEOUT_MS` in the worktree
 * sweep, `AMBIENT_PROBE_TIMEOUT_MS`/`ROUND_TRIP_TIMEOUT_MS` in the health
 * check, `POST_ALERT_TIMEOUT_MS` on the Slack post) — the mint is the one
 * network path they all depend on, and the only one still unbounded. The
 * deadline turns "no answer" into the same `GhAppError` channel a 5xx already
 * uses, so a failed mint stays a one-line diagnostic and a non-zero exit.
 */
const MINT_HTTP_TIMEOUT_MS = 15_000;

/** The (installationId, accountLogin) pairs discovery matches on. */
interface InstallationRef {
  readonly id: string;
  readonly login: string;
}

/** Project a decoded installations page into the pairs discovery matches on,
 *  dropping the account-less entries GitHub's schema allows. */
const projectInstallations = (
  page: ReadonlyArray<(typeof Installation)["Type"]>
): InstallationRef[] =>
  page.flatMap((entry) =>
    entry.account === null
      ? []
      : [
          {
            id: String(entry.id),
            login: entry.account.login,
          },
        ]
  );

/** Fetch one page of `GET /app/installations`, or fail `op:discover`/`op:parse`. */
const fetchInstallationsPage = (
  fetchImpl: FetchLike,
  jwt: string,
  page: number
): Effect.Effect<InstallationRef[], GhAppError> =>
  Effect.gen(function* () {
    const url = `https://api.github.com/app/installations?per_page=${INSTALLATIONS_PAGE_SIZE}&page=${page}`;
    const response = yield* Effect.tryPromise({
      catch: (cause) =>
        new GhAppError({
          cause,
          message: `GitHub installations list failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          op: "discover",
        }),
      try: () =>
        fetchImpl(url, {
          headers: githubAppHeaders(jwt),
          method: "GET",
        }),
      // Bound the wait: a fetch that never settles is a mint failure, not a
      // mint — see MINT_HTTP_TIMEOUT_MS.
    }).pipe(
      Effect.timeoutOrElse({
        duration: MINT_HTTP_TIMEOUT_MS,
        orElse: () =>
          new GhAppError({
            message: `GitHub installations list (page ${page}) did not answer within ${MINT_HTTP_TIMEOUT_MS / 1000}s`,
            op: "discover",
          }),
      })
    );
    if (!response.ok) {
      return yield* new GhAppError({
        message: `GitHub installations list failed: HTTP ${response.status}`,
        op: "discover",
        status: response.status,
      });
    }
    // Bounded by the same deadline as the page fetch: a headers-then-stall
    // body wedges the installations walk — the exact class the fetch
    // deadline closes, reopened through the body read. A genuinely non-JSON
    // body still fails `op:"parse"` via the decode below.
    const payload = yield* Effect.promise(
      (): Promise<unknown> => readBodyJson(response)
    ).pipe(
      Effect.timeoutOrElse({
        duration: MINT_HTTP_TIMEOUT_MS,
        orElse: () =>
          new GhAppError({
            message: `GitHub installations list (page ${page}) response body did not arrive within ${MINT_HTTP_TIMEOUT_MS / 1000}s`,
            op: "discover",
          }),
      })
    );
    const decoded = yield* Schema.decodeUnknownEffect(
      InstallationsPage,
      ALL_ERRORS
    )(payload).pipe(
      Effect.mapError(
        (error) =>
          new GhAppError({
            cause: error,
            message: `GitHub installations response did not match the expected shape: ${error.message}`,
            op: "parse",
          })
      )
    );
    return projectInstallations(decoded);
  });

/**
 * Discover the installation id for an App by paginating `GET /app/installations`.
 *
 * - With a non-empty `org`, matches `account.login` (case-insensitive) — used
 *   for registry-resolved apps AND the default app when `GITHUB_REPO` yields an
 *   org.
 * - With an empty `org` (org couldn't be derived), falls back to the App's sole
 *   installation; if the App has zero or several installations that's ambiguous
 *   and fails, so the caller sets `GITHUB_REPO`/targets a repo.
 *
 * FAIL CLOSED: the chosen installation's owner login MUST be in `allowedOrgs`
 * (`GH_APP_ALLOWED_ORGS`, else the owner of `GITHUB_REPO`).
 * A foreign owner is rejected on EVERY path — including the org-match and the
 * empty-org sole-installation fallback — so a token can never be minted against
 * an installation the operator did not allow.
 *
 * Fails with `op:"discover"` (list request failed, non-2xx, no/ambiguous match,
 * non-allowlisted owner) or `op:"parse"` (a page body was not JSON).
 */
export const discoverInstallationId = (
  fetchImpl: FetchLike,
  jwt: string,
  org: string,
  allowedOrgs?: Set<string>
): Effect.Effect<string, GhAppError> =>
  Effect.gen(function* () {
    const allowed = allowedOrgs ?? resolveAllowedOrgs(undefined, process.env);
    const wanted = org.trim().toLowerCase();
    // Name the actual cause for the empty-org fallback, the same "never
    // claim a populated env var is unset" discipline the sibling CLI
    // diagnostics apply (#207's class): a GITHUB_REPO that is SET to a
    // spelling resolving to no org (the orgs-page INDEX URL, a bare
    // `organizations`) reaches this branch exactly like an unset one, so
    // pre-fix both error messages below told the operator to "set
    // GITHUB_REPO" — an instruction the env var's own spelling already
    // satisfies, and a dead end that never names the real fix. The var is
    // read the same way the allowlist default above reads it; this changes
    // NO behavior, only the message.
    const rawEnvRepo = (process.env.GITHUB_REPO ?? "").trim();
    const orglessEnvRepo =
      rawEnvRepo !== "" && orgOf(rawEnvRepo) === "" ? rawEnvRepo : undefined;
    const all: InstallationRef[] = [];
    for (let page = 1; ; page += 1) {
      const parsed = yield* fetchInstallationsPage(fetchImpl, jwt, page);
      if (wanted !== "") {
        const match = parsed.find(
          (inst) => inst.login.toLowerCase() === wanted
        );
        if (match !== undefined) {
          // A requested org still has to clear the allowlist — an attacker org
          // that got the App installed must never be resolvable, even by name.
          if (!isAllowlistedOrg(match.login, allowed)) {
            return yield* rejectForeignInstallation(match.login, allowed);
          }
          return match.id;
        }
      }
      all.push(...parsed);
      if (parsed.length < INSTALLATIONS_PAGE_SIZE) {
        break;
      }
    }

    // No org to match on: use the App's sole installation, else it's ambiguous.
    if (wanted === "") {
      if (all.length === 1 && all[0] !== undefined) {
        const sole = all[0];
        // Even a single installation must be allowlisted: a lone FOREIGN install
        // (the public-App attack) is rejected, not blindly trusted.
        if (!isAllowlistedOrg(sole.login, allowed)) {
          return yield* rejectForeignInstallation(sole.login, allowed);
        }
        return sole.id;
      }
      return yield* new GhAppError({
        message:
          all.length === 0
            ? orglessEnvRepo === undefined
              ? "No GitHub App installation found. Install the App, or set GITHUB_REPO so its org can be matched."
              : `No GitHub App installation found. GITHUB_REPO "${orglessEnvRepo}" resolves to no GitHub org, so none can be matched — check its spelling (e.g. github.com/orgs, the organizations index, names no owner), or target a repo.`
            : orglessEnvRepo === undefined
            ? `GitHub App has ${all.length} installations (${all.map((i) => i.login).join(", ")}); set GITHUB_REPO or target a repo so the right one can be chosen.`
            : `GitHub App has ${all.length} installations (${all.map((i) => i.login).join(", ")}); GITHUB_REPO "${orglessEnvRepo}" resolves to no GitHub org, so the right one cannot be chosen — check its spelling, or target a repo.`,
        op: "discover",
      });
    }
    return yield* new GhAppError({
      message: `No GitHub App installation found for org "${org}". Known: ${all.map((i) => i.login).join(", ") || "(none)"}`,
      op: "discover",
    });
  });

// #endregion

/** POST `/app/installations/{id}/access_tokens` and return the minted token. */
export const requestInstallationToken = (
  fetchImpl: FetchLike,
  jwt: string,
  installationId: string
): Effect.Effect<InstallationToken, GhAppError> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      catch: (cause) =>
        new GhAppError({
          cause,
          message: `GitHub installation-token request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          op: "request",
        }),
      try: () =>
        fetchImpl(
          `https://api.github.com/app/installations/${installationId}/access_tokens`,
          {
            headers: githubAppHeaders(jwt),
            method: "POST",
          }
        ),
    }).pipe(
      // Bound the wait like the installations page walk: a token POST that
      // never settles must fail the mint, never hang it — see
      // MINT_HTTP_TIMEOUT_MS. `commit-via-api.ts` (which mints internally)
      // and every `GH_TOKEN=$(…)` capture share this deadline.
      Effect.timeoutOrElse({
        duration: MINT_HTTP_TIMEOUT_MS,
        orElse: () =>
          new GhAppError({
            message: `GitHub installation-token request did not answer within ${MINT_HTTP_TIMEOUT_MS / 1000}s`,
            op: "request",
          }),
      })
    );

    // A non-2xx stays `op:"http"` with its status: `gh-app-token.ts` retries a
    // stale installation on exactly that shape, and a decode failure must not
    // be mistaken for one. The read is bounded by the same deadline as the
    // token POST: a headers-then-stall body wedges the mint — the exact class
    // the fetch deadline closes, reopened through the body read.
    const payload = yield* Effect.promise(() => readBodyJson(response)).pipe(
      Effect.timeoutOrElse({
        duration: MINT_HTTP_TIMEOUT_MS,
        orElse: () =>
          new GhAppError({
            message: `GitHub installation-token response body did not arrive within ${MINT_HTTP_TIMEOUT_MS / 1000}s`,
            op: "request",
          }),
      })
    );
    if (!response.ok) {
      return yield* new GhAppError({
        message: `GitHub installation-token mint failed: ${githubErrorDetail(payload, response.status)}`,
        op: "http",
        status: response.status,
      });
    }

    if (payload === null) {
      return yield* new GhAppError({
        message: "GitHub access-token response was not JSON",
        op: "parse",
      });
    }

    const body = yield* Schema.decodeUnknownEffect(
      AccessTokenResponse,
      ALL_ERRORS
    )(payload).pipe(
      Effect.mapError(
        (error) =>
          new GhAppError({
            cause: error,
            message: `GitHub access-token response did not match the expected shape: ${error.message}`,
            op: "parse",
          })
      )
    );

    return {
      expiresAt: body.expires_at,
      token: body.token,
    };
  });
