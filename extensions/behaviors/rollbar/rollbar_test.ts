/**
 * Unit tests for the Rollbar behavior. Every request goes through a mocked
 * fetch: nothing here touches the network.
 */

import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1.0.19";
import {
  createModelTestContext,
  type ModelTestContextResult,
  withMockedFetch,
} from "jsr:@swamp-club/swamp-testing@0.20261016.58";
import {
  behavior,
  type Context,
  type GlobalArgs,
  levelName,
  normalizeBucket,
  normalizeEvent,
  normalizeOccurrence,
  normalizeTopActive,
  RollbarError,
  summarize,
} from "./rollbar.ts";

const HOST = "https://crash.example.com";
const TOKEN = "read-token-for-tests";

function testContext(overrides: Partial<GlobalArgs> = {}): {
  context: Context;
  getWrittenResources: ModelTestContextResult["getWrittenResources"];
  getLogs: ModelTestContextResult["getLogs"];
} {
  const globalArgs: GlobalArgs = { host: HOST, token: TOKEN, ...overrides };
  const result = createModelTestContext({ globalArgs: { ...globalArgs } });
  const context: Context = { ...result.context, globalArgs };
  return {
    context,
    getWrittenResources: result.getWrittenResources,
    getLogs: result.getLogs,
  };
}

function envelope(result: unknown, init: ResponseInit = {}): Response {
  return Response.json({ err: 0, result }, init);
}

function rawItem(
  counter: number,
  level: string | number,
  status = "active",
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 1000 + counter,
    counter,
    title: `Crash ${counter}`,
    level,
    status,
    environment: "production",
    total_occurrences: counter * 3,
    unique_occurrences: counter,
    first_occurrence_timestamp: 1_700_000_000,
    last_occurrence_timestamp: 1_700_001_000,
    first_version: "abc123",
    last_version: "def456",
    assigned_user_id: null,
    resolved_in_version: null,
    hash: "should-not-be-kept",
    ...extra,
  };
}

function fullPage(start: number, size = 100): Record<string, unknown>[] {
  return Array.from({ length: size }, (_, i) => rawItem(start + i, "error"));
}

Deno.test("global arguments default the host and require the token", () => {
  const parsed = behavior.globalArguments.parse({ token: "t" });
  assertEquals(parsed.host, "https://api.rollbar.com");
  assertFalse(behavior.globalArguments.safeParse({}).success);
  assertFalse(behavior.globalArguments.safeParse({ token: "" }).success);
});

Deno.test("items sends the token header and filters, pages until a short page", async () => {
  const { context, getWrittenResources } = testContext({
    environment: "production",
  });
  const { calls } = await withMockedFetch(
    (req) => {
      const url = new URL(req.url);
      const page = Number(url.searchParams.get("page"));
      return envelope({
        page,
        items: page === 1 ? fullPage(1) : [
          rawItem(101, "critical"),
          rawItem(102, "warning", "resolved"),
          rawItem(103, 40, "muted"),
        ],
      });
    },
    () =>
      behavior.methods.items.execute(
        { status: "active", level: undefined, page: 1, pages: 3 },
        context,
      ),
  );

  assertEquals(calls.length, 2, "a short second page ends the loop");
  assertEquals(calls[0].method, "GET");
  assertEquals(calls[0].headers["x-rollbar-access-token"], TOKEN);
  const first = new URL(calls[0].url);
  assertEquals(first.origin + first.pathname, `${HOST}/api/1/items/`);
  assertEquals(first.searchParams.get("status"), "active");
  assertEquals(first.searchParams.get("environment"), "production");
  assertEquals(first.searchParams.get("page"), "1");
  assertFalse(
    first.searchParams.has("level"),
    "undefined filters are left out",
  );

  const written = getWrittenResources();
  assertEquals(
    written.map((w) => [w.specName, w.name]),
    [
      ["items", "items"],
      ["summary", "summary"],
    ],
  );
  const items = written[0].data;
  assertEquals(items.count, 103);
  assertEquals(items.truncated, false);
  assertEquals(items.pagesFetched, 2);
  assertEquals(items.filters, { status: "active", environment: "production" });
  const list = items.items as Record<string, unknown>[];
  assertEquals(list[102].level, "error", "numeric levels are named");
  assertEquals(list[0].firstVersion, "abc123");
  assertFalse("hash" in list[0], "unknown fields are dropped");
  assertFalse("assignedUserId" in list[0], "nulls are dropped");

  const summary = written[1].data;
  assertEquals(summary.activeErrors, 101);
  assertEquals(summary.byLevel, {
    debug: 0,
    info: 0,
    warning: 1,
    error: 101,
    critical: 1,
  });
  assertEquals(summary.byStatus, {
    active: 101,
    resolved: 1,
    muted: 1,
    archived: 0,
  });
  assertEquals(summary.count, 103);
});

