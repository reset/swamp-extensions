/**
 * Records a Steam partner's daily sales aggregates through Valve's documented
 * partner financials Web API, `IPartnerFinancialsService` on
 * `https://partner.steam-api.com`, and summarises them over a range of days.
 *
 * `sample` calls `GetChangedDatesForPartner` with the highwatermark the
 * previous run recorded (0 on the first), then for each changed date pages
 * through `GetDetailedSales` from `highwatermark_id` 0, passing each answer's
 * `max_id` back until it equals the id sent, as Valve documents. The raw sales
 * rows are added up in memory into one aggregate per app, country, currency
 * and line item type (units, gross sales, returns, tax and net sales in USD)
 * and only those aggregates are written, as a new version of that day's
 * `sales` resource. The highwatermark is written to the `cursor` resource
 * once every changed date has been recorded; dates left over by the
 * `maxDates` cap are kept in the cursor and recorded first next time.
 * `summarise` reads the latest version of every recorded day in a range and
 * writes totals per app and per country, and a daily series per app.
 *
 * The financial Web API key is a sensitive global argument, supplied from a
 * swamp vault. It is sent only in the `x-webapi-key` request header, which
 * Valve documents for every Web API key, and only to
 * `https://partner.steam-api.com`; it is never part of a URL, a record, a log
 * or an error. No raw sales row is logged or written. Requests are made one
 * at a time with a pause between them, and a 403, which Valve answers to a bad
 * key and punishes with strict per-IP rate limits, stops the run without a
 * retry. `fetch` and the pause are injectable through the `_fetch` and
 * `_sleep` method arguments so tests never reach Valve.
 *
 * @module
 */

import { z } from "npm:zod@4";

/** This behavior's version, sent in the User-Agent of every request. */
export const VERSION = "2026.10.30.1";

/** The User-Agent every request sends, naming this extension and its version. */
export const USER_AGENT =
  `@reset/steamworks-sales/${VERSION} (swamp extension)`;

/** Valve's partner Web API host; the key is sent to no other origin. */
export const API_BASE = "https://partner.steam-api.com";

/** The documented method that lists dates with new or changed sales data. */
export const CHANGED_DATES_URL =
  `${API_BASE}/IPartnerFinancialsService/GetChangedDatesForPartner/v001/`;

/** The documented method that returns one date's detailed sales, a page at a time. */
export const DETAILED_SALES_URL =
  `${API_BASE}/IPartnerFinancialsService/GetDetailedSales/v001/`;

/** How long one request to Valve may take before it is abandoned. */
export const REQUEST_TIMEOUT_MS = 15_000;

/**
 * The pause between two requests. Valve publishes no numeric rate limit for
 * these methods; one request at a time with a second between them is this
 * extension's own choice.
 */
export const REQUEST_SPACING_MS = 1_000;

/** Changed dates recorded per run by default. */
export const DEFAULT_MAX_DATES = 31;

/** The most changed dates one run may be asked to record. */
export const MAX_DATES = 366;

/** `GetDetailedSales` pages read per date by default. */
export const DEFAULT_MAX_PAGES = 100;

/** The most `GetDetailedSales` pages per date one run may be asked to read. */
export const MAX_PAGES = 1_000;

/** The data name of the cursor that holds the highwatermark. */
export const CURSOR_NAME = "cursor";

/** The data name the summary is written under. */
export const SUMMARY_NAME = "summary";

/** A plain YYYY-MM-DD date. */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** A date as Valve writes it: YYYY-MM-DD, YYYY/MM/DD or YYYYMMDD. */
const STEAM_DATE_PATTERN = /^(\d{4})[-/]?(\d{2})[-/]?(\d{2})$/;

/** An unsigned integer as a string, the form of Valve's 64-bit ids. */
const ID_PATTERN = /^\d+$/;

/** A USD amount to at most four decimal places, as Valve writes it. */
const USD_PATTERN = /^-?\d+(?:\.\d{1,4})?$/;

/** `true` only when the zod output type and the hand-written interface describe the same shape. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

const GlobalArgsSchema = z.object({
  financialKey: z.string().min(1)
    .meta({ sensitive: true })
    .describe(
      "Steamworks financial Web API key from a Financial API Group, supplied with a vault.get expression, never a literal. Sent only as the x-webapi-key header to partner.steam-api.com",
    ),
  includeViewGrants: z.boolean().optional().describe(
    "Also record sales other partners granted this partner a view of; false when omitted",
  ),
});

/** Global arguments of a behavior instance: one partner's financial key. */
export interface GlobalArgs {
  /** Steamworks financial Web API key. Sensitive: supply it with a vault expression. */
  financialKey: string;
  /** Whether view-grant sales are included. */
  includeViewGrants?: boolean;
}

const _GlobalArgsMatch: Same<z.infer<typeof GlobalArgsSchema>, GlobalArgs> =
  true;

const TotalsSchema = z.object({
  grossUnitsSold: z.number().int(),
  grossUnitsReturned: z.number().int(),
  netUnitsSold: z.number().int(),
  unitsActivated: z.number().int(),
  grossSalesUsd: z.string(),
  grossReturnsUsd: z.string(),
  netTaxUsd: z.string(),
  netSalesUsd: z.string(),
});

/**
 * Units and USD amounts added up over sales rows. Amounts are decimal strings
 * to four places, added exactly; returns are negative, as Valve reports them.
 */
export interface Totals {
  /** Units sold. */
  grossUnitsSold: number;
  /** Units returned, zero or negative. */
  grossUnitsReturned: number;
  /** Units sold less units returned. */
  netUnitsSold: number;
  /** Retail (CD key) units activated. */
  unitsActivated: number;
  /** Sales before returns and tax, in USD. */
  grossSalesUsd: string;
  /** Returns, in USD, zero or negative. */
  grossReturnsUsd: string;
  /** Tax, in USD. */
  netTaxUsd: string;
  /** Sales less returns and tax, in USD. */
  netSalesUsd: string;
}

