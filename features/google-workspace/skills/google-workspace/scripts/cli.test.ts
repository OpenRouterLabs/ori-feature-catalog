import { describe, expect, it } from "bun:test";

import type { CliDeps } from "./cli.ts";

import { ACT_AS_HEADER, isGoogleApiUrl, runCli } from "./cli.ts";

interface Call {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

const SLACK_ENV = { SLACK_USER_ID: "U_PAT", SLACK_BOT_TOKEN: "xoxb-test" };
const LABELS_URL = "https://gmail.googleapis.com/gmail/v1/users/me/labels";

function makeDeps(
  respond: (url: string, init: RequestInit | undefined) => Response,
  env: Record<string, string | undefined> = SLACK_ENV
): { deps: CliDeps; calls: Call[]; out: string[]; err: string[] } {
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return respond(url, init);
    },
    env,
    readFile: async () => '{"from":"file"}',
    out: (text) => {
      out.push(text);
    },
    err: (text) => {
      err.push(text);
    },
  };
  return { deps, calls, out, err };
}

const slackUser = (email: string): Response =>
  new Response(JSON.stringify({ ok: true, user: { profile: { email } } }), {
    status: 200,
  });

const isSlack = (url: string): boolean => url.startsWith("https://slack.com/");

describe("isGoogleApiUrl", () => {
  it("accepts Google API hosts over https and nothing else", () => {
    expect(isGoogleApiUrl(LABELS_URL)).toBe(true);
    expect(
      isGoogleApiUrl(
        "https://www.googleapis.com/calendar/v3/calendars/primary/events"
      )
    ).toBe(true);
    expect(isGoogleApiUrl("http://gmail.googleapis.com/")).toBe(false);
    expect(isGoogleApiUrl("https://oauth2.googleapis.com/token")).toBe(false);
    expect(isGoogleApiUrl("https://example.com/googleapis.com")).toBe(false);
    expect(isGoogleApiUrl("not a url")).toBe(false);
  });
});

describe("runCli request", () => {
  it("names the acting member from the Slack user and never sends a credential", async () => {
    const { deps, calls, out } = makeDeps((url) =>
      isSlack(url)
        ? slackUser("Pat@Example.com")
        : new Response(JSON.stringify({ labels: [{ id: "INBOX" }] }), {
            status: 200,
          })
    );
    const code = await runCli(["request", "GET", LABELS_URL], deps);
    expect(code).toBe(0);
    const google = calls.find((call) => call.url.includes("googleapis.com"));
    const headers = new Headers(google?.init?.headers);
    expect(headers.get(ACT_AS_HEADER)).toBe("email:pat@example.com");
    expect(headers.has("authorization")).toBe(false);
    expect(out.join("\n")).toContain('"INBOX"');
  });

  it("forwards a JSON body, inline or from a file, with the content type", async () => {
    const { deps, calls } = makeDeps((url) =>
      isSlack(url)
        ? slackUser("pat@example.com")
        : new Response("{}", { status: 200 })
    );
    await runCli(
      [
        "request",
        "POST",
        "https://www.googleapis.com/calendar/v3/freeBusy",
        "--json",
        '{"items":[]}',
      ],
      deps
    );
    await runCli(
      [
        "request",
        "PUT",
        "https://docs.googleapis.com/v1/documents/1",
        "--json",
        "@/tmp/body.json",
      ],
      deps
    );
    const posts = calls.filter((call) => call.url.includes("googleapis.com"));
    expect(posts[0]?.init?.body).toBe('{"items":[]}');
    expect(new Headers(posts[0]?.init?.headers).get("content-type")).toBe(
      "application/json"
    );
    expect(posts[1]?.init?.body).toBe('{"from":"file"}');
  });

  it("rejects a body that is not JSON before sending anything", async () => {
    const { deps, calls, err } = makeDeps((url) =>
      isSlack(url) ? slackUser("pat@example.com") : new Response("{}")
    );
    const code = await runCli(
      ["request", "POST", LABELS_URL, "--json", "{not json"],
      deps
    );
    expect(code).toBe(1);
    expect(calls.filter((call) => !isSlack(call.url))).toHaveLength(0);
    expect(err.join("\n")).toContain("JSON");
  });

  it("refuses hosts other than Google's APIs before resolving anyone", async () => {
    const { deps, calls, err } = makeDeps(() => new Response("{}"));
    const code = await runCli(["request", "GET", "https://example.com/"], deps);
    expect(code).toBe(1);
    expect(calls).toHaveLength(0);
    expect(err.join("\n")).toContain("refused");
  });

  it("prints usage for an unknown method or a missing URL", async () => {
    const { deps, calls, err } = makeDeps(() => new Response("{}"));
    expect(await runCli(["request", "FETCH", LABELS_URL], deps)).toBe(1);
    expect(await runCli(["request", "GET"], deps)).toBe(1);
    expect(calls).toHaveLength(0);
    expect(err.join("\n")).toContain("Usage:");
  });

  it("points at the dashboard link step on 401 and 403, and relays other errors as they are", async () => {
    const respond = (status: number) => (url: string) =>
      isSlack(url)
        ? slackUser("pat@example.com")
        : new Response('{"error":{"message":"Request had invalid authentication credentials."}}', {
            status,
          });
    const denied = makeDeps(respond(401));
    expect(await runCli(["request", "GET", LABELS_URL], denied.deps)).toBe(1);
    expect(denied.err.join("\n")).toContain("Your accounts");
    expect(denied.err.join("\n")).toContain("invalid authentication credentials");
    const forbidden = makeDeps(respond(403));
    await runCli(["request", "GET", LABELS_URL], forbidden.deps);
    expect(forbidden.err.join("\n")).toContain("Your accounts");
    const broken = makeDeps(respond(500));
    await runCli(["request", "GET", LABELS_URL], broken.deps);
    expect(broken.err.join("\n")).toContain("Google answered 500");
    expect(broken.err.join("\n")).not.toContain("Your accounts");
  });

  it("prints a body that is not JSON as it came", async () => {
    const { deps, out } = makeDeps((url) =>
      isSlack(url)
        ? slackUser("pat@example.com")
        : new Response("plain text export", { status: 200 })
    );
    expect(
      await runCli(
        [
          "request",
          "GET",
          "https://www.googleapis.com/drive/v3/files/1/export?mimeType=text/plain",
        ],
        deps
      )
    ).toBe(0);
    expect(out).toEqual(["plain text export"]);
  });
});

