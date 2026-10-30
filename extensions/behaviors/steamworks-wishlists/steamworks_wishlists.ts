/**
 * Records a Steam app's daily wishlist activity from Valve's documented
 * Steamworks partner Web API and summarises it.
 *
 * `sample` calls
 * `GET https://partner.steam-api.com/IPartnerFinancialsService/GetAppWishlistReporting/v001/`
 * once per date in a range, one request at a time, and writes each day's
 * wishlist adds, deletes, purchases and gifts, and the adds by platform, as a
 * new version of the app's `wishlists` resource. `summarise` reads every
 * recorded version back, keeps the most recently read row for each date, and
 * writes the totals, the trend of daily adds, and the best and worst days.
 *
 * Valve's endpoint reports activity per day; it returns no running total of
 * outstanding wishlists, so none is recorded.
 *
 * The key is a Steamworks publisher Web API key with Financial permissions. It
 * is a sensitive global argument, supplied from a swamp vault, sent only in
 * the `x-webapi-key` request header Valve documents and only to
 * `https://partner.steam-api.com`, with redirects refused so it cannot follow
 * one to another host. It is never part of a URL, never written to a record
 * and never logged, and it is removed from any error text. Every request names
 * this extension and its version in its User-Agent. `fetch` is injectable
 * through the `_fetch` method argument so tests never reach Valve.
 *
 * @module
 */

import { z } from "npm:zod@4";

/** This behavior's version, sent in the User-Agent of every request. */
export const VERSION = "2026.10.30.1";

/** The User-Agent every request sends, naming this extension and its version. */
export const USER_AGENT =
  `@reset/steamworks-wishlists/${VERSION} (swamp extension)`;

/** Valve's partner Web API host; the key is sent to no other origin. */
export const PARTNER_BASE = "https://partner.steam-api.com";

/** The documented wishlist reporting method. */
export const WISHLIST_URL =
  `${PARTNER_BASE}/IPartnerFinancialsService/GetAppWishlistReporting/v001/`;

/** The request header Valve documents for passing a Web API key. */
export const KEY_HEADER = "x-webapi-key";

/** How long one request to Valve may take before it is abandoned. */
export const REQUEST_TIMEOUT_MS = 15_000;

/** The most dates one sample may request, one request each. */
export const MAX_DAYS = 92;

/** The largest app id Valve's `uint32` field holds. */
export const MAX_APP_ID = 4_294_967_295;

/** `true` only when the zod output type and the hand-written interface describe the same shape. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

/** A calendar date written YYYY-MM-DD. */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const GlobalArgsSchema = z.object({
  apiKey: z.string().min(1).meta({ sensitive: true }).describe(
    "Steamworks publisher Web API key with Financial permissions, supplied with a vault.get expression, never a literal. Sent only in the x-webapi-key header to partner.steam-api.com",
  ),
  appId: z.number().int().min(1).max(MAX_APP_ID).describe(
    "Steam app id whose wishlist activity is recorded, e.g. 440",
  ),
});

/** Global arguments of a behavior instance: the key and the one app it records. */
export interface GlobalArgs {
  /** Publisher Web API key with Financial permissions. Sensitive: supply it with a vault expression. */
  apiKey: string;
  /** Steam app id. */
  appId: number;
}

const _GlobalArgsMatch: Same<z.infer<typeof GlobalArgsSchema>, GlobalArgs> =
  true;

const DayRowSchema = z.object({
  date: z.string(),
  adds: z.number().int().min(0),
  deletes: z.number().int().min(0),
  purchases: z.number().int().min(0),
  gifts: z.number().int().min(0),
  addsWindows: z.number().int().min(0),
  addsMac: z.number().int().min(0),
  addsLinux: z.number().int().min(0),
});

/** One day's wishlist activity for the app, as Valve reports it. */
export interface DayRow {
  /** The date, YYYY-MM-DD, bounded in GMT as Valve documents. */
  date: string;
  /** Wishlist adds that day. */
  adds: number;
  /** Wishlist deletes that day. */
  deletes: number;
  /** Purchases from a wishlist that day. */
  purchases: number;
  /** Gifts from a wishlist that day. */
  gifts: number;
  /** Adds from users browsing for Windows games. */
  addsWindows: number;
  /** Adds from users browsing for Mac games. */
  addsMac: number;
  /** Adds from users browsing for Linux games. */
  addsLinux: number;
}

const _DayRowMatch: Same<z.infer<typeof DayRowSchema>, DayRow> = true;

