/**
 * Unit tests for the Steamworks sales behavior. Every test injects a fetch, a
 * clock, a pause and, for `summarise`, a query. The fixtures follow the
 * response shapes in Valve's `IPartnerFinancialsService` reference, with
 * made-up figures, so nothing here reaches Valve or a swamp datastore.
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
  aggregate,
  behavior,
  CHANGED_DATES_URL,
  type CursorRecord,
  DETAILED_SALES_URL,
  fetchChangedDates,
  fetchDaySales,
  type Fetcher,
  getJson,
  type MethodContext,
  normaliseDate,
  planDates,
  REQUEST_SPACING_MS,
  type SalesRecord,
  summarise,
  unitsToUsd,
  usdToUnits,
  USER_AGENT,
  VERSION,
} from "./steamworks_sales.ts";
import source from "./steamworks_sales.ts" with { type: "text" };
import manifest from "./manifest.yaml" with { type: "text" };

/** The version the manifest publishes, which the User-Agent names. */
const MANIFEST_VERSION = /^version: "([^"]+)"$/m.exec(manifest)?.[1];

const MODEL_ID = "00000000-0000-4000-8000-000000000088";
/** A made-up key; the tests assert it never leaves the x-webapi-key header. */
const KEY = "TESTKEY00000000000000000000000000";
const NOW = new Date("2026-10-23T12:00:00.000Z");
const noSleep = () => Promise.resolve();

/** A Steam sale row in the shape of Valve's first example, made-up figures. */
const PACKAGE_AU = {
  partnerid: "10500",
  date: "2026/10/20",
  line_item_type: "Package",
  packageid: 123,
  bundleid: 777,
  package_sale_type: "Steam",
  platform: "Windows",
  country_code: "AU",
  base_price: "3995",
  sale_price: "1995",
  currency: "AUD",
  gross_units_sold: 10,
  gross_units_returned: -2,
  gross_sales_usd: "311.7201",
  gross_returns_usd: "-25.5322",
  net_tax_usd: "26.0431",
  primary_appid: 999,
  additional_revenue_share_tier: 0,
  net_units_sold: 8,
  net_sales_usd: "260.1448",
  combined_discount_id: 8888,
  total_discount_percentage: 50,
};

/** A second sale of the same app, country and currency on another platform. */
const PACKAGE_AU_MAC = {
  ...PACKAGE_AU,
  platform: "Mac",
  gross_units_sold: 1,
  gross_units_returned: 0,
  gross_sales_usd: "13.0000",
  gross_returns_usd: "0.0000",
  net_tax_usd: "1.1818",
  net_units_sold: 1,
  net_sales_usd: "11.8182",
};

/** An in-game purchase row in the shape of Valve's MicroTxn example. */
const MICROTXN_US = {
  partnerid: "10500",
  date: "2026/10/20",
  line_item_type: "MicroTxn",
  appid: 999,
  game_item_id: 1,
  country_code: "US",
  currency: "USD",
  gross_units_sold: 2,
  gross_units_returned: 0,
  gross_sales_usd: "9.9800",
  gross_returns_usd: "0.0000",
  net_tax_usd: "0.0000",
  net_units_sold: 2,
  net_sales_usd: "9.9800",
  avg_sale_price_usd: "4.9900",
};

/** A retail key activation row in the shape of Valve's CD-key example. */
const RETAIL_AE = {
  partnerid: "10500",
  date: "2026/10/20",
  line_item_type: "Package",
  packageid: 123,
  package_sale_type: "Retail",
  platform: "Unknown",
  country_code: "AE",
  primary_appid: 999,
  key_request_id: 7100,
  gross_units_activated: 10,
};

/** A package with no app Valve can name. */
const UNATTRIBUTED = {
  ...PACKAGE_AU,
  primary_appid: 0,
  country_code: "DE",
  currency: "EUR",
};

const APP_INFO = [{ appid: 999, app_name: "Example Game" }];

/** A `GetChangedDatesForPartner` answer in Valve's documented shape. */
function changedDates(dates: string[], highwatermark: string): string {
  return JSON.stringify({
    response: { dates, result_highwatermark: highwatermark },
  });
}

/** A `GetDetailedSales` answer in Valve's documented shape. */
function detailedSales(results: unknown[], maxId: string): string {
  return JSON.stringify({
    response: {
      results,
      package_info: [{ packageid: 123, package_name: "Example Package" }],
      app_info: APP_INFO,
      country_info: [{ country_code: "AU", country_name: "Australia" }],
      max_id: maxId,
    },
  });
}

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