describe("runCli whoami and the acting member", () => {
  it("uses --as instead of Slack when given, lower-cased", async () => {
    const { deps, calls, out } = makeDeps(() => new Response("{}"));
    expect(await runCli(["whoami", "--as", "Sam@Example.com"], deps)).toBe(0);
    expect(calls).toHaveLength(0);
    expect(out).toEqual(['{"email":"sam@example.com"}']);
  });

  it("rejects an --as that is not an email address", async () => {
    const { deps, err } = makeDeps(() => new Response("{}"));
    expect(await runCli(["whoami", "--as", "sam"], deps)).toBe(1);
    expect(err.join("\n")).toContain("--as must be an email address");
  });

  it("fails clearly without a Slack user or without a bot token", async () => {
    const noUser = makeDeps(() => new Response("{}"), {});
    expect(await runCli(["whoami"], noUser.deps)).toBe(1);
    expect(noUser.err.join("\n")).toContain("SLACK_USER_ID");
    const noToken = makeDeps(() => new Response("{}"), {
      SLACK_USER_ID: "U_PAT",
    });
    expect(await runCli(["whoami"], noToken.deps)).toBe(1);
    expect(noToken.err.join("\n")).toContain("SLACK_BOT_TOKEN");
  });

  it("fails clearly when Slack does not return an email for the user", async () => {
    const noProfile = makeDeps(
      () => new Response(JSON.stringify({ ok: true, user: { id: "U_PAT" } }))
    );
    expect(await runCli(["whoami"], noProfile.deps)).toBe(1);
    expect(noProfile.err.join("\n")).toContain("users:read.email");
    const notJson = makeDeps(() => new Response("gateway timeout"));
    expect(await runCli(["whoami"], notJson.deps)).toBe(1);
    expect(notJson.err.join("\n")).toContain("Could not resolve Slack user");
  });

  it("asks Slack with the bot token, for the given user", async () => {
    const { deps, calls } = makeDeps(() => slackUser("pat@example.com"));
    await runCli(["whoami"], deps);
    expect(calls[0]?.url).toBe("https://slack.com/api/users.info?user=U_PAT");
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe(
      "Bearer xoxb-test"
    );
  });
});

describe("runCli dispatch", () => {
  it("prints usage for help and for no command", async () => {
    const { deps, out } = makeDeps(() => new Response("{}"));
    expect(await runCli([], deps)).toBe(0);
    expect(await runCli(["--help"], deps)).toBe(0);
    expect(await runCli(["-h"], deps)).toBe(0);
    expect(out).toHaveLength(3);
    expect(out[0]).toContain("Usage:");
  });

  it("names an unknown command", async () => {
    const { deps, err } = makeDeps(() => new Response("{}"));
    expect(await runCli(["send"], deps)).toBe(1);
    expect(err.join("\n")).toContain('Unknown command "send"');
  });

  it("treats a flag with no value as empty, and keeps later positionals", async () => {
    const { deps, calls } = makeDeps((url) =>
      isSlack(url) ? slackUser("pat@example.com") : new Response("{}")
    );
    expect(
      await runCli(["request", "--as", "--json", "GET", LABELS_URL], deps)
    ).toBe(1);
    expect(calls).toHaveLength(0);
  });
});
