/**
 * Unit tests for the Steamworks wishlists behavior. Every test injects a
 * fetch, a clock and, for `summarise`, a query, and the fixtures follow the
 * response shape Valve documents for
 * `IPartnerFinancialsService/GetAppWishlistReporting`, so nothing here reaches
 * Valve or a swamp datastore.
 *
 * @module
 */

import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20261016.58";
import {
  behavior,
  dateRange,
  type DayRow,
  fetchDay,
  type Fetcher,
  fetchRange,
  KEY_HEADER,
  MAX_DAYS,
  type MethodContext,
  summarise,
  trendOf,
  USER_AGENT,
  VERSION,
  type WishlistsRecord,
  wishlistUrl,
} from "./steamworks_wishlists.ts";
import source from "./steamworks_wishlists.ts" with { type: "text" };
import manifest from "./manifest.yaml" with { type: "text" };

/** The version the manifest publishes, which the User-Agent names. */
const MANIFEST_VERSION = /^version: "([^"]+)"$/m.exec(manifest)?.[1];

const APP_ID = 440;
const MODEL_ID = "00000000-0000-4000-8000-000000000078";
/** A made-up key; the tests assert it never leaves the x-webapi-key header. */
const KEY = "FAKEKEY0000000000000000000000000";
const NOW = new Date("2026-10-22T12:00:00.000Z");

/** A summary block in the documented `CPartnerFinancials_WishlistSummary` shape. */
function apiSummary(
  adds: number,
  deletes: number,
  purchases: number,
  gifts: number,
): Record<string, number> {
  return {
    wishlist_adds: adds,
    wishlist_deletes: deletes,
    wishlist_purchases: purchases,
    wishlist_gifts: gifts,
    wishlist_adds_windows: adds - 2,
    wishlist_adds_mac: 1,
    wishlist_adds_linux: 1,
  };
}

/** An answer in the shape of Valve's documented example, country and language breakdowns included. */
function apiAnswer(
  date: string,
  adds: number,
  deletes = 15,
  purchases = 10,
  gifts = 5,
): Record<string, unknown> {
  return {
    response: {
      appid: APP_ID,
      date,
      wishlist_summary: apiSummary(adds, deletes, purchases, gifts),
      country_summary: [
        {
          country_code: "CA",
          country_name: "Canada",
          region: "North America",
          summary_actions: apiSummary(adds, deletes, purchases, gifts),
        },
      ],
      language_summary: [
        {
          language: 0,
          language_name: "English",
          summary_actions: apiSummary(adds, deletes, purchases, gifts),
        },
      ],
      time_generated: 1772580513,
      app_min_date: "2010-01-01",
    },
  };
}

/** The answer Valve documents for a date outside the app's range: only app_min_date. */
const EMPTY = { response: { app_min_date: "2026-10-21" } };

/** One canned answer of a fake fetch. */
interface Answer {
  status?: number;
  body: string;
  headers?: Record<string, string>;
}

/** A fetch that answers in turn, the last answer repeating, recording the requests. */
function fakeFetch(
  ...answers: Answer[]
): { fetcher: Fetcher; urls: string[]; inits: (RequestInit | undefined)[] } {
  const urls: string[] = [];
  const inits: (RequestInit | undefined)[] = [];
  const fetcher: Fetcher = (input, init) => {
    const answer = answers[Math.min(urls.length, answers.length - 1)];
    urls.push(input);
    inits.push(init);
    return Promise.resolve(
      new Response(answer?.body ?? "", {
        status: answer?.status ?? 200,
        headers: answer?.headers ?? {},
      }),
    );
  };
  return { fetcher, urls, inits };
}

/** A fetch answering each request with the documented answer for its date. */
function byDateFetch(adds: Record<string, number>) {
  const urls: string[] = [];
  const inits: (RequestInit | undefined)[] = [];
  const fetcher: Fetcher = (input, init) => {
    urls.push(input);
    inits.push(init);
    const date = new URL(input).searchParams.get("date") ?? "";
    const count = adds[date];
    const body = count === undefined ? EMPTY : apiAnswer(date, count);
    return Promise.resolve(new Response(JSON.stringify(body)));
  };
  return { fetcher, urls, inits };
}

