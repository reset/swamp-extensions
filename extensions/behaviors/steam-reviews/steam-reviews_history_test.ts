/**
 * Unit tests for the Steam reviews behavior's `sample` and `summarise`
 * methods, the history half of the behavior, and for what the whole behavior
 * declares. Every test injects a fetch, a clock and, for `summarise`, a query,
 * so nothing here reaches Steam or a swamp datastore.
 *
 * @module
 */

import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20261016.58";
import {
  behavior,
  type Fetcher,
  fetchReviews,
  type MethodContext,
  positiveRatio,
  REVIEWS_URL,
  type Sample,
  summarise,
} from "./steam-reviews.ts";
import source from "./steam-reviews.ts" with { type: "text" };

const APP_ID = 440;
const MODEL_ID = "00000000-0000-4000-8000-000000000440";
const NOW = new Date("2026-10-22T12:00:00.000Z");

/** The shape Steam answered for app 440 on 2026-10-22. */
const BODY = JSON.stringify({
  success: 1,
  query_summary: {
    num_reviews: 0,
    review_score: 8,
    review_score_desc: "Very Positive",
    total_positive: 1143070,
    total_negative: 112091,
    total_reviews: 1255161,
  },
  reviews: [],
  cursor: "*",
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

/** A body with the given query_summary fields over the app 440 defaults. */
function bodyWith(fields: Record<string, unknown>): string {
  const parsed = JSON.parse(BODY);
  return JSON.stringify({
    ...parsed,
    query_summary: { ...parsed.query_summary, ...fields },
  });
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

/** A sample with the given counts, score and time. */
function sample(
  totalPositive: number,
  totalNegative: number,
  sampledAt: string,
  reviewScore = 8,
): Sample {
  return {
    appId: APP_ID,
    reviewScore,
    reviewScoreDesc: "Very Positive",
    totalPositive,
    totalNegative,
    totalReviews: totalPositive + totalNegative,
    positiveRatio: positiveRatio(totalPositive, totalNegative),
    sampledAt,
  };
}

/** A stored sample record as queryData returns it. */
function record(version: number, stored: Sample): unknown {
  return { version, name: `app-${stored.appId}`, attributes: stored };
}

Deno.test("sample requests the documented URL with the app id", async () => {
  const { fetcher, urls, inits } = fakeFetch(200, BODY);
  const { context } = testContext();
  await behavior.methods.sample.execute(
    { _fetch: fetcher, _now: () => NOW },
    context,
  );
  assertEquals(urls, [
    `${REVIEWS_URL}${APP_ID}?json=1&language=all&purchase_type=all&num_per_page=0`,
  ]);
  assertEquals(inits[0]?.method, "GET");
  assert(inits[0]?.signal instanceof AbortSignal);
});

Deno.test("sample records the score, counts, ratio, app id and time", async () => {
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
    reviewScore: 8,
    reviewScoreDesc: "Very Positive",
    totalPositive: 1143070,
    totalNegative: 112091,
    totalReviews: 1255161,
    positiveRatio: 1143070 / 1255161,
    sampledAt: NOW.toISOString(),
  });
  assertEquals(result.dataHandles.length, 1);
});

Deno.test("an app with no reviews is recorded with a null ratio", async () => {
  const { fetcher } = fakeFetch(
    200,
    bodyWith({
      review_score: 0,
      review_score_desc: "No user reviews",
      total_positive: 0,
      total_negative: 0,
      total_reviews: 0,
    }),
  );
  const { context, written } = testContext();
  await behavior.methods.sample.execute(
    { _fetch: fetcher, _now: () => NOW },
    context,
  );
  assertEquals(written()[0]?.data.positiveRatio, null);
  assertEquals(written()[0]?.data.totalReviews, 0);
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

Deno.test("positiveRatio divides positive by positive and negative", () => {
  assertEquals(positiveRatio(3, 1), 0.75);
  assertEquals(positiveRatio(0, 4), 0);
  assertEquals(positiveRatio(0, 0), null);
});

Deno.test("a response Steam marks unsuccessful fails with the app id and value, writing nothing", async () => {
  const { fetcher } = fakeFetch(200, '{"success":2}');
  const { context, written } = testContext();
  const error = await assertRejects(
    () => behavior.methods.sample.execute({ _fetch: fetcher }, context),
    Error,
  );
  assertStringIncludes(error.message, "app 440");
  assertStringIncludes(error.message, "success 2");
  assertStringIncludes(error.message, "HTTP 200");
  assertEquals(written().length, 0);
});

Deno.test("a rate limit names HTTP 429 and Retry-After", async () => {
  const { fetcher } = fakeFetch(429, "Too Many Requests", {
    "retry-after": "30",
  });
  const error = await assertRejects(
    () => fetchReviews(fetcher, APP_ID),
    Error,
  );
  assertStringIncludes(error.message, "HTTP 429");
  assertStringIncludes(error.message, "retry after 30 seconds");
});

Deno.test("a server error is reported as transient", async () => {
  const { fetcher } = fakeFetch(503, "<html>Service Unavailable</html>");
  const error = await assertRejects(
    () => fetchReviews(fetcher, APP_ID),
    Error,
  );
  assertStringIncludes(error.message, "HTTP 503");
  assertStringIncludes(error.message, "transient");
});

Deno.test("a network failure is reported with its cause", async () => {
  const fetcher: Fetcher = () =>
    Promise.reject(new TypeError("connection refused"));
  const error = await assertRejects(
    () => fetchReviews(fetcher, APP_ID),
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
    () => fetchReviews(fetcher, APP_ID),
    Error,
  );
  assertStringIncludes(error.message, "HTTP 400, body is not JSON");
});

Deno.test("a JSON body without a complete query_summary is rejected", async () => {
  for (
    const body of [
      "{}",
      "null",
      "[]",
      '{"success":1}',
      '{"success":1,"query_summary":null}',
      bodyWith({ total_positive: "12" }),
      bodyWith({ total_negative: -1 }),
      bodyWith({ total_reviews: 1.5 }),
      bodyWith({ review_score: undefined }),
      bodyWith({ review_score_desc: 8 }),
    ]
  ) {
    const { fetcher } = fakeFetch(200, body);
    await assertRejects(() => fetchReviews(fetcher, APP_ID), Error);
  }
});

Deno.test("a summary under a client error status is rejected", async () => {
  const { fetcher } = fakeFetch(403, BODY);
  const error = await assertRejects(
    () => fetchReviews(fetcher, APP_ID),
    Error,
  );
  assertStringIncludes(error.message, "HTTP 403");
});

Deno.test("a cancelled run aborts the request", async () => {
  const controller = new AbortController();
  let seen: AbortSignal | undefined;
  const fetcher: Fetcher = (_input, init) => {
    seen = init?.signal ?? undefined;
    controller.abort();
    return Promise.resolve(new Response(BODY));
  };
  await fetchReviews(fetcher, APP_ID, controller.signal);
  assertEquals(seen?.aborted, true);
});

const SAMPLES: Sample[] = [
  sample(900, 100, "2026-10-21T11:00:00.000Z"),
  sample(800, 200, "2026-10-21T09:00:00.000Z", 6),
  sample(700, 300, "2026-10-21T10:00:00.000Z", 5),
];

Deno.test("summarise finds first, latest, min and max ratio and the change", () => {
  const summary = summarise(APP_ID, SAMPLES, null, NOW.toISOString());
  assertEquals(summary.appId, APP_ID);
  assertEquals(summary.samples, 3);
  assertEquals(summary.since, null);
  assertEquals(summary.first.sampledAt, "2026-10-21T09:00:00.000Z");
  assertEquals(summary.latest.sampledAt, "2026-10-21T11:00:00.000Z");
  assertEquals(summary.min?.positiveRatio, 0.7);
  assertEquals(summary.min?.sampledAt, "2026-10-21T10:00:00.000Z");
  assertEquals(summary.max?.positiveRatio, 0.9);
  assertEquals(summary.max?.sampledAt, "2026-10-21T11:00:00.000Z");
  assertAlmostEquals(summary.change.positiveRatio ?? NaN, 0.1, 1e-12);
  assertEquals(summary.change.reviewScore, 2);
  assertEquals(summary.change.totalPositive, 100);
  assertEquals(summary.change.totalNegative, -100);
  assertEquals(summary.change.totalReviews, 0);
  assertEquals(summary.summarisedAt, NOW.toISOString());
});

Deno.test("summarise keeps the earliest sample on a tie", () => {
  const summary = summarise(
    APP_ID,
    [
      sample(5, 5, "2026-10-21T10:00:00.000Z"),
      sample(1, 1, "2026-10-21T09:00:00.000Z"),
    ],
    null,
    NOW.toISOString(),
  );
  assertEquals(summary.min?.sampledAt, "2026-10-21T09:00:00.000Z");
  assertEquals(summary.max?.sampledAt, "2026-10-21T09:00:00.000Z");
  assertEquals(summary.latest.sampledAt, "2026-10-21T10:00:00.000Z");
});

Deno.test("summarise leaves samples without reviews out of min and max", () => {
  const summary = summarise(
    APP_ID,
    [
      sample(0, 0, "2026-10-21T09:00:00.000Z", 0),
      sample(3, 1, "2026-10-21T10:00:00.000Z"),
    ],
    null,
    NOW.toISOString(),
  );
  assertEquals(summary.min?.positiveRatio, 0.75);
  assertEquals(summary.max?.positiveRatio, 0.75);
  assertEquals(summary.change.positiveRatio, null);
  assertEquals(summary.change.totalReviews, 4);
});

Deno.test("summarise with no reviewed sample has no min or max", () => {
  const summary = summarise(
    APP_ID,
    [sample(0, 0, "2026-10-21T09:00:00.000Z", 0)],
    null,
    NOW.toISOString(),
  );
  assertEquals(summary.min, null);
  assertEquals(summary.max, null);
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
  assertEquals(
    (writes[0]?.data.min as { positiveRatio: number }).positiveRatio,
    0.7,
  );
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
  assertEquals(
    (data?.first as { sampledAt: string }).sampledAt,
    "2026-10-21T10:00:00.000Z",
  );
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

Deno.test("the upgrade keeps either line's global arguments as written", () => {
  const upgrade = behavior.upgrades[behavior.upgrades.length - 1];
  assertEquals(upgrade.toVersion, behavior.version);
  const board = { appId: 440 };
  const keyed = { appId: 480, key: "publisher-key-for-tests" };
  for (const old of [board, keyed]) {
    const upgraded = upgrade.upgradeAttributes({ ...old });
    assertEquals(upgraded, old);
    assert(behavior.globalArguments.safeParse(upgraded).success);
  }
});

Deno.test("both lines' methods and resources are declared under distinct names", () => {
  assertEquals(Object.keys(behavior.resources).sort(), [
    "recent",
    "sample",
    "score",
    "summary",
  ]);
  assertEquals(Object.keys(behavior.methods).sort(), [
    "recent",
    "sample",
    "summarise",
    "summary",
  ]);
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