const _TotalsMatch: Same<z.infer<typeof TotalsSchema>, Totals> = true;

const AggregateSchema = z.object({
  appid: z.number().int().min(0),
  appName: z.string().nullable(),
  countryCode: z.string().nullable(),
  currency: z.string().nullable(),
  lineItemType: z.string(),
  totals: TotalsSchema,
});

/** One day's sales of one app in one country, currency and line item type. */
export interface Aggregate {
  /** The app sold, or the package's primary app; 0 when Valve names neither. */
  appid: number;
  /** The app's name from Valve's `app_info`, or null when it gives none. */
  appName: string | null;
  /** ISO 3166-1 alpha-2 country of purchase, or null when Valve gives none. */
  countryCode: string | null;
  /** Transaction currency, or null for a retail key activation. */
  currency: string | null;
  /** Valve's line item type: Package (a Steam sale or retail key) or MicroTxn. */
  lineItemType: string;
  /** The rows' units and USD amounts added up. */
  totals: Totals;
}

const _AggregateMatch: Same<z.infer<typeof AggregateSchema>, Aggregate> = true;

const SalesRecordSchema = z.object({
  date: z.string().regex(DATE_PATTERN),
  steamDate: z.string(),
  fetchedAt: z.iso.datetime(),
  highwatermark: z.string().regex(ID_PATTERN),
  includeViewGrants: z.boolean(),
  pages: z.number().int().positive(),
  rows: z.number().int().min(0),
  totals: TotalsSchema,
  aggregates: z.array(AggregateSchema),
});

/** One version of one day's `sales` resource. */
export interface SalesRecord {
  /** The sales day, Pacific Time, as YYYY-MM-DD. */
  date: string;
  /** The date exactly as Valve listed it and as it was sent back. */
  steamDate: string;
  /** ISO-8601 time the day was read. */
  fetchedAt: string;
  /** The changed-dates highwatermark of the run that read it. */
  highwatermark: string;
  /** Whether view-grant sales were asked for. */
  includeViewGrants: boolean;
  /** `GetDetailedSales` pages read. */
  pages: number;
  /** Sales rows added up; the rows themselves are not kept. */
  rows: number;
  /** Every aggregate added up. */
  totals: Totals;
  /** Aggregates sorted by app, country, currency and line item type. */
  aggregates: Aggregate[];
}

const _SalesRecordMatch: Same<z.infer<typeof SalesRecordSchema>, SalesRecord> =
  true;

const CursorRecordSchema = z.object({
  highwatermark: z.string().regex(ID_PATTERN),
  previousHighwatermark: z.string().regex(ID_PATTERN),
  fetchedAt: z.iso.datetime(),
  recordedDates: z.array(z.string().regex(DATE_PATTERN)),
  pendingDates: z.array(z.string()),
});

/** One version of the `cursor` resource. */
export interface CursorRecord {
  /** The highwatermark to send next time. */
  highwatermark: string;
  /** The highwatermark this run sent. */
  previousHighwatermark: string;
  /** ISO-8601 time of the run. */
  fetchedAt: string;
  /** The dates this run recorded, as YYYY-MM-DD. */
  recordedDates: string[];
  /** Changed dates, as Valve wrote them, left for the next run by the cap. */
  pendingDates: string[];
}

const _CursorRecordMatch: Same<
  z.infer<typeof CursorRecordSchema>,
  CursorRecord
> = true;

const DailySchema = z.object({
  date: z.string(),
  netUnitsSold: z.number().int(),
  netSalesUsd: z.string(),
});

/** One day of an app's series. */
export interface Daily {
  /** The day, YYYY-MM-DD. */
  date: string;
  /** Package units sold less returned that day. */
  netUnitsSold: number;
  /** Net sales that day in USD, every line item type. */
  netSalesUsd: string;
}

const _DailyMatch: Same<z.infer<typeof DailySchema>, Daily> = true;

const CountryTotalsSchema = z.object({
  countryCode: z.string().nullable(),
  currencies: z.array(z.string()),
  package: TotalsSchema,
  microTxn: TotalsSchema,
  netSalesUsd: z.string(),
});

/** One country's totals over the range. */
export interface CountryTotals {
  /** ISO 3166-1 alpha-2 country, or null for rows without one. */
  countryCode: string | null;
  /** The transaction currencies seen, sorted. */
  currencies: string[];
  /** Package line items: Steam sales and retail key activations. */
  package: Totals;
  /** MicroTxn line items: in-game purchases. */
  microTxn: Totals;
  /** Net sales of both, in USD. */
  netSalesUsd: string;
}

const _CountryTotalsMatch: Same<
  z.infer<typeof CountryTotalsSchema>,
  CountryTotals
> = true;

const TrendSchema = z.object({
  earlierDays: z.number().int().min(0),
  laterDays: z.number().int().min(0),
  earlierNetSalesUsd: z.string(),
  laterNetSalesUsd: z.string(),
  changeNetSalesUsd: z.string(),
  earlierNetUnitsSold: z.number().int(),
  laterNetUnitsSold: z.number().int(),
  changeNetUnitsSold: z.number().int(),
});

/** The range's earlier half against its later half. */
export interface Trend {
  /** Days in the earlier half. */
  earlierDays: number;
  /** Days in the later half. */
  laterDays: number;
  /** Net sales in the earlier half, USD. */
  earlierNetSalesUsd: string;
  /** Net sales in the later half, USD. */
  laterNetSalesUsd: string;
  /** Later less earlier, USD. */
  changeNetSalesUsd: string;
  /** Package net units in the earlier half. */
  earlierNetUnitsSold: number;
  /** Package net units in the later half. */
  laterNetUnitsSold: number;
  /** Later less earlier. */
  changeNetUnitsSold: number;
}

const _TrendMatch: Same<z.infer<typeof TrendSchema>, Trend> = true;