/** A test context with global arguments and an optional query. */
function testContext(
  options: { queryData?: (predicate: string) => Promise<unknown[]> } = {},
): {
  context: MethodContext;
  written: ReturnType<typeof createModelTestContext>["getWrittenResources"];
  logs: ReturnType<typeof createModelTestContext>["getLogs"];
} {
  const globalArgs = { apiKey: KEY, appId: APP_ID };
  const test = createModelTestContext({ globalArgs });
  const context: MethodContext = {
    ...test.context,
    globalArgs,
    modelId: MODEL_ID,
    queryData: options.queryData,
  };
  return { context, written: test.getWrittenResources, logs: test.getLogs };
}

/** The header the request sent under this name, ignoring case. */
function header(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name);
}

/** A recorded day with these adds and fixed other counts. */
function day(date: string, adds: number): DayRow {
  return {
    date,
    adds,
    deletes: 1,
    purchases: 2,
    gifts: 0,
    addsWindows: adds,
    addsMac: 0,
    addsLinux: 0,
  };
}

/** A recorded sample read at a time. */
function sample(fetchedAt: string, days: DayRow[]): WishlistsRecord {
  return {
    appId: APP_ID,
    from: days[0]?.date ?? "2026-10-01",
    to: days[days.length - 1]?.date ?? "2026-10-01",
    fetchedAt,
    appMinDate: "2010-01-01",
    days,
    emptyDates: [],
  };
}

/** A stored sample record as queryData returns it. */
function record(version: number, stored: WishlistsRecord): unknown {
  return { version, name: "wishlists-440", attributes: stored };
}

Deno.test("sample requests yesterday and today by default, at the documented URL", async () => {
  const { fetcher, urls, inits } = byDateFetch({
    "2026-10-21": 30,
    "2026-10-22": 12,
  });
  const { context } = testContext();
  await behavior.methods.sample.execute(
    { _fetch: fetcher, _now: () => NOW },
    context,
  );
  assertEquals(urls, [
    "https://partner.steam-api.com/IPartnerFinancialsService/GetAppWishlistReporting/v001/?appid=440&date=2026-10-21",
    "https://partner.steam-api.com/IPartnerFinancialsService/GetAppWishlistReporting/v001/?appid=440&date=2026-10-22",
  ]);
  assertEquals(urls[0], wishlistUrl(APP_ID, "2026-10-21"));
  for (const init of inits) {
    assertEquals(init?.method, "GET");
    assertEquals(init?.redirect, "error");
    assertEquals(header(init, "user-agent"), USER_AGENT);
    assertEquals(header(init, "accept"), "application/json");
    assert(init?.signal instanceof AbortSignal);
  }
});

Deno.test("the key is sent only in the x-webapi-key header, never in a URL, record or log", async () => {
  const { fetcher, urls, inits } = byDateFetch({ "2026-10-21": 30 });
  const { context, written, logs } = testContext();
  await behavior.methods.sample.execute(
    { _fetch: fetcher, _now: () => NOW },
    context,
  );
  assertEquals(KEY_HEADER, "x-webapi-key");
  assertEquals(urls.length, 2);
  for (const [i, url] of urls.entries()) {
    assertEquals(header(inits[i], KEY_HEADER), KEY);
    assertFalse(url.includes(KEY));
    assertFalse(url.includes("key="));
  }
  assertFalse(JSON.stringify(written()).includes(KEY));
  assertFalse(JSON.stringify(logs()).includes(KEY));
});

Deno.test("sample records every documented summary count per date, and empty dates", async () => {
  const { fetcher } = byDateFetch({ "2026-10-21": 30 });
  const { context, written, logs } = testContext();
  const result = await behavior.methods.sample.execute(
    { from: "2026-10-20", to: "2026-10-21", _fetch: fetcher, _now: () => NOW },
    context,
  );
  const writes = written();
  assertEquals(writes.length, 1);
  assertEquals(writes[0]?.specName, "wishlists");
  assertEquals(writes[0]?.name, "wishlists-440");
  assertEquals(writes[0]?.data, {
    appId: APP_ID,
    from: "2026-10-20",
    to: "2026-10-21",
    fetchedAt: NOW.toISOString(),
    appMinDate: "2010-01-01",
    days: [
      {
        date: "2026-10-21",
        adds: 30,
        deletes: 15,
        purchases: 10,
        gifts: 5,
        addsWindows: 28,
        addsMac: 1,
        addsLinux: 1,
      },
    ],
    emptyDates: ["2026-10-20"],
  });
  assertEquals(result.dataHandles.length, 1);
  assert(logs().some((log) => log.level === "warning"));
});

