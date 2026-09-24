import { describe, expect, it } from "bun:test";

import type { CliDeps } from "./cli.ts";

import {
  ACCOUNT_HEADER,
  ACT_AS_HEADER,
  USERINFO_URL,
  isGoogleApiUrl,
  runCli,
} from "./cli.ts";

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
const isGoogle = (url: string): boolean => url.includes("googleapis.com");

const googleHeaders = (calls: Call[]): Headers =>
  new Headers(calls.find((call) => isGoogle(call.url))?.init?.headers);

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
  it("names the Slack user the turn came from and never sends a credential", async () => {
    const { deps, calls, out } = makeDeps((url) =>
      isSlack(url)
        ? slackUser("Pat@Example.com")
        : new Response(JSON.stringify({ labels: [{ id: "INBOX" }] }), {
            status: 200,
          })
    );
    const code = await runCli(["request", "GET", LABELS_URL], deps);
    expect(code).toBe(0);
    const headers = googleHeaders(calls);
    expect(headers.get(ACT_AS_HEADER)).toBe("email:pat@example.com");
    expect(headers.has("authorization")).toBe(false);
    expect(out.join("\n")).toContain('"INBOX"');
  });

  it("names nobody when the turn did not come from Slack", async () => {
    const { deps, calls, out, err } = makeDeps(
      () => new Response('{"labels":[]}', { status: 200 }),
      {}
    );
    expect(await runCli(["request", "GET", LABELS_URL], deps)).toBe(0);
    expect(calls.filter((call) => isSlack(call.url))).toHaveLength(0);
    expect(googleHeaders(calls).has(ACT_AS_HEADER)).toBe(false);
    expect(out.join("\n")).toContain("labels");
    expect(err).toHaveLength(0);
  });

  it("goes on without a name when Slack cannot say, and says so", async () => {
    const { deps, calls, err } = makeDeps((url) =>
      isSlack(url)
        ? new Response(JSON.stringify({ ok: true, user: { id: "U_PAT" } }))
        : new Response("{}", { status: 200 })
    );
    expect(await runCli(["request", "GET", LABELS_URL], deps)).toBe(0);
    expect(googleHeaders(calls).has(ACT_AS_HEADER)).toBe(false);
    expect(err.join("\n")).toContain("users:read.email");
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
    const posts = calls.filter((call) => isGoogle(call.url));
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
    expect(calls).toHaveLength(0);
    expect(err.join("\n")).toContain("JSON");
  });

  it("refuses hosts other than Google's APIs before asking anyone", async () => {
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

describe("runCli whoami", () => {
  it("asks Google which account answers, through the same attributed request", async () => {
    const { deps, calls, out } = makeDeps((url) =>
      isSlack(url)
        ? slackUser("pat@example.com")
        : new Response(JSON.stringify({ email: "pat@example.com", name: "Pat" }), {
            status: 200,
          })
    );
    expect(await runCli(["whoami"], deps)).toBe(0);
    const google = calls.find((call) => isGoogle(call.url));
    expect(google?.url).toBe(USERINFO_URL);
    expect(google?.init?.method).toBe("GET");
    expect(googleHeaders(calls).get(ACT_AS_HEADER)).toBe("email:pat@example.com");
    expect(googleHeaders(calls).has("authorization")).toBe(false);
    expect(out).toEqual(['{"email":"pat@example.com"}']);
  });

  it("works without a Slack user, since the request is attributed for it", async () => {
    const { deps, calls, out } = makeDeps(
      () => new Response(JSON.stringify({ email: "pat@example.com" }), { status: 200 }),
      {}
    );
    expect(await runCli(["whoami"], deps)).toBe(0);
    expect(calls).toHaveLength(1);
    expect(googleHeaders(calls).has(ACT_AS_HEADER)).toBe(false);
    expect(out).toEqual(['{"email":"pat@example.com"}']);
  });

  it("points at the dashboard link step when no account is linked", async () => {
    const { deps, err } = makeDeps(
      () => new Response('{"error":"invalid_token"}', { status: 401 }),
      {}
    );
    expect(await runCli(["whoami"], deps)).toBe(1);
    expect(err.join("\n")).toContain("Your accounts");
  });

  it("fails when Google answers without an email", async () => {
    const { deps, err } = makeDeps(() => new Response("{}", { status: 200 }), {});
    expect(await runCli(["whoami"], deps)).toBe(1);
    expect(err.join("\n")).toContain("did not name an account");
  });

  it("asks Slack with the bot token, for the given user", async () => {
    const { deps, calls } = makeDeps((url) =>
      isSlack(url)
        ? slackUser("pat@example.com")
        : new Response(JSON.stringify({ email: "pat@example.com" }))
    );
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

  it("refuses --as on every command without sending anything", async () => {
    const { deps, calls, err } = makeDeps(() => new Response("{}"));
    expect(
      await runCli(["request", "GET", LABELS_URL, "--as", "sam@example.com"], deps)
    ).toBe(1);
    expect(await runCli(["whoami", "--as", "sam@example.com"], deps)).toBe(1);
    expect(calls).toHaveLength(0);
    expect(err.join("\n")).toContain("--as is not supported");
    expect(err.join("\n")).toContain("--account <email>");
  });

  it("treats a flag with no value as empty, and keeps later positionals", async () => {
    const { deps, calls } = makeDeps((url) =>
      isSlack(url) ? slackUser("pat@example.com") : new Response("{}")
    );
    expect(
      await runCli(["request", "--json", "--pretty", "GET", LABELS_URL], deps)
    ).toBe(1);
    expect(calls).toHaveLength(0);
  });
});

describe("runCli --account", () => {
  it("names the delegated account and skips the Slack lookup", async () => {
    const { deps, calls } = makeDeps(
      () => new Response(JSON.stringify({ labels: [] }), { status: 200 })
    );
    const code = await runCli(
      ["request", "GET", LABELS_URL, "--account", " Sam@Example.com "],
      deps
    );
    expect(code).toBe(0);
    const headers = googleHeaders(calls);
    expect(headers.get(ACCOUNT_HEADER)).toBe("sam@example.com");
    expect(headers.has(ACT_AS_HEADER)).toBe(false);
    expect(headers.has("authorization")).toBe(false);
    expect(calls.some((call) => isSlack(call.url))).toBe(false);
  });

  it("names the account on whoami too", async () => {
    const { deps, calls, out } = makeDeps(
      () => new Response(JSON.stringify({ email: "sam@example.com" }), { status: 200 })
    );
    expect(await runCli(["whoami", "--account", "sam@example.com"], deps)).toBe(0);
    expect(calls[0]?.url).toBe(USERINFO_URL);
    expect(googleHeaders(calls).get(ACCOUNT_HEADER)).toBe("sam@example.com");
    expect(out.join("\n")).toContain("sam@example.com");
  });

  it("refuses a value that is not an email without sending anything", async () => {
    const { deps, calls, err } = makeDeps(() => new Response("{}"));
    expect(await runCli(["request", "GET", LABELS_URL, "--account", "sam"], deps)).toBe(1);
    expect(await runCli(["whoami", "--account"], deps)).toBe(1);
    expect(calls).toHaveLength(0);
    expect(err.join("\n")).toContain("--account must be an email address");
  });

  it("says the owner has not given this intern access on 401 and 403", async () => {
    for (const status of [401, 403]) {
      const { deps, err } = makeDeps(() => new Response("denied", { status }));
      expect(
        await runCli(["request", "GET", LABELS_URL, "--account", "sam@example.com"], deps)
      ).toBe(1);
      expect(err.join("\n")).toContain("has not given this intern access");
    }
  });
});