const AppSummarySchema = z.object({
  appid: z.number().int().min(0),
  appName: z.string().nullable(),
  package: TotalsSchema,
  microTxn: TotalsSchema,
  netSalesUsd: z.string(),
  trend: TrendSchema,
  countries: z.array(CountryTotalsSchema),
  daily: z.array(DailySchema),
});

/** One app's totals, countries, trend and daily series over the range. */
export interface AppSummary {
  /** The app, 0 for sales Valve attributes to no app. */
  appid: number;
  /** Its most recent name, or null. */
  appName: string | null;
  /** Package line items added up. */
  package: Totals;
  /** MicroTxn line items added up. */
  microTxn: Totals;
  /** Net sales of both, in USD. */
  netSalesUsd: string;
  /** Earlier half against later half of the range. */
  trend: Trend;
  /** Per country, sorted by net sales, largest first. */
  countries: CountryTotals[];
  /** One entry per recorded day in the range, oldest first. */
  daily: Daily[];
}

const _AppSummaryMatch: Same<z.infer<typeof AppSummarySchema>, AppSummary> =
  true;

const SummarySchema = z.object({
  from: z.string().nullable(),
  to: z.string().nullable(),
  days: z.number().int().positive(),
  firstDate: z.string(),
  lastDate: z.string(),
  package: TotalsSchema,
  microTxn: TotalsSchema,
  netSalesUsd: z.string(),
  trend: TrendSchema,
  apps: z.array(AppSummarySchema),
  countries: z.array(CountryTotalsSchema),
  summarisedAt: z.iso.datetime(),
});

/** The summary of the recorded days in a range. */
export interface Summary {
  /** The first day asked for, or null for no lower bound. */
  from: string | null;
  /** The last day asked for, or null for no upper bound. */
  to: string | null;
  /** Recorded days in the range. */
  days: number;
  /** The earliest recorded day in the range. */
  firstDate: string;
  /** The latest recorded day in the range. */
  lastDate: string;
  /** Package line items of every app. */
  package: Totals;
  /** MicroTxn line items of every app. */
  microTxn: Totals;
  /** Net sales of everything, in USD. */
  netSalesUsd: string;
  /** Earlier half against later half, every app. */
  trend: Trend;
  /** Per app, sorted by net sales, largest first. */
  apps: AppSummary[];
  /** Per country over every app, sorted by net sales, largest first. */
  countries: CountryTotals[];
  /** ISO-8601 time the summary was written. */
  summarisedAt: string;
}

const _SummaryMatch: Same<z.infer<typeof SummarySchema>, Summary> = true;

const SampleArgsSchema = z.object({
  maxDates: z.number().int().min(1).max(MAX_DATES).optional().describe(
    "Most changed dates to record in this run, 1 to 366; 31 when omitted. The rest are kept in the cursor for the next run",
  ),
  maxPages: z.number().int().min(1).max(MAX_PAGES).optional().describe(
    "Most GetDetailedSales pages to read for one date, 1 to 1000; 100 when omitted. A date with more fails the run",
  ),
});

/** Arguments of the `sample` method. */
export interface SampleArgs {
  /** Most changed dates to record in this run. */
  maxDates?: number;
  /** Most `GetDetailedSales` pages to read for one date. */
  maxPages?: number;
}

const _SampleArgsMatch: Same<z.infer<typeof SampleArgsSchema>, SampleArgs> =
  true;

const SummariseArgsSchema = z.object({
  from: z.string().regex(DATE_PATTERN).optional().describe(
    "First sales day to include, YYYY-MM-DD Pacific Time; the earliest recorded when omitted",
  ),
  to: z.string().regex(DATE_PATTERN).optional().describe(
    "Last sales day to include, YYYY-MM-DD Pacific Time; the latest recorded when omitted",
  ),
});

/** Arguments of the `summarise` method. */
export interface SummariseArgs {
  /** First sales day to include. */
  from?: string;
  /** Last sales day to include. */
  to?: string;
}

const _SummariseArgsMatch: Same<
  z.infer<typeof SummariseArgsSchema>,
  SummariseArgs
> = true;

/** An integer Valve writes as a JSON number or a numeric string. */
const ApiInt = z.union([
  z.number().int(),
  z.string().regex(/^-?\d+$/).transform(Number),
]);

/** A 64-bit id Valve writes as a numeric string or a JSON number, kept as a string. */
const ApiId = z.union([
  z.string().regex(ID_PATTERN),
  z.number().int().min(0).transform(String),
]);

/** A USD amount Valve writes as a decimal string. */
const ApiUsd = z.union([
  z.string().regex(USD_PATTERN),
  z.number().transform((value) => value.toFixed(4)),
]);

/** The documented `GetChangedDatesForPartner` answer, the fields used. */
const ApiChangedDatesSchema = z.object({
  response: z.object({
    dates: z.array(z.string().regex(STEAM_DATE_PATTERN)).optional(),
    result_highwatermark: ApiId,
  }),
});

/** The documented fields of one `CPartnerFinancials_DetailedSalesResult` that are added up. */
const ApiSalesRowSchema = z.object({
  line_item_type: z.string(),
  appid: ApiInt.optional(),
  primary_appid: ApiInt.optional(),
  country_code: z.string().optional(),
  currency: z.string().optional(),
  gross_units_sold: ApiInt.optional(),
  gross_units_returned: ApiInt.optional(),
  net_units_sold: ApiInt.optional(),
  gross_units_activated: ApiInt.optional(),
  gross_sales_usd: ApiUsd.optional(),
  gross_returns_usd: ApiUsd.optional(),
  net_tax_usd: ApiUsd.optional(),
  net_sales_usd: ApiUsd.optional(),
});

/**
 * One `CPartnerFinancials_DetailedSalesResult` as parsed: only the fields that
 * are added up. It lives in memory only and is never written or logged.
 */
