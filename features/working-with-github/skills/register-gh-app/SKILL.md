---
name: register-gh-app
description: >
  Register which env-var NAMES hold a GitHub App's credentials for an (org, purpose) pair, so mint-token.ts (with --repo or --org, and an optional --purpose) can mint from a NON-default App. TRIGGER when you need to act as a GitHub App other than the default one and it is not registered yet — e.g. a repo in another org the default GH_APP_* App is not installed on ("I get a 404 / Not Found hitting acme-corp/…", "mint a token for a repo in another org"), or a distinct role in your own org (a reviewer App that only comments vs. a maintainer App that approves/merges). Also TRIGGER to inspect what is registered ("which GitHub Apps are registered", "list the app registry"). The one-time setup — register the App (records env-var key names, never secret values), then mint against it with mint-token.ts --repo <owner/repo> (or --org <org>) [--purpose <role>] (routing covered in the feature prompt). DO NOT TRIGGER for ordinary GitHub work under the default App — plain mint-token.ts with no flags already covers that; only reach here when a DIFFERENT App is needed and missing from the registry.
---

# Registering an additional GitHub App

The default App (`GH_APP_ID` / `GH_APP_PRIVATE_KEY`) only reaches the repos it is installed on, and mints under one identity. To act as a **different** App — another org's repos, or a distinct role in your own org — register it once here, then route mints to it by `(org, purpose)`. Everyday minting under the default App needs none of this; see the feature prompt for the `mint-token.ts` basics.

## The model — (org, purpose) → env-var key NAMES

The registry lives in a small SQLite DB in the intern's config dir (beside the other stores); the mapping is one table in it (`mint-token.ts` keeps a separate installation-id cache table in the same DB). Each registry row maps an **(org, purpose)** pair to the **names of the two env vars** that hold that App's credentials — an app-id key and a private-key key. It stores **only the key names, never the secret values**: the values stay in the service env, injected by Ori, and are read at mint time. `purpose` is a free-form role label (`reviewer`, `maintainer`, `read`, …); it defaults to `default`, the org-level catch-all.

## Register an App

```bash
# Record which env vars hold the App for (org, purpose). --purpose defaults to "default".
bun "$WWG"/scripts/register-gh-app.ts register \
  --org acme-corp --purpose reviewer \
  --app-id-key TEAM_GH_APP_ID --private-key-key TEAM_GH_APP_PRIVATE_KEY
```

- `--org` is the GitHub org/owner the App covers (matched case-insensitively; a repo's org is derived from `owner/repo` at mint time).
- `--app-id-key` / `--private-key-key` are the **names** of env vars Ori injected — NOT the values. Use whatever names the service env actually defines (e.g. `TEAM_GH_APP_ID`).
- `register` validates those env vars are actually set before saving (a typo fails loudly), and never prints their values. It refuses if a named var is missing or empty.

## Inspect what's registered

```bash
bun "$WWG"/scripts/register-gh-app.ts list
```

Prints one line per row — **org + purpose + key names only, never secrets**. With nothing registered it says so (the bare default `GH_APP_*` is used everywhere).

## After registering — mint against it

Registration only records the mapping. To actually use the App, mint with the target repo (or `--org`) and the purpose, exactly as the feature prompt describes:

```bash
GH_TOKEN=$(bun "$WWG"/scripts/mint-token.ts \
  --repo acme-corp/widgets --purpose reviewer) \
  gh pr view 123 --repo acme-corp/widgets
```

Resolution falls back `(org, purpose)` → `(org, "default")` → the bare `GH_APP_*` default. This is a **routing** fallback (which App's credentials are used), not a guarantee the mint succeeds: if the chosen App isn't installed on the target org, installation discovery still fails with a 404 — that's the signal to register an App that _is_ installed there. A registered App carries no pinned installation id; the mint path discovers the installation for the org automatically.

## Rules

- **Never pass secret values on the command line.** You register key _names_; Ori owns the values. If the App you need has no env vars injected yet, that is a service-env change for an admin — surface it, do not hardcode a key.
- All the token-handling rules from the feature prompt still apply (inject as `GH_TOKEN`, never persist, never `gh auth login`). The only difference is _which_ App the ephemeral token comes from.
