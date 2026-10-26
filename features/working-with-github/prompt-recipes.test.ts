import { describe, expect, test } from "bun:test";
// The prompt's recipes are copy-paste shell: a doc contract this suite pins.
// `gh --repo`, the `repos/…` Git-Data/GitHub-API paths, and the `github.com`
// git-fetch URL all take bare `owner/repo` — but `GITHUB_REPO` is set from
// service env and every sibling resolver tolerates URL spellings
// (`https://github.com/o/r`, a `.git` suffix, a trailing slash) for it. A
// recipe that interpolates the RAW env var produces, for those spellings,
// `gh --repo https://…` (gh rejects the URL form), `repos/https://…` (404),
// and `github.com/https://…` (no such remote) — so every recipe must
// interpolate the normalized `$REPO` the prompt derives once per shell.
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const promptPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "prompt.md"
);
const prompt = readFileSync(promptPath, "utf-8");

/** Every fenced bash block in the prompt (indented list fences included). */
const fences: readonly string[] = [
  ...prompt.matchAll(/```bash[^\n]*\n([\s\S]*?)```/g),
].map((match) => match[1] ?? "");

/**
 * The one line allowed to mention the raw env var: the normalization
 * definition itself (`REPO=$(printf '%s' "$GITHUB_REPO" | sed -E …)`), whose
 * output every recipe interpolates.
 */
const isNormalizerLine = (line: string): boolean =>
  line.trimStart().startsWith(`REPO=$(printf '%s' "$GITHUB_REPO"`);

