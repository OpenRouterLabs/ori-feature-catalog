/**
 * commit-api-core.ts — shared error type, seams, and GitHub Git-Data-API JSON
 * helper for the commit-via-API flow.
 *
 * Split out of `commit-via-api.ts` (see that file for the full "why this
 * exists" / usage docs) purely to keep each module under the file-length lint
 * budget; there is no independent reuse story yet.
 */

import { spawnSync } from "node:child_process";

import { Data, Effect, Option, Schema } from "effect";

// #region Error

/** Single typed failure for every commit-via-API operation. */
export class CommitApiError extends Data.TaggedError("CommitApiError")<{
  /** The failing stage — "args" | "mint" | "git" | "http" | "parse" | "nothing-to-commit". */
  readonly stage: string;
  /** Human-readable message (never carries token material). */
  readonly message: string;
  /** HTTP status for "http" failures; absent otherwise. */
  readonly status?: number;
}> {}

// #endregion
// #region Types

/** The subset of `fetch` this module uses — narrow so tests inject a fake
 *  without satisfying Bun's full `typeof fetch` (which requires `preconnect`). */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** A run-git seam so tests drive the porcelain/cat-file parsing without a repo. */
export type RunGit = (
  args: readonly string[],
  cwd: string
) => { readonly ok: boolean; readonly stdout: string; readonly stderr: string };

/** A read-file seam (absolute path → bytes) so tests inject content with no disk. */
export type ReadFile = (absolutePath: string) => Promise<ArrayBuffer>;

/**
 * A readlink seam (absolute path → link-target string) so tests inject content
 * with no disk. `lstatSync().isSymbolicLink()` is the only other filesystem
 * touch; a dangling link still readlinks fine (the target need not exist —
 * git stores the string either way).
 */
export type ReadLink = (absolutePath: string) => Promise<string>;

/** One worktree change: a repo-relative path plus whether it was deleted. */
export interface ChangedFile {
  readonly path: string;
  readonly deleted: boolean;
}

/**
 * True when a porcelain-v1 path names a directory, not a file: an untracked
 * directory git does not descend into (one holding a nested git repo — the
 * `?? tools/` record with `--untracked-files=all`) is emitted with a trailing
 * slash. `git add -A` stages exactly that path as a `160000` gitlink entry
 * (verified live: `git ls-files --stage` after `git add -A` shows mode 160000
 * for the nested repo's HEAD), so the record must KEEP flowing — with the
 * trailing slash stripped, since a git tree entry path never carries one —
 * to `commit-flow.ts`'s directory→gitlink branch. Dropping it here (the old
 * behavior) left the nested repo untracked, diverging from `git add -A`:
 * after the commit the branch's tree had no entry at the path at all.
 */
const isDirectoryPath = (path: string): boolean => path.endsWith("/");

/** Strip the trailing slashes a directory record carries — a git tree entry
 *  path never ends with one, and the Git-Data API would stage a literally
 *  slash-suffixed path otherwise. */
const stripTrailingSlashes = (path: string): string =>
  path.replace(/\/+$/u, "");

export interface CommitArgs {
  readonly worktree: string;
  readonly branch: string;
  readonly message: string;
  readonly repo: string;
}

export interface CommitDeps {
  readonly fetchImpl?: FetchLike;
  readonly runGit?: RunGit;
  readonly readFile?: ReadFile;
  /** Pre-resolved symlink-target seam; defaults to node:fs/promises readlink. */
  readonly readLink?: ReadLink;
  /** Pre-resolved token; when set, minting is skipped. */
  readonly token?: string;
}

export const GITHUB_API = "https://api.github.com";
/** GitHub's blob mode for a normal (non-executable, non-symlink) file. */
export const FILE_MODE = "100644";
export const EXEC_MODE = "100755";
/**
 * Git's object mode for a symbolic link: a `120000` blob whose CONTENT is the
 * link-target string (`git add` stores exactly that — the link's target text,
 * never the target's own bytes). The matching Git-Data-API tree entry is
 * `{ mode: "120000", type: "blob" }` with a blob of that string.
 */
export const SYMLINK_MODE = "120000";
/**
 * Git's object mode for a gitlink (submodule / embedded repo) entry: a tree
 * entry pointing at a COMMIT sha in another repository. `git add`/`git
 * commit` stage exactly this for a directory containing a nested git repo,
 * and the Git-Data API's tree shape carries `{ mode: "160000", type:
 * "commit" }` for it — a blob flow must never try to read the directory as a
 * file.
 */
export const GITLINK_MODE = "160000";
/**
 * How long one Git-Data-API HTTP call of the commit flow may wait before the
 * flow stops waiting. Pre-fix NONE of the flow's five network steps (the ref
 * read, the head-commit read, each blob POST, the tree POST, the commit POST,
 * the ref PATCH) carried a bound: a hung connection to api.github.com (a
 * dropped route, a wedged proxy) left `commit-via-api.ts` pending forever —
 * after it had already minted a token and possibly created blobs, with no
 * diagnostic and no exit. Every sibling network path in this feature already
 * bounds its wait (`PR_LOOKUP_TIMEOUT_MS` in the sweep, the mint's
 * `MINT_HTTP_TIMEOUT_MS`, the health check's two deadlines, the Slack alert
 * post); the commit flow is the feature's primary WRITE path and the last
 * unbounded one. The deadline turns "no answer" into the same `http`-stage
 * `CommitApiError` channel a 5xx already uses.
 */
export const COMMIT_HTTP_TIMEOUT_MS = 15_000;
/** `git status --porcelain=v1 -z` status-code column width before the path. */
const STATUS_PATH_OFFSET = 3;
/**
 * Porcelain-v1 statuses whose `-z` record emits a SECOND NUL field carrying
 * the source path: renames (`R`) and copies (`C`). Both shapes are
 * `XY␠new\0old` — the trailing field names the existing file the new path
 * came from.
 */
