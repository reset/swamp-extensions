/**
 * Unit tests for the socialq behavior. Every request goes to an in-process
 * fake of socialq's API behind Deno.serve on 127.0.0.1, which answers the
 * shapes the socialq README documents and refuses what it says it refuses:
 * an unknown service token, a token outside the organization, a token at an
 * administrator's route, and any write. Nothing here touches a deployed
 * socialq. The tests over the fake need `--allow-net=127.0.0.1` and are
 * skipped without it; the pure-function tests run anywhere.
 */

import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.19";
import {
  createModelTestContext,
  type ModelTestContextResult,
} from "jsr:@swamp-club/swamp-testing@0.20261016.58";
import {
  ageDays,
  behavior,
  type Context,
  countJobStates,
  type GlobalArgs,
  parseJobStates,
  plusDays,
  resolveRange,
  SocialqError,
  summarizeCoverage,
  utcDay,
} from "./socialq.ts";
import source from "./socialq.ts" with { type: "text" };

const NET = Deno.permissions.querySync({ name: "net", host: "127.0.0.1" })
  .state === "granted";

const DAY_MS = 86_400_000;

// The fake's people: a service token's client id maps to a person, as the
// README says the Worker does, and the person's memberships say where it may
// read. Markers in the fields a resource must never keep make a leak show up
// in a JSON.stringify of what was written.
const SMOKE = { id: "smoke-client-id", secret: "smoke-secret-for-tests" };
const OUTSIDER = { id: "outsider-client-id", secret: "outsider-secret" };
const ADMIN_TOKEN = { id: "admin-client-id", secret: "admin-secret" };
const PEOPLE: Record<
  string,
  { email: string; name: string; orgs: Record<string, string> }
> = {
  [SMOKE.id]: {
    email: "smoke@example.com",
    name: "Smoke Person",
    orgs: { first: "publisher" },
  },
  [OUTSIDER.id]: {
    email: "outsider@example.com",
    name: "Outsider Person",
    orgs: { other: "publisher" },
  },
  [ADMIN_TOKEN.id]: {
    email: "admin@example.com",
    name: "Admin Person",
    orgs: { first: "admin" },
  },
};
const SECRETS: Record<string, string> = {
  [SMOKE.id]: SMOKE.secret,
  [OUTSIDER.id]: OUTSIDER.secret,
  [ADMIN_TOKEN.id]: ADMIN_TOKEN.secret,
};
const ORG = { id: "org-first", slug: "first", name: "First Studio" };

interface Call {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
}

interface Fake {
  url: string;
  calls: Call[];
  /** How many times the fake's write guard answered: never, if the behavior is read-only. */
  writesRefused: number;
  /** On the deployment's domain /api/me answers the console shape. */
  console: boolean;
  /** What socialq would answer if it admitted a token to the ledger. Off: 403 as deployed. */
  ledgerOpen: boolean;
  shutdown: () => Promise<void>;
}

function daysAgo(days: number, hours = 1): string {
  return new Date(Date.now() - days * DAY_MS - hours * 3_600_000)
    .toISOString();
}

function accountRows(): Record<string, unknown>[] {
  return [
    {
      id: "acc-bsky",
      network: "bluesky",
      external_id: "did:plc:abc",
      handle: "studio.bsky.social",
      display_name: "DROP-DISPLAY-NAME",
      status: "connected",
      connected_by: "DROP-CONNECTED-BY",
      created_at: "2026-09-01T09:00:00.000Z",
      updated_at: "2026-10-01T09:00:00.000Z",
    },
    {
      id: "acc-threads",
      network: "threads",
      external_id: "17841400000000000",
      handle: "studio",
      display_name: null,
      status: "connected",
      connected_by: null,
      created_at: "2026-09-02T09:00:00.000Z",
      updated_at: "2026-10-02T09:00:00.000Z",
    },
    {
      id: "acc-old",
      network: "x",
      external_id: "1234",
      handle: "studio_old",
      display_name: "DROP-DISPLAY-NAME",
      status: "needs_reconnect",
      connected_by: "DROP-CONNECTED-BY",
      created_at: "2026-08-01T09:00:00.000Z",
      updated_at: "2026-10-03T09:00:00.000Z",
    },
    {
      id: "acc-gone",
      network: "youtube",
      external_id: "UC1",
      handle: "studio",
      display_name: null,
      status: "disconnected",
      connected_by: null,
      created_at: "2026-07-01T09:00:00.000Z",
      updated_at: "2026-10-04T09:00:00.000Z",
    },
  ];
}

function calendarAnswer(from: string, to: string): Record<string, unknown> {
  return {
    from,
    to,
    items: [
      {
        variant_id: "var-1",
        post_id: "post-1",
        account_id: "acc-bsky",
        network: "bluesky",
        handle: "studio.bsky.social",
        format: "post",
        status: "published",
        origin: "recorded",
        text: "DROP-TEXT the post body",
        day: to,
        at: `${to}T10:00:00.000Z`,
        permalink: "https://bsky.app/profile/DROP-PERMALINK/post/1",
        external_id: "at://did:plc:abc/app.bsky.feed.post/1",
        tags: [
          { id: "tag-1", name: "DROP-TAG-NAME", kind: "label", color: null },
          { id: "tag-2", name: "Launch", kind: "campaign", color: "#ff0000" },
        ],
        attachments: 2,
      },
      {
        variant_id: "var-2",
        post_id: "post-2",
        account_id: "acc-threads",
        network: "threads",
        handle: "studio",
        format: "post",
        status: "scheduled",
        origin: "composed",
        text: "DROP-TEXT",
        day: to,
        at: `${to}T18:00:00.000Z`,
        permalink: null,
        external_id: null,
        tags: [],
        attachments: 0,
      },
    ],
    coverage: [
      {
        account_id: "acc-bsky",
        network: "bluesky",
        handle: "studio.bsky.social",
        status: "connected",
        days: [from, to],
        last_collected_at: daysAgo(0),
        backfill_pending: false,
      },
      {
        account_id: "acc-threads",
        network: "threads",
        handle: "studio",
        status: "connected",
        days: [from],
        last_collected_at: daysAgo(3),
        backfill_pending: true,
      },
      {
        account_id: "acc-old",
        network: "x",
        handle: "studio_old",
        status: "needs_reconnect",
        days: [],
        last_collected_at: daysAgo(40),
        backfill_pending: false,
      },
      {
        account_id: "acc-gone",
        network: "youtube",
        handle: "studio",
        status: "disconnected",
        days: [],
        last_collected_at: null,
        backfill_pending: false,
      },
    ],
  };
}

