# ori-feature-catalog

A public catalog of [ori](https://openrouter.ai/ori) features that any intern can load
remotely. Each directory under `features/` is one self-contained feature.

This is a catalog, not a feature set: it is the list you pick *from*. The features an
individual intern actually runs — its own `features/` directory — are that intern's
feature set.

## Use the catalog

Point `--features` at the **repo root**, not at an individual feature:

```sh
ori dev --features github.com/OpenRouterLabs/ori-feature-catalog
```

`--features` takes a *features root*, and a bare repo root resolves to its nested
`features/`. Normalization descends one level only, so pointing at
`.../ori-feature-catalog/features/slack` would treat that directory as the root and
enumerate `src` and `skills` as features — not `slack`.

Pin a tag or commit SHA with `@<ref>`; omit it to track the default branch:

```sh
ori dev --features github.com/OpenRouterLabs/ori-feature-catalog@v1.0.0
```

Ori fetches the tree over HTTPS, caches it under `.ori/remote-features/`, and runs
`bun install` in the cache entry so each feature's own dependencies resolve.

Because the root resolves to `features/`, this loads **every** feature in the catalog.
There is no per-feature selection today.

## Keep your own features too

A single `--features <remote>` **replaces** the workspace's local features root rather
than composing with it, so your own `features/` will not load.

To run the catalog alongside your own features, declare it in `ori.md` instead. Declared
sources compose in the order `[declared…, local, …--features flags]`, and a later source
wins on a duplicate feature id. Your workspace's own root is appended after the declared
ones, so a local `features/<id>` shadows a catalog feature of the same id — which is how
you fork anything here: create a directory with the same name.

## Features

- **[slack](features/slack)** — Slack chat surface. Bolt Events API bridge, threaded
  replies, a typing indicator driven by tool calls, and seven skills (`slack-api`,
  `slack-ask`, `slack-chart`, `slack-image`, `slack-questions`, `slack-status`,
  `spawn-thread`). Requires `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET`.

## Develop

```sh
bun install
bun test
```

`bun run typecheck` needs the ori SDK present. `ori` is an optional `file:.ori/sdk`
dependency and `.ori/` is git-ignored, so run `ori init .` first — without it tsc reports
`Cannot find module 'ori'` plus a cascade of implicit-any errors from the same cause.

## Add a feature

1. Create `features/<id>/` with a `package.json` and a `feature.ts` default export.
2. Keep it self-contained — no imports from sibling features or from the repo root.
3. Declare every runtime dependency in the feature's own `package.json`.
4. Document required environment variables in the feature's `README.md`.