Deno.test("a count Valve leaves out is read as zero", async () => {
  const { fetcher } = fakeFetch({
    body: JSON.stringify({
      response: { appid: APP_ID, wishlist_summary: { wishlist_adds: 4 } },
    }),
  });
  const answer = await fetchDay(fetcher, KEY, APP_ID, "2026-10-21");
  assertEquals(answer.row, {
    date: "2026-10-21",
    adds: 4,
    deletes: 0,
    purchases: 0,
    gifts: 0,
    addsWindows: 0,
    addsMac: 0,
    addsLinux: 0,
  });
  assertEquals(answer.appMinDate, null);
});

Deno.test("an answer for another app is rejected", async () => {
  const { fetcher } = fakeFetch({
    body: JSON.stringify({
      response: { ...apiAnswer("2026-10-21", 20).response as object, appid: 7 },
    }),
  });
  await assertRejects(
    () => fetchDay(fetcher, KEY, APP_ID, "2026-10-21"),
    Error,
    "answered for app 7",
  );
});

Deno.test("dateRange defaults, bounds and refusals", () => {
  assertEquals(dateRange(undefined, undefined, NOW), [
    "2026-10-21",
    "2026-10-22",
  ]);
  assertEquals(dateRange(undefined, "2026-03-01", NOW), [
    "2026-02-28",
    "2026-03-01",
  ]);
  assertEquals(dateRange("2026-10-22", undefined, NOW), ["2026-10-22"]);
  assertEquals(
    dateRange("2026-07-23", "2026-10-22", NOW).length,
    MAX_DAYS,
  );
  assertThrows(
    () => dateRange("2026-07-22", "2026-10-22", NOW),
    Error,
    `at most ${MAX_DAYS}`,
  );
  assertThrows(
    () => dateRange(undefined, "2026-10-23", NOW),
    Error,
    "after today",
  );
  assertThrows(
    () => dateRange("2026-10-22", "2026-10-21", NOW),
    Error,
    "is after",
  );
  assertThrows(() => dateRange("2026-02-30", "2026-03-01", NOW), Error, "real");
});

Deno.test("sample fails before any request for a bad range", async () => {
  const { fetcher, urls } = byDateFetch({});
  const { context, written } = testContext();
  await assertRejects(
    () =>
      behavior.methods.sample.execute(
        { to: "2026-10-23", _fetch: fetcher, _now: () => NOW },
        context,
      ),
    Error,
    "after today",
  );
  assertEquals(urls.length, 0);
  assertEquals(written().length, 0);
});

Deno.test("a 403 explains the key and stops before the next date, without the key", async () => {
  const { fetcher, urls } = fakeFetch({
    status: 403,
    body: `<html>Forbidden ${KEY}</html>`,
  });
  const { context, written } = testContext();
  const error = await assertRejects(
    () =>
      behavior.methods.sample.execute(
        {
          from: "2026-10-20",
          to: "2026-10-22",
          _fetch: fetcher,
          _now: () => NOW,
        },
        context,
      ),
    Error,
  );
  assertEquals(urls.length, 1);
  assertStringIncludes(error.message, "HTTP 403");
  assertStringIncludes(error.message, "Financial permissions");
  assertStringIncludes(error.message, "rate-limits");
  assertFalse(error.message.includes(KEY));
  assertEquals(written().length, 0);
});

Deno.test("an error body that echoes the key is reported redacted", async () => {
  const { fetcher } = fakeFetch({ status: 400, body: `bad key ${KEY}` });
  const error = await assertRejects(
    () => fetchDay(fetcher, KEY, APP_ID, "2026-10-21"),
    Error,
  );
  assertStringIncludes(error.message, "HTTP 400");
  assertStringIncludes(error.message, "[redacted]");
  assertFalse(error.message.includes(KEY));
});

Deno.test("a network failure is reported with its cause and without the key", async () => {
  const fetcher: Fetcher = () =>
    Promise.reject(new TypeError(`connection refused ${KEY}`));
  const error = await assertRejects(
    () => fetchDay(fetcher, KEY, APP_ID, "2026-10-21"),
    Error,
  );
  assertStringIncludes(error.message, "request failed: connection refused");
  assertFalse(error.message.includes(KEY));
});