const TWO_FIELD_STATUS = new Set(["R", "C"]);
/** Fields consumed by a two-field (rename/copy) record: the entry + its source. */
const TWO_FIELD_STRIDE = 2;
/**
 * The EXACT set of porcelain-v1 status pairs marking an UNMERGED path (a
 * conflict): `DD`, `AU`, `UD`, `UA`, `DU`, `AA`, `UU` — git's documented
 * unmerged codes and no others. A single shared letter set over-matched: `AD`
 * (index-add + worktree-delete) and `DA` are normal, committable states (`git
 * commit` stages them), but both letters sat in the set, so the flow refused
 * them as "unmerged". `git commit` refuses exactly these seven; the Git-Data
 * flow refuses the same seven, or it silently commits conflict markers into a
 * `Verified` commit — and refusing `AD`/`DA` blocks a commit git itself would
 * take.
 */
const UNMERGED_STATUS = new Set([
  "DD",
  "AU",
  "UD",
  "UA",
  "DU",
  "AA",
  "UU",
]);
const isUnmergedStatus = (x: string, y: string): boolean =>
  UNMERGED_STATUS.has(`${x}${y}`);

/**
 * True when a two-field (rename/copy) record's DESTINATION is gone from the
 * worktree — exactly `RD` (git renames the path in the index, then the
 * worktree copy is deleted; `CD` does not exist in porcelain v1). The
 * destination must be staged as a DELETE for the flow to match `git add -A`
 * on the same worktree: staging it as an add would read a file that is no
 * longer there (a deleted `git mv` target) and fail the whole run.
 */
const isDeletedDestination = (x: string, y: string): boolean =>
  y === "D" && x !== "D";

/**
 * The first argv token no CLI in this feature accepts, in either of the two
 * junk shapes:
 *
 * - a single-dash token: `-repo o/r` is the near-universal typo for
 *   `--repo o/r` (drop a character). Every parser tolerates UNKNOWN `--`
 *   flags by design (a bare invocation keeps working), but a single-dash
 *   token can only be junk — and the parsers that silently ignored it turned
 *   the typo into a wrong-default action: `mint-token.ts -repo acme/x`
 *   minted the DEFAULT App (the #98/#107/#117 silent-identity-swap class),
 *   `cleanup-worktrees.ts -repo o/r` swept the DEFAULT repo's worktrees (a
 *   wrong-target removal), and `register-gh-app.ts -purpose reviewer`
 *   coerced to the org-level CATCH-ALL row (the #117 re-routing class).
 * - an equals-form `--flag=value` token: none of these CLIs supports the
 *   `=` spelling, so the token is never a flag the parser reads — it is an
 *   unknown argument whose value the parser would silently DROP.
 *   Pre-fix, `mint-token.ts --repo=acme/widgets --purpose=reviewer` parsed
 *   clean and minted the DEFAULT App's token (the target-org request
 *   silently discarded — the same #98/#107 silent-identity-swap class the
 *   single-dash guard closed), `cleanup-worktrees.ts --repo=other/rep`
 *   parsed clean and swept the DEFAULT repo's slug directory (the same
 *   wrong-target destructive sweep `-repo` produced), and
 *   `register-gh-app.ts --org=acme --app-id-key=K --private-key-key=P`
 *   parsed clean and failed with a misleading "requires --org" that never
 *   named the dropped flags. `commit-via-api.ts` already failed loudly on
 *   the shape (its pair loop reads `--worktree=/wt` as a flag whose value is
 *   missing), so the guard unifies all four CLIs on its loud-failure
 *   contract. The shape is rejected outright — matching the convention that
 *   a parser either supports `--flag=v` everywhere or nowhere — rather than
 *   trying to salvage the value after the `=`, which none of the documented
 *   usages produces.
 *
 * Callers fail the parse with the offending token named; `undefined` means
 * argv carries no junk.
 */
export const findJunkArgv = (argv: readonly string[]): string | undefined =>
  argv.find(
    (token) =>
      (token.startsWith("-") && !token.startsWith("--")) ||
      /^--[^=]+=/.test(token)
  );

/**
 * Back-compat alias for the single-dash half of {@link findJunkArgv}. New
 * call sites should fail the parse on `findJunkArgv` — both junk shapes.
 */
export const findSingleDashArgv = (
  argv: readonly string[]
): string | undefined =>
  argv.find((token) => token.startsWith("-") && !token.startsWith("--"));

/**
 * Resolve `owner/repo` from `GITHUB_REPO`, tolerating a full https URL or a
 * trailing `.git`. Returns `""` when unset so the CLI can fail with a clear
 * message rather than committing to the wrong repo.
 */
