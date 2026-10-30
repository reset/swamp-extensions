/**
 * Unit tests for the Steam concurrent players behavior. Every test injects a
 * fetch, a clock and, for `summarise`, a query, so nothing here reaches Steam
 * or a swamp datastore.
 *
 * @module
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20261016.58";
import {
  behavior,
  type Fetcher,
  fetchPlayerCount,
  type MethodContext,
  PLAYER_COUNT_URL,
  type Sample,
  summarise,
} from "./steam_players.ts";
import source from "./steam_players.ts" with { type: "text" };

const APP_ID = 440;
const MODEL_ID = "00000000-0000-4000-8000-000000000440";
const NOW = new Date("2026-10-21T12:00:00.000Z");

/** A fetch that answers every request with one status and body, recording the URLs. */
function fakeFetch(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): { fetcher: Fetcher; urls: string[]; inits: (RequestInit | undefined)[] } {
  const urls: string[] = [];
  const inits: (RequestInit | undefined)[] = [];
  const fetcher: Fetcher = (input, init) => {
    urls.push(input);
    inits.push(init);
    return Promise.resolve(new Response(body, { status, headers }));
  };
  return { fetcher, urls, inits };
}

/** A test context with the behavior's global arguments, id and an optional query. */
function testContext(
  queryData?: (predicate: string) => Promise<unknown[]>,
): {
  context: MethodContext;
  written: ReturnType<typeof createModelTestContext>["getWrittenResources"];
  logs: ReturnType<typeof createModelTestContext>["getLogs"];
} {
  const test = createModelTestContext({ globalArgs: { appId: APP_ID } });
  const context: MethodContext = {
    ...test.context,
    globalArgs: { appId: APP_ID },
    modelId: MODEL_ID,
    queryData,
  };
  return {
    context,
    written: test.getWrittenResources,
    logs: test.getLogs,
  };
}

/** A stored sample record as queryData returns it. */
function record(version: number, sample: Sample): unknown {
  return { version, name: `app-${sample.appId}`, attributes: sample };
}

Deno.test("sample requests the documented URL with the app id", async () => {
  const { fetcher, urls, inits } = fakeFetch(
    200,
    '{"response":{"player_count":61234,"result":1}}',
  );
  const { context } = testContext();
  await behavior.methods.sample.execute(
    { _fetch: fetcher, _now: () => NOW },
    context,
  );
  assertEquals(urls, [`${PLAYER_COUNT_URL}?appid=${APP_ID}`]);
  assertEquals(inits[0]?.method, "GET");
  assert(inits[0]?.signal instanceof AbortSignal);
});

Deno.test("sample records the count, app id and time as a sample", async () => {
  const { fetcher } = fakeFetch(
    200,
    '{"response":{"player_count":61234,"result":1}}',
  );
  const { context, written } = testContext();
  const result = await behavior.methods.sample.execute(
    { _fetch: fetcher, _now: () => NOW },
    context,
  );
  const writes = written();
  assertEquals(writes.length, 1);
  assertEquals(writes[0].specName, "sample");
  assertEquals(writes[0].name, "app-440");
  assertEquals(writes[0].data, {
    appId: APP_ID,
    playerCount: 61234,
    sampledAt: NOW.toISOString(),
  });
  assertEquals(result.dataHandles.length, 1);
});

Deno.test("sample records a count of zero", async () => {
  const { fetcher } = fakeFetch(
    200,
    '{"response":{"player_count":0,"result":1}}',
  );
  const { context, written } = testContext();
  await behavior.methods.sample.execute(
    { _fetch: fetcher, _now: () => NOW },
    context,
  );
  assertEquals(written()[0].data.playerCount, 0);
});

Deno.test("sample logs what it read", async () => {
  const { fetcher } = fakeFetch(
    200,
    '{"response":{"player_count":61234,"result":1}}',
  );
  const { context, logs } = testContext();
  await behavior.methods.sample.execute(
    { _fetch: fetcher, _now: () => NOW },
    context,
  );
  assert(logs().some((log) => log.level === "info"));
});

Deno.test("an app Steam does not know fails with the app id and result, writing nothing", async () => {
  const { fetcher } = fakeFetch(404, '{"response":{"result":42}}');
  const { context, written } = testContext();
  const error = await assertRejects(
    () => behavior.methods.sample.execute({ _fetch: fetcher }, context),
    Error,
  );
  assertStringIncludes(error.message, "app 440");
  assertStringIncludes(error.message, "result 42");
  assertStringIncludes(error.message, "HTTP 404");
  assertEquals(written().length, 0);
});