const WishlistsRecordSchema = z.object({
  appId: z.number().int().positive(),
  from: z.string(),
  to: z.string(),
  fetchedAt: z.iso.datetime(),
  appMinDate: z.string().nullable(),
  days: z.array(DayRowSchema),
  emptyDates: z.array(z.string()),
});

/** One version of an app's `wishlists` resource: a date range read at one moment. */
export interface WishlistsRecord {
  /** Steam app id. */
  appId: number;
  /** First date requested, YYYY-MM-DD. */
  from: string;
  /** Last date requested, YYYY-MM-DD. */
  to: string;
  /** ISO-8601 time the range was read. */
  fetchedAt: string;
  /** The earliest date Valve has data for the app, or null when no answer named it. */
  appMinDate: string | null;
  /** Every date Valve returned activity for, in date order. */
  days: DayRow[];
  /** Requested dates Valve returned no activity for, outside the app's available range. */
  emptyDates: string[];
}

const _WishlistsRecordMatch: Same<
  z.infer<typeof WishlistsRecordSchema>,
  WishlistsRecord
> = true;

const TotalsSchema = z.object({
  adds: z.number().int().min(0),
  deletes: z.number().int().min(0),
  purchases: z.number().int().min(0),
  gifts: z.number().int().min(0),
  addsWindows: z.number().int().min(0),
  addsMac: z.number().int().min(0),
  addsLinux: z.number().int().min(0),
});

/** Each count added up over the summarised days. */
export interface Totals {
  /** Wishlist adds. */
  adds: number;
  /** Wishlist deletes. */
  deletes: number;
  /** Purchases from a wishlist. */
  purchases: number;
  /** Gifts from a wishlist. */
  gifts: number;
  /** Adds from users browsing for Windows games. */
  addsWindows: number;
  /** Adds from users browsing for Mac games. */
  addsMac: number;
  /** Adds from users browsing for Linux games. */
  addsLinux: number;
}

const _TotalsMatch: Same<z.infer<typeof TotalsSchema>, Totals> = true;

const TrendSchema = z.object({
  direction: z.enum(["rising", "falling", "flat"]),
  earlierAverageAdds: z.number(),
  laterAverageAdds: z.number(),
  addsPerDayChange: z.number(),
});

/** How daily adds moved across the summarised days. */
export interface Trend {
  /** Whether the later half's average daily adds is above, below or equal to the earlier half's. */
  direction: "rising" | "falling" | "flat";
  /** Average daily adds over the earlier half of the days. */
  earlierAverageAdds: number;
  /** Average daily adds over the later half of the days. */
  laterAverageAdds: number;
  /** Least-squares slope of daily adds against the date, in adds per day per day. */
  addsPerDayChange: number;
}

const _TrendMatch: Same<z.infer<typeof TrendSchema>, Trend> = true;

const SummarySchema = z.object({
  appId: z.number().int().positive(),
  from: z.string().nullable(),
  to: z.string().nullable(),
  samples: z.number().int().positive(),
  days: z.number().int().positive(),
  firstDate: z.string(),
  lastDate: z.string(),
  totals: TotalsSchema,
  averageAdds: z.number(),
  trend: TrendSchema.nullable(),
  bestDay: DayRowSchema,
  worstDay: DayRowSchema,
  summarisedAt: z.iso.datetime(),
});

/** The summary of an app's recorded daily wishlist activity. */
export interface Summary {
  /** Steam app id. */
  appId: number;
  /** The lower date bound asked for, or null when every recorded date counted. */
  from: string | null;
  /** The upper date bound asked for, or null when every recorded date counted. */
  to: string | null;
  /** How many recorded versions were read. */
  samples: number;
  /** How many distinct dates were summarised. */
  days: number;
  /** The earliest summarised date. */
  firstDate: string;
  /** The latest summarised date. */
  lastDate: string;
  /** Each count added up over the summarised dates. */
  totals: Totals;
  /** Average daily adds. */
  averageAdds: number;
  /** How daily adds moved, or null with fewer than two dates. */
  trend: Trend | null;
  /** The date with the most adds, the earliest on a tie. */
  bestDay: DayRow;
  /** The date with the fewest adds, the earliest on a tie. */
  worstDay: DayRow;
  /** ISO-8601 time the summary was written. */
  summarisedAt: string;
}

const _SummaryMatch: Same<z.infer<typeof SummarySchema>, Summary> = true;