export const resolveRepoFromEnv = (
  // oxlint-disable-next-line node/no-process-env -- default deps seam; callers pass a fake env in tests.
  env: Readonly<Record<string, string | undefined>> = process.env
): string => {
  // A LEADING slash — `/acme/widgets` (a shell-autocomplete paste) — is the
  // same repo as `acme/widgets`, and every `repos/{repo}` route 404s on the
  // doubled slash the raw spelling produces. `resolveConfigDirName` already
  // strips it (its repo regexes key on the two-segment tail) and the
  // prompt's `REPO=` sed strips it (`s#^/##`) — this resolver is the one
  // that missed it, so one `GITHUB_REPO` spelling silently produced a
  // worktree SLUG of `-acme-widgets` and a repo route that never resolved
  // while the config dir said `widgets` (the #113 silent-migration class
  // reopened through the leading slash).
  // Trim trailing slashes as well as whitespace: `acme/widgets/` (a
  // copy-paste from a browser address bar) is the same repo as
  // `acme/widgets`, and every `https://api.github.com/repos/<repo>/...`
  // route answers 404 for the doubled trailing slash.
  // A host-case spelling — `https://GitHub.com/acme/widgets`, a copy-paste
  // that kept the address bar's capitalization — is the same URL: hosts are
  // case-insensitive (RFC 3986 §3.2.2), and git/gh/curl all accept the
  // mixed-case host. Lower-case the HOST WORD up front (never the
  // owner/repo path — GitHub logins keep their case) so every anchored
  // `github.com` branch below sees the same string `orgOf` and
  // `resolveAllowedOrgs` see; pre-fix a mixed-case host fell every branch
  // and the raw URL was returned whole, so every `repos/{repo}` route 404'd
  // (the #159/#169 class, reopened through the host's capitalization).
  // The rider/suffix strips BELOW run BEFORE this case-lower, never after:
  // the case-lower keys on a `github.com`-anchored lookahead, and a rider
  // or `.git` suffix PAST the host word (`GitHub.com#frag`,
  // `https://GitHub.com.git` — a tab/anchor or clone suffix riding past a
  // case-variant bare host, the same paste class the #159/#169 corpus pins
  // through the lowercase host) made the lookahead fail, so the host kept
  // its case, fell every anchored branch, and the raw string flowed on
  // whole — a repo every `repos/{repo}` route 404s on — while `orgOf` and
  // the REPO= recipe answered "" for the same spelling, and the config dir
  // keyed on the sanitized host. One spelling contract, five answers:
  // strip what no anchored branch depends on FIRST, then let the
  // case-lower see the clean host word.
  // The trailing trim ALSO runs before the rider strips, never only after:
  // a rider past an interior space (`o/r ?tab=readme`, `o/r /` — the #249
  // separator-adjacent-whitespace paste, with the tab the browser was on
  // riding past it) was not the raw tail yet, so a rider strip keyed on
  // the raw tail missed it, the exposed `"o/r "` kept its space, and a
  // trim running only AFTER never saw it again — while the REPO= recipe
  // (its `s#[/[:space:]]+$##` runs before its rider strips, and `[^/]*`
  // matches the space) answered the healthy `o/r`. One order, both classes.
  const raw = (env.GITHUB_REPO ?? "")
    .trim()
    // The strips the tail exposes — query/fragment riders, then the trailing
    // separator/whitespace, then whatever the separator exposed — mirror the
    // order the recipe's own rules run in, so both see the same string.
    .replace(/\?.*$/u, "")
    .replace(/#.*$/u, "")
    .replace(/[\/\s]+$/gu, "")
    .replace(/\.git$/u, "")
    .replace(/\/+$/u, "")
    // Re-strip the separator/whitespace the `.git` strip can expose — the
    // same re-strip `withoutSuffix` below established for the
    // rider-before-suffix paste: `o/r /.git/` trims its trailing slash to
    // `o/r /.git`, the suffix strip then exposes `o/r /`, and a trailing
    // space survives into `$REPO` unless it is re-trimmed here.
    .replace(/[\/\s]+$/gu, "")
    // A `.git` exposed by THAT re-trim (`o/r /.git/.git`) strips too.
    .replace(/\.git$/u, "")
    .replace(/[\/\s]+$/gu, "")
    .replace(
      /^((?:[a-zA-Z][a-zA-Z0-9+.-]*)?:\/\/)?((?:[^@\/\s]+@)?)([Gg][Ii][Tt][Hh][Uu][Bb]\.[Cc][Oo][Mm])(?=:\d+(?:[\/:]|$)|[\/:]|$)/u,
      (_m: string, scheme: string, user: string, host: string) =>
        // Lower-case the SCHEME word too, never just the host (§3.1, §3.2.2
        // both case-insensitive): an upper-case scheme spelling
        // (`HTTPS://github.com`) kept its case and fell the case-sensitive
        // `(?<!(?:https?|ssh|git\+ssh|git|ftp):)` guard below, so its own `://`
        // collapsed to `:` (`HTTPS:github.com`) and every bare-host branch
        // missed — the raw junk flowed on as the "repo" (the exact
        // silent-dead-value class the host-case fix closed, reopened through
        // the scheme word). The prompt's `REPO=` recipe already empties the
        // lowercase bare host; the resolver must agree with it.
        `${(scheme ?? "").toLowerCase()}${user ?? ""}${host.toLowerCase()}`
    );
  // A LEADING slash — `/acme/widgets` (a shell-autocomplete paste) — is the
  // same repo as `acme/widgets`, and every `repos/{repo}` route 404s on the
  // doubled slash the raw spelling produces. `resolveConfigDirName` already
  // strips it (its repo regexes key on the two-segment tail) and the
  // prompt's `REPO=` sed strips it (`s#^/##`) — this resolver is the one
  // that missed it, so one `GITHUB_REPO` spelling silently produced a
  // worktree SLUG of `-acme-widgets` and a repo route that never resolved
  // while the config dir said `widgets` (the #113 silent-migration class
  // reopened through the leading slash).
  // Strip leading slashes AND any whitespace they expose, in ONE step
  // (`^[/\s]+`) — the same #249 class `orgOf` closes (see gh-app-registry.ts):
  // the `raw` chain above already trimmed, so a leading space survives it only
  // behind a slash (`/ acme/widgets`, a shell-autocomplete paste that kept its
  // padding), and stripping the slash alone re-exposes it — every
  // `repos/{repo}` route then 404s on `" acme/widgets"` while the sibling
  // resolvers trim and answer the healthy pair. One character class keeps the
  // recipe and the four resolvers on one spelling contract.
  const leadingSlashStripped = raw.replace(/^[/\s]+/u, "");
  // Strip a QUERY or FRAGMENT suffix — `o/r?tab=readme`, `o/r#anchor`,
  // `https://github.com/o/r?tab=readme` (a browser address-bar copy-paste of
  // the repo page, which carries the tab the browser was on; a fragment
  // likewise rides any deep URL) — BEFORE the anchored branches below: both
  // delimiters are URL-reserved characters a repo NAME cannot carry, and
  // pre-fix every `$`-anchored branch keyed on a tail ending in the raw
  // suffix, so the spelling fell the two-segment/deep branches and flowed on
  // whole as the "repo" — `repos/o/r?tab=readme` (the query silently 404s the
  // route for a nonexistent repo: the `?` ends the PATH and the tab is not a
  // repo the route knows), `github.com/o/r#anchor` (the `#` makes the clone
  // URL invalid: git appends `/info/refs` past the fragment and the remote
  // never resolves), and a worktree SLUG + config dir keyed on
  // `r-tab-readme`. The prompt's REPO= sed recipe and every sibling resolver
  // must agree — one spelling contract.
  const queryFragmentStripped = leadingSlashStripped
    .replace(/\?.*$/u, "")
    .replace(/#.*$/u, "");
  // A `/.git` suffix (separator-then-dot-git — `https://github.com/acme/.git`,
  // `github.com:acme/.git`) exposes an interior `/` once the suffix comes off;
  // re-strip it or every `$`-anchored branch below misses and the raw URL is
  // returned whole — every `repos/{repo}` route then 404s (the #141 class,
  // reopened through the separator-then-dot-git paste). The prompt's `REPO=`
  // sed recipe already collapses these (`s#\.git$##` then `s#/$##`); the
  // resolver must agree with it.
  const withoutSuffix = queryFragmentStripped
    .replace(/\.git$/u, "")
    .replace(/\/+$/u, "")
    // Re-strip a `.git` exposed by the trailing-slash strip above: a clone
    // URL whose `.git` suffix carried a TRAILING SLASH before a stripped
    // rider (`https://github.com/acme/widgets.git/?tab=readme`,
    // `…widgets.git/#frag` — a browser address-bar copy-paste whose
    // tab/anchor rode past the suffix, the same rider corpus
    // repo-string-dotgit-suffix.test.ts pins) resolved, pre-fix, through the
    // FIRST `.git` rule's anchored `$` only: the rider sat past it, so the
    // rule missed, the trailing-slash strip ran on the rider-suffixed tail,
    // and `acme/widgets.git` flowed on whole — a value every
    // `repos/{repo}` route then 404s on (`repos/o/r.git/` is not a route,
    // verified live) while the prompt's REPO= recipe and `orgOf` answered
    // the healthy `acme/widgets`. The slash-before-`.git` order the
    // slash-dot-git fix established runs BOTH ways: strip the suffix, then
    // re-strip the separator it exposed — and re-strip the suffix the
    // separator can expose in turn.
    .replace(/\.git$/u, "")
    // Collapse interior runs of path slashes — `github.com//o/r`, `o//r`
    // (a copy-paste that kept a doubled path slash; the same paste class as
    // the trailing slash the strip above already handles). Every `$`-anchored
    // branch below keys on `[^/]+/[^/]+`-style tails, which an EMPTY path
    // segment never matches, so pre-fix the raw string fell every branch and
    // returned whole — every `repos/{repo}` API route then 404s (the #141
    // class, reopened through the interior double). The prompt's `REPO=`
    // sed recipe collapses the same paste (its anchored
    // `s#(^[^/]+/[^/]+)(/.*)?$#\1#` keys on the same non-empty segments);
    // `orgOf` and `resolveAllowedOrgs` strip the same runs; the resolvers
    // must agree. A scheme's own `://` is guarded (`https:`, `ssh:`, …) and
    // never collapses; the scp host separator is a bare `:`, so
    // `git@github.com://o/r` collapses to the scp form `git@github.com:o/r`.
    // Whitespace AFTER a path separator — `github.com/ acme`, `git@github.com:
    // acme`, `https://github.com:22/ acme` (a copy-paste that kept its padding)
    // — belongs to no login or repo name (GitHub carries a space in neither),
    // and the trim at the top of this chain cannot see it: it is INTERIOR,
    // behind the separator, so pre-fix the anchored branches below captured it
    // INSIDE their `[^/]+` segments (` acme`), so every `repos/{repo}` route
    // 404s on a repo no route answers — while the prompt's `REPO=` recipe and
    // `resolveAllowedOrgs` both answer the healthy pair. The same #249 re-trim
    // class `orgOf` closes (see gh-app-registry.ts), reopened through the
    // separator: drop the separator-adjacent whitespace so every branch below
    // sees the same string the recipe collapses to.
    // The strip runs BEFORE the interior-slash collapse below: a
    // PADDING-ONLY segment (`https://github.com/ /widgets`,
    // `git@github.com: :o/r` — one path segment carrying nothing but the
    // separator-adjacent whitespace, the same paste class) otherwise
    // blocks the collapse, so `//` never becomes `/` and the whole raw
    // URL flowed on past every anchored branch while the REPO= recipe
    // answered the healthy tail — the resolvers answering different
    // values for one spelling, the one-spelling contract broken (the
    // #113/#159 class, reopened through the segment form).
    .replace(/(?<=[\/:])\s+/gu, "")
    .replace(/(?<!(?:https?|ssh|git\+ssh|git|ftp)):\/+/giu, ":")
    .replace(/(?<!(?:https?|ssh|git\+ssh|git|ftp):)\/\/+/giu, "/");
  // Strip an explicit PORT before any regex runs — the same normalization
  // `orgOf` applies (see gh-app-registry.ts). With the port left in, the
  // `[/:]` host separator below can BACKTRACK past the optional `(?::\d+)?`
  // port group: the `:` itself becomes the separator, the port digits become
  // the "owner"/"repo" segment. A bare host+port spelling (`github.com:22`,
  // `git@github.com:22` — a truncated `git remote -v` copy-paste) then makes
  // the org-URL branch return `"22"` as the repo, and `github.com:22/acme`
  // match the fake owner/repo pair `22/acme` — the exact #186 "port digits
  // must never become the owner segment" class, reopened through the
  // no-path and org-only spellings. A port is unambiguous — `:<digits>`
  // right after the `github.com` host, before any separator or end — so
  // removing it up front lets every branch below see the same string every
  // sibling resolver already resolves through.
  const portStripped = withoutSuffix.replace(
    /((?:git@)?github\.com):\d+(?=[\/:]|$)/u,
    "$1"
  );
  // An api.github.com REST paste — `https://api.github.com/repos/acme/widgets`
  // (also the hostless `api.github.com/…` form, and any deep tail the REST
  // routes produce: `/contents/…`, `/tarball/…`, `/issues`, …) — is the URL
  // shape this feature's own prompt teaches the operator to build and curl,
  // so pasting it back into GITHUB_REPO is a realistic spelling. It is the
  // one host whose canonical path starts with a literal host-path word the
  // anchored branches below key on as the OWNER: pre-fix the two-segment
  // repo match read `repos/acme` as the owner/repo pair (`repos` is GitHub's
  // REST host-path word, never a login — `repos/repos/acme` answers 404,
  // verified live), `orgOf`/`resolveAllowedOrgs` keyed the registry and the
  // allowlist on `repos` (every mint failed closed with no hint the env
  // var's spelling was the cause), and the prompt's REPO= recipe answered a
  // FIFTH, different dead value (`https://api.repos/acme/widgets` — its
  // `github.com[/:]` strip consumed `github.com/` inside the api host and
  // welded `api.` onto `repos`) — five disagreeing answers for one spelling,
  // the exact one-spelling contract the README states. Strip the api host
  // word and the `repos` path word UP FRONT so every branch below sees the
  // same `owner/repo`-bearing string the sibling resolvers are fixed to see.
  // A bare api host (no path) names no owner, the same honest "" a bare
  // github.com host answers — never the host string itself.
  const apiHostMatch = /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:\/\/)?(?:[^@\/\s]+@)?[Aa][Pp][Ii]\.[Gg][Ii][Tt][Hh][Uu][Bb]\.[Cc][Oo][Mm](?:\/|$)/u.test(
    portStripped
  );
  const apiStripped = apiHostMatch
    ? portStripped.replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)?(?:[^@\/\s]+@)?[Aa][Pp][Ii]\.[Gg][Ii][Tt][Hh][Uu][Bb]\.[Cc][Oo][Mm]\/?/u, "")
    : portStripped;
  const apiRepoStripped = apiHostMatch
    ? apiStripped.replace(/^repos\//u, "")
    : apiStripped;
  // An ORGANIZATIONS-page URL — `github.com/orgs/acme` (the "Your
  // organizations" page), also `github.com/organizations/acme` — is the one
  // spelling whose ORG sits where the repo regexes below expect a repo
  // segment: `github.com/orgs/acme` parses as owner `orgs` with repo `acme`,
  // a fake owner/repo pair that looks legitimate downstream while every
  // `repos/{repo}` route 404s. The sibling resolvers (`orgOf`,
  // `resolveAllowedOrgs`) strip these spellings to the org they name
  // (#169's class, for the resolver that feeds the Git-Data routes), and
  // `orgOf` runs its own orgs-page branch BEFORE its repo regex for exactly
  // this reason; this resolver must too. A repo resolver cannot invent a
  // repo, so it returns the ORG — the same single-segment pass-through a
  // bare `owner` keeps at the bottom. The match tolerates a DEEP tail
  // (`/orgs/acme/teams`, `/organizations/acme/settings`) before the ORG
  // segment: the `$`-anchored form only caught the bare page, so a deep
  // orgs-page URL fell through to the repo regex and matched the fake
  // owner/repo pair `orgs/acme` — the exact class this branch exists to
  // close, reopened through the deep path (#101/#169's shape).
  // A port in the host separator (ssh://git@github.com:22/…) must not become
  // the "owner" segment — see gh-app-registry.ts orgOf for the full class.
  const orgsPageMatch =
    /(?:git@)?github\.com(?::\d+)?[/:](?:orgs|organizations|users)[/:]([^/]+)(?:\/.*)?$/u.exec(
      apiRepoStripped
    );
  if (orgsPageMatch?.[1] !== undefined) {
    return orgsPageMatch[1];
  }
  // A HOSTLESS paste of the orgs-page path — bare `orgs/<org>` or
  // `organizations/<org>` (the URL path copied without the host) — is the
  // same reserved-word spelling as the hosted form above: pre-fix it fell
  // through to the bare pass-through at the bottom and returned
  // `orgs/acme` whole, which every `repos/{repo}` route 404s on (the word
  // is a reserved host path, never an owner login), while `orgOf` and
  // `resolveConfigDirName` resolved the SAME spelling to `acme` — the
  // #169 orgs-page class reopened through the hostless form. A repo resolver
  // cannot invent a repo, so it returns the ORG, exactly like the hosted
  // branch above (the prompt's `REPO=` sed does the same).
  const hostlessOrgsMatch =
    /^(?:orgs|organizations|users)\/([^/]+?)(?:\/.*)?$/u.exec(apiRepoStripped);
  if (hostlessOrgsMatch?.[1] !== undefined) {
    return hostlessOrgsMatch[1];
  }
  // The ORGANIZATIONS-page INDEX spelling — `https://github.com/orgs`
  // (also `/organizations`, the scp/ssh host-word form, and the ported
  // spellings) — ends AT the reserved host-path word with no org segment
  // after it: it is the page that LISTS your organizations, not one of
  // them, and a repo resolver cannot invent a repo from it. Pre-fix the
  // host-only branch below captured the word itself as the owner/repo
  // tail (`orgs`), so `resolveRepoFromEnv({ GITHUB_REPO })` handed the
  // health check's round-trip and every `gh --repo`/`repos/{repo}` route
  // a permanent 404 named after a host path — the same fake-owner class
  // the orgs-page branch above exists to close, reopened through the
  // index spelling. The word is never an owner login — return "" so the
  // callers that must fail loudly do (commit-via-api's "--repo (or set
  // GITHUB_REPO)" diagnostic, the schedules' die). A REPO named `orgs`
  // under a real owner never reaches here: the repo branches below
  // capture the real owner/repo pair first.
  const orgsIndexMatch =
    /(?:git@)?github\.com(?::\d+)?[/:](?:orgs|organizations|users)$/u.exec(
      apiRepoStripped
    );
  if (orgsIndexMatch !== null) {
    return "";
  }
  // The HOSTLESS index spelling — a bare `organizations` word with no host
  // and no org segment — names no owner either: return "" so the callers
  // that must fail loudly do, matching `orgOf`'s no-owner answer for the
  // same word. A bare `orgs` word keeps the bare-owner pass-through, the
  // same split the registry resolver applies.
  if (/^(organizations|users)$/u.test(apiRepoStripped)) {
    return "";
  }
  const match = /github\.com(?::\d+)?[/:]([^/]+\/[^/]+)$/u.exec(apiRepoStripped);
  if (match?.[1] !== undefined) {
    return match[1];
  }
  // A deep GitHub URL — `https://github.com/o/r/tree/main` (a copied
  // blob/tree/PR/releases address) — must collapse to its `owner/repo` tail:
  // the raw URL passed straight through makes every `repos/{repo}` API
  // route 404, exactly the class the URL-spelling fix closed for the
  // two-segment form.
  const deepMatch =
    /github\.com(?::\d+)?[/:]([^/]+\/[^/]+)(?:\/.*)?$/u.exec(apiRepoStripped);
  if (deepMatch?.[1] !== undefined) {
    return deepMatch[1];
  }
  // A HOST-ONLY URL — an org page (`https://github.com/acme`) or any other
  // `github.com/<word>` address with no repo segment — carries an owner the
  // two-segment and deep regexes above both miss (they need two segments),
  // and the bare pass-through below would return the raw URL whole, which
  // every `repos/{repo}` route 404s on. Same treatment as the orgs-page
  // branch above: return the org it names, like `orgOf`'s org-URL branch.
  const orgUrlMatch = /(?:git@)?github\.com(?::\d+)?[\/:]([^/]+)$/u.exec(
    apiRepoStripped
  );
  if (orgUrlMatch?.[1] !== undefined) {
    return orgUrlMatch[1];
  }
  // A BARE-HOST spelling — `https://github.com`, `github.com`, or the
  // scp/ssh form `git@github.com` / `ssh://git@github.com` (a copied landing
  // page or a truncated `git remote -v` paste, with NO owner and NO repo
  // segment at all) — must resolve to "" so the callers that must fail
  // loudly do, exactly like the orgs-page INDEX spelling above: pre-fix the
  // bare pass-through below returned the raw host string whole as the
  // "repo", so every `repos/{repo}` route 404'd (`repos/https://github.com`
  // — verified live: no such route answers), `git ls-remote` never resolved,
  // and the health check's round-trip named a repo that does not exist —
  // while `orgOf` and `resolveAllowedOrgs` resolved the SAME spelling to the
  // raw host word and the config dir keyed `https-github.com`, so the four
  // resolvers silently disagreed on one spelling (the README's one-spelling
  // contract). A repo resolver cannot invent a repo from a host string; ""
  // is the honest no-owner answer.
  const bareHostMatch =
    /^(?:(?:[a-zA-Z][a-zA-Z0-9+.-]*:\/\/)?(?:[^@\/\s]+@)?(?:git\.)?github\.com)?$/u.exec(
      apiRepoStripped
    );
  if (bareHostMatch !== null) {
    return "";
  }
  // A HOSTLESS deep paste — bare `owner/repo/<tail>` (the URL path of a
  // copied blob/tree/PR/releases address, pasted without the host) — is
  // the same deep spelling the `deepMatch` branch above closes for the
  // hosted form: pre-fix it fell every branch (the bare pass-through below
  // returned the whole string), so every `repos/{repo}` route 404'd —
  // exactly the class the prompt's own `REPO=` sed recipe closes for the
  // same paste (`s#(^[^/]+/[^/]+)(/.*)?$#\1#` collapses it to the
  // `owner/repo` tail). One spelling contract, four resolvers: the recipe
  // and the code must agree, or a hostless deep paste in `$GITHUB_REPO`
  // silently targets a repo no route answers.
  const hostlessDeepMatch = /^([^/]+\/[^/]+)(?:\/.*)?$/u.exec(
    apiRepoStripped
  );
  if (hostlessDeepMatch?.[1] !== undefined) {
    return hostlessDeepMatch[1];
  }
  // A TRUNCATED scp/ssh host word — `github.com:`, `git@github.com:`,
  // `ssh://git@github.com:`, `https://github.com:` (a colon after the host
  // with no path after it — a `git remote -v` paste cut at the colon, the
  // same family as the bare-host and ported spellings the guards above
  // handle) — names no owner and no repo: the anchored branches above all
  // need a `[/:]` plus a segment, so it fell them and the bare pass-through
  // below returned the raw string whole as the "repo" — a value every
  // `repos/{repo}` route then 404s on (`repos/github.com:` is not a route),
  // while `orgOf` and the prompt's `REPO=` sed recipe answered "" for the
  // same spelling. A repo resolver cannot invent a repo from a host string;
  // "" is the honest no-repo answer (the callers fail loudly on it).
  if (
    /(?:git@)?github\.com(?::\d+)?:$/u.test(apiRepoStripped) ||
    /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:\/\/)?(?:[^@/\s]+@)?github\.com:$/u.test(
      apiRepoStripped
    )
  ) {
    return "";
  }
  // A bare string (no github.com host) keeps its historical pass-through.
  return apiRepoStripped;
};