/** The spellings every sibling resolver tolerates for `GITHUB_REPO`. */
const SPELLINGS: readonly { readonly raw: string; readonly normalized: string }[] =
  [
    { normalized: "acme/widgets", raw: "acme/widgets" },
    { normalized: "acme/widgets", raw: "https://github.com/acme/widgets" },
    {
      normalized: "acme/widgets",
      raw: "https://github.com/acme/widgets.git",
    },
    {
      normalized: "acme/widgets",
      raw: "git@github.com:acme/widgets.git",
    },
    { normalized: "acme/widgets", raw: "acme/widgets/" },
    // A deep GitHub URL — a copied blob/tree/PR/releases address — is a
    // spelling every sibling resolver in this feature tolerates (#159's own
    // corpus), so the prompt's normalization recipe must collapse it to
    // owner/repo too: the raw output `acme/widgets/tree/main` breaks
    // `gh --repo` (no such repo), the `repos/…` API routes (404), and the
    // github.com fetch URL, exactly the way the two-segment URL spelling
    // did before the recipe normalized it.
    {
      normalized: "acme/widgets",
      raw: "https://github.com/acme/widgets/tree/main",
    },
    {
      normalized: "acme/widgets",
      raw: "https://github.com/acme/widgets/pull/42",
    },
    // A HOSTLESS deep paste — bare `owner/repo/<tail>`, the URL path of a
    // copied blob/tree/PR/releases address pasted without the host — is the
    // same spelling every sibling resolver tolerates (repo-string-hostless-
    // deep.test.ts pins the code side): pre-fix the recipe returned it
    // whole while `resolveRepoFromEnv` collapsed it, so the recipe and the
    // code silently disagreed — one spelling contract, four resolvers.
    { normalized: "acme/widgets", raw: "acme/widgets/tree/main" },
    { normalized: "acme/widgets", raw: "acme/widgets/pull/42" },
    { normalized: "o/r", raw: "o/r/tree/main" },
    // Leading/trailing whitespace padding (a copy-paste with a stray space)
    // trims in every code resolver; the recipe must agree.
    { normalized: "acme/widgets", raw: " acme/widgets " },
    // A LEADING slash — `/acme/widgets` (a shell-autocomplete paste) — is a
    // spelling every code resolver strips (`resolveRepoFromEnv`,
    // `resolveConfigDirName` both strip `/+` before their repo branches), so
    // the recipe must agree: pre-fix its trailing `s#^/##` stripped ONE
    // slash but the deep-collapse rule above it anchors `^` and ran first,
    // so a doubled leading slash (`//acme/widgets`, and the deep form
    // `//acme/widgets/tree/main`) fell every branch and interpolated as
    // `/acme/widgets` — `gh --repo /acme/widgets` and
    // `repos//acme/widgets` (a doubled-slash route GitHub 404s), the same
    // silent-dead-value class the recipe's other branches close.
    { normalized: "acme/widgets", raw: "/acme/widgets" },
    { normalized: "acme/widgets", raw: "//acme/widgets" },
    { normalized: "acme/widgets", raw: "///acme/widgets" },
    { normalized: "acme/widgets", raw: "//acme/widgets/tree/main" },
    // The ORGANIZATIONS-page spellings — `github.com/orgs/<org>` (the "Your
    // organizations" page) and `/organizations/<org>` — are a spelling every
    // sibling resolver tolerates (#169/#175/#177 fixed them in `orgOf`,
    // `resolveRepoFromEnv`, `resolveAllowedOrgs` and `resolveConfigDirName`),
    // so the prompt's normalization recipe must collapse them to the org too:
    // pre-fix the recipe's two-segment rule matched the host-stripped
    // `orgs/acme` as a fake `owner/repo` pair — an owner login no GitHub
    // route answers (orgs/organizations are reserved host paths), so every
    // recipe that interpolated it (`gh --repo orgs/acme`, `repos/orgs/acme`,
    // the fetch URL, and the SLUG dir the worktree sweep then looked under)
    // silently targeted a nonexistent repo. The resolvers resolve these to
    // the ORG; the recipe must agree with them.
    { normalized: "acme", raw: "https://github.com/orgs/acme" },
    {
      normalized: "acme",
      raw: "https://github.com/organizations/acme",
    },
    { normalized: "acme", raw: "https://github.com/orgs/acme/teams" },
    { normalized: "acme", raw: "git@github.com:orgs/acme" },
    // The ORGANIZATIONS-page INDEX spelling — `github.com/orgs` with NO org
    // segment after it (the page that LISTS your organizations) — is the one
    // spelling that must normalize to NOTHING: `orgs`/`organizations` are
    // reserved host paths, never an owner login (verified live: no GitHub
    // account holds either exact login), so #203 taught the sibling resolvers
    // (`orgOf`, `resolveRepoFromEnv`, `resolveAllowedOrgs`,
    // `resolveConfigDirName`) to resolve it to no owner at all. The recipe
    // must agree: pre-fix it emitted the bare reserved word as `$REPO`, so
    // every interpolation 404'd a repo named after a host path
    // (`gh --repo orgs`, `repos/orgs`) — the same silent-dead-value class the
    // resolvers' fix closed, in the recipe. An empty `$REPO` makes every
    // interpolation fail loudly (gh errors on an empty --repo) instead.
    { normalized: "", raw: "https://github.com/orgs" },
    { normalized: "", raw: "https://github.com/organizations" },
    { normalized: "", raw: "github.com/orgs" },
    { normalized: "", raw: "git@github.com:organizations" },
    { normalized: "", raw: "ssh://git@github.com:22/orgs" },
    { normalized: "", raw: "https://github.com:443/organizations" },
    // A trailing slash on the INDEX spelling is the same page (the resolver
    // trims trailing slashes before its index branch — the recipe's own
    // leading trim mirrors it).
    { normalized: "", raw: "https://github.com/orgs/" },
    // An ssh URL with an explicit PORT — `ssh://git@github.com:22/…` (a
    // `git remote -v` copy-paste) — is a spelling every sibling resolver in
    // this feature has tolerated since the port group landed (#186's own
    // corpus, pinned by repo-string-port.test.ts), so the prompt's
    // normalization recipe must collapse it too: pre-fix the recipe's
    // scheme group only matched `https?://`, so a ported ssh URL left its
    // `ssh://` prefix behind (`ssh://22/acme/widgets`) — a string that breaks
    // `gh --repo`, the `repos/…` API routes, and the github.com fetch URL
    // exactly the way the deep and orgs-page spellings did before their
    // branches. The colon-host port forms (`git@github.com:29418/…`,
    // `github.com:29418/…`) are the same spelling through the scp form.
    {
      normalized: "acme/widgets",
      raw: "ssh://git@github.com:22/acme/widgets",
    },
    {
      normalized: "acme/widgets",
      raw: "ssh://git@github.com:2222/acme/widgets.git",
    },
    {
      normalized: "acme/widgets",
      raw: "git@github.com:29418/acme/widgets",
    },
    {
      normalized: "acme/widgets",
      raw: "github.com:29418/acme/widgets",
    },
    {
      normalized: "acme/widgets",
      raw: "https://github.com:443/acme/widgets",
    },
    // An scp/ssh USER-INFO word other than the literal `git` —
    // `ssh://deploy@github.com/acme/widgets`, `bob@github.com:22/acme/widgets`
    // (a deploy-key or CI remote form `git remote -v` produces) — is a
    // spelling every code resolver tolerates (repo-string-userinfo.test.ts
    // pins the code side): pre-fix the recipe's `(git@)?` groups only
    // matched the literal user word, so the host-strip rules left it behind
    // (`ssh://deploy@acme/widgets`, `bob@acme/widgets`) — a `$REPO` value
    // `gh --repo` rejects, every `repos/…` route 404s, and the github.com
    // fetch URL never resolves, exactly the way the ported ssh form left
    // its `ssh://` prefix behind before its scheme group grew. The recipe's
    // user-info groups now match any user word, like the resolvers.
    {
      normalized: "acme/widgets",
      raw: "ssh://deploy@github.com/acme/widgets",
    },
    {
      normalized: "acme/widgets",
      raw: "bob@github.com:22/acme/widgets",
    },
    {
      normalized: "acme/widgets",
      raw: "deploy@github.com:29418/acme/widgets.git",
    },
    // A bare host+PORT spelling — `github.com:22`, `ssh://git@github.com:22`
    // (a truncated `git remote -v` copy-paste) — is a spelling every sibling
    // resolver tolerates (#190's own corpus), so the recipe must agree with
    // them: pre-fix its port rule consumed the trailing `[/:]` at the colon
    // INSIDE the port, leaving the PORT DIGITS as `$REPO` (`22`) while every
    // code resolver passes the host word through — and `gh --repo 22` /
    // `repos/22` silently target a repo no route answers.
    { normalized: "github.com", raw: "github.com:22" },
    { normalized: "git@github.com", raw: "git@github.com:22" },
    { normalized: "ssh://git@github.com", raw: "ssh://git@github.com:22" },
    { normalized: "https://github.com", raw: "https://github.com:443" },
    // A HOST-CASE spelling — `https://GitHub.com/acme/widgets`, a copy-paste
    // whose host kept the address bar's capitalization (also `git@GitHub.com:…`,
    // an upper-case SCHEME `HTTPS://…`) — is the same URL: hosts and schemes
    // are case-insensitive (RFC 3986 §3.1, §3.2.2) and every real client
    // accepts them, so the recipe must collapse them exactly like the
    // lowercase spellings above. Pre-fix every anchored `github.com` rule in
    // the recipe matched lowercase only, so the mixed-case host fell every
    // branch and the RAW URL flowed on as `$REPO` — `gh --repo https://…`,
    // `repos/https://…` (404), a SLUG dir the sweep never lists — the same
    // silent-dead-value class the resolvers' host-case fix closes, in the
    // recipe.
    {
      normalized: "acme/widgets",
      raw: "https://GitHub.com/acme/widgets",
    },
    {
      normalized: "acme/widgets",
      raw: "git@GitHub.com:acme/widgets",
    },
    {
      normalized: "acme/widgets",
      raw: "GitHub.com:22/acme/widgets",
    },
    // The orgs-page spellings under a mixed-case host resolve to the org (or
    // nothing, for the INDEX form) exactly like their lowercase spellings.
    { normalized: "acme", raw: "https://GitHub.com/orgs/acme" },
    { normalized: "", raw: "https://GitHub.com/orgs" },
    // An upper-case SCHEME alone (`HTTPS://github.com/…`) is the same class.
    {
      normalized: "acme/widgets",
      raw: "HTTPS://GitHub.com/acme/widgets",
    },
    // An INTERIOR doubled slash — `github.com//o/r`, `o//r`, or a doubled
    // segment separator like `https://github.com/o//r` (a copy-paste that
    // kept a doubled path slash) — is the same paste class as the trailing
    // slash and the doubled LEADING slash above, and every code resolver
    // collapses it (repo-string-interior-slashes.test.ts pins the code
    // side): pre-fix the recipe's anchored rules keyed on non-empty path
    // segments and left the double whole, so `$REPO` interpolated a string
    // no route answers (`gh --repo /o/r`, `repos//o/r`) while the code
    // resolvers collapsed it — one spelling contract, four resolvers.
    { normalized: "acme/widgets", raw: "https://github.com//acme/widgets" },
    { normalized: "acme/widgets", raw: "github.com//acme/widgets" },
    { normalized: "acme/widgets", raw: "https://github.com/acme//widgets" },
    { normalized: "acme/widgets", raw: "acme//widgets" },
    { normalized: "acme/widgets", raw: "git@github.com://acme/widgets" },
    {
      normalized: "acme/widgets",
      raw: "ssh://git@github.com:22//acme/widgets",
    },
  ];