const SampleArgsSchema = z.object({
  from: z.string().regex(DATE_PATTERN).optional().describe(
    "First date to record, YYYY-MM-DD in GMT; the day before to when omitted",
  ),
  to: z.string().regex(DATE_PATTERN).optional().describe(
    "Last date to record, YYYY-MM-DD in GMT, no later than today; today when omitted",
  ),
});

/** Arguments of the `sample` method. */
export interface SampleArgs {
  /** First date to record, YYYY-MM-DD. */
  from?: string;
  /** Last date to record, YYYY-MM-DD. */
  to?: string;
}

const _SampleArgsMatch: Same<z.infer<typeof SampleArgsSchema>, SampleArgs> =
  true;

const SummariseArgsSchema = z.object({
  from: z.string().regex(DATE_PATTERN).optional().describe(
    "Only summarise dates on or after this YYYY-MM-DD date; every recorded date when omitted",
  ),
  to: z.string().regex(DATE_PATTERN).optional().describe(
    "Only summarise dates on or before this YYYY-MM-DD date; every recorded date when omitted",
  ),
});

/** Arguments of the `summarise` method. */
export interface SummariseArgs {
  /** Only dates on or after this one count. */
  from?: string;
  /** Only dates on or before this one count. */
  to?: string;
}

const _SummariseArgsMatch: Same<
  z.infer<typeof SummariseArgsSchema>,
  SummariseArgs
> = true;

/**
 * The documented `CPartnerFinancials_WishlistSummary` fields. A count Valve
 * leaves out is read as 0, the default of a protobuf `uint32`.
 */
const ApiWishlistSummarySchema = z.object({
  wishlist_adds: z.number().int().min(0).default(0),
  wishlist_deletes: z.number().int().min(0).default(0),
  wishlist_purchases: z.number().int().min(0).default(0),
  wishlist_gifts: z.number().int().min(0).default(0),
  wishlist_adds_windows: z.number().int().min(0).default(0),
  wishlist_adds_mac: z.number().int().min(0).default(0),
  wishlist_adds_linux: z.number().int().min(0).default(0),
});