Deno.test("items marks a full last page truncated and honours total_count", async () => {
  const full = testContext();
  await withMockedFetch(
    [envelope({ items: fullPage(1) })],
    () => behavior.methods.items.execute({ page: 1, pages: 1 }, full.context),
  );
  assertEquals(full.getWrittenResources()[0].data.truncated, true);

  const counted = testContext();
  await withMockedFetch(
    [envelope({ items: fullPage(1), total_count: 100 })],
    () =>
      behavior.methods.items.execute({ page: 1, pages: 1 }, counted.context),
  );
  assertEquals(counted.getWrittenResources()[0].data.truncated, false);
});

Deno.test("items writes nothing when the API refuses", async () => {
  const { context, getWrittenResources, getLogs } = testContext();
  const error = await assertRejects(
    () =>
      withMockedFetch(
        [
          Response.json(
            { err: 1, message: "invalid access token" },
            {
              status: 403,
            },
          ),
        ],
        () => behavior.methods.items.execute({ page: 1, pages: 1 }, context),
      ),
    RollbarError,
  );
  assertEquals(error.status, 403);
  assertStringIncludes(error.message, "GET /api/1/items/: 403");
  assertStringIncludes(error.message, "invalid access token");
  assertStringIncludes(error.message, "lacks the scope");
  assertEquals(getWrittenResources().length, 0);
  for (const log of getLogs()) {
    assertFalse(JSON.stringify([log.message, log.args]).includes(TOKEN));
  }
});

Deno.test("errors map 401, 404, 429, err:1 and non-JSON answers", async () => {
  const run = (response: Response) => {
    const { context } = testContext();
    return assertRejects(
      () =>
        withMockedFetch(
          [response],
          () => behavior.methods.items.execute({ page: 1, pages: 1 }, context),
        ),
      RollbarError,
    );
  };

  const unauthorized = await run(new Response("", { status: 401 }));
  assertEquals(unauthorized.status, 401);
  assertStringIncludes(unauthorized.message, "missing or malformed");

  const missing = await run(
    Response.json({ err: 1, message: "Item not found" }, { status: 404 }),
  );
  assertEquals(missing.status, 404);
  assertStringIncludes(missing.message, "Item not found");

  const limited = await run(
    new Response("rate limited", {
      status: 429,
      headers: { "X-Rate-Limit-Remaining-Seconds": "17" },
    }),
  );
  assertEquals(limited.status, 429);
  assertEquals(limited.retryAfterSeconds, 17);
  assertStringIncludes(limited.message, "retry after 17 seconds");

  const retryAfter = await run(
    new Response("", { status: 429, headers: { "Retry-After": "5" } }),
  );
  assertEquals(retryAfter.retryAfterSeconds, 5);

  const refused = await run(Response.json({ err: 1, message: "bad query" }));
  assertEquals(refused.status, 200);
  assertStringIncludes(refused.message, "bad query");

  const html = await run(new Response("<html>", { status: 200 }));
  assertStringIncludes(html.message, "not JSON");
});

Deno.test("host joins a trailing slash and a path prefix", async () => {
  const { context } = testContext({
    host: "https://proxy.example.com/rollbar/",
  });
  const { calls } = await withMockedFetch(
    [envelope({ items: [] })],
    () => behavior.methods.items.execute({ page: 1, pages: 1 }, context),
  );
  assertStringIncludes(
    calls[0].url,
    "https://proxy.example.com/rollbar/api/1/items/?page=1",
  );
});

Deno.test("item reads by counter through item_by_counter and by id directly", async () => {
  const byCounter = testContext();
  const first = await withMockedFetch(
    [envelope(rawItem(42, "error"))],
    () => behavior.methods.item.execute({ counter: 42 }, byCounter.context),
  );
  assertEquals(first.calls[0].url, `${HOST}/api/1/item_by_counter/42`);
  const written = byCounter.getWrittenResources();
  assertEquals(written[0].specName, "item");
  assertEquals(written[0].name, "item-42");
  assertEquals(written[0].data.id, 1042);
  assertEquals(written[0].data.host, HOST);
  assertEquals(first.result.dataHandles.length, 1);

  const byId = testContext();
  const second = await withMockedFetch(
    [envelope(rawItem(7, "error"))],
    () => behavior.methods.item.execute({ id: 1007 }, byId.context),
  );
  assertEquals(second.calls[0].url, `${HOST}/api/1/item/1007`);
});