// #endregion

// #region Unset-vs-unresolvable

/**
 * True when `GITHUB_REPO` is genuinely ABSENT (undefined, empty, or
 * whitespace-only) — as opposed to SET to a spelling that
 * {@link resolveRepoFromEnv} resolves to no owner/repo (the empty string).
 *
 * The two cases share the resolver's `""` result but need different
 * diagnostics, and every caller of the resolver reads the same `env` it
 * passes in, so the split belongs here — one predicate beside the resolver
 * that produces the shared empty value, not a private copy at each site:
 *   - unset → "GITHUB_REPO is not set" (the operator must configure it);
 *   - set-but-unresolvable → "resolves to no owner/repo — check its
 *     spelling", naming the spelling (the orgs-page INDEX URL is the first
 *     corpus: `https://github.com/orgs` names no owner, #203). Pre-fix every
 *     site printed "not set" for both, which is a lie for exactly the input
 *     that most needs the message — it sent the operator to inspect service
 *     env that was present and populated.
 */
export const isRepoUnset = (
  // oxlint-disable-next-line node/no-process-env -- default deps seam; callers pass a fake env in tests.
  env: Readonly<Record<string, string | undefined>> = process.env
): boolean => (env.GITHUB_REPO ?? "").trim() === "";

// #endregion