function reportAnswer(from: string, to: string): Record<string, unknown> {
  const metrics = (views: number | null) => ({
    views,
    reach: null,
    impressions: null,
    likes: 12,
    comments: 0,
    shares: null,
    saves: null,
    reposts: 3,
    quotes: null,
    link_clicks: null,
    watch_time_ms: null,
  });
  return {
    from,
    to,
    rows: [
      {
        network: "bluesky",
        source: "network",
        followers: { accounts: 1, measured: 1, at_end: 1500, at_start: 1400 },
        daily: { rows: 0, variants: 0, days: 0, metrics: metrics(null) },
        lifetime: { published: 4, measured: 4, metrics: metrics(900) },
      },
    ],
    accounts: [
      {
        account_id: "acc-bsky",
        network: "bluesky",
        handle: "studio.bsky.social",
        status: "connected",
        source: "network",
        at_end: { day: to, followers: 1500 },
        at_start: { day: from, followers: 1400 },
      },
      {
        account_id: "acc-threads",
        network: "threads",
        handle: "studio",
        status: "connected",
        source: "network",
        at_end: { day: to, followers: null },
        at_start: null,
      },
    ],
  };
}

function activityAnswer(day: string, admin: boolean): Record<string, unknown> {
  const job = (
    id: string,
    kind: string,
    state: string,
    outcome: string | null,
  ) => ({
    id,
    kind,
    state,
    attempts: state === "dead" ? 5 : 1,
    created_at: `${day}T09:00:00.000Z`,
    next_run_at: `${day}T09:00:00.000Z`,
    updated_at: `${day}T09:05:00.000Z`,
    outcome,
    run: state === "done"
      ? { status: "ok", items: 7, ended_at: `${day}T09:04:00.000Z` }
      : null,
    requested_by: { id: "person-1", name: "DROP-REQUESTER" },
    ...(admin ? { error: "DROP-ERROR text" } : {}),
  });
  return {
    day,
    accounts: [
      {
        account_id: "acc-bsky",
        network: "bluesky",
        handle: "studio.bsky.social",
        status: "connected",
        jobs: [
          job("job-1", "collect_posts", "done", "ok"),
          job("job-2", "collect_account", "leased", null),
          job("job-3", "collect_metrics", "due", null),
        ],
      },
      {
        account_id: "acc-threads",
        network: "threads",
        handle: "studio",
        status: "connected",
        jobs: [
          job("job-4", "collect_posts", "dead", "retry"),
          job("job-5", "collect_account", "failed", "auth"),
        ],
      },
    ],
    mine: [job("job-9", "publish", "unknown", null)],
    running: 2,
  };
}

function jobsAnswer(states: string[]): Record<string, unknown> {
  const all = [
    {
      id: "job-4",
      kind: "collect_posts",
      target_id: "acc-threads",
      operation_key: "collect_posts:acc-threads:2026-10-20",
      state: "dead",
      attempts: 5,
      next_run_at: "2026-10-20T09:00:00.000Z",
      lease_owner: "DROP-LEASE",
      lease_until: null,
      dispatched_at: null,
      last_error: "DROP-ERROR",
      handle: '{"DROP-HANDLE":1}',
      created_at: "2026-10-20T09:00:00.000Z",
      updated_at: "2026-10-20T10:00:00.000Z",
      requested_by: "DROP-REQUESTER",
    },
    {
      id: "job-9",
      kind: "publish",
      target_id: "var-2",
      operation_key: "publish:var-2:3",
      state: "unknown",
      attempts: 2,
      next_run_at: "2026-10-21T09:00:00.000Z",
      lease_owner: null,
      lease_until: null,
      dispatched_at: null,
      last_error: null,
      handle: "{}",
      created_at: "2026-10-21T08:00:00.000Z",
      updated_at: "2026-10-21T09:00:00.000Z",
      requested_by: null,
    },
    {
      id: "job-1",
      kind: "collect_posts",
      target_id: "acc-bsky",
      operation_key: "collect_posts:acc-bsky:2026-10-21",
      state: "done",
      attempts: 1,
      next_run_at: "2026-10-21T09:00:00.000Z",
      lease_owner: null,
      lease_until: null,
      dispatched_at: null,
      last_error: null,
      handle: "{}",
      created_at: "2026-10-21T09:00:00.000Z",
      updated_at: "2026-10-21T09:05:00.000Z",
      requested_by: null,
    },
  ];
  return {
    jobs: states.length === 0
      ? all
      : all.filter((j) => states.includes(j.state)),
  };
}

