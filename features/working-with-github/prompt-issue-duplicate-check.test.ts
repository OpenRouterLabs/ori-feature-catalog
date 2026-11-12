import { afterEach, describe, expect, test } from "bun:test";

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The ambient-mode duplicate check named `GET /repos/{owner}/{repo}/issues?state=all`
// as its search. That route takes no keywords and answers the 30 newest
// entries, pull requests included. Reproduced 2026-11-03 on
// OpenRouterLabs/ori-feature-catalog: page one held 29 pull requests and one
// issue, and the open duplicate #326 was not on it, while a keyword search
// found it. `/search/issues` is no way out in ambient mode: it is unscoped,
// goes out without the workspace credential, and answered 422 for a private
// repo. The guidance now pages the whole list and matches keywords locally.
// It paged with a growing `page=N`, which GitHub refuses past page 100 with
// 422 "Pagination with the page parameter is not supported for large
// datasets" (reproduced 2026-11-12 on microsoft/vscode: HTTP 422 after 100
// requests). It now follows the `after` cursor from each `Link` header, on
// the `/repos/{owner}/{repo}` path: the link itself names
// `/repositories/{id}`, which a per-owner proxy sends uncredentialed (a
// private repo answered 404 there, 200 on the owner path).

const prompt = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "prompt.md"),
  "utf-8"
);

const filingSection = (): string => {
  const start = prompt.indexOf("## Filing issues");
  const end = prompt.indexOf("\n## ", start + 1);
  return prompt.slice(start, end === -1 ? undefined : end);
};

const recipe = (): string => {
  const match = /bun -e '\n([\s\S]*?)' "\{owner\}\/\{repo\}"/u.exec(
    filingSection()
  );
  return match?.[1] ?? "";
};

const scratch: string[] = [];
afterEach(() => {
  for (const path of scratch.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

interface FakeItem {
  readonly number: number;
  readonly title: string;
  readonly body?: string | null;
  readonly state?: string;
  readonly pull_request?: object;
}

/** Run the prompt's recipe with `fetch` answering `pages` (page N = index N-1). */
const runRecipe = (
  pages: readonly (readonly FakeItem[])[],
  words: readonly string[],
  status = 200
) => {
  const dir = mkdtempSync(join(tmpdir(), "wwg-dupcheck-"));
  scratch.push(dir);
  const stub = join(dir, "stub.ts");
  writeFileSync(
    stub,
    `const pages = ${JSON.stringify(pages)};
const seen = [];
process.on("exit", () => process.stderr.write("URLS " + JSON.stringify(seen) + "\\n"));
globalThis.fetch = async (url) => {
  seen.push(String(url));
  const params = new URL(String(url)).searchParams;
  const page = Number(params.get("page") ?? "1");
  if (page > 100 && !params.has("after")) {
    return new Response(JSON.stringify({ message: "Pagination with the page parameter is not supported for large datasets, please use cursor based pagination (after/before)" }), { status: 422 });
  }
  const headers = page < pages.length
    ? { link: '<https://api.github.com/repositories/42/issues?state=all&per_page=100&page=' + (page + 1) + '&after=cur' + page + '>; rel="next"' }
    : {};
  return new Response(JSON.stringify(pages[page - 1] ?? []), { headers, status: ${status} });
};
`
  );
  const result = Bun.spawnSync(
    ["bun", "--preload", stub, "-e", recipe(), "acme/widgets", ...words],
    { stderr: "pipe", stdout: "pipe" }
  );
  const stderr = result.stderr.toString();
  const urls = /URLS (\[.*\])/u.exec(stderr)?.[1];
  return {
    exitCode: result.exitCode,
    stderr,
    stdout: result.stdout.toString(),
    urls: (urls === undefined ? [] : JSON.parse(urls)) as string[],
  };
};

const pulls = (from: number, count: number): FakeItem[] =>
  Array.from({ length: count }, (_unused, index) => ({
    number: from + index,
    pull_request: {},
    state: "closed",
    title: `fix: recipe composites ${from + index}`,
  }));

describe("the ambient duplicate check searches every issue", () => {
  test("the filing section no longer offers one list read as the duplicate check", () => {
    expect(filingSection()).not.toContain(
      "(`GET /repos/{owner}/{repo}/issues?state=all` for the duplicate check"
    );
    expect(recipe()).toContain("state=all&per_page=100");
    expect(recipe()).toContain(String.raw`rel="next"`);
    expect(recipe()).not.toContain("&page=${page}");
  });

  test("an older issue behind a full page of pull requests is found", () => {
    const run = runRecipe(
      [
        pulls(200, 100),
        [
          { number: 7, state: "open", title: "Recipe composites diverge" },
          { number: 6, state: "closed", title: "unrelated" },
        ],
      ],
      ["composites"]
    );
    expect(run.exitCode).toBe(0);
    expect(run.stdout.trim()).toBe("#7 [open] Recipe composites diverge");
    expect(run.urls).toHaveLength(2);
    expect(run.urls[0]).toContain("/repos/acme/widgets/issues?state=all");
  });

  test("an issue past page 100 is reached through the Link cursor, on the owner path", () => {
    const filler = Array.from({ length: 101 }, (_unused, index) => pulls(1000 + index * 100, 100));
    const run = runRecipe(
      [...filler, [{ number: 5, state: "closed", title: "Recipe composites diverge" }]],
      ["composites"]
    );
    expect(run.stderr).not.toContain("HTTP 422");
    expect(run.exitCode).toBe(0);
    expect(run.stdout.trim()).toBe("#5 [closed] Recipe composites diverge");
    expect(run.urls).toHaveLength(102);
    expect(run.urls.at(-1)).toContain("/repos/acme/widgets/issues?");
    expect(run.urls.at(-1)).toContain("after=cur101");
    expect(run.urls.some((url) => url.includes("/repositories/"))).toBe(false);
  });

  test("keywords match the body and ignore case", () => {
    const run = runRecipe(
      [[{ body: "The TOKEN cache races", number: 3, state: "closed", title: "flaky mint" }]],
      ["token"]
    );
    expect(run.stdout.trim()).toBe("#3 [closed] flaky mint");
    expect(run.urls).toHaveLength(1);
  });

  test("an HTTP error fails loudly instead of reading as no duplicates", () => {
    const run = runRecipe([[]], ["anything"], 401);
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("HTTP 401");
  });
});