// #region git seam

/** Default `runGit`: a synchronous git invocation in `cwd`. */
export const defaultRunGit = (
  args: readonly string[],
  cwd: string
): { ok: boolean; stdout: string; stderr: string } => {
  // 64MB, not spawnSync's 1MB default: a large worktree's
  // `git status --porcelain=v1 -z --untracked-files=all` (the record the
  // commit flow stages from) can far exceed 1MB — ~5,200 files with long
  // names already do. At the default the child is killed at the cap with
  // ENOBUFS, stdout is silently truncated mid-record, and the flow dies on
  // `git status failed:` with a blank message (spawnSync reports the
  // buffer overflow on `result.error`, not stderr). 64MB covers ~1M
  // changed paths — orders of magnitude past any real worktree.
  const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;
  const result = spawnSync("git", [...args], {
    cwd,
    encoding: "utf-8",
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
  });
  // A spawn-level failure (ENOBUFS, spawn ENOENT, …) lands on `result.error`
  // with an empty/partial stderr — surface it, or every caller's
  // `git status failed: <stderr>` diagnostic is blank.
  const spawnError =
    result.error === undefined ? "" : ` ${result.error.message}`;
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: `${result.stderr ?? ""}${spawnError}`,
  };
};

/**
 * Parse one non-two-field porcelain-z record into a `ChangedFile`, or `null`
 * when nothing should be staged for it. The rule mirrors what `git add -A`
 * stages (the flow is worktree-sync: it commits ` M` worktree-only modifies
 * too), keyed on the real porcelain columns:
 *   X = the INDEX vs HEAD, Y = the WORKTREE vs index.
 * - UNMERGED (one of the seven codes): `null` — the caller reports the path
 *   and refuses, never committing conflict markers.
 * - Worktree copy GONE (`D `, ` D`, or `AD`): a delete — EXCEPT `AD`, where
 *   the path was never in HEAD (X `A`), so there is nothing in the base tree
 *   to remove and no worktree file to read: staging a `sha:null` removal for a
 *   path that exists in no tree is wrong (and a blob read would ENOENT), so it
 *   is skipped — exactly what `git add -A` does, which drops the path.
 * - Worktree copy PRESENT (everything else, including `DA` — staged delete
 *   with the file re-created on disk): a blob add. `DA`'s worktree copy is
 *   real, so `git add -A` re-adds it; marking it deleted from the X column
 *   would drop a file the user has on disk.
 */