function taxonomyAnswer(archived: boolean): Record<string, unknown> {
  const collections = [
    {
      id: "col-1",
      parent_id: null,
      name: "Campaigns",
      icon: "flag",
      created_at: "2026-09-01T00:00:00.000Z",
      archived_at: null,
    },
    {
      id: "col-2",
      parent_id: "col-1",
      name: "Old",
      icon: null,
      created_at: "2026-09-01T00:00:00.000Z",
      archived_at: "2026-10-01T00:00:00.000Z",
    },
  ];
  const tags = [
    {
      id: "tag-1",
      collection_id: null,
      kind: "label",
      name: "Community",
      color: "#00ff00",
      description: "DROP-DESCRIPTION",
      brief: null,
      starts_on: null,
      ends_on: null,
      created_by: "DROP-CREATOR",
      created_at: "2026-09-01T00:00:00.000Z",
      archived_at: null,
      posts: 12,
    },
    {
      id: "tag-2",
      collection_id: "col-1",
      kind: "campaign",
      name: "Launch",
      color: "#ff0000",
      description: null,
      brief: "DROP-BRIEF",
      starts_on: "2026-10-01",
      ends_on: "2026-10-31",
      created_by: "DROP-CREATOR",
      created_at: "2026-09-15T00:00:00.000Z",
      archived_at: null,
      posts: 4,
    },
    {
      id: "tag-3",
      collection_id: "col-2",
      kind: "label",
      name: "Retired",
      color: null,
      description: null,
      brief: null,
      starts_on: null,
      ends_on: null,
      created_by: null,
      created_at: "2026-08-01T00:00:00.000Z",
      archived_at: "2026-10-01T00:00:00.000Z",
      posts: 1,
    },
  ];
  return {
    collections: archived
      ? collections
      : collections.filter((c) => c.archived_at === null),
    tags: archived ? tags : tags.filter((t) => t.archived_at === null),
  };
}

/**
 * socialq's API in memory, as its README documents it (How a request is
 * served, Smoke run, Jobs, Activity, Calendar, Console, Taxonomy,
 * Connecting): Cloudflare Access turns a missing or wrong service token
 * away with a redirect to its sign-in page; the Worker maps a known client
 * id to a person and refuses one that is no SocialQ user, no member of the
 * organization, or an administrator; a service token is refused every
 * write; the ledger is administrators only; /api/health needs no token.
 */
function fakeSocialq(options: { console?: boolean } = {}): Fake {
  const fake: Fake = {
    url: "",
    calls: [],
    writesRefused: 0,
    console: options.console ?? false,
    ledgerOpen: false,
    shutdown: () => Promise.resolve(),
  };
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (request) => {
      const url = new URL(request.url);
      const headers: Record<string, string> = {};
      request.headers.forEach((value, key) => (headers[key] = value));
      fake.calls.push({
        method: request.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers,
      });
      if (url.pathname === "/api/health") {
        return json({ ok: true, app: "socialq", version: "82+7bd3836" });
      }
      // The edge: Cloudflare Access, before the Worker.
      const clientId = request.headers.get("cf-access-client-id") ?? "";
      const secret = request.headers.get("cf-access-client-secret") ?? "";
      if (clientId === "" || SECRETS[clientId] !== secret) {
        return new Response("<html>Sign in</html>", {
          status: 302,
          headers: {
            Location: "https://team.cloudflareaccess.com/cdn-cgi/access/login",
            "Content-Type": "text/html",
          },
        });
      }
      // The Worker: the person the id maps to, then the org and the method.
      const person = PEOPLE[clientId];
      if (person === undefined) {
        return json({ error: "not a SocialQ user" }, 403);
      }
      if (url.pathname === "/api/me" && fake.console) {
        const orgs = Object.entries(person.orgs)
          .filter(([, role]) => role === "publisher")
          .map(([slug, role]) => ({
            id: `org-${slug}`,
            slug,
            name: `${slug} name`,
            role,
            origin: `https://${slug}.socialq.example.com`,
          }));
        if (orgs.length === 0) {
          return json({ error: "not a member of any organization" }, 403);
        }
        const here = orgs.find((o) => o.slug === ORG.slug);
        return json({
          id: "smoke",
          email: person.email,
          name: person.name,
          role: here?.role ?? null,
          operator: false,
          org: here === undefined ? null : ORG,
          console: true,
          orgs,
        });
      }
      const role = person.orgs[ORG.slug];
      if (role === "admin") {
        return json(
          { error: "a service token is never an administrator" },
          403,
        );
      }
      if (role === undefined) {
        return json({ error: "not a member of this organization" }, 403);
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        fake.writesRefused++;
        return json({ error: "a service token changes nothing" }, 403);
      }
      switch (url.pathname) {
        case "/api/me":
          return json({
            id: "smoke",
            email: person.email,
            name: person.name,
            role,
            operator: false,
            org: ORG,
            console: false,
          });
        case "/api/accounts":
          return json({ accounts: accountRows() });
        case "/api/calendar":
        case "/api/reports": {
          const from = url.searchParams.get("from");
          const to = url.searchParams.get("to");
          if (from === null || to === null) {
            return json(
              { error: "from and to are required, as YYYY-MM-DD" },
              400,
            );
          }
          return json(
            url.pathname === "/api/calendar"
              ? calendarAnswer(from, to)
              : reportAnswer(from, to),
          );
        }
        case "/api/activity":
          return json(activityAnswer(utcDay(new Date()), false));
        case "/api/jobs": {
          if (!fake.ledgerOpen) {
            return json({ error: "administrators only" }, 403);
          }
          const states = (url.searchParams.get("state") ?? "")
            .split(",")
            .filter((s) => s !== "");
          return json(jobsAnswer(states));
        }
        case "/api/taxonomy":
          return json(taxonomyAnswer(url.searchParams.get("archived") === "1"));
        default:
          return json({ error: "not found" }, 404);
      }
    },
  );
  fake.url = `http://127.0.0.1:${server.addr.port}`;
  fake.shutdown = () => server.shutdown();
  return fake;
}