Deno.test("a 429 names Retry-After, a 5xx is transient, a 401 is reported", async () => {
  const limited = await assertRejects(
    () =>
      fetchDay(
        fakeFetch({ status: 429, body: "", headers: { "retry-after": "60" } })
          .fetcher,
        KEY,
        APP_ID,
        "2026-10-21",
      ),
    Error,
  );
  assertStringIncludes(limited.message, "retry after 60 seconds");
  const down = await assertRejects(
    () =>
      fetchDay(
        fakeFetch({ status: 503, body: "busy" }).fetcher,
        KEY,
        APP_ID,
        "2026-10-21",
      ),
    Error,
  );
  assertStringIncludes(down.message, "transient");
  const unauthorised = await assertRejects(
    () =>
      fetchDay(
        fakeFetch({ status: 401, body: "no" }).fetcher,
        KEY,
        APP_ID,
        "2026-10-21",
      ),
    Error,
  );
  assertStringIncludes(unauthorised.message, "HTTP 401");
});

Deno.test("a body that is not the documented answer is rejected", async () => {
  for (
    const body of [
      "not json",
      "{}",
      "null",
      JSON.stringify({ response: { wishlist_summary: { wishlist_adds: -1 } } }),
      JSON.stringify({
        response: { wishlist_summary: { wishlist_adds: "3" } },
      }),
    ]
  ) {
    await assertRejects(
      () => fetchDay(fakeFetch({ body }).fetcher, KEY, APP_ID, "2026-10-21"),
      Error,
    );
  }
});

Deno.test("a cancelled run aborts the request", async () => {
  const controller = new AbortController();
  let seen: AbortSignal | undefined;
  const fetcher: Fetcher = (_input, init) => {
    seen = init?.signal ?? undefined;
    controller.abort();
    return Promise.resolve(new Response(JSON.stringify(EMPTY)));
  };
  await fetchRange(
    fetcher,
    KEY,
    APP_ID,
    ["2026-10-21"],
    NOW.toISOString(),
    controller.signal,
  );
  assertEquals(seen?.aborted, true);
});

const SAMPLES: WishlistsRecord[] = [
  sample("2026-10-05T12:00:00.000Z", [
    day("2026-10-03", 10),
    day("2026-10-04", 4),
  ]),
  sample("2026-10-03T12:00:00.000Z", [
    day("2026-10-01", 2),
    day("2026-10-02", 6),
    day("2026-10-03", 1),
  ]),
];

Deno.test("summarise keeps the latest read of each date and reports totals, trend and extremes", () => {
  const summary = summarise(APP_ID, SAMPLES, null, null, NOW.toISOString());
  assertEquals(summary.samples, 2);
  assertEquals(summary.days, 4);
  assertEquals(summary.firstDate, "2026-10-01");
  assertEquals(summary.lastDate, "2026-10-04");
  assertEquals(summary.totals, {
    adds: 22,
    deletes: 4,
    purchases: 8,
    gifts: 0,
    addsWindows: 22,
    addsMac: 0,
    addsLinux: 0,
  });
  assertEquals(summary.averageAdds, 5.5);
  assertEquals(summary.trend, {
    direction: "rising",
    earlierAverageAdds: 4,
    laterAverageAdds: 7,
    addsPerDayChange: 1,
  });
  assertEquals(summary.bestDay, day("2026-10-03", 10));
  assertEquals(summary.worstDay, day("2026-10-01", 2));
});

Deno.test("summarise honours from and to, and needs a day", () => {
  const summary = summarise(
    APP_ID,
    SAMPLES,
    "2026-10-02",
    "2026-10-03",
    NOW.toISOString(),
  );
  assertEquals(summary.days, 2);
  assertEquals(summary.totals.adds, 16);
  assertEquals(summary.trend?.direction, "rising");
  assertThrows(
    () => summarise(APP_ID, SAMPLES, "2027-01-01", null, ""),
    Error,
    "No recorded wishlist days",
  );
});

Deno.test("the trend is null for one day and flat for equal halves, ties pick the earliest day", () => {
  assertEquals(trendOf([day("2026-10-01", 3)]), null);
  const flat = [day("2026-10-01", 3), day("2026-10-02", 3)];
  assertEquals(trendOf(flat), {
    direction: "flat",
    earlierAverageAdds: 3,
    laterAverageAdds: 3,
    addsPerDayChange: 0,
  });
  const summary = summarise(
    APP_ID,
    [sample(NOW.toISOString(), flat)],
    null,
    null,
    "",
  );
  assertEquals(summary.bestDay.date, "2026-10-01");
  assertEquals(summary.worstDay.date, "2026-10-01");
});