const parseStatusEntry = (entry: string): ChangedFile | null => {
  const x = entry[0] ?? " ";
  const y = entry[1] ?? " ";
  if (isUnmergedStatus(x, y)) {
    return null;
  }
  const worktreeGone = y === "D" || (x === "D" && y === " ");
  if (!worktreeGone) {
    return { deleted: false, path: entry.slice(STATUS_PATH_OFFSET) };
  }
  // X `A` on a gone-worktree record (`AD`): new in the index, so absent from
  // HEAD and from the worktree — nothing to stage, nothing to remove.
  if (x === "A") {
    return null;
  }
  return { deleted: true, path: entry.slice(STATUS_PATH_OFFSET) };
};

/**
 * Parse `git status --porcelain=v1 -z --untracked-files=all` output into the
 * changed-file list, plus the unmerged (conflicted) paths. The `-z` form is
 * NUL-delimited and quoting-free, so paths with spaces / unicode / renames
 * are handled without unescaping. Renames (`R`) and copies (`C`) emit two NUL
 * fields (new\0old): a rename stages the source as deleted, a copy leaves its
 * source INTACT (the field is consumed, nothing staged — misparsing it as a
 * `XY␠path` record of its own would stage a bogus tree entry at a garbage
 * path, e.g. `src.ts` → `.ts`, and fail the whole commit). Unmerged records
 * are reported, never staged — `git commit` refuses them and so does this
 * flow.
 */