/** The documented `GetAppWishlistReporting` answer, inside Valve's `response` wrapper. */
const ApiAnswerSchema = z.object({
  response: z.object({
    appid: z.number().int().optional(),
    date: z.string().optional(),
    wishlist_summary: ApiWishlistSummarySchema.optional(),
    app_min_date: z.string().optional(),
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
  /** Id of this behavior instance, used to find its own recorded samples. */
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
  /** CEL query over stored data; a predicate naming `version` searches every version. */
  queryData?: (predicate: string) => Promise<unknown[]>;
}

/** The data name an app's wishlist activity is written under. */
export function wishlistsName(appId: number): string {
  return `wishlists-${appId}`;
}

/** The data name an app's summary is written under. */
export function summaryName(appId: number): string {
  return `summary-${appId}`;
}

/** Whether a YYYY-MM-DD string names a real calendar date. */
export function isDate(text: string): boolean {
  if (!DATE_PATTERN.test(text)) {
    return false;
  }
  const ms = Date.parse(`${text}T00:00:00Z`);
  return Number.isFinite(ms) &&
    new Date(ms).toISOString().slice(0, 10) === text;
}

/** The date `days` after a YYYY-MM-DD date. */
export function addDays(date: string, days: number): string {
  const ms = Date.parse(`${date}T00:00:00Z`) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to`. */
function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
      86_400_000,
  );
}

/**
 * The dates one sample requests: `to` defaults to today in GMT and `from` to
 * the day before `to`, the two dates Valve suggests querying each day. Throws
 * for a date that does not exist, a range that runs backwards, ends after
 * today, or spans more than `MAX_DAYS` dates.
 */
export function dateRange(
  from: string | undefined,
  to: string | undefined,
  now: Date,
): string[] {
  const today = now.toISOString().slice(0, 10);
  const last = to ?? today;
  const first = from ?? addDays(last, -1);
  for (const [name, value] of [["from", first], ["to", last]]) {
    if (!isDate(value ?? "")) {
      throw new Error(`${name} ${value} is not a real YYYY-MM-DD date`);
    }
  }
  if (last > today) {
    throw new Error(
      `to ${last} is after today (${today} GMT); Valve has no data for it yet`,
    );
  }
  if (first > last) {
    throw new Error(`from ${first} is after to ${last}`);
  }
  const span = daysBetween(first, last) + 1;
  if (span > MAX_DAYS) {
    throw new Error(
      `${first} to ${last} is ${span} dates; one sample requests at most ${MAX_DAYS}, one request each`,
    );
  }
  return Array.from({ length: span }, (_, i) => addDays(first, i));
}

/** The request URL for one app and date. The key is never part of it. */
export function wishlistUrl(appId: number, date: string): string {
  const url = new URL(WISHLIST_URL);
  url.searchParams.set("appid", String(appId));
  url.searchParams.set("date", date);
  return url.toString();
}

/** Removes every occurrence of the key from a text before it is reported. */
function redact(text: string, apiKey: string): string {
  return apiKey.length === 0 ? text : text.split(apiKey).join("[redacted]");
}

/** What a status code means for this endpoint. */
const STATUS_HINTS: Record<number, string> = {
  400: "Valve rejected the request's parameters",
  401: "the key was not accepted",
  404: "no such method on the partner host",
};

/** One date's answer: its activity, or null when Valve returned none for it. */
export interface DayAnswer {
  /** The day's activity, or null outside the app's available range. */
  row: DayRow | null;
  /** The earliest date Valve has data for the app, when the answer named it. */
  appMinDate: string | null;
}

/**
 * Sends one GET request for one app and date with the key in the
 * `x-webapi-key` header. Redirects are refused so the key cannot follow one
 * to another host. Throws a specific error for a network failure, a refused
 * key, a rate limit, a server error, another failing status, or a body that is
 * not the documented answer. No message contains the key.
 */
export async function fetchDay(
  fetcher: Fetcher,
  apiKey: string,
  appId: number,
  date: string,
  signal?: AbortSignal,
): Promise<DayAnswer> {
  const url = wishlistUrl(appId, date);
  const where = `GetAppWishlistReporting for app ${appId} on ${date}`;
  if (!url.startsWith(`${PARTNER_BASE}/`)) {
    throw new Error(
      `${where}: refusing to send the key outside ${PARTNER_BASE}`,
    );
  }
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        "user-agent": USER_AGENT,
        [KEY_HEADER]: apiKey,
      },
      redirect: "error",
      signal: combined,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${where}: request failed: ${redact(detail, apiKey)}`);
  }
  const body = await response.text();
  const text = redact(body, apiKey).slice(0, 200);
  if (response.status === 403) {
    throw new Error(
      `${where}: HTTP 403, Valve refused the key: it must be a publisher key with Financial permissions, and the calling address must be on the key's allow list when it has one. Valve rate-limits an address strictly after 403 answers, so fix the key before retrying`,
    );
  }
  if (response.status === 429) {
    const retryAfter = response.headers.get("retry-after");
    throw new Error(
      `${where}: Valve rate limited the request (HTTP 429)` +
        (retryAfter === null
          ? ", wait before retrying"
          : `, retry after ${retryAfter} seconds`),
    );
  }
  if (response.status >= 500) {
    throw new Error(
      `${where}: Valve is unavailable (HTTP ${response.status}), a transient failure, retry later: ${text}`,
    );
  }
  if (!response.ok) {
    const hint = STATUS_HINTS[response.status] ?? "unexpected status";
    throw new Error(`${where}: HTTP ${response.status}, ${hint}: ${text}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error(
      `${where}: HTTP ${response.status}, body is not JSON: ${text}`,
    );
  }
  const parsed = ApiAnswerSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `${where}: the answer is not the documented wishlist report: ${
        parsed.error.issues.map((issue) =>
          `${issue.path.join(".")}: ${issue.message}`
        ).join("; ").slice(0, 300)
      }`,
    );
  }
  const answer = parsed.data.response;
  if (answer.appid !== undefined && answer.appid !== appId) {
    throw new Error(
      `${where}: Valve answered for app ${answer.appid}, not ${appId}`,
    );
  }
  const appMinDate = answer.app_min_date ?? null;
  const summary = answer.wishlist_summary;
  if (summary === undefined) {
    return { row: null, appMinDate };
  }
  return {
    row: {
      date,
      adds: summary.wishlist_adds,
      deletes: summary.wishlist_deletes,
      purchases: summary.wishlist_purchases,
      gifts: summary.wishlist_gifts,
      addsWindows: summary.wishlist_adds_windows,
      addsMac: summary.wishlist_adds_mac,
      addsLinux: summary.wishlist_adds_linux,
    },
    appMinDate,
  };
}

/**
 * Reads every date in order, one request at a time, and stops at the first
 * failure so a refused key is not sent again. Returns the record to write.
 */
export async function fetchRange(
  fetcher: Fetcher,
  apiKey: string,
  appId: number,
  dates: readonly string[],
  fetchedAt: string,
  signal?: AbortSignal,
): Promise<WishlistsRecord> {
  const days: DayRow[] = [];
  const emptyDates: string[] = [];
  let appMinDate: string | null = null;
  for (const date of dates) {
    const answer = await fetchDay(fetcher, apiKey, appId, date, signal);
    appMinDate = answer.appMinDate ?? appMinDate;
    if (answer.row === null) {
      emptyDates.push(date);
    } else {
      days.push(answer.row);
    }
  }
  const from = dates[0];
  const to = dates[dates.length - 1];
  if (from === undefined || to === undefined) {
    throw new Error("No dates to read");
  }
  return { appId, from, to, fetchedAt, appMinDate, days, emptyDates };
}

/** Rounds to three decimal places, so summaries compare exactly. */
function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** The mean of a list, 0 for none. */
function mean(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** The trend of daily adds, or null with fewer than two days. */
export function trendOf(days: readonly DayRow[]): Trend | null {
  if (days.length < 2) {
    return null;
  }
  const half = Math.floor(days.length / 2);
  const earlier = mean(days.slice(0, half).map(({ adds }) => adds));
  const later = mean(days.slice(days.length - half).map(({ adds }) => adds));
  const first = days[0]?.date ?? "";
  const xs = days.map(({ date }) => daysBetween(first, date));
  const ys = days.map(({ adds }) => adds);
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let den = 0;
  for (const [i, x] of xs.entries()) {
    num += (x - mx) * ((ys[i] ?? 0) - my);
    den += (x - mx) ** 2;
  }
  return {
    direction: later > earlier
      ? "rising"
      : later < earlier
      ? "falling"
      : "flat",
    earlierAverageAdds: round(earlier),
    laterAverageAdds: round(later),
    addsPerDayChange: den === 0 ? 0 : round(num / den),
  };
}

/**
 * Summarises recorded samples. Each date takes its row from the sample read
 * most recently, since a day read while it was open may have grown. Only dates
 * within `from` and `to`, when given, count. Throws when no date is left.
 */
export function summarise(
  appId: number,
  samples: readonly WishlistsRecord[],
  from: string | null,
  to: string | null,
  summarisedAt: string,
): Summary {
  const ordered = [...samples].sort((a, b) =>
    Date.parse(a.fetchedAt) - Date.parse(b.fetchedAt)
  );
  const byDate = new Map<string, DayRow>();
  for (const sample of ordered) {
    for (const row of sample.days) {
      if (
        (from === null || row.date >= from) && (to === null || row.date <= to)
      ) {
        byDate.set(row.date, row);
      }
    }
  }
  const days = [...byDate.values()].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0
  );
  const first = days[0];
  const last = days[days.length - 1];
  if (first === undefined || last === undefined) {
    throw new Error(
      `No recorded wishlist days for app ${appId}` +
        (from === null && to === null
          ? ""
          : ` between ${from ?? "the first date"} and ${
            to ?? "the last date"
          }`),
    );
  }
  const totals: Totals = {
    adds: 0,
    deletes: 0,
    purchases: 0,
    gifts: 0,
    addsWindows: 0,
    addsMac: 0,
    addsLinux: 0,
  };
  let bestDay = first;
  let worstDay = first;
  for (const day of days) {
    totals.adds += day.adds;
    totals.deletes += day.deletes;
    totals.purchases += day.purchases;
    totals.gifts += day.gifts;
    totals.addsWindows += day.addsWindows;
    totals.addsMac += day.addsMac;
    totals.addsLinux += day.addsLinux;
    if (day.adds > bestDay.adds) {
      bestDay = day;
    }
    if (day.adds < worstDay.adds) {
      worstDay = day;
    }
  }
  return {
    appId,
    from,
    to,
    samples: ordered.length,
    days: days.length,
    firstDate: first.date,
    lastDate: last.date,
    totals,
    averageAdds: round(totals.adds / days.length),
    trend: trendOf(days),
    bestDay,
    worstDay,
    summarisedAt,
  };
}

/** The Steamworks wishlists behavior. */
export const behavior = {
  type: "@reset/steamworks-wishlists",
  version: "2026.10.30.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    wishlists: {
      description:
        "One app's daily wishlist adds, deletes, purchases and gifts over a date range, read at one moment",
      schema: WishlistsRecordSchema,
      lifetime: "infinite",
      garbageCollection: "730d",
    },
    summary: {
      description:
        "Totals, the trend of daily adds, and the best and worst days of an app's recorded wishlist activity",
      schema: SummarySchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    sample: {
      description:
        "Read a date range's daily wishlist activity from Valve's GetAppWishlistReporting, one request per date, and record it as a new version",
      arguments: SampleArgsSchema,
      execute: async (
        args: SampleArgs & Injected,
        context: MethodContext,
      ): Promise<MethodResult> => {
        const { globalArgs, logger } = context;
        const { appId, apiKey } = globalArgs;
        const fetcher = args._fetch ?? globalThis.fetch;
        const now = args._now ?? (() => new Date());
        const at = now();
        const dates = dateRange(args.from, args.to, at);
        logger.info(
          "Reading wishlist activity for app {appId} from {from} to {to}, {count} requests",
          {
            appId,
            from: dates[0] ?? "",
            to: dates[dates.length - 1] ?? "",
            count: dates.length,
          },
        );
        const data = await fetchRange(
          fetcher,
          apiKey,
          appId,
          dates,
          at.toISOString(),
          context.signal,
        );
        const handle = await context.writeResource(
          "wishlists",
          wishlistsName(appId),
          { ...data },
        );
        if (data.emptyDates.length > 0) {
          logger.warning(
            "Valve returned no wishlist activity for {count} dates of app {appId}; its data starts {appMinDate}",
            {
              count: data.emptyDates.length,
              appId,
              appMinDate: data.appMinDate ?? "at an unnamed date",
            },
          );
        }
        logger.info(
          "Recorded {days} days of wishlist activity for app {appId}: {adds} adds, {deletes} deletes",
          {
            days: data.days.length,
            appId,
            adds: data.days.reduce((sum, day) => sum + day.adds, 0),
            deletes: data.days.reduce((sum, day) => sum + day.deletes, 0),
          },
        );
        return { dataHandles: [handle] };
      },
    },
    summarise: {
      description:
        "Summarise the recorded daily wishlist activity: totals, the trend of daily adds, and the best and worst days",
      arguments: SummariseArgsSchema,
      execute: async (
        args: SummariseArgs & Injected,
        context: MethodContext,
      ): Promise<MethodResult> => {
        const { globalArgs, logger } = context;
        const { appId } = globalArgs;
        const now = args._now ?? (() => new Date());
        const from = args.from ?? null;
        const to = args.to ?? null;
        for (const [name, value] of [["from", from], ["to", to]]) {
          if (value !== null && !isDate(value ?? "")) {
            throw new Error(`${name} ${value} is not a real YYYY-MM-DD date`);
          }
        }
        if (from !== null && to !== null && from > to) {
          throw new Error(`from ${from} is after to ${to}`);
        }
        if (context.queryData === undefined) {
          throw new Error(
            "summarise needs swamp's queryData to read the recorded samples; upgrade swamp",
          );
        }
        logger.info("Reading the recorded wishlist activity of app {appId}", {
          appId,
        });
        const name = wishlistsName(appId);
        const predicate = `modelId == ${JSON.stringify(context.modelId)} && ` +
          `specName == "wishlists" && name == ${
            JSON.stringify(name)
          } && version >= 0`;
        const records = await context.queryData(predicate);
        const samples: WishlistsRecord[] = [];
        let skipped = 0;
        for (const record of records) {
          const attributes = record !== null && typeof record === "object"
            ? (record as Partial<DataRecord>).attributes
            : undefined;
          const parsed = WishlistsRecordSchema.safeParse(attributes);
          if (!parsed.success || parsed.data.appId !== appId) {
            skipped += 1;
            continue;
          }
          samples.push(parsed.data);
        }
        if (skipped > 0) {
          logger.warning(
            "Skipped {skipped} stored records that are not wishlist samples of app {appId}",
            { skipped, appId },
          );
        }
        if (samples.length === 0) {
          throw new Error(
            `No wishlist samples of app ${appId} recorded; run the sample method first`,
          );
        }
        const data = summarise(appId, samples, from, to, now().toISOString());
        const handle = await context.writeResource(
          "summary",
          summaryName(appId),
          { ...data },
        );
        logger.info(
          "Summarised {days} days of app {appId}: {adds} adds, best {best}, worst {worst}",
          {
            days: data.days,
            appId,
            adds: data.totals.adds,
            best: data.bestDay.date,
            worst: data.worstDay.date,
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
        "Moved to the swamp-extensions repository, which is now the extension's published home; arguments and behavior unchanged",
      upgradeAttributes: (old: Record<string, unknown>): Record<
        string,
        unknown
      > => old,
    },
  ],
};