function testContext(
  fake: Fake,
  token: { id: string; secret: string } = SMOKE,
): {
  context: Context;
  getWrittenResources: ModelTestContextResult["getWrittenResources"];
  getLogs: ModelTestContextResult["getLogs"];
} {
  const globalArgs: GlobalArgs = {
    host: fake.url,
    clientId: token.id,
    clientSecret: token.secret,
  };
  const result = createModelTestContext({ globalArgs: { ...globalArgs } });
  const context: Context = { ...result.context, globalArgs };
  return {
    context,
    getWrittenResources: result.getWrittenResources,
    getLogs: result.getLogs,
  };
}

function assertNoMarker(value: unknown, ...markers: string[]) {
  const text = JSON.stringify(value);
  for (const marker of markers) {
    assertFalse(text.includes(marker), `${marker} reached a resource`);
  }
}

async function withFake(
  options: { console?: boolean },
  body: (fake: Fake) => Promise<void>,
) {
  const fake = fakeSocialq(options);
  try {
    await body(fake);
  } finally {
    await fake.shutdown();
  }
}

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

Deno.test("global arguments need a URL host and both halves of the token", () => {
  const good = behavior.globalArguments.safeParse({
    host: "https://socialq.example.com",
    clientId: "id",
    clientSecret: "secret",
  });
  assert(good.success);
  assertFalse(
    behavior.globalArguments.safeParse({ clientId: "id", clientSecret: "s" })
      .success,
  );
  assertFalse(
    behavior.globalArguments.safeParse({
      host: "socialq.example.com",
      clientId: "id",
      clientSecret: "s",
    }).success,
    "a bare hostname is not a URL",
  );
  assertFalse(
    behavior.globalArguments.safeParse({
      host: "https://socialq.example.com",
      clientId: "id",
      clientSecret: "",
    }).success,
  );
});

Deno.test("resolveRange defaults to today and the 30 days before, and refuses bad ranges", () => {
  const now = new Date("2026-10-21T12:34:56.000Z");
  assertEquals(resolveRange({}, 62, now), {
    from: "2026-09-21",
    to: "2026-10-21",
    days: 31,
  });
  assertEquals(resolveRange({ from: "2026-10-01" }, 62, now), {
    from: "2026-10-01",
    to: "2026-10-21",
    days: 21,
  });
  assertEquals(resolveRange({ to: "2026-10-10" }, 62, now).from, "2026-09-10");
  assertEquals(
    resolveRange({ from: "2026-10-05", to: "2026-10-05" }, 62, now).days,
    1,
  );
  for (
    const [args, message] of [
      [{ from: "2026-02-30", to: "2026-03-01" }, "not a calendar day"],
      [{ from: "2026-10-10", to: "2026-10-01" }, "is before from"],
      [{ from: "2026-08-01", to: "2026-10-21" }, "at most 62"],
    ] as const
  ) {
    let thrown: Error | undefined;
    try {
      resolveRange(args, 62, now);
    } catch (error) {
      thrown = error as Error;
    }
    assert(thrown !== undefined, `${JSON.stringify(args)} should throw`);
    assertStringIncludes(thrown.message, message);
  }
  assertEquals(
    resolveRange({ from: "2026-08-01", to: "2026-10-21" }, 366, now).days,
    82,
  );
});

Deno.test("day helpers and ageDays", () => {
  assertEquals(plusDays("2026-10-21", -31), "2026-09-20");
  assertEquals(plusDays("2026-12-31", 1), "2027-01-01");
  assertEquals(utcDay(new Date("2026-10-21T23:59:59.000Z")), "2026-10-21");
  const now = new Date("2026-10-21T12:00:00.000Z");
  assertEquals(ageDays("2026-10-21T09:00:00.000Z", now), 0);
  assertEquals(ageDays("2026-10-18T13:00:00.000Z", now), 2);
  assertEquals(ageDays("2026-10-22T13:00:00.000Z", now), 0, "never negative");
  assertEquals(ageDays("not a date", now), undefined);
});

Deno.test("summarizeCoverage counts connected accounts only", () => {
  const base = { network: "x", daysWithData: 0, backfillPending: false };
  const summary = summarizeCoverage([
    {
      ...base,
      accountId: "a",
      handle: "fresh",
      status: "connected",
      readAgeDays: 0,
    },
    {
      ...base,
      accountId: "b",
      handle: "stale",
      status: "connected",
      readAgeDays: 9,
    },
    { ...base, accountId: "c", handle: "never", status: "connected" },
    {
      ...base,
      accountId: "d",
      handle: "old",
      status: "needs_reconnect",
      readAgeDays: 90,
    },
    { ...base, accountId: "e", handle: "gone", status: "disconnected" },
  ]);
  assertEquals(summary, {
    connected: 3,
    neverRead: 1,
    oldestReadAgeDays: 9,
    oldestReadHandle: "stale",
  });
  assertEquals(summarizeCoverage([]), {
    connected: 0,
    neverRead: 0,
    oldestReadAgeDays: 0,
  });
  assertEquals(
    summarizeCoverage([
      { ...base, accountId: "c", handle: "never", status: "connected" },
    ]),
    { connected: 1, neverRead: 1, oldestReadAgeDays: 0 },
  );
});

Deno.test("parseJobStates and countJobStates", () => {
  assertEquals(parseJobStates("failed,dead,unknown"), [
    "failed",
    "dead",
    "unknown",
  ]);
  assertEquals(parseJobStates(" dead , "), ["dead"]);
  assertEquals(parseJobStates(""), []);
  let thrown: Error | undefined;
  try {
    parseJobStates("dead,stalled");
  } catch (error) {
    thrown = error as Error;
  }
  assertStringIncludes(thrown?.message ?? "", "unknown job state 'stalled'");
  assertEquals(
    countJobStates([{ state: "dead" }, { state: "done" }, { state: "odd" }]),
    { due: 0, leased: 0, done: 1, failed: 0, unknown: 0, dead: 1 },
  );
});

// ---------------------------------------------------------------------------
// Over the in-process fake (needs --allow-net=127.0.0.1)
// ---------------------------------------------------------------------------