Deno.test("item references need exactly one of id or counter", () => {
  const schema = behavior.methods.item.arguments;
  assertFalse(schema.safeParse({}).success);
  assertFalse(schema.safeParse({ id: 1, counter: 2 }).success);
  assert(schema.safeParse({ counter: 2 }).success);
  assertFalse(
    behavior.methods.occurrences.arguments.safeParse({ limit: 5 }).success,
  );
});

Deno.test("occurrences keep triage fields only and never the payload", async () => {
  const { context, getWrittenResources } = testContext();
  const longMessage = "x".repeat(400);
  const instances = [
    {
      id: 501,
      timestamp: 1_700_002_000,
      data: {
        environment: "production",
        code_version: "def456",
        level: "error",
        body: {
          trace: {
            frames: [{ filename: "Game.cs", lineno: 10 }],
            exception: {
              class: "NullReferenceException",
              message: longMessage,
            },
          },
        },
        person: { id: "3f0c6a5e-0000-4000-8000-000000000001" },
        custom: { steam_id: "76561197960287930" },
      },
    },
    {
      id: 502,
      timestamp: 1_700_002_100,
      data: {
        environment: "production",
        level: 50,
        body: {
          trace_chain: [
            { exception: { class: "Outer", message: "outer" } },
            { exception: { class: "Inner", message: "inner" } },
          ],
        },
      },
    },
    {
      id: 503,
      data: { body: { message: { body: "Audio device lost" } } },
    },
  ];
  const { calls } = await withMockedFetch(
    (req) => {
      if (req.url.endsWith("/api/1/item_by_counter/42")) {
        return envelope(rawItem(42, "error"));
      }
      return envelope({ instances });
    },
    () =>
      behavior.methods.occurrences.execute(
        { counter: 42, limit: 3, page: 2 },
        context,
      ),
  );

  assertEquals(calls.length, 2);
  assertEquals(
    calls[1].url,
    `${HOST}/api/1/item/1042/instances/?page=2&limit=3`,
  );

  const written = getWrittenResources();
  assertEquals(written[0].specName, "occurrences");
  assertEquals(written[0].name, "occurrences-42");
  const data = written[0].data;
  assertEquals(data.itemId, 1042);
  assertEquals(data.count, 3);
  assertEquals(
    data.truncated,
    true,
    "three rows at limit three: more may exist",
  );
  const rows = data.occurrences as Record<string, unknown>[];
  assertEquals(rows[0], {
    id: 501,
    timestamp: 1_700_002_000,
    environment: "production",
    codeVersion: "def456",
    level: "error",
    exceptionClass: "NullReferenceException",
    exceptionMessage: "x".repeat(300),
  });
  assertEquals(rows[1].exceptionClass, "Outer");
  assertEquals(rows[1].level, "critical");
  assertEquals(rows[2], { id: 503, exceptionMessage: "Audio device lost" });
  const serialized = JSON.stringify(data);
  assertFalse(serialized.includes("person"));
  assertFalse(serialized.includes("7656119"));
  assertFalse(serialized.includes("frames"));
});

Deno.test("resolve patches status and version, then re-reads the item", async () => {
  const { context, getWrittenResources } = testContext();
  const { calls } = await withMockedFetch(
    (req) => {
      if (req.method === "PATCH") return envelope({});
      return envelope(
        rawItem(42, "error", "resolved", { resolved_in_version: "1.2.3" }),
      );
    },
    () =>
      behavior.methods.resolve.execute(
        { counter: 42, resolvedInVersion: "1.2.3" },
        context,
      ),
  );

  assertEquals(
    calls.map((c) => `${c.method} ${new URL(c.url).pathname}`),
    [
      "GET /api/1/item_by_counter/42",
      "PATCH /api/1/item/1042",
      "GET /api/1/item/1042",
    ],
  );
  assertEquals(calls[1].headers["content-type"], "application/json");
  assertEquals(JSON.parse(calls[1].body ?? ""), {
    status: "resolved",
    resolved_in_version: "1.2.3",
  });
  const written = getWrittenResources();
  assertEquals(written[0].name, "item-42");
  assertEquals(written[0].data.status, "resolved");
  assertEquals(written[0].data.resolvedInVersion, "1.2.3");
});