export const parseStatusZ = (
  output: string
): { readonly changed: ChangedFile[]; readonly unmerged: string[] } => {
  // Keyed by path: git's index holds exactly ONE entry per path, so a
  // worktree can produce TWO porcelain records for the same path — a staged
  // deletion (`D <path>` from `git rm --cached`) plus an untracked worktree
  // copy (`?? <path>` re-created on disk) — where `git add -A` stages exactly
  // one entry: the new blob. Staging both as separate tree entries sends the
  // Git-Data API a duplicate-path array, which the tree contract does not
  // define (entries overwrite base-tree items BY path); the LAST record for a
  // path must win, exactly like the index `git add -A` writes. A Map keyed on
  // the record ORDER git emits preserves the last-write-wins collapse while
  // keeping unrelated paths in their porcelain order.
  const files = new Map<string, ChangedFile>();
  const unmerged: string[] = [];
  // Records are `XY␠path` joined by NUL; a rename/copy adds a trailing NUL +
  // the source path.
  const fields = output.split("\0");
  let i = 0;
  while (i < fields.length) {
    const entry = fields[i];
    if (entry === undefined || entry === "") {
      i += 1;
      continue;
    }
    const x = entry[0] ?? " ";
    const y = entry[1] ?? " ";
    const isTwoField = TWO_FIELD_STATUS.has(x) || TWO_FIELD_STATUS.has(y);
    if (isTwoField) {
      // The next field is the source path. A RENAME's source is gone from the
      // tree (stage its deletion); a COPY's source is untouched (consume the
      // field, stage nothing). An absent/empty source field is tolerated
      // rather than staged as a bogus path.
      const sourcePath = fields[i + 1];
      const isRename = x === "R" || y === "R";
      // `RD` renames the path in the index and then deletes the worktree copy,
      // so the destination is gone from disk — `git add -A` stages its deletion
      // (staging it as an add would read a file that no longer exists and fail
      // the whole run). The source deletion below still applies: the rename's
      // origin is gone from the tree either way.
      const destinationDeleted = isDeletedDestination(x, y);
      if (
        isRename &&
        sourcePath !== undefined &&
        sourcePath !== "" &&
        // Same directory guard as the one-field records: a source path that
        // names a directory is not a blob removal.
        !isDirectoryPath(sourcePath)
      ) {
        files.set(sourcePath, {
          path: sourcePath,
          deleted: true,
        });
      }
      files.set(entry.slice(STATUS_PATH_OFFSET), {
        path: entry.slice(STATUS_PATH_OFFSET),
        deleted: destinationDeleted,
      });
      i += TWO_FIELD_STRIDE;
      continue;
    }
    // `null` from `parseStatusEntry` is ambiguous between UNMERGED (refuse)
    // and SKIP (`AD`: nothing to stage) — recheck the record to decide.
    //
    // A directory record (`?? dir/` — the only shape git abbreviates: it
    // never descends into a dir holding a nested git repo, even with
    // `--untracked-files=all`) is KEPT, slash-stripped, exactly like `git add
    // -A` stages it: the flow's directory→gitlink branch turns it into a
    // `160000` commit entry pointing at the nested repo's HEAD. A plain
    // untracked dir never appears here — `-uall` flattens those into per-file
    // records — so the only records reaching the gitlink branch are the
    // nested-repo ones git itself would stage as a gitlink.
    const parsed = parseStatusEntry(entry);
    if (parsed === null) {
      if (isUnmergedStatus(entry[0] ?? " ", entry[1] ?? " ")) {
        unmerged.push(entry.slice(STATUS_PATH_OFFSET));
      }
    } else {
      const path = isDirectoryPath(parsed.path)
        ? stripTrailingSlashes(parsed.path)
        : parsed.path;
      files.set(path, {
        ...parsed,
        path,
      });
    }
    i += 1;
  }
  return {
    changed: Array.from(files.values()),
    unmerged,
  };
};

