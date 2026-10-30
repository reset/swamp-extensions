/**
 * Unit tests for the Steam Workshop item statistics behavior. Every test
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
  behavior,
  DETAILS_URL,
  fetchDetails,
  type Fetcher,
  type MethodContext,
  parseCount,
  parseUnixTime,
  type Sample,
  summarise,
  USER_AGENT,
  VERSION,
} from "./steam_workshop.ts";
import source from "./steam_workshop.ts" with { type: "text" };
import manifest from "./manifest.yaml" with { type: "text" };

/** The version the manifest publishes, which the User-Agent names. */
const MANIFEST_VERSION = /^version: "([^"]+)"$/m.exec(manifest)?.[1];

const ITEM_ID = "104691717";
const MODEL_ID = "00000000-0000-4000-8000-000000104691";
const NOW = new Date("2026-10-22T12:00:00.000Z");
/** A made-up SteamID64; tests carry no real account. */
const CREATOR = "76561190000000001";

/** The fields Steam answered for item 104691717 on 2026-10-22, the description cut and the creator replaced. */
const ITEM = {
  publishedfileid: ITEM_ID,
  result: 1,
  creator: CREATOR,
  creator_app_id: 4000,
  consumer_app_id: 4000,
  filename: "",
  file_size: "8707715",
  file_url: "",
  title: "PAC3",
  description: "Gives you the ability to personalize your player model.",
  time_created: 1351222862,
  time_updated: 1792034791,
  visibility: 0,
  banned: 0,
  ban_reason: "",
  subscriptions: 915651,
  favorited: 45834,
  lifetime_subscriptions: 2403729,
  lifetime_favorited: 54548,
  views: 875451,
  tags: [{ tag: "Addon" }, { tag: "tool" }, { tag: "Fun" }, {
    tag: "Roleplay",
  }],
};

/** A response body carrying the given item entries. */
function bodyWith(...items: unknown[]): string {
  return JSON.stringify({
    response: {
      result: 1,
      resultcount: items.length,
      publishedfiledetails: items,
    },
  });
}

const BODY = bodyWith(ITEM);

/** A fetch that answers every request with one status and body, recording the requests. */
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
  const test = createModelTestContext({ globalArgs: { itemId: ITEM_ID } });
  const context: MethodContext = {
    ...test.context,
    globalArgs: { itemId: ITEM_ID },
    modelId: MODEL_ID,
    queryData,
  };
  return {
    context,
    written: test.getWrittenResources,
    logs: test.getLogs,
  };
}

/** The sample the fixture body records at `NOW`. */
const SAMPLED: Sample = {
  itemId: ITEM_ID,
  title: "PAC3",
  appId: 4000,
  creator: CREATOR,
  createdAt: "2012-10-26T03:41:02.000Z",
  updatedAt: "2026-10-15T03:26:31.000Z",
  subscriptions: 915651,
  lifetimeSubscriptions: 2403729,
  favorited: 45834,
  lifetimeFavorited: 54548,
  views: 875451,
  fileSize: 8707715,
  tags: ["Addon", "tool", "Fun", "Roleplay"],
  sampledAt: NOW.toISOString(),
};

/** A sample at a time with some fields changed. */
function sample(sampledAt: string, fields: Partial<Sample> = {}): Sample {
  return { ...SAMPLED, sampledAt, ...fields };
}

/** A stored sample record as queryData returns it. */
function record(version: number, stored: unknown): unknown {
  return { version, name: `item-${ITEM_ID}`, attributes: stored };
}

Deno.test("sample posts the documented form with an honest User-Agent and no key", async () => {
  const { fetcher, urls, inits } = fakeFetch(200, BODY);
  const { context } = testContext();
  await behavior.methods.sample.execute(
    { _fetch: fetcher, _now: () => NOW },
    context,
  );
  assertEquals(urls, [DETAILS_URL]);
  assertEquals(inits[0]?.method, "POST");
  assert(inits[0]?.signal instanceof AbortSignal);
  const form = new URLSearchParams(String(inits[0]?.body));
  assertEquals([...form.entries()], [
    ["itemcount", "1"],
    ["publishedfileids[0]", ITEM_ID],
  ]);
  assert(!form.has("key"));
  const headers = new Headers(inits[0]?.headers);
  assertEquals(
    headers.get("content-type"),
    "application/x-www-form-urlencoded",
  );
  assertEquals(headers.get("user-agent"), USER_AGENT);
  assertStringIncludes(USER_AGENT, "@reset/steam-workshop");
  assertStringIncludes(USER_AGENT, VERSION);
  assertEquals(behavior.version, VERSION);
  assertEquals(VERSION, MANIFEST_VERSION);
});

