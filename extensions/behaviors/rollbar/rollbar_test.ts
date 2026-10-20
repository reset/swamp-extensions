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
  normalizeOccurrence,
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