// #endregion

// #region GitHub API helpers

export interface GhJsonInput {
  readonly fetchImpl: FetchLike;
  /**
   * Bearer token for the call. Absent → the request goes bare: in ambient
   * mode (`GH_APP_ID` unset) the host's egress proxy attaches the workspace
   * credential to `api.github.com` requests itself, and an App token cannot
   * be minted at all — the same ambient REST discipline the feature prompt
   * teaches. Every App-mode caller still passes one.
   */
  readonly token?: string;
  readonly method: "GET" | "POST" | "PATCH";
  readonly url: string;
  readonly body?: unknown;
}

/**
 * GitHub's error envelope, returned on every non-2xx REST response. `message`
 * is `optional` so a body that lacks it (or is not an object at all) degrades
 * to the HTTP status rather than failing: the call has already failed, and a
 * schema complaint here would replace GitHub's own explanation of why.
 */
const GitHubErrorBody = Schema.Struct({
  message: Schema.optional(Schema.String),
});

/** GitHub's non-2xx `message`, falling back to the status when the body is not the envelope. */
const githubErrorDetail = (payload: unknown, status: number): string => {
  const decoded = Schema.decodeUnknownOption(GitHubErrorBody)(payload);
  const message = Option.isSome(decoded) ? decoded.value.message : undefined;
  return message ?? `HTTP ${status}`;
};

/**
 * One JSON GitHub API call as an Effect, decoded against `schema`. Non-2xx →
 * typed `http` CommitApiError carrying GitHub's own message; a 2xx body that
 * does not match `schema` → typed `parse` CommitApiError naming the field.
 *
 * The schema is per call site rather than a shared `Record<string, unknown>`,
 * so each response is checked once here instead of being re-inspected key by
 * key by whoever consumes it.
 */
export const ghJson = <S extends Schema.Top>(
  input: GhJsonInput & { readonly schema: S }
): Effect.Effect<S["Type"], CommitApiError, S["DecodingServices"]> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        input.fetchImpl(input.url, {
          method: input.method,
          headers: {
            Accept: "application/vnd.github+json",
            // Absent token → bare request: the ambient credential path (the
            // host's proxy attaches it), never an empty Authorization header
            // (GitHub answers 400 for one).
            ...(input.token === undefined
              ? {}
              : { Authorization: `Bearer ${input.token}` }),
            "X-GitHub-Api-Version": "2022-11-28",
            ...(input.body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
          },
          ...(input.body === undefined
            ? {}
            : { body: JSON.stringify(input.body) }),
        }),
      catch: (cause) =>
        new CommitApiError({
          stage: "http",
          message: `${input.method} ${input.url} request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
    }).pipe(
      // Bound the wait: a fetch that never settles is a failed call, not a
      // slow one — see COMMIT_HTTP_TIMEOUT_MS. Applies to every Git-Data-API
      // call of the commit flow AND the sweep's PR-lookup pages (which add
      // their own tighter deadline on top).
      Effect.timeoutOrElse({
        duration: COMMIT_HTTP_TIMEOUT_MS,
        orElse: () =>
          new CommitApiError({
            stage: "http",
            message: `${input.method} ${input.url} did not answer within ${COMMIT_HTTP_TIMEOUT_MS / 1000}s`,
          }),
      })
    );

    // Read the body as JSON up front, degrading to `null` when it is not JSON
    // at all (an HTML error page, a 0-byte body). A non-2xx must be explained
    // by its own envelope or degrade to the HTTP status — never fail as a
    // "response was not JSON" complaint, which both mislabels the failure and
    // drops the status a caller may match on (and hides the actual 502/404).
    // The read is bounded by the SAME deadline as the fetch: a server that
    // sends headers and then stalls the body leaves `response.json()` pending
    // forever — the exact wedge the fetch deadline exists to close, reopened
    // through the body read, so it must fail into the same `http` channel
    // rather than hang the commit flow (or a sweep's PR lookup) indefinitely.
    // (`Effect.promise`, not `tryPromise`: the `.catch(() => null)` already
    // keeps the promise settling, so its only failure mode is the timeout.)
    const parsed: unknown = yield* Effect.promise(() =>
      response.json().catch(() => null)
    ).pipe(
      Effect.timeoutOrElse({
        duration: COMMIT_HTTP_TIMEOUT_MS,
        orElse: () =>
          new CommitApiError({
            stage: "http",
            message: `${input.method} ${input.url} response body did not arrive within ${COMMIT_HTTP_TIMEOUT_MS / 1000}s`,
          }),
      })
    );

    if (!response.ok) {
      return yield* new CommitApiError({
        stage: "http",
        status: response.status,
        message: `${input.method} ${input.url}: ${githubErrorDetail(parsed, response.status)}`,
      });
    }

    if (parsed === null) {
      return yield* new CommitApiError({
        stage: "parse",
        message: `${input.method} ${input.url}: response was not JSON`,
      });
    }

    return yield* Schema.decodeUnknownEffect(input.schema, { errors: "all" })(
      parsed
    ).pipe(
      Effect.mapError(
        (error) =>
          new CommitApiError({
            stage: "parse",
            message: `${input.method} ${input.url}: response did not match the expected shape: ${error.message}`,
          })
      )
    );
  });

// #endregion