describe("prompt.md recipes interpolate the normalized $REPO, never the raw $GITHUB_REPO", () => {
  test("no bash fence interpolates $GITHUB_REPO outside the normalization definition", () => {
    const offenders: string[] = [];
    for (const fence of fences) {
      for (const line of fence.split("\n")) {
        const trimmed = line.trim();
        // Comments are prose, not commands — the invariant is about what runs.
        if (trimmed.startsWith("#")) {
          continue;
        }
        if (/\$\{?GITHUB_REPO\}?/u.test(line) && !isNormalizerLine(line)) {
          offenders.push(trimmed);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the three URL-bearing recipe forms never carry the raw env var", () => {
    // These exact pre-fix literals are the breakage: `gh --repo` rejects the
    // URL form, `/repos/https://…` is not a GitHub API route (404), and
    // `github.com/https://…` cannot resolve as a fetch remote.
    expect(prompt).not.toContain('--repo "$GITHUB_REPO"');
    expect(prompt).not.toContain("repos/${GITHUB_REPO}");
    expect(prompt).not.toContain("github.com/${GITHUB_REPO}");
  });

  test("the normalization recipe itself normalizes every tolerated spelling", () => {
    const line = fences
      .flatMap((fence) => fence.split("\n"))
      .find((candidate) => isNormalizerLine(candidate))
      ?.trim();
    expect(line).toBeDefined();
    if (line === undefined) {
      return;
    }
    for (const spelling of SPELLINGS) {
      const output = execFileSync(
        "bash",
        ["-c", `${line}\nprintf '%s' "$REPO"`],
        {
          encoding: "utf-8",
          env: { ...process.env, GITHUB_REPO: spelling.raw },
        }
      );
      expect(output).toBe(spelling.normalized);
    }
  });
});

describe("prompt.md's WWG resolution recipe prefers the workspace's real source over the .bun store copy", () => {
  // The recipe is copy-paste shell run from the workspace root; this suite
  // executes it against faithful layouts, the same discipline the
  // readme-sync-recipe suite pins the README's `diff -rq` with.
  const recipeOf = (): string => {
    const fence = fences.find((candidate) =>
      candidate.includes("WWG=$(find")
    );
    if (fence === undefined) {
      throw new Error("prompt.md carries no WWG=$(find …) recipe");
    }
    // The recipe statement: from `WWG=$(find` through its closing `)`.
    const start = fence.indexOf("WWG=$(find");
    const rest = fence.slice(start);
    let open = 0;
    let end = -1;
    for (let i = 0; i < rest.length; i += 1) {
      const ch = rest[i];
      if (ch === undefined) {
        break;
      }
      if (ch === "(") {
        open += 1;
      } else if (ch === ")") {
        open -= 1;
        if (open === 0) {
          end = i + 1;
          break;
        }
      }
    }
    if (end === -1) {
      throw new Error("the WWG recipe statement never closes its $()");
    }
    return rest.slice(0, end).replace(/\\\n/gu, " ");
  };

  const runRecipe = (cwd: string): string =>
    // The assignment stands on its own line in real use; find's exit status
    // (a missing starting point makes it non-zero) never gates the capture.
    execFileSync("bash", ["-c", `cd '${cwd}' && { ${recipeOf()}; printf '%s' "$WWG"; }`], {
      encoding: "utf-8",
    });

  test("a vendored workspace resolves to the vendored source tree, not the store symlink", () => {
    // The composed-intern layout this workspace itself runs: the only
    // working-with-github on disk lives under vendor/…/features, while
    // node_modules/@ori-monorepo/working-with-github is a symlink INTO
    // node_modules/.bun/… — a store copy that silently diverges from the
    // vendored tree until a root bun install re-syncs it.
    const root = mkdtempSync(join(tmpdir(), "wwg-recipe-vendored-"));
    try {
      // The real composed-intern workspace carries all four starting points.
      mkdirSync(join(root, "features"), { recursive: true });
      mkdirSync(join(root, ".ori/remote-features"), { recursive: true });
      mkdirSync(join(root, "vendor/ori-feature-catalog/features/working-with-github"), {
        recursive: true,
      });
      mkdirSync(join(root, "node_modules/@ori-monorepo"), { recursive: true });
      mkdirSync(
        join(root, "node_modules/.bun/wwg@file/store/node_modules/@ori-monorepo/working-with-github"),
        { recursive: true }
      );
      symlinkSync(
        "../.bun/wwg@file/store/node_modules/@ori-monorepo/working-with-github",
        join(root, "node_modules/@ori-monorepo/working-with-github")
      );
      expect(runRecipe(root)).toBe(
        "vendor/ori-feature-catalog/features/working-with-github"
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a plain features/ layout keeps resolving its own feature directory", () => {
    const root = mkdtempSync(join(tmpdir(), "wwg-recipe-plain-"));
    try {
      mkdirSync(join(root, ".ori/remote-features"), { recursive: true });
      mkdirSync(join(root, "vendor"), { recursive: true });
      mkdirSync(join(root, "node_modules"), { recursive: true });
      mkdirSync(join(root, "features/working-with-github"), { recursive: true });
      expect(runRecipe(root)).toBe("features/working-with-github");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the remote-features cache outranks the installed package", () => {
    const root = mkdtempSync(join(tmpdir(), "wwg-recipe-remote-"));
    try {
      mkdirSync(join(root, "features"), { recursive: true });
      mkdirSync(join(root, "vendor"), { recursive: true });
      mkdirSync(join(root, ".ori/remote-features/cache/working-with-github"), {
        recursive: true,
      });
      mkdirSync(join(root, "node_modules/@ori-monorepo/working-with-github"), {
        recursive: true,
      });
      expect(runRecipe(root)).toBe(
        ".ori/remote-features/cache/working-with-github"
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