Deno.test({
  name: "health needs no token and writes the build",
  ignore: !NET,
  fn: () =>
    withFake({}, async (fake) => {
      const { context, getWrittenResources } = testContext(fake);
      const result = await behavior.methods.health.execute({}, context);
      assertEquals(fake.calls.length, 1);
      assertEquals(fake.calls[0].method, "GET");
      assertEquals(fake.calls[0].path, "/api/health");
      const written = getWrittenResources();
      assertEquals(written.map((w) => [w.specName, w.name]), [[
        "health",
        "health",
      ]]);
      assertEquals(written[0].data.ok, true);
      assertEquals(written[0].data.app, "socialq");
      assertEquals(written[0].data.version, "82+7bd3836");
      assertEquals(written[0].data.host, fake.url);
      assertEquals(result.dataHandles.length, 1);
    }),
});

Deno.test({
  name:
    "me sends both token headers and keeps the role and org, never the person",
  ignore: !NET,
  fn: () =>
    withFake({}, async (fake) => {
      const { context, getWrittenResources } = testContext(fake);
      await behavior.methods.me.execute({}, context);
      assertEquals(fake.calls[0].headers["cf-access-client-id"], SMOKE.id);
      assertEquals(
        fake.calls[0].headers["cf-access-client-secret"],
        SMOKE.secret,
      );
      assertEquals(fake.calls[0].headers["accept"], "application/json");
      const me = getWrittenResources()[0];
      assertEquals(me.specName, "me");
      assertEquals(me.data, {
        fetchedAt: me.data.fetchedAt,
        host: fake.url,
        console: false,
        role: "publisher",
        operator: false,
        org: { id: ORG.id, slug: ORG.slug },
      });
      assertNoMarker(me.data, "example.com", "Smoke Person", "First Studio");
    }),
});

Deno.test({
  name: "me on the deployment's domain keeps the organizations the token reads",
  ignore: !NET,
  fn: () =>
    withFake({ console: true }, async (fake) => {
      const { context, getWrittenResources } = testContext(fake);
      await behavior.methods.me.execute({}, context);
      const me = getWrittenResources()[0].data;
      assertEquals(me.console, true);
      assertEquals(me.role, "publisher");
      assertEquals(me.orgs, [{
        id: "org-first",
        slug: "first",
        role: "publisher",
      }]);
      assertNoMarker(me, "example.com", "Smoke Person", "first name", "origin");
    }),
});

Deno.test({
  name: "accounts keeps ids, networks, handles and statuses with counts",
  ignore: !NET,
  fn: () =>
    withFake({}, async (fake) => {
      const { context, getWrittenResources } = testContext(fake);
      await behavior.methods.accounts.execute({}, context);
      const accounts = getWrittenResources()[0];
      assertEquals(accounts.name, "accounts");
      assertEquals(accounts.data.count, 4);
      assertEquals(accounts.data.byStatus, {
        connected: 2,
        needsReconnect: 1,
        disconnected: 1,
      });
      const rows = accounts.data.accounts as Record<string, unknown>[];
      assertEquals(rows[0], {
        id: "acc-bsky",
        network: "bluesky",
        handle: "studio.bsky.social",
        status: "connected",
        createdAt: "2026-09-01T09:00:00.000Z",
        updatedAt: "2026-10-01T09:00:00.000Z",
      });
      assertNoMarker(
        accounts.data,
        "DROP-",
        "external_id",
        "did:plc",
        "connected_by",
      );
    }),
});

Deno.test({
  name: "calendar reads the default range and writes calendar and coverage",
  ignore: !NET,
  fn: () =>
    withFake({}, async (fake) => {
      const { context, getWrittenResources } = testContext(fake);
      const today = utcDay(new Date());
      await behavior.methods.calendar.execute({}, context);
      assertEquals(fake.calls.length, 1);
      assertEquals(fake.calls[0].path, "/api/calendar");
      assertEquals(fake.calls[0].query, {
        from: plusDays(today, -30),
        to: today,
      });

      const written = getWrittenResources();
      assertEquals(written.map((w) => w.name), ["calendar", "coverage"]);
      const calendar = written[0].data;
      assertEquals(calendar.count, 2);
      assertEquals(calendar.byStatus, { published: 1, scheduled: 1 });
      const items = calendar.items as Record<string, unknown>[];
      assertEquals(items[0], {
        variantId: "var-1",
        postId: "post-1",
        accountId: "acc-bsky",
        network: "bluesky",
        handle: "studio.bsky.social",
        format: "post",
        status: "published",
        origin: "recorded",
        day: today,
        attachments: 2,
        tags: 2,
      });
      assertNoMarker(
        calendar,
        "DROP-",
        "permalink",
        "bsky.app",
        "at://",
        "Launch",
      );

      const coverage = written[1].data;
      assertEquals(coverage.from, plusDays(today, -30));
      assertEquals(coverage.to, today);
      assertEquals(coverage.days, 31);
      assertEquals(coverage.connected, 2);
      assertEquals(coverage.neverRead, 0);
      assertEquals(coverage.oldestReadAgeDays, 3);
      assertEquals(coverage.oldestReadHandle, "studio");
      const accounts = coverage.accounts as Record<string, unknown>[];
      assertEquals(accounts.length, 4);
      assertEquals(accounts[0].daysWithData, 2);
      assertEquals(accounts[0].readAgeDays, 0);
      assertEquals(accounts[0].backfillPending, false);
      assertEquals(accounts[1].daysWithData, 1);
      assertEquals(accounts[1].readAgeDays, 3);
      assertEquals(accounts[1].backfillPending, true);
      assertEquals(
        accounts[2].readAgeDays,
        40,
        "a needs_reconnect account is reported but not counted",
      );
      assertFalse("lastCollectedAt" in accounts[3]);
      assertFalse("readAgeDays" in accounts[3]);
    }),
});