Deno.test("sample records the item's statistics as a new version", async () => {
  const { fetcher } = fakeFetch(200, BODY);
  const { context, written } = testContext();
  const result = await behavior.methods.sample.execute(
    { _fetch: fetcher, _now: () => NOW },
    context,
  );
  const writes = written();
  assertEquals(writes.length, 1);
  assertEquals(writes[0]?.specName, "sample");
  assertEquals(writes[0]?.name, `item-${ITEM_ID}`);
  assertEquals(writes[0]?.data, { ...SAMPLED });
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

Deno.test("an item without tags records an empty list", async () => {
  const { tags: _tags, ...untagged } = ITEM;
  const { fetcher } = fakeFetch(200, bodyWith(untagged));
  const sampled = await fetchDetails(fetcher, ITEM_ID, NOW.toISOString());
  assertEquals(sampled.tags, []);
});

Deno.test("parseCount reads integers and Steam's decimal strings of them", () => {
  assertEquals(parseCount(0), 0);
  assertEquals(parseCount(915651), 915651);
  assertEquals(parseCount("8707715"), 8707715);
  for (
    const bad of [
      "",
      "1.5",
      "-1",
      "1e3",
      " 5",
      "99999999999999999",
      1.5,
      -1,
      NaN,
      null,
    ]
  ) {
    assertEquals(parseCount(bad), undefined, String(bad));
  }
});

Deno.test("parseUnixTime turns Steam's seconds into ISO-8601", () => {
  assertEquals(parseUnixTime(1351222862), "2012-10-26T03:41:02.000Z");
  assertEquals(parseUnixTime("x"), undefined);
});

Deno.test("an item Steam has no public record of fails with the id, writing nothing", async () => {
  const { fetcher } = fakeFetch(
    200,
    bodyWith({ publishedfileid: ITEM_ID, result: 9 }),
  );
  const { context, written } = testContext();
  const error = await assertRejects(
    () => behavior.methods.sample.execute({ _fetch: fetcher }, context),
    Error,
  );
  assertStringIncludes(error.message, `item ${ITEM_ID}`);
  assertStringIncludes(error.message, "no public Workshop item");
  assertEquals(written().length, 0);
});

Deno.test("another item result is reported with its code", async () => {
  const { fetcher } = fakeFetch(
    200,
    bodyWith({ publishedfileid: ITEM_ID, result: 15 }),
  );
  await assertRejects(
    () => fetchDetails(fetcher, ITEM_ID, NOW.toISOString()),
    Error,
    "result 15",
  );
});

Deno.test("an answer for another item is rejected", async () => {
  const { fetcher } = fakeFetch(
    200,
    bodyWith({ ...ITEM, publishedfileid: "1" }),
  );
  await assertRejects(
    () => fetchDetails(fetcher, ITEM_ID, NOW.toISOString()),
    Error,
    "another item",
  );
});

Deno.test("a rate limit names HTTP 429 and Retry-After", async () => {
  const { fetcher } = fakeFetch(429, "Too Many Requests", {
    "retry-after": "30",
  });
  const error = await assertRejects(
    () => fetchDetails(fetcher, ITEM_ID, NOW.toISOString()),
    Error,
  );
  assertStringIncludes(error.message, "HTTP 429");
  assertStringIncludes(error.message, "retry after 30 seconds");
});

Deno.test("a server error is reported as transient", async () => {
  const { fetcher } = fakeFetch(503, "<html>Service Unavailable</html>");
  const error = await assertRejects(
    () => fetchDetails(fetcher, ITEM_ID, NOW.toISOString()),
    Error,
  );
  assertStringIncludes(error.message, "HTTP 503");
  assertStringIncludes(error.message, "transient");
});

Deno.test("a network failure is reported with its cause", async () => {
  const fetcher: Fetcher = () =>
    Promise.reject(new TypeError("connection refused"));
  const error = await assertRejects(
    () => fetchDetails(fetcher, ITEM_ID, NOW.toISOString()),
    Error,
  );
  assertStringIncludes(error.message, "request failed: connection refused");
});

Deno.test("a body that is not JSON is reported with its status", async () => {
  // Steam answers a GET with this page and HTTP 405.
  const { fetcher } = fakeFetch(
    405,
    "<html><head><title>Method Not Allowed</title></head></html>",
  );
  const error = await assertRejects(
    () => fetchDetails(fetcher, ITEM_ID, NOW.toISOString()),
    Error,
  );
  assertStringIncludes(error.message, "HTTP 405, body is not JSON");
});

Deno.test("a JSON body without a well-formed item is rejected", async () => {
  const without = (field: string) =>
    Object.fromEntries(Object.entries(ITEM).filter(([key]) => key !== field));
  const bodies = [
    "{}",
    "null",
    "[]",
    '{"response":null}',
    '{"response":{}}',
    '{"response":{"result":2,"publishedfiledetails":[]}}',
    bodyWith(),
    bodyWith(ITEM, ITEM),
    bodyWith(null),
    bodyWith({ ...ITEM, consumer_app_id: 0 }),
    bodyWith({ ...ITEM, file_size: "big" }),
    bodyWith({ ...ITEM, subscriptions: -1 }),
    bodyWith({ ...ITEM, title: 7 }),
    bodyWith({ ...ITEM, tags: "Addon" }),
    bodyWith({ ...ITEM, tags: [{ name: "Addon" }] }),
    ...[
      "title",
      "creator",
      "consumer_app_id",
      "time_created",
      "time_updated",
      "subscriptions",
      "lifetime_subscriptions",
      "favorited",
      "lifetime_favorited",
      "views",
      "file_size",
    ].map((field) => bodyWith(without(field))),
  ];
  for (const body of bodies) {
    const { fetcher } = fakeFetch(200, body);
    await assertRejects(
      () => fetchDetails(fetcher, ITEM_ID, NOW.toISOString()),
      Error,
      undefined,
      body,
    );
  }
});

Deno.test("a well-formed item under a client error status is rejected", async () => {
  const { fetcher } = fakeFetch(400, BODY);
  const error = await assertRejects(
    () => fetchDetails(fetcher, ITEM_ID, NOW.toISOString()),
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
  await fetchDetails(fetcher, ITEM_ID, NOW.toISOString(), controller.signal);
  assertEquals(seen?.aborted, true);
});

const SAMPLES: Sample[] = [
  sample("2026-10-21T11:00:00.000Z", {
    title: "PAC3 (legacy)",
    subscriptions: 915000,
    lifetimeSubscriptions: 2403900,
    favorited: 45830,
    lifetimeFavorited: 54560,
    views: 876000,
    fileSize: 8800000,
    updatedAt: "2026-10-21T10:30:00.000Z",
  }),
  sample("2026-10-21T09:00:00.000Z"),
  sample("2026-10-21T10:00:00.000Z", { subscriptions: 915500 }),
];

Deno.test("summarise reports each count's first, latest and change", () => {
  const summary = summarise(ITEM_ID, SAMPLES, null, NOW.toISOString());
  assertEquals(summary, {
    itemId: ITEM_ID,
    title: "PAC3 (legacy)",
    appId: 4000,
    samples: 3,
    since: null,
    firstSampledAt: "2026-10-21T09:00:00.000Z",
    latestSampledAt: "2026-10-21T11:00:00.000Z",
    createdAt: "2012-10-26T03:41:02.000Z",
    updatedAt: "2026-10-21T10:30:00.000Z",
    updatedSinceFirst: true,
    changes: {
      subscriptions: { first: 915651, latest: 915000, change: -651 },
      lifetimeSubscriptions: { first: 2403729, latest: 2403900, change: 171 },
      favorited: { first: 45834, latest: 45830, change: -4 },
      lifetimeFavorited: { first: 54548, latest: 54560, change: 12 },
      views: { first: 875451, latest: 876000, change: 549 },
      fileSize: { first: 8707715, latest: 8800000, change: 92285 },
    },
    summarisedAt: NOW.toISOString(),
  });
});

Deno.test("summarise of one sample reports no change and no update", () => {
  const summary = summarise(
    ITEM_ID,
    [sample("2026-10-21T09:00:00.000Z")],
    null,
    NOW.toISOString(),
  );
  assertEquals(summary.updatedSinceFirst, false);
  assertEquals(summary.updatedAt, SAMPLED.updatedAt);
  assertEquals(
    Object.values(summary.changes).map(({ change }) => change),
    [0, 0, 0, 0, 0, 0],
  );
});

Deno.test("summarise of nothing throws", () => {
  assertThrows(() => summarise(ITEM_ID, [], null, ""), Error, "No samples");
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
  assertStringIncludes(predicates[0] ?? "", `name == "item-${ITEM_ID}"`);
  assertStringIncludes(predicates[0] ?? "", "version >= 0");
  const writes = written();
  assertEquals(writes.length, 1);
  assertEquals(writes[0]?.specName, "summary");
  assertEquals(writes[0]?.name, `summary-${ITEM_ID}`);
  assertEquals(writes[0]?.data.samples, 3);
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
  assertEquals(
    (data?.changes as Record<string, { change: number }>).subscriptions?.change,
    -500,
  );
});

Deno.test("the summarise method skips records that are not samples of its item", async () => {
  const first = SAMPLES[0];
  const second = SAMPLES[1];
  assert(first !== undefined && second !== undefined);
  const { context, written, logs } = testContext(() =>
    Promise.resolve([
      record(1, first),
      record(2, { ...second, itemId: "1619685021" }),
      { version: 3, attributes: { unexpected: true } },
      record(4, { ...second, views: -1 }),
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
  const globals = behavior.globalArguments;
  assert(globals.safeParse({ itemId: ITEM_ID }).success);
  for (const bad of ["", "0", "0123", "12a", "-5", "1".repeat(21)]) {
    assert(!globals.safeParse({ itemId: bad }).success, bad);
  }
  assert(!globals.safeParse({ itemId: 104691717 }).success);
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