Deno.test("a rate limit names HTTP 429 and Retry-After", async () => {
  const { fetcher } = fakeFetch(429, "Too Many Requests", {
    "retry-after": "30",
  });
  const error = await assertRejects(
    () => fetchPlayerCount(fetcher, APP_ID),
    Error,
  );
  assertStringIncludes(error.message, "HTTP 429");
  assertStringIncludes(error.message, "retry after 30 seconds");
});

Deno.test("a server error is reported as transient", async () => {
  const { fetcher } = fakeFetch(503, "<html>Service Unavailable</html>");
  const error = await assertRejects(
    () => fetchPlayerCount(fetcher, APP_ID),
    Error,
  );
  assertStringIncludes(error.message, "HTTP 503");
  assertStringIncludes(error.message, "transient");
});

Deno.test("a network failure is reported with its cause", async () => {
  const fetcher: Fetcher = () =>
    Promise.reject(new TypeError("connection refused"));
  const error = await assertRejects(
    () => fetchPlayerCount(fetcher, APP_ID),
    Error,
  );
  assertStringIncludes(error.message, "request failed: connection refused");
});

Deno.test("a body that is not JSON is reported with its status", async () => {
  const { fetcher } = fakeFetch(
    400,
    "<html><body>Bad Request</body></html>",
  );
  const error = await assertRejects(
    () => fetchPlayerCount(fetcher, APP_ID),
    Error,
  );
  assertStringIncludes(error.message, "HTTP 400, body is not JSON");
});

Deno.test("a JSON body without a count is rejected", async () => {
  for (
    const body of [
      "{}",
      "null",
      '{"response":{"result":1}}',
      '{"response":{"player_count":"12","result":1}}',
      '{"response":{"player_count":-1,"result":1}}',
      '{"response":{"player_count":1.5,"result":1}}',
    ]
  ) {
    const { fetcher } = fakeFetch(200, body);
    await assertRejects(() => fetchPlayerCount(fetcher, APP_ID), Error);
  }
});

Deno.test("a cancelled run aborts the request", async () => {
  const controller = new AbortController();
  let seen: AbortSignal | undefined;
  const fetcher: Fetcher = (_input, init) => {
    seen = init?.signal ?? undefined;
    controller.abort();
    return Promise.resolve(
      new Response('{"response":{"player_count":1,"result":1}}'),
    );
  };
  await fetchPlayerCount(fetcher, APP_ID, controller.signal);
  assertEquals(seen?.aborted, true);
});

const SAMPLES: Sample[] = [
  { appId: APP_ID, playerCount: 64003, sampledAt: "2026-10-21T11:00:00.000Z" },
  { appId: APP_ID, playerCount: 61234, sampledAt: "2026-10-21T09:00:00.000Z" },
  { appId: APP_ID, playerCount: 58210, sampledAt: "2026-10-21T10:00:00.000Z" },
];

Deno.test("summarise finds first, min, max and latest by recording time", () => {
  const summary = summarise(APP_ID, SAMPLES, null, NOW.toISOString());
  assertEquals(summary, {
    appId: APP_ID,
    samples: 3,
    since: null,
    first: { playerCount: 61234, sampledAt: "2026-10-21T09:00:00.000Z" },
    min: { playerCount: 58210, sampledAt: "2026-10-21T10:00:00.000Z" },
    max: { playerCount: 64003, sampledAt: "2026-10-21T11:00:00.000Z" },
    latest: { playerCount: 64003, sampledAt: "2026-10-21T11:00:00.000Z" },
    summarisedAt: NOW.toISOString(),
  });
});

Deno.test("summarise keeps the earliest sample on a tie", () => {
  const summary = summarise(
    APP_ID,
    [
      { appId: APP_ID, playerCount: 5, sampledAt: "2026-10-21T10:00:00.000Z" },
      { appId: APP_ID, playerCount: 5, sampledAt: "2026-10-21T09:00:00.000Z" },
    ],
    null,
    NOW.toISOString(),
  );
  assertEquals(summary.min.sampledAt, "2026-10-21T09:00:00.000Z");
  assertEquals(summary.max.sampledAt, "2026-10-21T09:00:00.000Z");
  assertEquals(summary.latest.sampledAt, "2026-10-21T10:00:00.000Z");
});

Deno.test("summarise of nothing throws", () => {
  assertThrows(() => summarise(APP_ID, [], null, ""), Error, "No samples");
});