Deno.test({
  name: "calendar refuses a bad range before any request",
  ignore: !NET,
  fn: () =>
    withFake({}, async (fake) => {
      const { context, getWrittenResources } = testContext(fake);
      await assertRejects(
        () =>
          behavior.methods.calendar.execute(
            { from: "2026-01-01", to: "2026-12-31" },
            context,
          ),
        Error,
        "at most 62",
      );
      await assertRejects(
        () =>
          behavior.methods.calendar.execute(
            { from: "2026-10-10", to: "2026-10-01" },
            context,
          ),
        Error,
        "is before from",
      );
      assertFalse(
        behavior.methods.calendar.arguments.safeParse({ from: "10/01/2026" })
          .success,
      );
      assertEquals(fake.calls.length, 0);
      assertEquals(getWrittenResources().length, 0);
    }),
});

Deno.test({
  name:
    "report keeps rows and account readings in camelCase, nulls as not reported",
  ignore: !NET,
  fn: () =>
    withFake({}, async (fake) => {
      const { context, getWrittenResources } = testContext(fake);
      await behavior.methods.report.execute(
        { from: "2026-10-01", to: "2026-10-21" },
        context,
      );
      assertEquals(fake.calls[0].path, "/api/reports");
      assertEquals(fake.calls[0].query, {
        from: "2026-10-01",
        to: "2026-10-21",
      });
      const report = getWrittenResources()[0];
      assertEquals(report.name, "report");
      assertEquals(report.data.rowCount, 1);
      assertEquals(report.data.accountCount, 2);
      const rows = report.data.rows as Record<string, unknown>[];
      assertEquals(rows[0].network, "bluesky");
      assertEquals(rows[0].followers, {
        accounts: 1,
        measured: 1,
        atEnd: 1500,
        atStart: 1400,
      });
      const lifetime = rows[0].lifetime as Record<string, unknown>;
      assertEquals(lifetime.published, 4);
      assertEquals(
        (lifetime.metrics as Record<string, unknown>).views,
        900,
      );
      assertEquals((lifetime.metrics as Record<string, unknown>).reach, null);
      const accounts = report.data.accounts as Record<string, unknown>[];
      assertEquals(accounts[0].atEnd, { day: "2026-10-21", followers: 1500 });
      assertEquals(accounts[1].atEnd, { day: "2026-10-21", followers: null });
      assertFalse("atStart" in accounts[1]);
    }),
});

Deno.test({
  name: "activity keeps job states and outcomes, never errors or requesters",
  ignore: !NET,
  fn: () =>
    withFake({}, async (fake) => {
      const { context, getWrittenResources } = testContext(fake);
      await behavior.methods.activity.execute({}, context);
      assertEquals(fake.calls[0].path, "/api/activity");
      const activity = getWrittenResources()[0];
      assertEquals(activity.name, "activity");
      assertEquals(activity.data.day, utcDay(new Date()));
      assertEquals(activity.data.running, 2);
      assertEquals(activity.data.jobCount, 5);
      assertEquals(activity.data.byState, {
        due: 1,
        leased: 1,
        done: 1,
        failed: 1,
        unknown: 0,
        dead: 1,
      });
      const accounts = activity.data.accounts as Record<string, unknown>[];
      const jobs = accounts[0].jobs as Record<string, unknown>[];
      assertEquals(jobs[0], {
        id: "job-1",
        kind: "collect_posts",
        state: "done",
        attempts: 1,
        outcome: "ok",
        createdAt: `${activity.data.day}T09:00:00.000Z`,
        updatedAt: `${activity.data.day}T09:05:00.000Z`,
        nextRunAt: `${activity.data.day}T09:00:00.000Z`,
        run: {
          status: "ok",
          items: 7,
          endedAt: `${activity.data.day}T09:04:00.000Z`,
        },
      });
      assertFalse("run" in jobs[1]);
      assertNoMarker(activity.data, "DROP-", "mine", "person-1");
    }),
});

Deno.test({
  name:
    "jobs is refused to a service token, as socialq documents, and writes nothing",
  ignore: !NET,
  fn: () =>
    withFake({}, async (fake) => {
      const { context, getWrittenResources } = testContext(fake);
      const error = await assertRejects(
        () =>
          behavior.methods.jobs.execute({ state: "dead", limit: 100 }, context),
        SocialqError,
      );
      assertEquals(error.status, 403);
      assertStringIncludes(
        error.message,
        "GET /api/jobs: 403 administrators only",
      );
      assertStringIncludes(error.message, "only an administrator reads");
      assertEquals(fake.calls[0].query, { state: "dead", limit: "100" });
      assertEquals(getWrittenResources().length, 0);
    }),
});

Deno.test({
  name: "jobs keeps kind, state, key and attempts when the ledger answers",
  ignore: !NET,
  fn: () =>
    withFake({}, async (fake) => {
      // What the behavior would write if socialq admitted a token to the
      // ledger. The fake's switch models that one future, nothing deployed.
      fake.ledgerOpen = true;
      const { context, getWrittenResources } = testContext(fake);
      const parsed = behavior.methods.jobs.arguments.parse({});
      assertEquals(parsed, { state: "failed,dead,unknown", limit: 100 });
      await behavior.methods.jobs.execute(parsed, context);
      assertEquals(fake.calls[0].query, {
        state: "failed,dead,unknown",
        limit: "100",
      });
      const jobs = getWrittenResources()[0];
      assertEquals(jobs.name, "jobs");
      assertEquals(jobs.data.states, ["failed", "dead", "unknown"]);
      assertEquals(jobs.data.count, 2);
      assertEquals(jobs.data.truncated, false);
      assertEquals(jobs.data.byState, {
        due: 0,
        leased: 0,
        done: 0,
        failed: 0,
        unknown: 1,
        dead: 1,
      });
      const rows = jobs.data.jobs as Record<string, unknown>[];
      assertEquals(rows[0], {
        id: "job-4",
        kind: "collect_posts",
        state: "dead",
        targetId: "acc-threads",
        operationKey: "collect_posts:acc-threads:2026-10-20",
        attempts: 5,
        nextRunAt: "2026-10-20T09:00:00.000Z",
        createdAt: "2026-10-20T09:00:00.000Z",
        updatedAt: "2026-10-20T10:00:00.000Z",
      });
      assertNoMarker(jobs.data, "DROP-", "handle", "lease_owner", "last_error");

      const limited = testContext(fake);
      await behavior.methods.jobs.execute(
        { state: "", limit: 3 },
        limited.context,
      );
      assertEquals(fake.calls[1].query, { limit: "3" }, "no state lists all");
      assertEquals(limited.getWrittenResources()[0].data.truncated, true);
    }),
});