export interface ApiSalesRow {
  /** Package or MicroTxn. */
  line_item_type: string;
  /** The app of the item sold. */
  appid?: number;
  /** The app a package counts toward; 0 when Valve has none set. */
  primary_appid?: number;
  /** ISO 3166-1 alpha-2 country of purchase. */
  country_code?: string;
  /** Transaction currency. */
  currency?: string;
  /** Units sold. */
  gross_units_sold?: number;
  /** Units returned, zero or negative. */
  gross_units_returned?: number;
  /** Units sold less returned. */
  net_units_sold?: number;
  /** Retail key units activated. */
  gross_units_activated?: number;
  /** Sales in USD, four places. */
  gross_sales_usd?: string;
  /** Returns in USD, four places. */
  gross_returns_usd?: string;
  /** Tax in USD, four places. */
  net_tax_usd?: string;
  /** Sales less returns and tax in USD, four places. */
  net_sales_usd?: string;
}

const _ApiSalesRowMatch: Same<z.infer<typeof ApiSalesRowSchema>, ApiSalesRow> =
  true;

/** The documented `GetDetailedSales` answer, the fields used. */
const ApiDetailedSalesSchema = z.object({
  response: z.object({
    results: z.array(ApiSalesRowSchema).optional(),
    app_info: z.array(z.object({
      appid: ApiInt,
      app_name: z.string().optional(),
    })).optional(),
    max_id: ApiId,
  }),
});

/** The subset of `fetch` the methods use. Tests replace it. */
export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

/** Injectable dependencies, set by tests and otherwise defaulted to the runtime. */
export interface Injected {
  /** Replaces the global `fetch`. */
  _fetch?: Fetcher;
  /** Replaces the clock, returning the current time. */
  _now?: () => Date;
  /** Replaces the pause between requests. */
  _sleep?: (ms: number) => Promise<void>;
}

/** The logger fields this module uses, as swamp's LogTape logger provides them. */
export interface Logger {
  /** User-visible progress. */
  info(message: string, properties?: Record<string, unknown>): void;
  /** Recoverable trouble. */
  warning(message: string, properties?: Record<string, unknown>): void;
}

/** A handle swamp returns for a written record. */
export interface DataHandle {
  /** The record's data name. */
  name: string;
}

/** What a method returns to swamp. */
export interface MethodResult {
  /** Handles of the records the method wrote. */
  dataHandles: DataHandle[];
}

/** One stored record, as swamp's `queryData` returns it. */
export interface DataRecord {
  /** Version number of this record. */
  version: number;
  /** The record's parsed JSON content. */
  attributes: Record<string, unknown>;
}

