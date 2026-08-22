# ori-feature-catalog

A public catalog of [ori](https://github.com/OpenRouterIncubator/ori) features that any
intern can load remotely. Each directory under `features/` is one self-contained feature.

This is a catalog, not a feature set: it is the list you pick *from*. The features an
individual intern actually runs — its own `features/` directory — are that intern's
feature set.

## Use a feature

Add the catalog to your intern's `ori.md`, or pass it on the command line:

```sh
ori dev --features github.com/OpenRouterLabs/ori-feature-catalog/features/slack
```

The grammar is `<host>/<owner>/<repo>[/<path>][@<ref>]`. Omit `@<ref>` to track the
default branch; pin a tag or commit SHA for a fixed version:

```sh
ori dev --features github.com/OpenRouterLabs/ori-feature-catalog/features/slack@v1.0.0
```

Ori fetches the tree over HTTPS, caches it under `.ori/remote-features/`, and runs
`bun install` in the cache entry so each feature's own dependencies resolve.

A local `features/<id>` in your workspace shadows a remote feature with the same id, so
you can fork anything here by simply creating a directory of the same name.

## Features

- **[slack](features/slack)** — Slack chat surface. Bolt Events API bridge, threaded
  replies, a typing indicator driven by tool calls, and seven skills (`slack-api`,
  `slack-ask`, `slack-chart`, `slack-image`, `slack-questions`, `slack-status`,
  `spawn-thread`). Requires `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET`.

## Add a feature

1. Create `features/<id>/` with a `package.json` and a `feature.ts` default export.
2. Keep it self-contained — no imports from sibling features or from the repo root.
3. Declare every runtime dependency in the feature's own `package.json`.
4. Document required environment variables in the feature's `README.md`.