/** The answers of one run: changed dates, then each date's pages. */
function runFetch(
  dates: string[],
  highwatermark: string,
  pagesPerDate: unknown[][][],
) {
  const answers: Answer[] = [{ body: changedDates(dates, highwatermark) }];
  for (const pages of pagesPerDate) {
    let id = 0;
    for (const page of pages) {
      id += 100;
      answers.push({ body: detailedSales(page, String(id)) });
    }
    answers.push({ body: detailedSales([], String(id)) });
  }
  return fakeFetch(...answers);
}

/** A test context with global arguments, stored records and an optional query. */
function testContext(
  options: {
    includeViewGrants?: boolean;
    storedResources?: Record<string, Record<string, unknown>>;
    queryData?: (predicate: string) => Promise<unknown[]>;
  } = {},
): {
  context: MethodContext;
  written: ReturnType<typeof createModelTestContext>["getWrittenResources"];
  logs: ReturnType<typeof createModelTestContext>["getLogs"];
} {
  const globalArgs = options.includeViewGrants === undefined
    ? { financialKey: KEY }
    : { financialKey: KEY, includeViewGrants: options.includeViewGrants };
  const test = createModelTestContext({
    globalArgs,
    storedResources: options.storedResources ?? {},
  });
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

/** The query parameters of a request URL. */
function params(url: string | undefined): Record<string, string> {
  return Object.fromEntries(new URL(url ?? "").searchParams);
}

Deno.test("sample calls the documented methods with the documented parameters and headers", async () => {
  const { fetcher, urls, inits } = runFetch(["2026/10/20"], "1841", [[[
    PACKAGE_AU,
  ]]]);
  const { context } = testContext();
  await behavior.methods.sample.execute(
    { _fetch: fetcher, _now: () => NOW, _sleep: noSleep },
    context,
  );
  assertEquals(urls.length, 3);
  assertEquals(urls[0]?.split("?")[0], CHANGED_DATES_URL);
  assertEquals(
    CHANGED_DATES_URL,
    "https://partner.steam-api.com/IPartnerFinancialsService/GetChangedDatesForPartner/v001/",
  );
  assertEquals(params(urls[0]), { highwatermark: "0" });
  assertEquals(urls[1]?.split("?")[0], DETAILED_SALES_URL);
  assertEquals(
    DETAILED_SALES_URL,
    "https://partner.steam-api.com/IPartnerFinancialsService/GetDetailedSales/v001/",
  );
  assertEquals(params(urls[1]), {
    date: "2026/10/20",
    highwatermark_id: "0",
  });
  assertEquals(params(urls[2]), {
    date: "2026/10/20",
    highwatermark_id: "100",
  });
  for (const init of inits) {
    assertEquals(init?.method, "GET");
    assertEquals(header(init, "x-webapi-key"), KEY);
    assertEquals(init?.redirect, "error");
    assertEquals(header(init, "user-agent"), USER_AGENT);
    assert(init?.signal instanceof AbortSignal);
  }
});

Deno.test("the key is sent only in the header, never in a URL, record or log", async () => {
  const { fetcher, urls } = runFetch(["2026/10/20", "2026/10/21"], "1841", [
    [[PACKAGE_AU], [MICROTXN_US]],
    [[RETAIL_AE]],
  ]);
  const { context, written, logs } = testContext({ includeViewGrants: true });
  await behavior.methods.sample.execute(
    { _fetch: fetcher, _now: () => NOW, _sleep: noSleep },
    context,
  );
  for (const url of urls) {
    assertFalse(url.includes(KEY));
    assertEquals(params(url).include_view_grants, "true");
    assertFalse("key" in params(url));
  }
  assertFalse(JSON.stringify(written()).includes(KEY));
  assertFalse(JSON.stringify(logs()).includes(KEY));
});

Deno.test("no raw sales row reaches a record or a log", async () => {
  const { fetcher } = runFetch(["2026/10/20"], "1841", [[[
    PACKAGE_AU,
    RETAIL_AE,
  ]]]);
  const { context, written, logs } = testContext();
  await behavior.methods.sample.execute(
    { _fetch: fetcher, _now: () => NOW, _sleep: noSleep },
    context,
  );
  const everything = JSON.stringify(written()) + JSON.stringify(logs());
  for (
    const raw of [
      "partnerid",
      "10500",
      "packageid",
      "key_request_id",
      "7100",
      "combined_discount_id",
      "sale_price",
      "platform",
    ]
  ) {
    assertFalse(everything.includes(raw), raw);
  }
  assertFalse(JSON.stringify(logs()).includes("260.1448"));
});

Deno.test("the first sample records the day's aggregates and the cursor", async () => {
  const { fetcher } = runFetch(["2026/10/20"], "1841518117865", [[
    [PACKAGE_AU, MICROTXN_US],
    [PACKAGE_AU_MAC, RETAIL_AE, UNATTRIBUTED],
  ]]);
  const { context, written } = testContext();
  const result = await behavior.methods.sample.execute(
    { _fetch: fetcher, _now: () => NOW, _sleep: noSleep },
    context,
  );
  const writes = written();
  assertEquals(writes.map(({ specName, name }) => [specName, name]), [
    ["sales", "sales-2026-10-20"],
    ["cursor", "cursor"],
  ]);
  assertEquals(result.dataHandles.length, 2);
  const zero = {
    grossUnitsSold: 0,
    grossUnitsReturned: 0,
    netUnitsSold: 0,
    unitsActivated: 0,
    grossSalesUsd: "0.0000",
    grossReturnsUsd: "0.0000",
    netTaxUsd: "0.0000",
    netSalesUsd: "0.0000",
  };
  assertEquals(writes[0]?.data, {
    date: "2026-10-20",
    steamDate: "2026/10/20",
    fetchedAt: NOW.toISOString(),
    highwatermark: "1841518117865",
    includeViewGrants: false,
    pages: 3,
    rows: 5,
    totals: {
      grossUnitsSold: 23,
      grossUnitsReturned: -4,
      netUnitsSold: 19,
      unitsActivated: 10,
      grossSalesUsd: "646.4202",
      grossReturnsUsd: "-51.0644",
      netTaxUsd: "53.2680",
      netSalesUsd: "542.0878",
    },
    aggregates: [
      {
        appid: 0,
        appName: null,
        countryCode: "DE",
        currency: "EUR",
        lineItemType: "Package",
        totals: {
          grossUnitsSold: 10,
          grossUnitsReturned: -2,
          netUnitsSold: 8,
          unitsActivated: 0,
          grossSalesUsd: "311.7201",
          grossReturnsUsd: "-25.5322",
          netTaxUsd: "26.0431",
          netSalesUsd: "260.1448",
        },
      },
      {
        appid: 999,
        appName: "Example Game",
        countryCode: "AE",
        currency: null,
        lineItemType: "Package",
        totals: { ...zero, unitsActivated: 10 },
      },
      {
        appid: 999,
        appName: "Example Game",
        countryCode: "AU",
        currency: "AUD",
        lineItemType: "Package",
        totals: {
          grossUnitsSold: 11,
          grossUnitsReturned: -2,
          netUnitsSold: 9,
          unitsActivated: 0,
          grossSalesUsd: "324.7201",
          grossReturnsUsd: "-25.5322",
          netTaxUsd: "27.2249",
          netSalesUsd: "271.9630",
        },
      },
      {
        appid: 999,
        appName: "Example Game",
        countryCode: "US",
        currency: "USD",
        lineItemType: "MicroTxn",
        totals: {
          grossUnitsSold: 2,
          grossUnitsReturned: 0,
          netUnitsSold: 2,
          unitsActivated: 0,
          grossSalesUsd: "9.9800",
          grossReturnsUsd: "0.0000",
          netTaxUsd: "0.0000",
          netSalesUsd: "9.9800",
        },
      },
    ],
  });
  assertEquals(writes[1]?.data, {
    highwatermark: "1841518117865",
    previousHighwatermark: "0",
    fetchedAt: NOW.toISOString(),
    recordedDates: ["2026-10-20"],
    pendingDates: [],
  });
});

Deno.test("a later sample sends the stored highwatermark", async () => {
  const cursor: CursorRecord = {
    highwatermark: "120",
    previousHighwatermark: "0",
    fetchedAt: "2026-10-22T12:00:00.000Z",
    recordedDates: ["2026-10-19"],
    pendingDates: [],
  };
  const { fetcher, urls } = runFetch(["2026/10/19"], "150", [[[PACKAGE_AU]]]);
  const { context, written } = testContext({
    storedResources: { cursor: { ...cursor } },
  });
  await behavior.methods.sample.execute(
    { _fetch: fetcher, _now: () => NOW, _sleep: noSleep },
    context,
  );
  assertEquals(params(urls[0]), { highwatermark: "120" });
  const next = written()[1]?.data as unknown as CursorRecord;
  assertEquals(next.highwatermark, "150");
  assertEquals(next.previousHighwatermark, "120");
});

Deno.test("an unchanged highwatermark records no day and keeps the cursor", async () => {
  const { fetcher, urls } = fakeFetch({ body: changedDates([], "120") });
  const { context, written, logs } = testContext({
    storedResources: {
      cursor: {
        highwatermark: "120",
        previousHighwatermark: "0",
        fetchedAt: "2026-10-22T12:00:00.000Z",
        recordedDates: [],
        pendingDates: [],
      },
    },
  });
  await behavior.methods.sample.execute(
    { _fetch: fetcher, _now: () => NOW, _sleep: noSleep },
    context,
  );
  assertEquals(urls.length, 1);
  assertEquals(written().map(({ specName }) => specName), ["cursor"]);
  assertEquals(
    (written()[0]?.data as unknown as CursorRecord).highwatermark,
    "120",
  );
  assert(logs().some((log) => log.message.includes("No sales dates changed")));
});

Deno.test("an answer without dates is read as no changed dates", async () => {
  const { fetcher } = fakeFetch({
    body: JSON.stringify({ response: { result_highwatermark: "7" } }),
  });
  const changed = await fetchChangedDates(fetcher, KEY, "7", false);
  assertEquals(changed, { dates: [], highwatermark: "7" });
});

Deno.test("maxDates leaves the newest dates in the cursor, recorded first next run", async () => {
  const first = runFetch(
    ["2026/10/21", "2026/10/19", "2026/10/20"],
    "200",
    [[[PACKAGE_AU]], [[PACKAGE_AU]]],
  );
  const run = testContext();
  await behavior.methods.sample.execute(
    { maxDates: 2, _fetch: first.fetcher, _now: () => NOW, _sleep: noSleep },
    run.context,
  );
  const cursor = run.written().at(-1)?.data as unknown as CursorRecord;
  assertEquals(cursor.recordedDates, ["2026-10-19", "2026-10-20"]);
  assertEquals(cursor.pendingDates, ["2026/10/21"]);
  assertEquals(cursor.highwatermark, "200");
  assert(run.logs().some((log) => log.level === "warning"));
  const second = runFetch([], "200", [[[PACKAGE_AU]]]);
  await behavior.methods.sample.execute(
    { _fetch: second.fetcher, _now: () => NOW, _sleep: noSleep },
    run.context,
  );
  assertEquals(params(second.urls[1]).date, "2026/10/21");
  const after = run.written().at(-1)?.data as unknown as CursorRecord;
  assertEquals(after.pendingDates, []);
});

Deno.test("planDates merges pending and changed dates once each, oldest first", () => {
  assertEquals(
    planDates(["2026/10/21"], ["2026-10-22", "2026/10/21", "20261020"], 2),
    { now: ["20261020", "2026/10/21"], later: ["2026-10-22"] },
  );
});

Deno.test("paging follows max_id until it equals the id sent", async () => {
  const { fetcher, urls } = fakeFetch(
    { body: detailedSales([PACKAGE_AU], "29481179373") },
    { body: detailedSales([MICROTXN_US], "29481179999") },
    { body: detailedSales([], "29481179999") },
  );
  const pauses: number[] = [];
  const day = await fetchDaySales(
    fetcher,
    KEY,
    "2026/10/20",
    false,
    10,
    () => {
      pauses.push(1);
      return Promise.resolve();
    },
  );
  assertEquals(urls.map((url) => params(url).highwatermark_id), [
    "0",
    "29481179373",
    "29481179999",
  ]);
  assertEquals(day.pages, 3);
  assertEquals(day.rows, 2);
  assertEquals(pauses.length, 2);
});

Deno.test("a date with more pages than maxPages fails without recording it", async () => {
  let id = 0;
  const fetcher: Fetcher = () => {
    id += 1;
    return Promise.resolve(
      new Response(detailedSales([PACKAGE_AU], String(id))),
    );
  };
  await assertRejects(
    () => fetchDaySales(fetcher, KEY, "2026/10/20", false, 3, noSleep),
    Error,
    "more than 3 pages",
  );
  const { context, written } = testContext();
  const run = fakeFetch(
    { body: changedDates(["2026/10/20"], "9") },
    { body: detailedSales([PACKAGE_AU], "1") },
    { body: detailedSales([PACKAGE_AU], "2") },
  );
  await assertRejects(
    () =>
      behavior.methods.sample.execute(
        { maxPages: 2, _fetch: run.fetcher, _sleep: noSleep },
        context,
      ),
    Error,
    "raise maxPages",
  );
  assertEquals(written().length, 0);
});

Deno.test("a max_id that goes backwards fails", async () => {
  const { fetcher } = fakeFetch(
    { body: detailedSales([PACKAGE_AU], "500") },
    { body: detailedSales([PACKAGE_AU], "400") },
  );
  await assertRejects(
    () => fetchDaySales(fetcher, KEY, "2026/10/20", false, 10, noSleep),
    Error,
    "backwards",
  );
});

Deno.test("sample pauses between requests", async () => {
  const { fetcher } = runFetch(["2026/10/20", "2026/10/21"], "9", [
    [[PACKAGE_AU]],
    [[PACKAGE_AU]],
  ]);
  const pauses: number[] = [];
  const { context } = testContext();
  await behavior.methods.sample.execute(
    {
      _fetch: fetcher,
      _sleep: (ms) => {
        pauses.push(ms);
        return Promise.resolve();
      },
    },
    context,
  );
  // Five requests, a pause before each but the first.
  assertEquals(pauses, [1, 2, 3, 4].map(() => REQUEST_SPACING_MS));
});

Deno.test("numbers written as strings and strings written as numbers are read", async () => {
  const row = {
    ...PACKAGE_AU,
    gross_units_sold: "10",
    gross_units_returned: "-2",
    net_units_sold: "8",
    primary_appid: "999",
    net_sales_usd: 260.1448,
  };
  const { fetcher } = fakeFetch(
    {
      body: JSON.stringify({
        response: { results: [row], app_info: APP_INFO, max_id: 5 },
      }),
    },
    { body: JSON.stringify({ response: { results: [], max_id: 5 } }) },
  );
  const day = await fetchDaySales(
    fetcher,
    KEY,
    "2026/10/20",
    false,
    5,
    noSleep,
  );
  assertEquals(day.aggregates[0]?.appid, 999);
  assertEquals(day.aggregates[0]?.totals.netUnitsSold, 8);
  assertEquals(day.aggregates[0]?.totals.netSalesUsd, "260.1448");
});

Deno.test("USD amounts are added exactly", () => {
  assertEquals(usdToUnits("311.7201"), 3_117_201n);
  assertEquals(usdToUnits("-25.5"), -255_000n);
  assertEquals(usdToUnits("7"), 70_000n);
  assertEquals(unitsToUsd(-255_000n), "-25.5000");
  assertEquals(unitsToUsd(-1n), "-0.0001");
  assertEquals(unitsToUsd(usdToUnits("0.1") + usdToUnits("0.2")), "0.3000");
  assertThrows(() => usdToUnits("1.23456"), Error);
  assertThrows(() => usdToUnits("$1"), Error);
});

Deno.test("dates are normalised from each documented form", () => {
  assertEquals(normaliseDate("2026/10/20"), "2026-10-20");
  assertEquals(normaliseDate("2026-10-20"), "2026-10-20");
  assertEquals(normaliseDate("20261020"), "2026-10-20");
  assertThrows(() => normaliseDate("Oct 20"), Error);
});

Deno.test("aggregate attributes a row to its appid, else its primary app, else 0", () => {
  const items = aggregate(
    [
      { line_item_type: "MicroTxn", appid: 5, primary_appid: 6 },
      { line_item_type: "Package", primary_appid: 6 },
      { line_item_type: "Package", appid: 0, primary_appid: 0 },
    ],
    new Map(),
  );
  assertEquals(items.map(({ appid }) => appid), [0, 5, 6]);
  assertEquals(items[0]?.countryCode, null);
});

Deno.test("a 403 is reported without the key and not retried", async () => {
  const { fetcher, urls } = fakeFetch({ status: 403, body: "Forbidden" });
  const { context, written } = testContext();
  const error = await assertRejects(
    () =>
      behavior.methods.sample.execute(
        { _fetch: fetcher, _sleep: noSleep },
        context,
      ),
    Error,
  );
  assertStringIncludes(error.message, "HTTP 403");
  assertStringIncludes(error.message, "Not retried");
  assertFalse(error.message.includes(KEY));
  assertEquals(urls.length, 1);
  assertEquals(written().length, 0);
});

Deno.test("a 429, server error, other status and network failure are reported", async () => {
  const cases: [Answer, string][] = [
    [
      { status: 429, body: "", headers: { "retry-after": "60" } },
      "retry after 60 seconds",
    ],
    [{ status: 429, body: "" }, "wait before retrying"],
    [{ status: 503, body: "busy" }, "transient"],
    [{ status: 400, body: "bad date" }, "rejected the parameters"],
    [{ status: 418, body: "" }, "unexpected status"],
  ];
  for (const [answer, text] of cases) {
    const { fetcher } = fakeFetch(answer);
    const error = await assertRejects(
      () => fetchChangedDates(fetcher, KEY, "0", false),
      Error,
    );
    assertStringIncludes(error.message, text);
  }
  const failing: Fetcher = () =>
    Promise.reject(new TypeError(`connection refused, key ${KEY}`));
  const error = await assertRejects(
    () => fetchChangedDates(failing, KEY, "0", false),
    Error,
  );
  assertStringIncludes(error.message, "request failed: connection refused");
  assertFalse(error.message.includes(KEY));
});

Deno.test("an error never echoes the key, even when Valve's body does", async () => {
  const { fetcher } = fakeFetch({ status: 500, body: `bad key ${KEY}` });
  const error = await assertRejects(
    () => fetchChangedDates(fetcher, KEY, "0", false),
    Error,
  );
  assertFalse(error.message.includes(KEY));
  assertStringIncludes(error.message, "[redacted]");
});

Deno.test("a body that is not the documented shape is rejected without its values", async () => {
  for (
    const body of [
      "not json",
      "{}",
      JSON.stringify({ response: {} }),
      JSON.stringify({
        response: { results: [{ gross_sales_usd: "311.72" }], max_id: "1" },
      }),
      JSON.stringify({
        response: {
          results: [{ ...PACKAGE_AU, net_sales_usd: "lots" }],
          max_id: "1",
        },
      }),
    ]
  ) {
    const { fetcher } = fakeFetch({ body });
    const error = await assertRejects(
      () => fetchDaySales(fetcher, KEY, "2026/10/20", false, 2, noSleep),
      Error,
    );
    assertFalse(error.message.includes("311.72"));
    assertFalse(error.message.includes("lots"));
  }
  const { fetcher } = fakeFetch({
    body: changedDates(["last tuesday"], "1"),
  });
  await assertRejects(() => fetchChangedDates(fetcher, KEY, "0", false), Error);
});

Deno.test("the key is never sent outside the partner host", async () => {
  const { fetcher, urls } = fakeFetch({ body: "{}" });
  await assertRejects(
    () =>
      getJson(
        fetcher,
        "https://api.steampowered.com/IPartnerFinancialsService/GetDetailedSales/v001/",
        {},
        "test",
        KEY,
      ),
    Error,
    "refusing",
  );
  assertEquals(urls.length, 0);
});

Deno.test("a cancelled run aborts the request", async () => {
  const controller = new AbortController();
  let seen: AbortSignal | undefined;
  const fetcher: Fetcher = (_input, init) => {
    seen = init?.signal ?? undefined;
    controller.abort();
    return Promise.resolve(new Response(changedDates([], "1")));
  };
  await fetchChangedDates(fetcher, KEY, "0", false, controller.signal);
  assertEquals(seen?.aborted, true);
});

Deno.test("a stored cursor in another shape stops the run rather than starting over", async () => {
  const { fetcher, urls } = fakeFetch({ body: changedDates([], "1") });
  const { context } = testContext({ storedResources: { cursor: { old: 1 } } });
  await assertRejects(
    () => behavior.methods.sample.execute({ _fetch: fetcher }, context),
    Error,
    "not in the current shape",
  );
  assertEquals(urls.length, 0);
});

/** A recorded day with one aggregate per entry. */
function day(
  date: string,
  items: {
    appid: number;
    country: string;
    type?: string;
    units: number;
    net: string;
  }[],
): SalesRecord {
  const aggregates = items.map((item) => ({
    appid: item.appid,
    appName: item.appid === 0 ? null : `App ${item.appid}`,
    countryCode: item.country,
    currency: "USD",
    lineItemType: item.type ?? "Package",
    totals: {
      grossUnitsSold: item.units,
      grossUnitsReturned: 0,
      netUnitsSold: item.units,
      unitsActivated: 0,
      grossSalesUsd: item.net,
      grossReturnsUsd: "0.0000",
      netTaxUsd: "0.0000",
      netSalesUsd: item.net,
    },
  }));
  return {
    date,
    steamDate: date.replaceAll("-", "/"),
    fetchedAt: NOW.toISOString(),
    highwatermark: "1",
    includeViewGrants: false,
    pages: 1,
    rows: items.length,
    totals: aggregates[0]?.totals ?? {
      grossUnitsSold: 0,
      grossUnitsReturned: 0,
      netUnitsSold: 0,
      unitsActivated: 0,
      grossSalesUsd: "0.0000",
      grossReturnsUsd: "0.0000",
      netTaxUsd: "0.0000",
      netSalesUsd: "0.0000",
    },
    aggregates,
  };
}

const DAYS: SalesRecord[] = [
  day("2026-10-21", [
    { appid: 1, country: "US", units: 3, net: "30.0000" },
    { appid: 1, country: "US", type: "MicroTxn", units: 5, net: "5.0000" },
  ]),
  day("2026-10-19", [
    { appid: 1, country: "US", units: 1, net: "10.0000" },
    { appid: 2, country: "GB", units: 2, net: "4.0000" },
  ]),
  day("2026-10-20", [{ appid: 1, country: "GB", units: 2, net: "20.0000" }]),
  day("2026-10-22", [{ appid: 2, country: "US", units: 1, net: "2.0000" }]),
];

Deno.test("summarise reports totals per app and country, a daily series and a trend", () => {
  const summary = summarise(DAYS, null, null, NOW.toISOString());
  assertEquals(summary.days, 4);
  assertEquals(summary.firstDate, "2026-10-19");
  assertEquals(summary.lastDate, "2026-10-22");
  assertEquals(summary.netSalesUsd, "71.0000");
  assertEquals(summary.package.netUnitsSold, 9);
  assertEquals(summary.microTxn.netUnitsSold, 5);
  assertEquals(summary.apps.map(({ appid }) => appid), [1, 2]);
  const app = summary.apps[0];
  assertEquals(app?.appName, "App 1");
  assertEquals(app?.netSalesUsd, "65.0000");
  assertEquals(app?.package.netUnitsSold, 6);
  assertEquals(app?.microTxn.netSalesUsd, "5.0000");
  assertEquals(
    app?.countries.map(({ countryCode, netSalesUsd }) => [
      countryCode,
      netSalesUsd,
    ]),
    [["US", "45.0000"], ["GB", "20.0000"]],
  );
  assertEquals(app?.daily, [
    { date: "2026-10-19", netUnitsSold: 1, netSalesUsd: "10.0000" },
    { date: "2026-10-20", netUnitsSold: 2, netSalesUsd: "20.0000" },
    { date: "2026-10-21", netUnitsSold: 3, netSalesUsd: "35.0000" },
    { date: "2026-10-22", netUnitsSold: 0, netSalesUsd: "0.0000" },
  ]);
  assertEquals(app?.trend, {
    earlierDays: 2,
    laterDays: 2,
    earlierNetSalesUsd: "30.0000",
    laterNetSalesUsd: "35.0000",
    changeNetSalesUsd: "5.0000",
    earlierNetUnitsSold: 3,
    laterNetUnitsSold: 3,
    changeNetUnitsSold: 0,
  });
  assertEquals(summary.trend.changeNetSalesUsd, "3.0000");
  assertEquals(
    summary.countries.map(({ countryCode, currencies }) => [
      countryCode,
      currencies,
    ]),
    [["US", ["USD"]], ["GB", ["USD"]]],
  );
});

Deno.test("summarise of nothing throws", () => {
  assertThrows(() => summarise([], null, null, ""), Error, "No recorded days");
});

/** A stored day as queryData returns it. */
function stored(version: number, record: SalesRecord): unknown {
  return { version, name: `sales-${record.date}`, attributes: record };
}

Deno.test("the summarise method queries every version and counts each day's latest once", async () => {
  const predicates: string[] = [];
  const superseded = day("2026-10-20", [
    { appid: 1, country: "GB", units: 99, net: "999.0000" },
  ]);
  const { context, written } = testContext({
    queryData: (predicate) => {
      predicates.push(predicate);
      return Promise.resolve([
        ...DAYS.map((record, i) => stored(i + 2, record)),
        stored(1, superseded),
      ]);
    },
  });
  await behavior.methods.summarise.execute({ _now: () => NOW }, context);
  assertEquals(predicates.length, 1);
  assertStringIncludes(predicates[0] ?? "", `modelId == "${MODEL_ID}"`);
  assertStringIncludes(predicates[0] ?? "", 'specName == "sales"');
  assertStringIncludes(predicates[0] ?? "", "version >= 0");
  const writes = written();
  assertEquals(writes.length, 1);
  assertEquals(writes[0]?.specName, "summary");
  assertEquals(writes[0]?.name, "summary");
  assertEquals(writes[0]?.data.days, 4);
  assertEquals(writes[0]?.data.netSalesUsd, "71.0000");
});

Deno.test("the summarise method honours from and to", async () => {
  const { context, written } = testContext({
    queryData: () =>
      Promise.resolve(DAYS.map((record, i) => stored(i + 1, record))),
  });
  await behavior.methods.summarise.execute(
    { from: "2026-10-20", to: "2026-10-21", _now: () => NOW },
    context,
  );
  const data = written()[0]?.data;
  assertEquals(data?.days, 2);
  assertEquals(data?.from, "2026-10-20");
  assertEquals(data?.to, "2026-10-21");
  assertEquals(data?.netSalesUsd, "55.0000");
  await assertRejects(
    () =>
      behavior.methods.summarise.execute(
        { from: "2026-10-22", to: "2026-10-21" },
        context,
      ),
    Error,
    "after",
  );
});

Deno.test("the summarise method skips stored records that are not days and fails on none", async () => {
  const first = DAYS[0];
  assert(first !== undefined);
  const mixed = testContext({
    queryData: () =>
      Promise.resolve([
        stored(1, first),
        { version: 2, attributes: { unexpected: true } },
        null,
      ]),
  });
  await behavior.methods.summarise.execute({ _now: () => NOW }, mixed.context);
  assertEquals(mixed.written()[0]?.data.days, 1);
  assert(mixed.logs().some((log) => log.level === "warning"));
  const empty = testContext({ queryData: () => Promise.resolve([]) });
  await assertRejects(
    () => behavior.methods.summarise.execute({}, empty.context),
    Error,
    "run the sample method first",
  );
  assertEquals(empty.written().length, 0);
});

Deno.test("the methods fail clearly without readResource or queryData", async () => {
  const { context } = testContext();
  await assertRejects(
    () => behavior.methods.summarise.execute({}, context),
    Error,
    "queryData",
  );
  await assertRejects(
    () =>
      behavior.methods.sample.execute(
        { _fetch: fakeFetch({ body: "{}" }).fetcher },
        { ...context, readResource: undefined },
      ),
    Error,
    "readResource",
  );
});

Deno.test("the User-Agent names the version the manifest publishes", () => {
  assertEquals(VERSION, behavior.version);
  assertEquals(VERSION, MANIFEST_VERSION);
  assertEquals(
    USER_AGENT,
    `@reset/steamworks-sales/${MANIFEST_VERSION} (swamp extension)`,
  );
});

Deno.test("the method arguments and global arguments validate", () => {
  const globals = behavior.globalArguments;
  assert(globals.safeParse({ financialKey: "k" }).success);
  assert(
    globals.safeParse({ financialKey: "k", includeViewGrants: true }).success,
  );
  assert(!globals.safeParse({ financialKey: "" }).success);
  assert(!globals.safeParse({}).success);
  const sampleArgs = behavior.methods.sample.arguments;
  assert(sampleArgs.safeParse({}).success);
  assert(sampleArgs.safeParse({ maxDates: 1, maxPages: 1000 }).success);
  assert(!sampleArgs.safeParse({ maxDates: 0 }).success);
  assert(!sampleArgs.safeParse({ maxDates: 367 }).success);
  assert(!sampleArgs.safeParse({ maxPages: 1001 }).success);
  const summariseArgs = behavior.methods.summarise.arguments;
  assert(summariseArgs.safeParse({}).success);
  assert(summariseArgs.safeParse({ from: "2026-10-01" }).success);
  assert(!summariseArgs.safeParse({ from: "2026/10/01" }).success);
  assert(!summariseArgs.safeParse({ to: "yesterday" }).success);
});

Deno.test("the key is marked sensitive in the schema", () => {
  const key = behavior.globalArguments.shape.financialKey;
  assertEquals(key.meta()?.sensitive, true);
  assertStringIncludes(String(key.description), "vault.get");
});

Deno.test("written records conform to their resource schemas", async () => {
  const sampled = testContext();
  await behavior.methods.sample.execute(
    {
      _fetch: runFetch(["2026/10/20"], "9", [[[PACKAGE_AU, RETAIL_AE]]])
        .fetcher,
      _now: () => NOW,
      _sleep: noSleep,
    },
    sampled.context,
  );
  const [sales, cursor] = sampled.written();
  assert(
    behavior.resources.sales.schema.strict().safeParse(sales?.data).success,
  );
  assert(
    behavior.resources.cursor.schema.strict().safeParse(cursor?.data).success,
  );
  const summarised = testContext({
    queryData: () =>
      Promise.resolve(DAYS.map((record, i) => stored(i + 1, record))),
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