Deno.test({
  name: "jobs refuses an unknown state before any request",
  ignore: !NET,
  fn: () =>
    withFake({}, async (fake) => {
      const { context } = testContext(fake);
      await assertRejects(
        () =>
          behavior.methods.jobs.execute(
            { state: "dead,stalled", limit: 10 },
            context,
          ),
        Error,
        "unknown job state 'stalled'",
      );
      assertEquals(fake.calls.length, 0);
    }),
});

Deno.test({
  name:
    "taxonomy keeps names, kinds, days and post counts, never briefs or creators",
  ignore: !NET,
  fn: () =>
    withFake({}, async (fake) => {
      const live = testContext(fake);
      await behavior.methods.taxonomy.execute(
        { archived: false },
        live.context,
      );
      assertEquals(fake.calls[0].path, "/api/taxonomy");
      assertEquals(fake.calls[0].query, {});
      const taxonomy = live.getWrittenResources()[0];
      assertEquals(taxonomy.name, "taxonomy");
      assertEquals(taxonomy.data.archived, false);
      assertEquals(taxonomy.data.counts, {
        collections: 1,
        tags: 2,
        labels: 1,
        campaigns: 1,
      });
      assertEquals(taxonomy.data.collections, [
        { id: "col-1", name: "Campaigns", archived: false },
      ]);
      const tags = taxonomy.data.tags as Record<string, unknown>[];
      assertEquals(tags[1], {
        id: "tag-2",
        collectionId: "col-1",
        kind: "campaign",
        name: "Launch",
        startsOn: "2026-10-01",
        endsOn: "2026-10-31",
        posts: 4,
        archived: false,
      });
      assertNoMarker(taxonomy.data, "DROP-", "color", "icon");

      const all = testContext(fake);
      await behavior.methods.taxonomy.execute({ archived: true }, all.context);
      assertEquals(fake.calls[1].query, { archived: "1" });
      const data = all.getWrittenResources()[0].data;
      assertEquals((data.counts as Record<string, number>).collections, 2);
      assertEquals((data.counts as Record<string, number>).tags, 3);
      const archived = (data.tags as Record<string, unknown>[])[2];
      assertEquals(archived.archived, true);
    }),
});

Deno.test({
  name: "every method sends GET and nothing else: the write guard never fires",
  ignore: !NET,
  fn: () =>
    withFake({}, async (fake) => {
      const { context } = testContext(fake);
      await behavior.methods.health.execute({}, context);
      await behavior.methods.me.execute({}, context);
      await behavior.methods.accounts.execute({}, context);
      await behavior.methods.calendar.execute({}, context);
      await behavior.methods.report.execute({}, context);
      await behavior.methods.activity.execute({}, context);
      await behavior.methods.taxonomy.execute({ archived: false }, context);
      await assertRejects(
        () => behavior.methods.jobs.execute({ state: "", limit: 1 }, context),
        SocialqError,
      );
      assertEquals(fake.calls.length, 8);
      assertEquals(new Set(fake.calls.map((c) => c.method)), new Set(["GET"]));
      assertEquals(fake.writesRefused, 0);

      // The guard is live: a write the behavior cannot make is refused.
      const probe = await fetch(`${fake.url}/api/accounts/acc-bsky/collect`, {
        method: "POST",
        headers: {
          "CF-Access-Client-Id": SMOKE.id,
          "CF-Access-Client-Secret": SMOKE.secret,
        },
      });
      assertEquals(probe.status, 403);
      assertEquals(await probe.json(), {
        error: "a service token changes nothing",
      });
      assertEquals(fake.writesRefused, 1);
    }),
});

Deno.test({
  name:
    "a token outside the organization gets 403 and nothing is written or logged",
  ignore: !NET,
  fn: () =>
    withFake({}, async (fake) => {
      const outsider = testContext(fake, OUTSIDER);
      const error = await assertRejects(
        () => behavior.methods.accounts.execute({}, outsider.context),
        SocialqError,
      );
      assertEquals(error.status, 403);
      assertStringIncludes(
        error.message,
        "GET /api/accounts: 403 not a member of this organization",
      );
      assertEquals(outsider.getWrittenResources().length, 0);
      for (const log of outsider.getLogs()) {
        assertFalse(
          JSON.stringify([log.message, log.args]).includes(OUTSIDER.secret),
        );
      }

      const admin = testContext(fake, ADMIN_TOKEN);
      const refused = await assertRejects(
        () => behavior.methods.me.execute({}, admin.context),
        SocialqError,
      );
      assertStringIncludes(refused.message, "never an administrator");

      const stranger = testContext(fake, { id: "nobody", secret: "x" });
      fake.calls.length = 0;
      const unknown = await assertRejects(
        () => behavior.methods.me.execute({}, stranger.context),
        SocialqError,
      );
      assertEquals(
        unknown.status,
        302,
        "Access, not the Worker, turns it away",
      );
      assertStringIncludes(
        unknown.message,
        "Cloudflare Access turned the request away",
      );
      assertEquals(stranger.getWrittenResources().length, 0);
    }),
});