/** The context fields the methods read. */
export interface MethodContext {
  /** Validated global arguments of the behavior instance. */
  globalArgs: GlobalArgs;
  /** Id of this behavior instance, used to find its own recorded days. */
  modelId: string;
  /** Cancellation from swamp. */
  signal?: AbortSignal;
  /** Structured logger. */
  logger: Logger;
  /** Writes a validated record under a resource spec. */
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<DataHandle>;
  /** Reads the latest version of one of this instance's records, or null. */
  readResource?: (
    instanceName: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;
  /** CEL query over stored data; a predicate naming `version` searches every version. */
  queryData?: (predicate: string) => Promise<unknown[]>;
}

/** The data name one day's sales are written under. */
export function salesName(date: string): string {
  return `sales-${date}`;
}

/** A date as Valve writes it, as YYYY-MM-DD. Throws on anything else. */
export function normaliseDate(steamDate: string): string {
  const match = STEAM_DATE_PATTERN.exec(steamDate);
  if (match === null) {
    throw new Error(
      `Valve listed a date in an undocumented form: ${steamDate}`,
    );
  }
  const [, year, month, day] = match;
  return `${year}-${month}-${day}`;
}

/** A USD decimal string as an exact count of ten-thousandths of a dollar. */
export function usdToUnits(usd: string): bigint {
  if (!USD_PATTERN.test(usd)) {
    throw new Error(`not a USD amount to four places: ${usd}`);
  }
  const negative = usd.startsWith("-");
  const [whole = "0", fraction = ""] = (negative ? usd.slice(1) : usd).split(
    ".",
  );
  const units = BigInt(whole) * 10_000n + BigInt(fraction.padEnd(4, "0"));
  return negative ? -units : units;
}

/** An exact count of ten-thousandths of a dollar as a USD decimal string. */
export function unitsToUsd(units: bigint): string {
  const negative = units < 0n;
  const magnitude = negative ? -units : units;
  const whole = magnitude / 10_000n;
  const fraction = (magnitude % 10_000n).toString().padStart(4, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/** Totals while they are added up, amounts in exact ten-thousandths. */
interface Sum {
  grossUnitsSold: number;
  grossUnitsReturned: number;
  netUnitsSold: number;
  unitsActivated: number;
  grossSalesUsd: bigint;
  grossReturnsUsd: bigint;
  netTaxUsd: bigint;
  netSalesUsd: bigint;
}

function emptySum(): Sum {
  return {
    grossUnitsSold: 0,
    grossUnitsReturned: 0,
    netUnitsSold: 0,
    unitsActivated: 0,
    grossSalesUsd: 0n,
    grossReturnsUsd: 0n,
    netTaxUsd: 0n,
    netSalesUsd: 0n,
  };
}

function addTotals(sum: Sum, totals: Totals): void {
  sum.grossUnitsSold += totals.grossUnitsSold;
  sum.grossUnitsReturned += totals.grossUnitsReturned;
  sum.netUnitsSold += totals.netUnitsSold;
  sum.unitsActivated += totals.unitsActivated;
  sum.grossSalesUsd += usdToUnits(totals.grossSalesUsd);
  sum.grossReturnsUsd += usdToUnits(totals.grossReturnsUsd);
  sum.netTaxUsd += usdToUnits(totals.netTaxUsd);
  sum.netSalesUsd += usdToUnits(totals.netSalesUsd);
}

function addRow(sum: Sum, row: ApiSalesRow): void {
  sum.grossUnitsSold += row.gross_units_sold ?? 0;
  sum.grossUnitsReturned += row.gross_units_returned ?? 0;
  sum.netUnitsSold += row.net_units_sold ?? 0;
  sum.unitsActivated += row.gross_units_activated ?? 0;
  sum.grossSalesUsd += usdToUnits(row.gross_sales_usd ?? "0");
  sum.grossReturnsUsd += usdToUnits(row.gross_returns_usd ?? "0");
  sum.netTaxUsd += usdToUnits(row.net_tax_usd ?? "0");
  sum.netSalesUsd += usdToUnits(row.net_sales_usd ?? "0");
}

function toTotals(sum: Sum): Totals {
  return {
    grossUnitsSold: sum.grossUnitsSold,
    grossUnitsReturned: sum.grossUnitsReturned,
    netUnitsSold: sum.netUnitsSold,
    unitsActivated: sum.unitsActivated,
    grossSalesUsd: unitsToUsd(sum.grossSalesUsd),
    grossReturnsUsd: unitsToUsd(sum.grossReturnsUsd),
    netTaxUsd: unitsToUsd(sum.netTaxUsd),
    netSalesUsd: unitsToUsd(sum.netSalesUsd),
  };
}

/** Sorts strings in code-unit order, nulls first, the same on every runtime. */
function byText(a: string | null, b: string | null): number {
  if (a === b) {
    return 0;
  }
  if (a === null) {
    return -1;
  }
  if (b === null) {
    return 1;
  }
  return a < b ? -1 : 1;
}

/** The app a row's sale counts toward: its appid, else its package's primary app, else 0. */
function rowApp(row: ApiSalesRow): number {
  if (row.appid !== undefined && row.appid > 0) {
    return row.appid;
  }
  if (row.primary_appid !== undefined && row.primary_appid > 0) {
    return row.primary_appid;
  }
  return 0;
}

/**
 * Adds raw sales rows up into one aggregate per app, country, currency and
 * line item type, sorted. Only the aggregates leave this function.
 */
export function aggregate(
  rows: readonly ApiSalesRow[],
  appNames: ReadonlyMap<number, string>,
): Aggregate[] {
  const groups = new Map<
    string,
    Omit<Aggregate, "totals"> & { sum: Sum }
  >();
  for (const row of rows) {
    const appid = rowApp(row);
    const countryCode = row.country_code || null;
    const currency = row.currency || null;
    const key = JSON.stringify([
      appid,
      countryCode,
      currency,
      row.line_item_type,
    ]);
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        appid,
        appName: appNames.get(appid) ?? null,
        countryCode,
        currency,
        lineItemType: row.line_item_type,
        sum: emptySum(),
      };
      groups.set(key, group);
    }
    addRow(group.sum, row);
  }
  return [...groups.values()]
    .map(({ sum, ...rest }) => ({ ...rest, totals: toTotals(sum) }))
    .sort((a, b) =>
      a.appid - b.appid || byText(a.countryCode, b.countryCode) ||
      byText(a.currency, b.currency) || byText(a.lineItemType, b.lineItemType)
    );
}

/** Replaces every occurrence of the key in a message, should one ever reach it. */
function redact(message: string, key: string): string {
  return key.length === 0 ? message : message.split(key).join("[redacted]");
}

/** What a status code means for these methods. */
const STATUS_HINTS: Record<number, string> = {
  400: "Valve rejected the parameters",
  401: "the key was refused",
  404: "no such method",
};

/**
 * Sends one GET request to a documented `IPartnerFinancialsService` method
 * with its parameters in the query string and the key in the `x-webapi-key`
 * header, and returns the parsed JSON body. Throws a specific error for a
 * request outside the partner host, a network failure, a 403 (never
 * retried, because Valve rate-limits the IP strictly after one), a 429, a
 * server error, another failing status or a body that is not JSON. No message
 * contains the key or any part of a successful answer.
 */
export async function getJson(
  fetcher: Fetcher,
  base: string,
  params: Record<string, string>,
  where: string,
  key: string,
  signal?: AbortSignal,
): Promise<unknown> {
  if (!base.startsWith(`${API_BASE}/`)) {
    throw new Error(`${where}: refusing to send the key outside ${API_BASE}`);
  }
  const url = new URL(base);
  for (const [name, value] of Object.entries(params)) {
    url.searchParams.set(name, value);
  }
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetcher(url.toString(), {
      method: "GET",
      headers: {
        accept: "application/json",
        "user-agent": USER_AGENT,
        "x-webapi-key": key,
      },
      // A redirect would carry the key header to whatever host it names.
      redirect: "error",
      signal: combined,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(redact(`${where}: request failed: ${detail}`, key));
  }
  if (response.status === 403) {
    await response.body?.cancel();
    throw new Error(
      `${where}: Valve refused the request (HTTP 403): the key is not a financial Web API key, is revoked, or this IP is not on the key's allow list. Not retried: Valve rate-limits an IP strictly after a 403`,
    );
  }
  if (response.status === 429) {
    await response.body?.cancel();
    const retryAfter = response.headers.get("retry-after");
    throw new Error(
      `${where}: Valve rate limited the request (HTTP 429)` +
        (retryAfter === null
          ? ", wait before retrying"
          : `, retry after ${retryAfter} seconds`),
    );
  }
  const text = await response.text();
  if (response.status >= 500) {
    throw new Error(redact(
      `${where}: Valve is unavailable (HTTP ${response.status}), a transient failure, retry later: ${
        text.slice(0, 200)
      }`,
      key,
    ));
  }
  if (!response.ok) {
    const hint = STATUS_HINTS[response.status] ?? "unexpected status";
    throw new Error(redact(
      `${where}: HTTP ${response.status}, ${hint}: ${text.slice(0, 200)}`,
      key,
    ));
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `${where}: HTTP ${response.status}, the answer is not JSON (${text.length} characters, not shown)`,
    );
  }
}

/** Where a parsed answer departs from the documented shape, without its values. */
function shapeIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".")}: ${issue.code}`)
    .join("; ").slice(0, 300);
}

/** The dates `GetChangedDatesForPartner` lists and the highwatermark to store. */
export interface ChangedDates {
  /** Dates with new or recalculated data, exactly as Valve wrote them. */
  dates: string[];
  /** The `result_highwatermark` to send next time. */
  highwatermark: string;
}

/** Calls `GetChangedDatesForPartner` once with a highwatermark. */
export async function fetchChangedDates(
  fetcher: Fetcher,
  key: string,
  highwatermark: string,
  includeViewGrants: boolean,
  signal?: AbortSignal,
): Promise<ChangedDates> {
  const where = "GetChangedDatesForPartner";
  const params: Record<string, string> = { highwatermark };
  if (includeViewGrants) {
    params.include_view_grants = "true";
  }
  const body = await getJson(
    fetcher,
    CHANGED_DATES_URL,
    params,
    where,
    key,
    signal,
  );
  const parsed = ApiChangedDatesSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(
      `${where}: the answer is not the documented shape: ${
        shapeIssues(parsed.error)
      }`,
    );
  }
  return {
    dates: parsed.data.response.dates ?? [],
    highwatermark: parsed.data.response.result_highwatermark,
  };
}

/** One date's aggregates and how many pages and rows it took. */
export interface DaySales {
  /** `GetDetailedSales` pages read. */
  pages: number;
  /** Rows added up. */
  rows: number;
  /** The rows' aggregates. */
  aggregates: Aggregate[];
}

/**
 * Pages through `GetDetailedSales` for one date as Valve documents: start at
 * `highwatermark_id` 0 and send each answer's `max_id` back until it equals
 * the id sent. Throws when the date needs more than `maxPages` pages or
 * `max_id` goes backwards, so a partial day is never recorded.
 */
export async function fetchDaySales(
  fetcher: Fetcher,
  key: string,
  steamDate: string,
  includeViewGrants: boolean,
  maxPages: number,
  pause: () => Promise<void>,
  signal?: AbortSignal,
): Promise<DaySales> {
  const rows: ApiSalesRow[] = [];
  const appNames = new Map<number, string>();
  let sent = "0";
  let pages = 0;
  while (true) {
    if (pages >= maxPages) {
      throw new Error(
        `GetDetailedSales ${steamDate}: more than ${maxPages} pages; nothing recorded for this date, raise maxPages`,
      );
    }
    if (pages > 0) {
      await pause();
    }
    pages += 1;
    const where = `GetDetailedSales ${steamDate} page ${pages}`;
    const params: Record<string, string> = {
      date: steamDate,
      highwatermark_id: sent,
    };
    if (includeViewGrants) {
      params.include_view_grants = "true";
    }
    const body = await getJson(
      fetcher,
      DETAILED_SALES_URL,
      params,
      where,
      key,
      signal,
    );
    const parsed = ApiDetailedSalesSchema.safeParse(body);
    if (!parsed.success) {
      throw new Error(
        `${where}: the answer is not the documented shape: ${
          shapeIssues(parsed.error)
        }`,
      );
    }
    const { results, app_info: appInfo, max_id: maxId } = parsed.data.response;
    for (const app of appInfo ?? []) {
      if (app.app_name !== undefined) {
        appNames.set(app.appid, app.app_name);
      }
    }
    if (maxId === sent) {
      break;
    }
    if (BigInt(maxId) < BigInt(sent)) {
      throw new Error(
        `${where}: max_id went backwards; nothing recorded for this date`,
      );
    }
    rows.push(...(results ?? []));
    sent = maxId;
  }
  return { pages, rows: rows.length, aggregates: aggregate(rows, appNames) };
}

/** Builds one day's record from its aggregates. */
export function buildSalesRecord(
  steamDate: string,
  day: DaySales,
  highwatermark: string,
  includeViewGrants: boolean,
  fetchedAt: string,
): SalesRecord {
  const sum = emptySum();
  for (const item of day.aggregates) {
    addTotals(sum, item.totals);
  }
  return {
    date: normaliseDate(steamDate),
    steamDate,
    fetchedAt,
    highwatermark,
    includeViewGrants,
    pages: day.pages,
    rows: day.rows,
    totals: toTotals(sum),
    aggregates: day.aggregates,
  };
}

/** The dates to record now, oldest first, and those left for the next run. */
export function planDates(
  pending: readonly string[],
  changed: readonly string[],
  maxDates: number,
): { now: string[]; later: string[] } {
  const byDay = new Map<string, string>();
  for (const steamDate of [...pending, ...changed]) {
    byDay.set(normaliseDate(steamDate), steamDate);
  }
  const ordered = [...byDay.entries()].sort(([a], [b]) => byText(a, b)).map((
    [, steamDate],
  ) => steamDate);
  return { now: ordered.slice(0, maxDates), later: ordered.slice(maxDates) };
}

/** Totals split by line item type while a summary is added up. */
interface Split {
  package: Sum;
  microTxn: Sum;
}

function emptySplit(): Split {
  return { package: emptySum(), microTxn: emptySum() };
}

function addToSplit(split: Split, item: Aggregate): void {
  addTotals(
    item.lineItemType === "MicroTxn" ? split.microTxn : split.package,
    item.totals,
  );
}

function netOf(split: Split): bigint {
  return split.package.netSalesUsd + split.microTxn.netSalesUsd;
}

/** The earlier half of a range's days against the later half. */
function trendOf(
  days: readonly string[],
  perDay: ReadonlyMap<string, Split>,
): Trend {
  const half = Math.floor(days.length / 2);
  const earlier = days.slice(0, half);
  const later = days.slice(half);
  const add = (list: readonly string[]) => {
    let usd = 0n;
    let units = 0;
    for (const day of list) {
      const split = perDay.get(day);
      if (split !== undefined) {
        usd += netOf(split);
        units += split.package.netUnitsSold;
      }
    }
    return { usd, units };
  };
  const a = add(earlier);
  const b = add(later);
  return {
    earlierDays: earlier.length,
    laterDays: later.length,
    earlierNetSalesUsd: unitsToUsd(a.usd),
    laterNetSalesUsd: unitsToUsd(b.usd),
    changeNetSalesUsd: unitsToUsd(b.usd - a.usd),
    earlierNetUnitsSold: a.units,
    laterNetUnitsSold: b.units,
    changeNetUnitsSold: b.units - a.units,
  };
}

/** Per-country totals, sorted by net sales, largest first. */
function countriesOf(
  countries: ReadonlyMap<
    string | null,
    { split: Split; currencies: Set<string> }
  >,
): CountryTotals[] {
  return [...countries.entries()]
    .map(([countryCode, { split, currencies }]) => ({
      countryCode,
      currencies: [...currencies].sort(byText),
      package: toTotals(split.package),
      microTxn: toTotals(split.microTxn),
      net: netOf(split),
    }))
    .sort((a, b) =>
      a.net === b.net
        ? byText(a.countryCode, b.countryCode)
        : a.net > b.net
        ? -1
        : 1
    )
    .map(({ net, ...rest }) => ({ ...rest, netSalesUsd: unitsToUsd(net) }));
}

/**
 * Summarises recorded days: totals per app and per country, each app's daily
 * series, and the range's earlier half against its later half. Each day
 * counts once, from the record given for it. Throws when there are none.
 */
export function summarise(
  records: readonly SalesRecord[],
  from: string | null,
  to: string | null,
  summarisedAt: string,
): Summary {
  const ordered = [...records].sort((a, b) => byText(a.date, b.date));
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  if (first === undefined || last === undefined) {
    throw new Error("No recorded days to summarise");
  }
  const days = ordered.map(({ date }) => date);
  const total = emptySplit();
  const totalPerDay = new Map<string, Split>();
  const allCountries = new Map<
    string | null,
    { split: Split; currencies: Set<string> }
  >();
  const apps = new Map<number, {
    appName: string | null;
    split: Split;
    perDay: Map<string, Split>;
    countries: Map<string | null, { split: Split; currencies: Set<string> }>;
  }>();
  for (const record of ordered) {
    const daySplit = emptySplit();
    totalPerDay.set(record.date, daySplit);
    for (const item of record.aggregates) {
      addToSplit(total, item);
      addToSplit(daySplit, item);
      let app = apps.get(item.appid);
      if (app === undefined) {
        app = {
          appName: null,
          split: emptySplit(),
          perDay: new Map(),
          countries: new Map(),
        };
        apps.set(item.appid, app);
      }
      app.appName = item.appName ?? app.appName;
      addToSplit(app.split, item);
      let appDay = app.perDay.get(record.date);
      if (appDay === undefined) {
        appDay = emptySplit();
        app.perDay.set(record.date, appDay);
      }
      addToSplit(appDay, item);
      for (const countries of [app.countries, allCountries]) {
        let country = countries.get(item.countryCode);
        if (country === undefined) {
          country = { split: emptySplit(), currencies: new Set() };
          countries.set(item.countryCode, country);
        }
        addToSplit(country.split, item);
        if (item.currency !== null) {
          country.currencies.add(item.currency);
        }
      }
    }
  }
  const appSummaries = [...apps.entries()]
    .map(([appid, app]) => ({ appid, app, net: netOf(app.split) }))
    .sort((a, b) =>
      a.net === b.net ? a.appid - b.appid : a.net > b.net ? -1 : 1
    )
    .map(({ appid, app, net }) => ({
      appid,
      appName: app.appName,
      package: toTotals(app.split.package),
      microTxn: toTotals(app.split.microTxn),
      netSalesUsd: unitsToUsd(net),
      trend: trendOf(days, app.perDay),
      countries: countriesOf(app.countries),
      daily: days.map((date) => {
        const split = app.perDay.get(date) ?? emptySplit();
        return {
          date,
          netUnitsSold: split.package.netUnitsSold,
          netSalesUsd: unitsToUsd(netOf(split)),
        };
      }),
    }));
  return {
    from,
    to,
    days: ordered.length,
    firstDate: first.date,
    lastDate: last.date,
    package: toTotals(total.package),
    microTxn: toTotals(total.microTxn),
    netSalesUsd: unitsToUsd(netOf(total)),
    trend: trendOf(days, totalPerDay),
    apps: appSummaries,
    countries: countriesOf(allCountries),
    summarisedAt,
  };
}

/** Reads the stored cursor, or null when there is none or it no longer parses. */
async function readCursor(
  context: MethodContext,
): Promise<CursorRecord | null> {
  if (context.readResource === undefined) {
    throw new Error(
      "sample needs swamp's readResource to read the stored highwatermark; upgrade swamp",
    );
  }
  const stored = await context.readResource(CURSOR_NAME);
  if (stored === null) {
    return null;
  }
  const parsed = CursorRecordSchema.safeParse(stored);
  if (!parsed.success) {
    throw new Error(
      "The stored cursor is not in the current shape; refusing to start again from highwatermark 0 without being asked. Delete the cursor data to start over",
    );
  }
  return parsed.data;
}

/** The Steamworks sales behavior. */
export const behavior = {
  type: "@reset/steamworks-sales",
  version: "2026.10.30.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    sales: {
      description:
        "One sales day's aggregates per app, country, currency and line item type: units, and gross, returns, tax and net sales in USD. Financial data: keep it in a private datastore",
      schema: SalesRecordSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    cursor: {
      description:
        "The GetChangedDatesForPartner highwatermark to send next, the dates the last run recorded and those it left for the next",
      schema: CursorRecordSchema,
      lifetime: "infinite",
      garbageCollection: 30,
    },
    summary: {
      description:
        "Totals per app and per country, each app's daily series and the range's earlier half against its later half",
      schema: SummarySchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    sample: {
      description:
        "Read the dates Valve changed since the stored highwatermark and record each day's sales aggregates as a new version",
      arguments: SampleArgsSchema,
      execute: async (
        args: SampleArgs & Injected,
        context: MethodContext,
      ): Promise<MethodResult> => {
        const { globalArgs, logger } = context;
        const key = globalArgs.financialKey;
        const includeViewGrants = globalArgs.includeViewGrants ?? false;
        const fetcher = args._fetch ?? globalThis.fetch;
        const now = args._now ?? (() => new Date());
        const sleep = args._sleep ??
          ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
        const pause = () => sleep(REQUEST_SPACING_MS);
        const cursor = await readCursor(context);
        const sent = cursor?.highwatermark ?? "0";
        logger.info(
          "Reading the sales dates changed since highwatermark {highwatermark}",
          { highwatermark: sent },
        );
        const changed = await fetchChangedDates(
          fetcher,
          key,
          sent,
          includeViewGrants,
          context.signal,
        );
        const plan = planDates(
          cursor?.pendingDates ?? [],
          changed.dates,
          args.maxDates ?? DEFAULT_MAX_DATES,
        );
        const handles: DataHandle[] = [];
        const recorded: string[] = [];
        for (const steamDate of plan.now) {
          await pause();
          const day = await fetchDaySales(
            fetcher,
            key,
            steamDate,
            includeViewGrants,
            args.maxPages ?? DEFAULT_MAX_PAGES,
            pause,
            context.signal,
          );
          const data = buildSalesRecord(
            steamDate,
            day,
            changed.highwatermark,
            includeViewGrants,
            now().toISOString(),
          );
          handles.push(
            await context.writeResource("sales", salesName(data.date), {
              ...data,
            }),
          );
          recorded.push(data.date);
          logger.info(
            "Recorded {date}: {aggregates} aggregates from {rows} rows in {pages} pages",
            {
              date: data.date,
              aggregates: data.aggregates.length,
              rows: data.rows,
              pages: data.pages,
            },
          );
        }
        const nextCursor: CursorRecord = {
          highwatermark: changed.highwatermark,
          previousHighwatermark: sent,
          fetchedAt: now().toISOString(),
          recordedDates: recorded,
          pendingDates: plan.later,
        };
        handles.push(
          await context.writeResource("cursor", CURSOR_NAME, { ...nextCursor }),
        );
        if (plan.later.length > 0) {
          logger.warning(
            "{later} changed dates are left for the next run by maxDates",
            { later: plan.later.length },
          );
        }
        logger.info(
          recorded.length === 0
            ? "No sales dates changed since highwatermark {highwatermark}"
            : "Recorded {count} sales days; the next run starts from highwatermark {next}",
          {
            highwatermark: sent,
            count: recorded.length,
            next: changed.highwatermark,
          },
        );
        return { dataHandles: handles };
      },
    },
    summarise: {
      description:
        "Summarise the recorded days in a range: totals per app and country, a daily series per app, and the earlier half against the later",
      arguments: SummariseArgsSchema,
      execute: async (
        args: SummariseArgs & Injected,
        context: MethodContext,
      ): Promise<MethodResult> => {
        const { logger } = context;
        const now = args._now ?? (() => new Date());
        const from = args.from ?? null;
        const to = args.to ?? null;
        if (from !== null && to !== null && from > to) {
          throw new Error(`from ${from} is after to ${to}`);
        }
        if (context.queryData === undefined) {
          throw new Error(
            "summarise needs swamp's queryData to read the recorded days; upgrade swamp",
          );
        }
        const predicate = `modelId == ${JSON.stringify(context.modelId)} && ` +
          `specName == "sales" && version >= 0`;
        const stored = await context.queryData(predicate);
        const latest = new Map<
          string,
          { version: number; data: SalesRecord }
        >();
        let skipped = 0;
        for (const item of stored) {
          const record = item !== null && typeof item === "object"
            ? item as Partial<DataRecord>
            : {};
          const parsed = SalesRecordSchema.safeParse(record.attributes);
          if (!parsed.success) {
            skipped += 1;
            continue;
          }
          const { date } = parsed.data;
          if ((from !== null && date < from) || (to !== null && date > to)) {
            continue;
          }
          const version = typeof record.version === "number"
            ? record.version
            : 0;
          const seen = latest.get(date);
          if (seen === undefined || version > seen.version) {
            latest.set(date, { version, data: parsed.data });
          }
        }
        if (skipped > 0) {
          logger.warning(
            "Skipped {skipped} stored records that are not a recorded sales day",
            { skipped },
          );
        }
        if (latest.size === 0) {
          throw new Error(
            "No sales days recorded" +
              (from === null && to === null
                ? ""
                : ` from ${from ?? "the start"} to ${to ?? "the end"}`) +
              "; run the sample method first",
          );
        }
        const data = summarise(
          [...latest.values()].map(({ data }) => data),
          from,
          to,
          now().toISOString(),
        );
        const handle = await context.writeResource("summary", SUMMARY_NAME, {
          ...data,
        });
        logger.info(
          "Summarised {days} sales days from {first} to {last} across {apps} apps",
          {
            days: data.days,
            first: data.firstDate,
            last: data.lastDate,
            apps: data.apps.length,
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
  upgrades: [
    {
      toVersion: "2026.10.30.1",
      description:
        "Moved to the swamp-extensions repository, which is now the extension's published home, and refuse redirects so the key header cannot follow one; arguments unchanged",
      upgradeAttributes: (old: Record<string, unknown>): Record<
        string,
        unknown
      > => old,
    },
  ],
};
