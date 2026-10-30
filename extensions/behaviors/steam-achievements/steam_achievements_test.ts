/**
 * Unit tests for the Steam global achievement percentage behavior. Every test
 * injects a fetch, a clock and, for `summarise`, a query, so nothing here
 * reaches Steam or a swamp datastore.
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
  type Achievement,
  behavior,
  type Fetcher,
  fetchPercentages,
  type MethodContext,
  parsePercent,
  PERCENTAGES_URL,
  type Sample,
  summarise,
} from "./steam_achievements.ts";
import source from "./steam_achievements.ts" with { type: "text" };

const APP_ID = 440;
const MODEL_ID = "00000000-0000-4000-8000-000000000440";
const NOW = new Date("2026-10-22T12:00:00.000Z");

/** The shape Steam answered for app 440 on 2026-10-22, cut to three achievements. */
const BODY = JSON.stringify({
  achievementpercentages: {
    achievements: [
      { name: "TF_SCOUT_LONG_DISTANCE_RUNNER", percent: "49.5" },
      { name: "TF_HEAVY_DAMAGE_TAKEN", percent: "39.9" },
      { name: "TF_PASS_TIME_GRIND", percent: "3.2" },
    ],
  },
});

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

/** A body with the given achievement entries. */
function bodyWith(achievements: unknown): string {
  return JSON.stringify({ achievementpercentages: { achievements } });
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

/** A sample of the given achievements at a time. */
function sample(sampledAt: string, percents: Record<string, number>): Sample {
  const achievements: Achievement[] = Object.entries(percents).map((
    [name, percent],
  ) => ({ name, percent }));
  return {
    appId: APP_ID,
    count: achievements.length,
    achievements,
    sampledAt,
  };
}

/** A stored sample record as queryData returns it. */
function record(version: number, stored: Sample): unknown {
  return { version, name: `app-${stored.appId}`, attributes: stored };
}

Deno.test("sample requests the documented URL with the app id as gameid", async () => {
  const { fetcher, urls, inits } = fakeFetch(200, BODY);
  const { context } = testContext();
  await behavior.methods.sample.execute(
    { _fetch: fetcher, _now: () => NOW },
    context,
  );
  assertEquals(urls, [`${PERCENTAGES_URL}?gameid=${APP_ID}`]);
  assertEquals(inits[0]?.method, "GET");
  assert(inits[0]?.signal instanceof AbortSignal);
  assert(!urls[0]?.includes("key="));
});

Deno.test("sample records every achievement as a number, in Steam's order", async () => {
  const { fetcher } = fakeFetch(200, BODY);
  const { context, written } = testContext();
  const result = await behavior.methods.sample.execute(
    { _fetch: fetcher, _now: () => NOW },
    context,
  );
  const writes = written();
  assertEquals(writes.length, 1);
  assertEquals(writes[0]?.specName, "sample");
  assertEquals(writes[0]?.name, "app-440");
  assertEquals(writes[0]?.data, {
    appId: APP_ID,
    count: 3,
    achievements: [
      { name: "TF_SCOUT_LONG_DISTANCE_RUNNER", percent: 49.5 },
      { name: "TF_HEAVY_DAMAGE_TAKEN", percent: 39.9 },
      { name: "TF_PASS_TIME_GRIND", percent: 3.2 },
    ],
    sampledAt: NOW.toISOString(),
  });
  assertEquals(result.dataHandles.length, 1);
});

Deno.test("sample logs what it read", async () => {
  const { fetcher } = fakeFetch(200, BODY);
  const { context, logs } = testContext();
  await behavior.methods.sample.execute(
    { _fetch: fetcher, _now: () => NOW },
    context,
  );
  assert(logs().some((log) => log.level === "info"));
});

Deno.test("parsePercent reads Steam's decimal strings and numbers from 0 to 100", () => {
  assertEquals(parsePercent("49.5"), 49.5);
  assertEquals(parsePercent("0"), 0);
  assertEquals(parsePercent("100.0"), 100);
  assertEquals(parsePercent(12.25), 12.25);
  for (const bad of ["", "abc", "-1", "100.1", "1e2", " 5", null, NaN, 101]) {
    assertEquals(parsePercent(bad), undefined, String(bad));
  }
});

Deno.test("an app Steam has no statistics for fails with the app id, writing nothing", async () => {
  for (const status of [403, 404]) {
    const { fetcher } = fakeFetch(status, "<html>Forbidden</html>");
    const { context, written } = testContext();
    const error = await assertRejects(
      () => behavior.methods.sample.execute({ _fetch: fetcher }, context),
      Error,
    );
    assertStringIncludes(error.message, "app 440");
    assertStringIncludes(error.message, `HTTP ${status}`);
    assertStringIncludes(error.message, "no public achievement statistics");
    assertEquals(written().length, 0);
  }
});

Deno.test("an empty achievement list fails rather than recording nothing", async () => {
  const { fetcher } = fakeFetch(200, bodyWith([]));
  const { context, written } = testContext();
  await assertRejects(
    () => behavior.methods.sample.execute({ _fetch: fetcher }, context),
    Error,
    "no achievements",
  );
  assertEquals(written().length, 0);
});

Deno.test("a rate limit names HTTP 429 and Retry-After", async () => {
  const { fetcher } = fakeFetch(429, "Too Many Requests", {
    "retry-after": "30",
  });
  const error = await assertRejects(
    () => fetchPercentages(fetcher, APP_ID),
    Error,
  );
  assertStringIncludes(error.message, "HTTP 429");
  assertStringIncludes(error.message, "retry after 30 seconds");
});

Deno.test("a server error is reported as transient", async () => {
  const { fetcher } = fakeFetch(503, "<html>Service Unavailable</html>");
  const error = await assertRejects(
    () => fetchPercentages(fetcher, APP_ID),
    Error,
  );
  assertStringIncludes(error.message, "HTTP 503");
  assertStringIncludes(error.message, "transient");
});

Deno.test("a network failure is reported with its cause", async () => {
  const fetcher: Fetcher = () =>
    Promise.reject(new TypeError("connection refused"));
  const error = await assertRejects(
    () => fetchPercentages(fetcher, APP_ID),
    Error,
  );
  assertStringIncludes(error.message, "request failed: connection refused");
});

Deno.test("a body that is not JSON is reported with its status", async () => {
  const { fetcher } = fakeFetch(400, "<html><body>Bad Request</body></html>");
  const error = await assertRejects(
    () => fetchPercentages(fetcher, APP_ID),
    Error,
  );
  assertStringIncludes(error.message, "HTTP 400, body is not JSON");
});

Deno.test("a JSON body without a well-formed achievement list is rejected", async () => {
  for (
    const body of [
      "{}",
      "null",
      "[]",
      '{"achievementpercentages":null}',
      '{"achievementpercentages":{}}',
      '{"achievementpercentages":{"achievements":{}}}',
      bodyWith([null]),
      bodyWith([{ name: "A" }]),
      bodyWith([{ name: "", percent: "1.0" }]),
      bodyWith([{ name: 7, percent: "1.0" }]),
      bodyWith([{ name: "A", percent: "n/a" }]),
      bodyWith([{ name: "A", percent: "150" }]),
      bodyWith([{ name: "A", percent: "1" }, { name: "A", percent: "2" }]),
    ]
  ) {
    const { fetcher } = fakeFetch(200, body);
    await assertRejects(() => fetchPercentages(fetcher, APP_ID), Error);
  }
});

Deno.test("a well-formed list under a client error status is rejected", async () => {
  const { fetcher } = fakeFetch(400, BODY);
  const error = await assertRejects(
    () => fetchPercentages(fetcher, APP_ID),
    Error,
  );
  assertStringIncludes(error.message, "HTTP 400");
});

Deno.test("a cancelled run aborts the request", async () => {
  const controller = new AbortController();
  let seen: AbortSignal | undefined;
  const fetcher: Fetcher = (_input, init) => {
    seen = init?.signal ?? undefined;
    controller.abort();
    return Promise.resolve(new Response(BODY));
  };
  await fetchPercentages(fetcher, APP_ID, controller.signal);
  assertEquals(seen?.aborted, true);
});

const SAMPLES: Sample[] = [
  sample("2026-10-21T11:00:00.000Z", { A: 50.2, B: 3.4, D: 0.8 }),
  sample("2026-10-21T09:00:00.000Z", { A: 49.5, B: 3.2, C: 12.0 }),
  sample("2026-10-21T10:00:00.000Z", { A: 49.9, B: 3.3, C: 12.1, D: 0.1 }),
];

Deno.test("summarise reports first, latest and change per achievement", () => {
  const summary = summarise(APP_ID, SAMPLES, null, NOW.toISOString());
  assertEquals(summary.appId, APP_ID);
  assertEquals(summary.samples, 3);
  assertEquals(summary.since, null);
  assertEquals(summary.firstSampledAt, "2026-10-21T09:00:00.000Z");
  assertEquals(summary.latestSampledAt, "2026-10-21T11:00:00.000Z");
  assertEquals(summary.count, 3);
  assertEquals(summary.achievements, [
    {
      name: "A",
      first: 49.5,
      firstSeenAt: "2026-10-21T09:00:00.000Z",
      latest: 50.2,
      lastSeenAt: "2026-10-21T11:00:00.000Z",
      change: 0.7,
    },
    {
      name: "B",
      first: 3.2,
      firstSeenAt: "2026-10-21T09:00:00.000Z",
      latest: 3.4,
      lastSeenAt: "2026-10-21T11:00:00.000Z",
      change: 0.2,
    },
    {
      name: "C",
      first: 12.0,
      firstSeenAt: "2026-10-21T09:00:00.000Z",
      latest: 12.1,
      lastSeenAt: "2026-10-21T10:00:00.000Z",
      change: 0.1,
    },
    {
      name: "D",
      first: 0.1,
      firstSeenAt: "2026-10-21T10:00:00.000Z",
      latest: 0.8,
      lastSeenAt: "2026-10-21T11:00:00.000Z",
      change: 0.7,
    },
  ]);
  assertEquals(summary.summarisedAt, NOW.toISOString());
});

Deno.test("summarise names the rarest and most common of the latest sample", () => {
  const summary = summarise(APP_ID, SAMPLES, null, NOW.toISOString());
  assertEquals(summary.rarest, { name: "D", percent: 0.8 });
  assertEquals(summary.mostCommon, { name: "A", percent: 50.2 });
});

Deno.test("summarise lists achievements added and removed since the first sample", () => {
  const summary = summarise(APP_ID, SAMPLES, null, NOW.toISOString());
  assertEquals(summary.added, ["D"]);
  assertEquals(summary.removed, ["C"]);
});

Deno.test("summarise takes the first name on a tie", () => {
  const summary = summarise(
    APP_ID,
    [sample("2026-10-21T09:00:00.000Z", { Z: 5, Y: 5, X: 9, W: 9 })],
    null,
    NOW.toISOString(),
  );
  assertEquals(summary.rarest.name, "Y");
  assertEquals(summary.mostCommon.name, "W");
  assertEquals(summary.added, []);
  assertEquals(summary.removed, []);
  assertEquals(summary.achievements.map(({ change }) => change), [0, 0, 0, 0]);
});

Deno.test("summarise of nothing throws", () => {
  assertThrows(() => summarise(APP_ID, [], null, ""), Error, "No samples");
});

Deno.test("the summarise method queries every version of its own samples", async () => {
  const predicates: string[] = [];
  const { context, written } = testContext((predicate) => {
    predicates.push(predicate);
    return Promise.resolve(SAMPLES.map((stored, i) => record(i + 1, stored)));
  });
  await behavior.methods.summarise.execute({ _now: () => NOW }, context);
  assertEquals(predicates.length, 1);
  assertStringIncludes(predicates[0] ?? "", `modelId == "${MODEL_ID}"`);
  assertStringIncludes(predicates[0] ?? "", 'specName == "sample"');
  assertStringIncludes(predicates[0] ?? "", 'name == "app-440"');
  assertStringIncludes(predicates[0] ?? "", "version >= 0");
  const writes = written();
  assertEquals(writes.length, 1);
  assertEquals(writes[0]?.specName, "summary");
  assertEquals(writes[0]?.name, "summary-440");
  assertEquals(writes[0]?.data.samples, 3);
  assertEquals(writes[0]?.data.added, ["D"]);
});

Deno.test("the summarise method honours since", async () => {
  const since = "2026-10-21T10:00:00.000Z";
  const { context, written } = testContext(() =>
    Promise.resolve(SAMPLES.map((stored, i) => record(i + 1, stored)))
  );
  await behavior.methods.summarise.execute({ since, _now: () => NOW }, context);
  const data = written()[0]?.data;
  assertEquals(data?.samples, 2);
  assertEquals(data?.since, since);
  assertEquals(data?.firstSampledAt, since);
  assertEquals(data?.added, []);
  assertEquals(data?.removed, ["C"]);
});

Deno.test("the summarise method skips records that are not samples of its app", async () => {
  const first = SAMPLES[0];
  const second = SAMPLES[1];
  assert(first !== undefined && second !== undefined);
  const { context, written, logs } = testContext(() =>
    Promise.resolve([
      record(1, first),
      record(2, { ...second, appId: 730 }),
      { version: 3, attributes: { unexpected: true } },
      { version: 4, attributes: { ...second, achievements: [] } },
      null,
    ])
  );
  await behavior.methods.summarise.execute({ _now: () => NOW }, context);
  assertEquals(written()[0]?.data.samples, 1);
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
  const { fetcher } = fakeFetch(200, BODY);
  const sampled = testContext();
  await behavior.methods.sample.execute(
    { _fetch: fetcher, _now: () => NOW },
    sampled.context,
  );
  assert(
    behavior.resources.sample.schema.strict().safeParse(
      sampled.written()[0]?.data,
    ).success,
  );
  const summarised = testContext(() =>
    Promise.resolve(SAMPLES.map((stored, i) => record(i + 1, stored)))
  );
  await behavior.methods.summarise.execute(
    { _now: () => NOW },
    summarised.context,
  );
  assert(
    behavior.resources.summary.schema.strict().safeParse(
      summarised.written()[0]?.data,
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