Deno.test("mute and assign patch by id without a lookup", async () => {
  const muted = testContext();
  const mute = await withMockedFetch(
    [envelope({}), envelope(rawItem(9, "error", "muted"))],
    () => behavior.methods.mute.execute({ id: 1009 }, muted.context),
  );
  assertEquals(mute.calls[0].method, "PATCH");
  assertEquals(JSON.parse(mute.calls[0].body ?? ""), { status: "muted" });
  assertEquals(muted.getWrittenResources()[0].data.status, "muted");

  const assigned = testContext();
  const assign = await withMockedFetch(
    [
      envelope({}),
      envelope(rawItem(9, "error", "active", { assigned_user_id: 77 })),
    ],
    () =>
      behavior.methods.assign.execute(
        { id: 1009, assignedUserId: 77 },
        assigned.context,
      ),
  );
  assertEquals(JSON.parse(assign.calls[0].body ?? ""), {
    assigned_user_id: 77,
  });
  assertEquals(assigned.getWrittenResources()[0].data.assignedUserId, 77);
});

Deno.test("write failures leave nothing written", async () => {
  const { context, getWrittenResources } = testContext();
  const error = await assertRejects(
    () =>
      withMockedFetch(
        [
          Response.json(
            { err: 1, message: "write scope required" },
            {
              status: 403,
            },
          ),
        ],
        () => behavior.methods.mute.execute({ id: 1009 }, context),
      ),
    RollbarError,
  );
  assertStringIncludes(error.message, "PATCH /api/1/item/1009: 403");
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("deploy posts snake_case fields and reads both answer shapes", async () => {
  const bare = testContext({ environment: "staging" });
  const first = await withMockedFetch(
    [Response.json({ data: { deploy_id: 310 } })],
    () =>
      behavior.methods.deploy.execute(
        {
          revision: "abc123",
          localUsername: "ci",
          comment: "nightly",
          status: "started",
        },
        bare.context,
      ),
  );
  assertEquals(first.calls[0].method, "POST");
  assertEquals(first.calls[0].url, `${HOST}/api/1/deploy/`);
  assertEquals(JSON.parse(first.calls[0].body ?? ""), {
    environment: "staging",
    revision: "abc123",
    local_username: "ci",
    comment: "nightly",
    status: "started",
  });
  const written = bare.getWrittenResources();
  assertEquals(written[0].specName, "deploy");
  assertEquals(written[0].name, "deploy-310");
  assertEquals(written[0].data.environment, "staging");
  assertEquals(written[0].data.status, "started");
  assertEquals(written[0].data.localUsername, "ci");

  const enveloped = testContext();
  await withMockedFetch(
    [envelope({ deploy_id: 311 })],
    () =>
      behavior.methods.deploy.execute(
        { environment: "production", revision: "def456" },
        enveloped.context,
      ),
  );
  const second = enveloped.getWrittenResources()[0];
  assertEquals(second.name, "deploy-311");
  assertEquals(second.data.status, "succeeded", "the API default is recorded");
  assertFalse("comment" in second.data);
});

Deno.test("deploy refuses to run without an environment", async () => {
  const { context, getWrittenResources } = testContext();
  const { calls } = await withMockedFetch([], async () => {
    await assertRejects(
      () => behavior.methods.deploy.execute({ revision: "abc" }, context),
      Error,
      "needs an environment",
    );
  });
  assertEquals(calls.length, 0);
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("deploys lists a page for the environment and marks a full page", async () => {
  const { context, getWrittenResources } = testContext({
    environment: "production",
  });
  const deploys = Array.from({ length: 20 }, (_, i) => ({
    id: 200 + i,
    environment: "production",
    revision: `rev${i}`,
    status: "succeeded",
    local_username: "ci",
    comment: null,
    start_time: 1_700_000_000 + i,
    finish_time: 1_700_000_010 + i,
  }));
  const { calls } = await withMockedFetch(
    [envelope({ deploys, page: 2 })],
    () => behavior.methods.deploys.execute({ page: 2 }, context),
  );
  assertEquals(
    calls[0].url,
    `${HOST}/api/1/deploys/?environment=production&page=2`,
  );
  const written = getWrittenResources();
  assertEquals(written[0].specName, "deploys");
  assertEquals(written[0].name, "deploys");
  assertEquals(written[0].data.count, 20);
  assertEquals(written[0].data.truncated, true);
  assertEquals(written[0].data.environment, "production");
  const rows = written[0].data.deploys as Record<string, unknown>[];
  assertEquals(rows[0], {
    id: 200,
    environment: "production",
    revision: "rev0",
    status: "succeeded",
    localUsername: "ci",
    startTime: 1_700_000_000,
    finishTime: 1_700_000_010,
  });
});

Deno.test("levelName, summarize and normalizeOccurrence handle odd input", () => {
  assertEquals(levelName(40), "error");
  assertEquals(levelName("ERROR"), "error");
  assertEquals(levelName(99), "99");
  assertEquals(levelName(undefined), "unknown");

  const summary = summarize([
    {
      id: 1,
      counter: 1,
      title: "",
      level: "fatal",
      status: "active",
      environment: "",
      totalOccurrences: 0,
    },
  ]);
  assertEquals(summary.activeErrors, 0, "unknown levels are not errors");
  assertEquals(summary.byStatus.active, 1);

  assertEquals(normalizeOccurrence({ id: 1 }), { id: 1 });
  assertEquals(normalizeOccurrence({ id: "2", data: { body: {} } }), {
    id: 2,
  });
});

// ---------------------------------------------------------------------------
// Reports, events and the fingerprint test
// ---------------------------------------------------------------------------

/** Sixty report rows as Rollbar and crashq answer them: `[timestamp, count]`. */
function pairs(size: number, count: number, last: number): number[][] {
  const since = 1_761_000_000 - (count - 1) * size;
  return Array.from({ length: count }, (_, i) => [
    since + i * size,
    i === count - 1 ? last : i,
  ]);
}

Deno.test("occurrence-counts sends the filters, keeps the buckets and flattens the newest", async () => {
  const { context, getWrittenResources } = testContext({
    environment: "production",
  });
  const rows = pairs(86400, 60, 4);
  const { calls } = await withMockedFetch(
    [envelope(rows)],
    () =>
      behavior.methods["occurrence-counts"].execute(
        { bucketSize: 86400, itemId: 1042 },
        context,
      ),
  );
  const url = new URL(calls[0].url);
  assertEquals(url.pathname, "/api/1/reports/occurrence_counts");
  assertEquals(url.searchParams.get("bucket_size"), "86400");
  assertEquals(url.searchParams.get("environments"), "production");
  assertEquals(url.searchParams.get("min_level"), "error");
  assertEquals(url.searchParams.get("item_id"), "1042");
  assertFalse(url.searchParams.has("max_level"), "no max level was given");
  assertEquals(calls[0].headers["x-rollbar-access-token"], TOKEN);

  const written = getWrittenResources();
  assertEquals(written.map((w) => [w.specName, w.name]), [
    ["occurrence-counts", "occurrence-counts"],
  ]);
  const data = written[0].data;
  assertEquals(data.environments, ["production"]);
  assertEquals(data.bucketSize, 86400);
  assertEquals(data.minLevel, "error");
  assertEquals(data.itemId, 1042);
  assertFalse("maxLevel" in data);
  assertEquals(data.count, 60);
  assertEquals(data.total, 59 * 58 / 2 + 4);
  assertEquals(data.newestTimestamp, 1_761_000_000);
  assertEquals(data.newestCount, 4);
  const buckets = data.buckets as Record<string, unknown>[];
  assertEquals(buckets[0], { timestamp: rows[0][0], count: 0 });
  assertEquals(buckets[59], { timestamp: 1_761_000_000, count: 4 });
});

Deno.test("occurrence-counts joins environments, sends both levels and reads an empty report", async () => {
  const { context, getWrittenResources } = testContext({
    environment: "production",
  });
  const { calls } = await withMockedFetch(
    [envelope([])],
    () =>
      behavior.methods["occurrence-counts"].execute(
        {
          bucketSize: 3600,
          environments: ["staging", "qa"],
          minLevel: "warning",
          maxLevel: "error",
        },
        context,
      ),
  );
  const url = new URL(calls[0].url);
  assertEquals(
    url.searchParams.get("environments"),
    "staging,qa",
    "the argument overrides the global environment",
  );
  assertEquals(url.searchParams.get("min_level"), "warning");
  assertEquals(url.searchParams.get("max_level"), "error");
  const data = getWrittenResources()[0].data;
  assertEquals(data.count, 0);
  assertEquals(data.total, 0);
  assertFalse("newestCount" in data, "an empty report has no newest bucket");
  assertEquals(data.environments, ["staging", "qa"]);
});

Deno.test("activated-counts asks for the buckets and leaves environments out when none apply", async () => {
  const { context, getWrittenResources } = testContext();
  const rows = pairs(86400, 7, 2);
  const { calls } = await withMockedFetch(
    [envelope(rows)],
    () => behavior.methods["activated-counts"].execute({ buckets: 7 }, context),
  );
  const url = new URL(calls[0].url);
  assertEquals(url.pathname, "/api/1/reports/activated_counts");
  assertEquals(url.searchParams.get("buckets"), "7");
  assertFalse(url.searchParams.has("environments"));
  const written = getWrittenResources();
  assertEquals(written[0].specName, "activated-counts");
  assertEquals(written[0].name, "activated-counts");
  assertEquals(written[0].data.bucketsRequested, 7);
  assertEquals(written[0].data.count, 7);
  assertEquals(written[0].data.environments, []);
  assertEquals(written[0].data.newestCount, 2);
  assertEquals(written[0].data.total, 0 + 1 + 2 + 3 + 4 + 5 + 2);
});

Deno.test("top-active reads Rollbar's item shape and crashq's, and sorts on request", async () => {
  const rollbar = testContext();
  const first = await withMockedFetch(
    [
      envelope([
        {
          item: {
            id: 1042,
            counter: 42,
            title: "t".repeat(400),
            level: 50,
            environment: "production",
            framework: 0,
            occurrences: 17,
            unique_occurrences: 5,
            last_occurrence_timestamp: 1_761_000_000,
            project_id: 1,
          },
          counts: [0, 0, 5, 12],
        },
      ]),
    ],
    () =>
      behavior.methods["top-active"].execute(
        { hours: 4, byOccurrences: true },
        rollbar.context,
      ),
  );
  const url = new URL(first.calls[0].url);
  assertEquals(url.pathname, "/api/1/reports/top_active_items");
  assertEquals(url.searchParams.get("hours"), "4");
  assertEquals(url.searchParams.get("sort"), "occurrences");
  const written = rollbar.getWrittenResources();
  assertEquals(written[0].specName, "top-active");
  assertEquals(written[0].name, "top-active");
  assertEquals(written[0].data.sort, "occurrences");
  assertEquals(written[0].data.count, 1);
  const rows = written[0].data.items as Record<string, unknown>[];
  assertEquals(rows[0], {
    id: 1042,
    counter: 42,
    title: "t".repeat(300),
    level: "critical",
    environment: "production",
    occurrences: 17,
    uniqueOccurrences: 5,
    lastOccurrenceTimestamp: 1_761_000_000,
    counts: [0, 0, 5, 12],
  });
  assertFalse("framework" in rows[0]);

  const crashq = testContext({ environment: "production" });
  const second = await withMockedFetch(
    [
      envelope([
        { item: rawItem(7, "error"), counts: [1, 2, 3] },
        { item: rawItem(8, "warning"), counts: [] },
      ]),
    ],
    () =>
      behavior.methods["top-active"].execute(
        { hours: 24, byOccurrences: false },
        crashq.context,
      ),
  );
  const crashqUrl = new URL(second.calls[0].url);
  assertFalse(
    crashqUrl.searchParams.has("sort"),
    "the default order is level then occurrences",
  );
  assertEquals(crashqUrl.searchParams.get("environments"), "production");
  const items = crashq.getWrittenResources()[0].data.items as Record<
    string,
    unknown
  >[];
  assertEquals(items[0].occurrences, 6, "the window's count is the sum");
  assertEquals(items[0].totalOccurrences, 21);
  assertEquals(items[0].status, "active");
  assertEquals(items[0].firstVersion, undefined, "versions are not kept");
  assertEquals(items[1].occurrences, 0);
  assertEquals(crashq.getWrittenResources()[0].data.sort, "level");
});

Deno.test("events resolve a counter, keep the history and cut long values", async () => {
  const { context, getWrittenResources } = testContext();
  const events = [
    {
      id: 1,
      project_id: 1,
      item_id: 1042,
      timestamp: 1_760_000_000,
      type: "status",
      old_value: "resolved",
      new_value: "active",
      user_id: null,
      occurrence_id: 501,
    },
    {
      id: 2,
      project_id: 1,
      item_id: 1042,
      timestamp: 1_760_000_100,
      type: "comment",
      old_value: null,
      new_value: "c".repeat(400),
      user_id: 77,
      occurrence_id: null,
    },
    { id: 3, type: "title", old_value: "a", new_value: { odd: true } },
  ];
  const { calls } = await withMockedFetch(
    (req) => {
      if (req.url.endsWith("/api/1/item_by_counter/42")) {
        return envelope(rawItem(42, "error"));
      }
      return envelope({ events });
    },
    () => behavior.methods.events.execute({ counter: 42 }, context),
  );
  assertEquals(
    calls.map((c) => new URL(c.url).pathname),
    ["/api/1/item_by_counter/42", "/api/1/item/1042/events"],
  );
  const written = getWrittenResources();
  assertEquals(written[0].specName, "events");
  assertEquals(written[0].name, "events-42");
  assertEquals(written[0].data.itemId, 1042);
  assertEquals(written[0].data.count, 3);
  const rows = written[0].data.events as Record<string, unknown>[];
  assertEquals(rows[0], {
    id: 1,
    timestamp: 1_760_000_000,
    type: "status",
    oldValue: "resolved",
    newValue: "active",
    occurrenceId: 501,
  });
  assertEquals(rows[1].newValue, "c".repeat(300));
  assertEquals(rows[1].userId, 77);
  assertFalse("occurrenceId" in rows[1]);
  assertEquals(rows[2], {
    id: 3,
    type: "title",
    oldValue: "a",
    newValue: '{"odd":true}',
  });
  assertFalse(JSON.stringify(written[0].data).includes("project_id"));
});

Deno.test("events by id skip the lookup", async () => {
  const { context } = testContext();
  const { calls } = await withMockedFetch(
    [envelope(rawItem(7, "error")), envelope({ events: [] })],
    () => behavior.methods.events.execute({ id: 1007 }, context),
  );
  assertEquals(
    calls.map((c) => new URL(c.url).pathname),
    ["/api/1/item/1007", "/api/1/item/1007/events"],
  );
});

Deno.test("fingerprint-test posts the occurrence id and keeps the grouping only", async () => {
  const stored = testContext();
  const first = await withMockedFetch(
    [
      envelope({
        rule: null,
        fingerprint: "NullReferenceException Game.cs Update",
        hash: "0123abcd",
        title: "NullReferenceException: Object reference not set",
        item: { id: 1042, counter: 42 },
      }),
    ],
    () =>
      behavior.methods["fingerprint-test"].execute(
        { projectId: 3, instance: 501 },
        stored.context,
      ),
  );
  assertEquals(first.calls[0].method, "POST");
  assertEquals(
    first.calls[0].url,
    `${HOST}/api/1/project/3/fingerprint_rules/test`,
  );
  assertEquals(first.calls[0].headers["content-type"], "application/json");
  assertEquals(JSON.parse(first.calls[0].body ?? ""), { instance: 501 });
  const written = stored.getWrittenResources();
  assertEquals(written[0].specName, "fingerprint-test");
  assertEquals(written[0].name, "fingerprint-test-501");
  assertEquals(written[0].data, {
    testedAt: written[0].data.testedAt,
    host: HOST,
    projectId: 3,
    instance: 501,
    rulesSent: false,
    itemId: 1042,
    counter: 42,
    fingerprint: "NullReferenceException Game.cs Update",
    hash: "0123abcd",
    title: "NullReferenceException: Object reference not set",
  });

  const tried = testContext();
  const rules = [
    {
      condition: { path: "body.trace.exception.class", eq: "Stuck" },
      fingerprint: "stuck",
      title: "Stuck",
    },
  ];
  const second = await withMockedFetch(
    [
      envelope({
        rule: 0,
        fingerprint: "stuck",
        hash: "ffff",
        title: "Stuck",
        item: null,
      }),
    ],
    () =>
      behavior.methods["fingerprint-test"].execute(
        { projectId: 3, instance: 502, rules, ignoreClientFingerprint: true },
        tried.context,
      ),
  );
  assertEquals(JSON.parse(second.calls[0].body ?? ""), {
    instance: 502,
    rules,
    ignore_client_fingerprint: true,
  });
  const data = tried.getWrittenResources()[0].data;
  assertEquals(data.rule, 0);
  assertEquals(data.rulesSent, true);
  assertFalse("itemId" in data, "no item counts it yet");
  assertFalse(JSON.stringify(data).includes("condition"));
});

Deno.test("reports and the fingerprint test write nothing on a scope refusal", async () => {
  const refusal = () =>
    Response.json(
      {
        err: 1,
        message: "token has scope post_server_item, this call needs read",
      },
      { status: 403 },
    );
  const runs: [string, (context: Context) => Promise<unknown>][] = [
    [
      "GET /api/1/reports/occurrence_counts",
      (context) =>
        behavior.methods["occurrence-counts"].execute(
          { bucketSize: 86400 },
          context,
        ),
    ],
    [
      "GET /api/1/reports/activated_counts",
      (context) =>
        behavior.methods["activated-counts"].execute({ buckets: 60 }, context),
    ],
    [
      "GET /api/1/reports/top_active_items",
      (context) =>
        behavior.methods["top-active"].execute(
          { hours: 24, byOccurrences: false },
          context,
        ),
    ],
    [
      "GET /api/1/item/1007/events",
      (context) => behavior.methods.events.execute({ id: 1007 }, context),
    ],
    [
      "POST /api/1/project/3/fingerprint_rules/test",
      (context) =>
        behavior.methods["fingerprint-test"].execute(
          { projectId: 3, instance: 501 },
          context,
        ),
    ],
  ];
  for (const [label, run] of runs) {
    const { context, getWrittenResources, getLogs } = testContext();
    const error = await assertRejects(
      () =>
        withMockedFetch(
          (req) =>
            req.url.endsWith("/api/1/item/1007")
              ? envelope(rawItem(7, "error"))
              : refusal(),
          () => run(context),
        ),
      RollbarError,
    );
    assertEquals(error.status, 403, label);
    assertStringIncludes(error.message, `${label}: 403`);
    assertStringIncludes(error.message, "needs read");
    assertStringIncludes(error.message, "lacks the scope");
    assertEquals(getWrittenResources().length, 0, label);
    for (const log of getLogs()) {
      assertFalse(JSON.stringify([log.message, log.args]).includes(TOKEN));
    }
  }
});

Deno.test("report answers that are not pairs fail before anything is written", async () => {
  const { context, getWrittenResources } = testContext();
  await assertRejects(
    () =>
      withMockedFetch(
        [envelope([[1_761_000_000, "many"]])],
        () =>
          behavior.methods["activated-counts"].execute(
            { buckets: 60 },
            context,
          ),
      ),
    Error,
    "not a [timestamp, count] pair",
  );
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("report, event and fingerprint arguments are bounded", () => {
  const counts = behavior.methods["occurrence-counts"].arguments;
  assertEquals(counts.parse({}).bucketSize, 86400);
  assertFalse(counts.safeParse({ bucketSize: 120 }).success);
  assertFalse(counts.safeParse({ minLevel: "fatal" }).success);
  assertFalse(counts.safeParse({ environments: [""] }).success);

  const activated = behavior.methods["activated-counts"].arguments;
  assertEquals(activated.parse({}).buckets, 60);
  assertFalse(activated.safeParse({ buckets: 1 }).success);
  assertFalse(activated.safeParse({ buckets: 367 }).success);

  const top = behavior.methods["top-active"].arguments;
  assertEquals(top.parse({}), { hours: 24, byOccurrences: false });
  assertFalse(top.safeParse({ hours: 0 }).success);
  assertFalse(top.safeParse({ hours: 169 }).success);

  assertFalse(behavior.methods.events.arguments.safeParse({}).success);

  const test = behavior.methods["fingerprint-test"].arguments;
  assertFalse(test.safeParse({ instance: 1 }).success);
  assertFalse(test.safeParse({ projectId: 1 }).success);
  assertFalse(
    test.safeParse({ projectId: 1, instance: 1, rules: [1] }).success,
  );
  assert(test.safeParse({ projectId: 1, instance: 1, rules: [{}] }).success);
});

Deno.test("normalizeBucket, normalizeTopActive and normalizeEvent handle odd input", () => {
  assertEquals(normalizeBucket([1, 2]), { timestamp: 1, count: 2 });
  assertEquals(normalizeBucket({ timestamp: "3", count: 4 }), {
    timestamp: 3,
    count: 4,
  });
  assertThrows(() => normalizeBucket([1]), Error, "pair");
  assertThrows(() => normalizeBucket("x"), Error, "pair");
  assertThrows(() => normalizeTopActive({ counts: [] }), Error, "no item");
  assertThrows(
    () => normalizeTopActive({ item: { title: "x" } }),
    Error,
    "no id and counter",
  );
  assertEquals(
    normalizeTopActive({ item: { id: 1, counter: 2 }, counts: ["a", 3] }),
    {
      id: 1,
      counter: 2,
      title: "",
      level: "unknown",
      environment: "",
      occurrences: 3,
      counts: [3],
    },
  );
  assertEquals(normalizeEvent({ id: 9 }), { id: 9, type: "unknown" });
  assertThrows(() => normalizeEvent({}), Error, "no id");
});

Deno.test("the version bump carries a no-op upgrade to the same version", () => {
  const last = behavior.upgrades[behavior.upgrades.length - 1];
  assertEquals(last.toVersion, behavior.version);
  const args = { host: HOST, token: TOKEN };
  assertEquals(last.upgradeAttributes(args), args);
});