Deno.test("the summarise method queries every version of its own samples", async () => {
  const predicates: string[] = [];
  const { context, written } = testContext({
    queryData: (predicate) => {
      predicates.push(predicate);
      return Promise.resolve(SAMPLES.map((stored, i) => record(i + 1, stored)));
    },
  });
  await behavior.methods.summarise.execute({ _now: () => NOW }, context);
  assertEquals(predicates.length, 1);
  assertStringIncludes(predicates[0] ?? "", `modelId == "${MODEL_ID}"`);
  assertStringIncludes(predicates[0] ?? "", 'specName == "wishlists"');
  assertStringIncludes(predicates[0] ?? "", 'name == "wishlists-440"');
  assertStringIncludes(predicates[0] ?? "", "version >= 0");
  const writes = written();
  assertEquals(writes.length, 1);
  assertEquals(writes[0]?.specName, "summary");
  assertEquals(writes[0]?.name, "summary-440");
  assertEquals(writes[0]?.data.days, 4);
});

Deno.test("the summarise method skips records that are not samples of its app", async () => {
  const first = SAMPLES[0];
  assert(first !== undefined);
  const { context, written, logs } = testContext({
    queryData: () =>
      Promise.resolve([
        record(1, first),
        record(2, { ...first, appId: 7 }),
        { version: 3, attributes: { unexpected: true } },
        null,
      ]),
  });
  await behavior.methods.summarise.execute({ _now: () => NOW }, context);
  assertEquals(written()[0]?.data.samples, 1);
  assert(logs().some((log) => log.level === "warning"));
});

Deno.test("the summarise method fails before writing on nothing sampled or bad dates", async () => {
  const empty = testContext({ queryData: () => Promise.resolve([]) });
  await assertRejects(
    () => behavior.methods.summarise.execute({}, empty.context),
    Error,
    "run the sample method first",
  );
  assertEquals(empty.written().length, 0);
  await assertRejects(
    () =>
      behavior.methods.summarise.execute(
        { from: "2026-10-05", to: "2026-10-01" },
        empty.context,
      ),
    Error,
    "is after",
  );
  await assertRejects(
    () =>
      behavior.methods.summarise.execute({ from: "2026-13-01" }, empty.context),
    Error,
    "real",
  );
  const { context } = testContext();
  await assertRejects(
    () => behavior.methods.summarise.execute({}, context),
    Error,
    "queryData",
  );
});

Deno.test("the User-Agent names the version the manifest publishes", () => {
  assertEquals(VERSION, behavior.version);
  assertEquals(VERSION, MANIFEST_VERSION);
  assertEquals(
    USER_AGENT,
    `@reset/steamworks-wishlists/${MANIFEST_VERSION} (swamp extension)`,
  );
});

Deno.test("the method arguments and global arguments validate", () => {
  const globals = behavior.globalArguments;
  assert(globals.safeParse({ apiKey: "k", appId: 440 }).success);
  assert(!globals.safeParse({ apiKey: "", appId: 440 }).success);
  assert(!globals.safeParse({ appId: 440 }).success);
  assert(!globals.safeParse({ apiKey: "k", appId: 0 }).success);
  assert(!globals.safeParse({ apiKey: "k", appId: 4_294_967_296 }).success);
  assert(!globals.safeParse({ apiKey: "k", appId: 1.5 }).success);
  for (
    const args of [
      behavior.methods.sample.arguments,
      behavior.methods.summarise.arguments,
    ]
  ) {
    assert(args.safeParse({}).success);
    assert(args.safeParse({ from: "2026-10-01", to: "2026-10-02" }).success);
    assert(!args.safeParse({ from: "2026/10/01" }).success);
    assert(!args.safeParse({ to: "yesterday" }).success);
  }
});

Deno.test("the key is marked sensitive in the schema", () => {
  const meta = behavior.globalArguments.shape.apiKey.meta();
  assertEquals(meta?.sensitive, true);
  assertStringIncludes(String(meta?.description), "vault.get");
});

Deno.test("written records conform to their resource schemas", async () => {
  const sampled = testContext();
  await behavior.methods.sample.execute(
    { _fetch: byDateFetch({ "2026-10-21": 3 }).fetcher, _now: () => NOW },
    sampled.context,
  );
  assert(
    behavior.resources.wishlists.schema.strict().safeParse(
      sampled.written()[0]?.data,
    ).success,
  );
  const summarised = testContext({
    queryData: () =>
      Promise.resolve(SAMPLES.map((stored, i) => record(i + 1, stored))),
  });
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