Deno.test({
  name:
    "a wrong secret is reported as Access turning the request away, not followed",
  ignore: !NET,
  fn: () =>
    withFake({}, async (fake) => {
      const { context, getWrittenResources, getLogs } = testContext(fake, {
        id: SMOKE.id,
        secret: "wrong",
      });
      const error = await assertRejects(
        () => behavior.methods.accounts.execute({}, context),
        SocialqError,
      );
      assertEquals(error.status, 302);
      assertStringIncludes(error.message, "GET /api/accounts: 302");
      assertStringIncludes(
        error.message,
        "service token is missing, wrong or not admitted",
      );
      assertEquals(fake.calls.length, 1, "the redirect was not followed");
      assertEquals(getWrittenResources().length, 0);
      for (const log of getLogs()) {
        assertFalse(JSON.stringify([log.message, log.args]).includes("wrong"));
      }
    }),
});

Deno.test({
  name: "errors map 400, 404, 429, a non-JSON page and a host with a path",
  ignore: !NET,
  fn: async () => {
    // A tiny server for the answers the fake does not give: the shapes the
    // transport must survive rather than socialq's routes.
    const answers: Response[] = [];
    const server = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen() {} },
      () => answers.shift() ?? new Response("", { status: 500 }),
    );
    const host = `http://127.0.0.1:${server.addr.port}/prefix/`;
    const run = (response: Response, method = "accounts") => {
      answers.push(response);
      const result = createModelTestContext({
        globalArgs: { host, clientId: "id", clientSecret: "secret" },
      });
      const context: Context = {
        ...result.context,
        globalArgs: { host, clientId: "id", clientSecret: "secret" },
      };
      const execute = method === "health"
        ? behavior.methods.health.execute
        : behavior.methods.accounts.execute;
      return assertRejects(() => execute({}, context), SocialqError);
    };
    try {
      const bad = await run(
        Response.json({ error: "from and to are days, as YYYY-MM-DD" }, {
          status: 400,
        }),
      );
      assertEquals(bad.status, 400);
      assertStringIncludes(
        bad.message,
        "GET /api/accounts: 400 from and to are days",
      );

      const missing = await run(
        Response.json({ error: "no organization answers on this hostname" }, {
          status: 404,
        }),
      );
      assertEquals(missing.status, 404);
      assertStringIncludes(missing.message, "no organization answers");
      assertStringIncludes(missing.message, "(no such route");

      const limited = await run(
        new Response("slow down", {
          status: 429,
          headers: { "Retry-After": "17" },
        }),
      );
      assertEquals(limited.status, 429);
      assertEquals(limited.retryAfterSeconds, 17);
      assertStringIncludes(limited.message, "retry after 17 seconds");

      const html = await run(
        new Response("<html>Sign in</html>", { status: 200 }),
      );
      assertEquals(html.status, 200);
      assertStringIncludes(html.message, "answer was not JSON");
      assertStringIncludes(html.message, "Cloudflare Access");

      const down = await run(new Response("", { status: 503 }), "health");
      assertEquals(down.status, 503);
      assertStringIncludes(down.message, "GET /api/health: 503");
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test("every argument's description is written where the registry reads it", () => {
  // swamp's registry reads arguments from the source text, not the running
  // behavior: the fields written inside the schema's own `z.object({ ... })`,
  // each starting `name: z.<type>(` on one line, with its description in
  // `.describe("...")` as a string literal. The registry reads a single-quoted
  // literal too; this test matches only the double-quoted one, so a
  // description holds no double quote. A spread, a shared schema constant, a
  // field split after `z` or written `z.iso.datetime()` is left out of the
  // registry's argument list; `.meta({ description })`, a constant or a
  // template literal leaves its description empty.
  const objects = objectLiterals(source);
  const schemas: { shape: Record<string, { description?: string }> }[] = [
    behavior.globalArguments,
    ...Object.values(behavior.methods).map((method) => method.arguments),
  ];
  const unread: string[] = [];
  for (const schema of schemas) {
    const names = Object.keys(schema.shape);
    if (names.length === 0) {
      continue;
    }
    const written = objects.find((fields) =>
      fields.length === names.length &&
      fields.every((field, i) => field.startsWith(`${names[i]}:`))
    );
    for (const [i, name] of names.entries()) {
      const text = written?.[i] ?? "";
      const description = schema.shape[name].description;
      const read = description !== undefined &&
        new RegExp(`^${name}:[ \\t]*z\\.\\w+\\(`).test(text) &&
        new RegExp(`\\.describe\\(\\s*${escape(JSON.stringify(description))}`)
          .test(text);
      if (!read) {
        unread.push(name);
      }
    }
  }
  assertEquals(unread, []);
});

/** `text` with every regular-expression metacharacter escaped. */
function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The top-level fields of every `z.object({ ... })` literal in `text`, as written. */
function objectLiterals(text: string): string[][] {
  const objects: string[][] = [];
  const opener = /z\.object\(\{/g;
  for (const match of text.matchAll(opener)) {
    const fields: string[] = [];
    let depth = 0;
    let quote = "";
    let start = match.index + match[0].length;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (quote) {
        if (c === "\\") {
          i++;
        } else if (c === quote) {
          quote = "";
        }
      } else if (c === '"' || c === "'" || c === "`") {
        quote = c;
      } else if ("([{".includes(c)) {
        depth++;
      } else if (depth > 0 && ")]}".includes(c)) {
        depth--;
      } else if (depth === 0 && (c === "," || c === "}")) {
        const field = text.slice(start, i).trim();
        if (field) {
          fields.push(field);
        }
        start = i + 1;
        if (c === "}") {
          break;
        }
      }
    }
    objects.push(fields);
  }
  return objects;
}