Deno.test("the summarise method queries every version of its own samples", async () => {
  const predicates: string[] = [];
  const { context, written } = testContext((predicate) => {
    predicates.push(predicate);
    return Promise.resolve(SAMPLES.map((sample, i) => record(i + 1, sample)));
  });
  await behavior.methods.summarise.execute({ _now: () => NOW }, context);
  assertEquals(predicates.length, 1);
  assertStringIncludes(predicates[0], `modelId == "${MODEL_ID}"`);
  assertStringIncludes(predicates[0], 'specName == "sample"');
  assertStringIncludes(predicates[0], 'name == "app-440"');
  assertStringIncludes(predicates[0], "version >= 0");
  const writes = written();
  assertEquals(writes.length, 1);
  assertEquals(writes[0].specName, "summary");
  assertEquals(writes[0].name, "summary-440");
  assertEquals(writes[0].data.samples, 3);
  assertEquals(
    (writes[0].data.min as { playerCount: number }).playerCount,
    58210,
  );
});

Deno.test("the summarise method honours since", async () => {
  const since = "2026-10-21T10:00:00.000Z";
  const { context, written } = testContext(() =>
    Promise.resolve(SAMPLES.map((sample, i) => record(i + 1, sample)))
  );
  await behavior.methods.summarise.execute({ since, _now: () => NOW }, context);
  const data = written()[0].data;
  assertEquals(data.samples, 2);
  assertEquals(data.since, since);
  assertEquals(
    (data.first as { sampledAt: string }).sampledAt,
    "2026-10-21T10:00:00.000Z",
  );
});

Deno.test("the summarise method skips records that are not samples of its app", async () => {
  const { context, written, logs } = testContext(() =>
    Promise.resolve([
      record(1, SAMPLES[0]),
      record(2, { ...SAMPLES[1], appId: 730 }),
      { version: 3, attributes: { unexpected: true } },
      null,
    ])
  );
  await behavior.methods.summarise.execute({ _now: () => NOW }, context);
  assertEquals(written()[0].data.samples, 1);
  assert(logs().some((log) => log.level === "warning"));
});

Deno.test("the summarise method fails before writing when nothing was sampled", async () => {
  const { context, written } = testContext(() => Promise.resolve([]));
  await assertRejects(
    () => behavior.methods.summarise.execute({}, context),
    Error,
    "run the sample method first",
  );
  assertEquals(written().length, 0);
});

Deno.test("the summarise method fails clearly without queryData", async () => {
  const { context } = testContext();
  await assertRejects(
    () => behavior.methods.summarise.execute({}, context),
    Error,
    "queryData",
  );
});

Deno.test("the method arguments and global arguments validate", () => {
  assert(behavior.globalArguments.safeParse({ appId: 440 }).success);
  assert(!behavior.globalArguments.safeParse({ appId: 0 }).success);
  assert(!behavior.globalArguments.safeParse({ appId: "440" }).success);
  const summariseArgs = behavior.methods.summarise.arguments;
  assert(summariseArgs.safeParse({}).success);
  assert(summariseArgs.safeParse({ since: "2026-10-01T00:00:00Z" }).success);
  assert(!summariseArgs.safeParse({ since: "yesterday" }).success);
});

Deno.test("written records conform to their resource schemas", async () => {
  const { fetcher } = fakeFetch(
    200,
    '{"response":{"player_count":61234,"result":1}}',
  );
  const sampled = testContext();
  await behavior.methods.sample.execute(
    { _fetch: fetcher, _now: () => NOW },
    sampled.context,
  );
  assert(
    behavior.resources.sample.schema.strict().safeParse(
      sampled.written()[0].data,
    ).success,
  );
  const summarised = testContext(() =>
    Promise.resolve(SAMPLES.map((sample, i) => record(i + 1, sample)))
  );
  await behavior.methods.summarise.execute(
    { _now: () => NOW },
    summarised.context,
  );
  assert(
    behavior.resources.summary.schema.strict().safeParse(
      summarised.written()[0].data,
    ).success,
  );
});

Deno.test("every argument's description is written where the registry reads it", () => {
  // swamp's registry reads argument descriptions from the source text: a field
  // that starts `name: z.<type>(` and carries `.describe("...")` with a string
  // literal. `.meta({ description })` or a template literal leaves the
  // registry's description empty, and a field that starts `z.iso.datetime()`
  // is left out of the registry's argument list.
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const schemas: { shape: Record<string, { description?: string }> }[] = [
    behavior.globalArguments,
    ...Object.values(behavior.methods).map((method) => method.arguments),
  ];
  const unread: string[] = [];
  for (const schema of schemas) {
    for (const [name, field] of Object.entries(schema.shape)) {
      const description = field.description;
      const starts = new RegExp(`(?<![.\\w])${name}:\\s*z\\.\\w+\\(`);
      const described = description !== undefined && new RegExp(
        `\\.describe\\(\\s*${escape(JSON.stringify(description))}`,
      ).test(source);
      if (!described || !starts.test(source)) {
        unread.push(name);
      }
    }
  }
  assertEquals(unread, []);
});
