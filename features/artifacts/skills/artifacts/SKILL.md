---
name: artifacts
description: Turn work into a web page saved in the workspace and reply with its link. Use when a comparison, a report, a dashboard, a walkthrough of a change or a set of options to choose between would read better as a page than as a chat message, or when someone asks for a page, a chart, a visual, a report "as a page" or an HTML file. Saves with `artifact save`, which prints a dashboard link only people who can see this intern can open. Not for a short answer, and not for attaching a file to Slack.
---

# Artifacts

A page is one HTML file saved in this workspace under `artifacts/<name>/`. Save it with `artifact save` and reply with the link it prints. On a hosted intern that link opens the page in the dashboard for anyone who can see this intern, and nobody else. On a laptop it is the saved file's path.

## When a page is worth it

Make a page when the visual form carries something text cannot:

- a comparison across several options or vendors
- a report with charts or tables
- a dashboard of numbers someone will read more than once
- a walkthrough of a change, step by step
- a set of options for someone to choose between

A styled page costs more output than the same content as text, and every version stays in the workspace's backup. When a sentence, a short list or one table answers the question, reply in chat instead.

## Rules for the page

1. **One file.** Styles, scripts, fonts and images all live inside the HTML. A relative address such as `chart.png` or `./app.js` is refused, because a saved page has no files beside it. Put a small image in as a `data:` URI.
2. **Libraries and fonts only from these CDNs:** `cdnjs.cloudflare.com`, `cdn.jsdelivr.net`, `unpkg.com`, `fonts.googleapis.com` and `fonts.gstatic.com`. Saving downloads them and puts them inside the page. Any other address in a `<script src>`, `<link href>`, `<img src>`, CSS `url()` or `@import` is refused with that address. Links people click (`<a href>`) can go anywhere.
3. **Classic scripts, not module imports.** Load a library's UMD or `.min.js` build with `<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>`. A `<script type="module">` that imports from a URL is refused. Put scripts that touch the page at the end of `<body>`; a `defer` script still runs after the page once it is inside it.
4. **No frames and no live data.** The page cannot fetch, open windows or embed other pages when someone opens it; saving writes that block into the page itself. Put the data in the page as it was when you saved it.
5. **Readable on a phone.** Add `<meta name="viewport" content="width=device-width, initial-scale=1">`, let content wrap, and keep wide tables scrollable inside their own container.
6. **Light and dark themes.** Define colours as CSS variables and switch them with `@media (prefers-color-scheme: dark)`.
7. **Real numbers, shown as numbers.** Use the values you measured or were given, with units, and right-align numeric table columns. Never invent data to fill a chart.
8. **At most 16 MiB** after the CDN files are inside it.

## Save and reply

Run it from the workspace through the harness command surface:

```bash
artifact save /tmp/vendor-comparison.html \
  --name vendor-comparison --title "Vendor comparison"
```

It prints the link on stdout. Reply with that link and one or two sentences on what the page shows.

- **Changing the page:** edit the file and save again with the same `--name`. That adds the next version behind the same link, and anyone with it open sees the new version within 10 seconds. Do not pick a new name for a revision.
- **Names** start with a lowercase letter or digit, then up to 62 more lowercase letters, digits or hyphens.
- **Finding pages:** `artifact list` prints this workspace's pages with their versions.
- **Deleting a page** when someone asks: `artifact delete <name>`.
- `--json` prints the result as a JSON envelope with `name`, `version`, `file` and `link`.

## When saving refuses

- **`ORI_CLI_ARTIFACT_RESOURCE_REFUSED`:** the message names every address that cannot go inside the page. Move the file to one of the CDNs above, inline it, or remove it, then save again.
- **`ORI_CLI_ARTIFACT_RESOURCE_DOWNLOAD_FAILED`:** a CDN address is wrong, usually a misspelt package, version or file path.
- **`ORI_CLI_ARTIFACT_TOO_LARGE`:** drop large images or libraries the page does not use.
- **`ORI_CLI_ARTIFACT_NAME_INVALID`:** pick a name that follows the rule above.
