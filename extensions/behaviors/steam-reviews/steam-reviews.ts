/**
 * A Swamp behavior for a Steam app's public user reviews. It has two pairs of
 * methods:
 *
 * - `summary` and `recent` read Steamworks' documented Web API method
 *   IUserReviewsService/GetAppReviews, which replaces
 *   store.steampowered.com/appreviews. `summary` keeps the review score and
 *   totals for a set of filters; `recent` pages through the reviews created in
 *   a window, newest first, and counts positive and negative reviews overall
 *   and by language.
 * - `sample` reads the `query_summary` of Steam's public, keyless store
 *   endpoint `appreviews/<appid>` once and writes the score and counts as a
 *   new version of the app's `sample` resource; `summarise` reads every
 *   recorded version back and writes the first, latest, minimum and maximum
 *   positive ratio and the change over the period.
 *
 * Every method writes what it read as a resource, so a workflow can assert on
 * it with CEL.
 *
 * Reviews are data about players: each one carries its author's SteamID,
 * playtime and free text. A `recent` resource keeps the review id, whether it
 * was positive, when it was written and its language. The author's SteamID
 * and playtime, and the review text, are kept only when the method is asked
 * to keep them. `sample` asks for no reviews at all, only the counts.
 *
 * @module
 */

import { z } from "npm:zod@4";

const API_URL =
  "https://api.steampowered.com/IUserReviewsService/GetAppReviews/v1/";

/** The Steam store endpoint `sample` reads; the app id is appended. */
export const REVIEWS_URL = "https://store.steampowered.com/appreviews/";

/** How long one request to Steam may take before it is abandoned. */
export const REQUEST_TIMEOUT_MS = 15_000;

/** GetAppReviews returns at most 100 reviews per page. */
const MAX_PER_PAGE = 100;
/** Longest review text a `recent` resource keeps when text is kept. */
const TEXT_LIMIT = 2000;

/** EUserReviewsAppReviewsFilter: most recently created first. */
const FILTER_RECENT = 1;
/** EUserReviewsReviewType: all reviews, which the score fields need. */
const REVIEW_TYPE_ALL = 0;

/** EUserReviewsPurchaseType values by the name this behavior accepts. */
const PURCHASE_TYPES = {
  steam: 0,
  all: 1,
  nonSteam: 2,
} as const;

/** What a status code means when the answer carries no message of its own. */
const STATUS_HINTS: Record<number, string> = {
  400: "the request was malformed, or the app id is not a valid app",
  401: "the key was rejected",
  403: "the key is not allowed for this app",
  429: "rate limited; a publisher key for the app raises the limit",
};

/** `true` only when the zod output type and the hand-written interface describe the same shape. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

// ---------------------------------------------------------------------------
// Context and global arguments
// ---------------------------------------------------------------------------

/** How purchases are filtered: Steam purchasers, everyone, or non-Steam keys. */
export type PurchaseType = "steam" | "all" | "nonSteam";

/** Global arguments every method reads from the behavior definition. */
export interface GlobalArgs {
  /** The Steam app id whose reviews are read. */
  appId: number;
  /** Optional Steamworks Web API publisher key for the app. Sensitive. */
  key?: string;
}

const GlobalArgsSchema = z.object({
  appId: z.number().int().positive().describe(
    "Steam app id whose reviews are read, e.g. 440 for Team Fortress 2",
  ),
  key: z.string().min(1).optional().meta({ sensitive: true }).describe(
    "Optional Steamworks Web API publisher key for the app, which summary and recent send for the higher rate limit; reviews are public without it",
  ),
});

const _GlobalArgsMatch: Same<z.infer<typeof GlobalArgsSchema>, GlobalArgs> =
  true;

/** The logger methods this behavior calls. */
export interface Logger {
  /** Internal detail, such as a page fetched. */
  debug(message: string, ...args: unknown[]): void;
  /** What a method is about to do and what it did. */
  info(message: string, ...args: unknown[]): void;
  /** A recoverable oddity in an answer. */
  warning(message: string, ...args: unknown[]): void;
}

/** The handle a resource write returns. */
export interface DataHandle {
  /** Instance name of the written resource. */
  name: string;
}

/** What every method returns. */
export interface MethodResult {
  /** Handles of the resources the method wrote. */
  dataHandles: DataHandle[];
}

/** One stored record, as swamp's `queryData` returns it. */
export interface DataRecord {
  /** Version number of this record. */
  version: number;
  /** The record's parsed JSON content. */
  attributes: Record<string, unknown>;
}

/** The parts of Swamp's method context this behavior uses. */
export interface MethodContext {
  /** Parsed global arguments of the behavior definition. */
  globalArgs: GlobalArgs;
  /** Id of this behavior instance, used to find its own recorded samples. */
  modelId: string;
  /** Cancels requests in flight when the run is cancelled. */
  signal?: AbortSignal;
  /** Structured logger. */
  logger: Logger;
  /** Writes a resource validated against its spec and returns its handle. */
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<DataHandle>;
  /** CEL query over stored data; a predicate naming `version` searches every version. */
  queryData?: (predicate: string) => Promise<unknown[]>;
}

/** The subset of `fetch` the `sample` method uses. Tests replace it. */
export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

/** Injectable dependencies, set by tests and otherwise defaulted to the runtime. */
export interface Injected {
  /** Replaces the global `fetch`. */
  _fetch?: Fetcher;
  /** Replaces the clock, returning the current time. */
  _now?: () => Date;
}

/** An answer from the Web API that this behavior cannot use. */
export class SteamReviewsError extends Error {
  /** HTTP status of the answer, or 0 when there was none. */
  readonly status: number;
  /** Seconds to wait before trying again, on a 429 answer that says. */
  readonly retryAfterSeconds: number | undefined;

  /** Builds the error. `retryAfterSeconds` is set for a 429 answer only. */
  constructor(message: string, status: number, retryAfterSeconds?: number) {
    super(message);
    this.name = "SteamReviewsError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// ---------------------------------------------------------------------------
// summary and recent: types and schemas
// ---------------------------------------------------------------------------

/** The filters both methods share. */
export interface ReviewFilters {
  /** API language codes, or ["all"] for every language. */
  languages: string[];
  /** Which purchases count. */
  purchaseType: PurchaseType;
  /** Include reviews Steam marked as off-topic activity (review bombs). */
  includeOfftopic: boolean;
}

/** Arguments of the `summary` method. */
export interface SummaryArgs extends ReviewFilters {}

/** Arguments of the `recent` method. */
export interface RecentArgs extends ReviewFilters {
  /** Unix seconds of the window's start. Overrides `days`. */
  since?: number;
  /** Unix seconds of the window's end. Defaults to now. */
  until?: number;
  /** Window length in days, ending at `until`, when `since` is not given. */
  days: number;
  /** Reviews per page, at most 100. */
  perPage: number;
  /** Most pages to fetch before stopping with `truncated: true`. */
  maxPages: number;
  /** Keep each review's author SteamID and playtime at review. */
  keepAuthor: boolean;
  /** Keep each review's text, cut to 2000 characters. */
  keepText: boolean;
}

/** The score and totals Steam reports for an app's reviews. */
export interface ScoreSummary {
  /** Steam's score bucket, 0 to 9. */
  reviewScore: number;
  /** The bucket's description, such as "Very Positive". */
  reviewScoreDesc: string;
  /** Positive reviews counted. */
  totalPositive: number;
  /** Negative reviews counted. */
  totalNegative: number;
  /** All reviews counted. */
  totalReviews: number;
  /** totalPositive / totalReviews, or null when there are no reviews. */
  positiveShare: number | null;
}

/** Positive and negative counts over a set of reviews. */
export interface VoteCounts {
  /** Positive reviews. */
  positive: number;
  /** Negative reviews. */
  negative: number;
}

/** One review as a `recent` resource keeps it. */
export interface Review {
  /** The review's id. */
  recommendationId: string;
  /** True for a positive review. */
  votedUp: boolean;
  /** Unix seconds the review was created. */
  timestampCreated: number;
  /** API language code the review was written in. */
  language: string;
  /** The author's SteamID, only when keepAuthor is set. */
  authorSteamId?: string;
  /** The author's playtime in minutes when writing, only when keepAuthor is set. */
  playtimeAtReviewMinutes?: number;
  /** The review text, cut to 2000 characters, only when keepText is set. */
  text?: string;
}

/** Why `recent` stopped paging. */
export type StopReason = "window" | "empty" | "pageLimit" | "cursorRepeat";

/** Counts and reviews over a window, as the `recent` resource keeps them. */
export interface RecentSummary extends VoteCounts {
  /** Reviews counted in the window. */
  count: number;
  /** positive / count, or null when the window holds no reviews. */
  positiveShare: number | null;
  /** Counts by API language code. */
  byLanguage: Record<string, VoteCounts>;
}

/** One page of a GetAppReviews answer, reduced to what this behavior reads. */
export interface ReviewsPage {
  /** Score fields, present on the first page of an all-types query. */
  score?: ScoreSummary;
  /** Reviews matching the query, when reported. */
  totalMatching?: number;
  /** The reviews on this page, as the answer gave them. */
  reviews: Record<string, unknown>[];
  /** Cursor for the next page. */
  cursor?: string;
}

// Each argument is written out in its own schema, on a line that starts
// `name: z.<type>(`, with a literal `.describe("...")`: the registry catalogs
// arguments from the source text and drops any it cannot read that way, a
// field spread from a shared shape included.
const SummaryArgsSchema = z.object({
  languages: z.array(z.string().min(1)).min(1).default(["all"]).describe(
    "API language codes to read, such as english or schinese; all means every language.",
  ),
  purchaseType: z.enum(["steam", "all", "nonSteam"]).default("steam").describe(
    "steam counts reviews by Steam purchasers, as the store's score does; all counts every review; nonSteam only keys bought elsewhere.",
  ),
  includeOfftopic: z.boolean().default(false).describe(
    "Include reviews Steam filtered as off-topic activity (review bombs).",
  ),
}) satisfies z.ZodType<SummaryArgs>;

const RecentArgsSchema = z
  .object({
    languages: z.array(z.string().min(1)).min(1).default(["all"]).describe(
      "API language codes to read, such as english or schinese; all means every language.",
    ),
    purchaseType: z.enum(["steam", "all", "nonSteam"]).default("steam")
      .describe(
        "steam counts reviews by Steam purchasers, as the store's score does; all counts every review; nonSteam only keys bought elsewhere.",
      ),
    includeOfftopic: z.boolean().default(false).describe(
      "Include reviews Steam filtered as off-topic activity (review bombs).",
    ),
    since: z.number().int().nonnegative().optional().describe(
      "Unix seconds of the window's start. Overrides days.",
    ),
    until: z.number().int().positive().optional().describe(
      "Unix seconds of the window's end. Defaults to now.",
    ),
    days: z.number().positive().max(3650).default(7).describe(
      "Window length in days, when since is not given.",
    ),
    perPage: z.number().int().min(1).max(MAX_PER_PAGE).default(100).describe(
      "Reviews per page, at most 100.",
    ),
    maxPages: z.number().int().min(1).max(100).default(10).describe(
      "Most pages to fetch; reaching it sets truncated.",
    ),
    keepAuthor: z.boolean().default(false).describe(
      "Keep each review's author SteamID and playtime at review, which are personal data.",
    ),
    keepText: z.boolean().default(false).describe(
      "Keep each review's text, cut to 2000 characters, which players wrote.",
    ),
  })
  .refine(
    (value) =>
      value.since === undefined || value.until === undefined ||
      value.since < value.until,
    { message: "since must be before until." },
  ) satisfies z.ZodType<RecentArgs>;

const VoteCountsSchema = z.object({
  positive: z.number().int(),
  negative: z.number().int(),
}) satisfies z.ZodType<VoteCounts>;

const FiltersSchema = z.object({
  languages: z.array(z.string()),
  purchaseType: z.enum(["steam", "all", "nonSteam"]),
  includeOfftopic: z.boolean(),
}) satisfies z.ZodType<ReviewFilters>;

const ScoreResourceSchema = z.object({
  fetchedAt: z.iso.datetime(),
  appId: z.number().int(),
  filters: FiltersSchema,
  reviewScore: z.number().int(),
  reviewScoreDesc: z.string(),
  totalPositive: z.number().int(),
  totalNegative: z.number().int(),
  totalReviews: z.number().int(),
  positiveShare: z.number().nullable(),
});

const ReviewSchema = z.object({
  recommendationId: z.string(),
  votedUp: z.boolean(),
  timestampCreated: z.number().int(),
  language: z.string(),
  authorSteamId: z.string().optional(),
  playtimeAtReviewMinutes: z.number().int().optional(),
  text: z.string().optional(),
}) satisfies z.ZodType<Review>;

const RecentResourceSchema = z.object({
  fetchedAt: z.iso.datetime(),
  appId: z.number().int(),
  filters: FiltersSchema,
  since: z.number().int(),
  until: z.number().int(),
  pagesFetched: z.number().int(),
  stopReason: z.enum(["window", "empty", "pageLimit", "cursorRepeat"]),
  truncated: z.boolean(),
  count: z.number().int(),
  positive: z.number().int(),
  negative: z.number().int(),
  positiveShare: z.number().nullable(),
  byLanguage: z.record(z.string(), VoteCountsSchema),
  keptAuthor: z.boolean(),
  keptText: z.boolean(),
  reviews: z.array(ReviewSchema),
});

// ---------------------------------------------------------------------------
// sample and summarise: types and schemas
// ---------------------------------------------------------------------------

const ReviewsSchema = z.object({
  reviewScore: z.number().int().nonnegative(),
  reviewScoreDesc: z.string(),
  totalPositive: z.number().int().nonnegative(),
  totalNegative: z.number().int().nonnegative(),
  totalReviews: z.number().int().nonnegative(),
});

/** The review score and counts Steam reports in its `query_summary`. */
export interface Reviews {
  /** Steam's review score, 0 to 9, from `review_score`. */
  reviewScore: number;
  /** Steam's words for the score, e.g. "Very Positive", from `review_score_desc`. */
  reviewScoreDesc: string;
  /** Positive reviews, from `total_positive`. */
  totalPositive: number;
  /** Negative reviews, from `total_negative`. */
  totalNegative: number;
  /** All reviews, from `total_reviews`. */
  totalReviews: number;
}

const _ReviewsMatch: Same<z.infer<typeof ReviewsSchema>, Reviews> = true;

const PointSchema = ReviewsSchema.extend({
  positiveRatio: z.number().min(0).max(1).nullable(),
  sampledAt: z.iso.datetime(),
});

/** A review score, its counts and ratio, and the moment they were recorded. */
export interface Point extends Reviews {
  /** Positive reviews over positive and negative reviews, or null when there are none. */
  positiveRatio: number | null;
  /** ISO-8601 time the reviews were read. */
  sampledAt: string;
}

const _PointMatch: Same<z.infer<typeof PointSchema>, Point> = true;

const SampleSchema = PointSchema.extend({
  appId: z.number().int().positive(),
});

/** One recorded review summary, as stored in one version of the `sample` resource. */
export interface Sample extends Point {
  /** Steam app id the reviews belong to. */
  appId: number;
}

const _SampleMatch: Same<z.infer<typeof SampleSchema>, Sample> = true;

const ChangeSchema = z.object({
  positiveRatio: z.number().min(-1).max(1).nullable(),
  reviewScore: z.number().int(),
  totalPositive: z.number().int(),
  totalNegative: z.number().int(),
  totalReviews: z.number().int(),
});

/** The latest sample minus the first. */
export interface Change {
  /** Change in positive ratio, or null when either end has no reviews. */
  positiveRatio: number | null;
  /** Change in Steam's review score. */
  reviewScore: number;
  /** Positive reviews added. */
  totalPositive: number;
  /** Negative reviews added. */
  totalNegative: number;
  /** Reviews added. */
  totalReviews: number;
}

const _ChangeMatch: Same<z.infer<typeof ChangeSchema>, Change> = true;

const SummarySchema = z.object({
  appId: z.number().int().positive(),
  samples: z.number().int().positive(),
  since: z.iso.datetime().nullable(),
  first: PointSchema,
  latest: PointSchema,
  min: PointSchema.nullable(),
  max: PointSchema.nullable(),
  change: ChangeSchema,
  summarisedAt: z.iso.datetime(),
});

/** The summary of an app's recorded samples. */
export interface Summary {
  /** Steam app id the samples belong to. */
  appId: number;
  /** How many samples were summarised. */
  samples: number;
  /** The lower bound on recording time, or null when every sample counted. */
  since: string | null;
  /** The earliest sample. */
  first: Point;
  /** The most recent sample. */
  latest: Point;
  /** The lowest positive ratio, the earliest on a tie; null when no sample has reviews. */
  min: Point | null;
  /** The highest positive ratio, the earliest on a tie; null when no sample has reviews. */
  max: Point | null;
  /** The latest sample minus the first. */
  change: Change;
  /** ISO-8601 time the summary was written. */
  summarisedAt: string;
}

const _SummaryMatch: Same<z.infer<typeof SummarySchema>, Summary> = true;

const SampleArgsSchema = z.object({});

const SummariseArgsSchema = z.object({
  since: z.string().pipe(z.iso.datetime()).optional().describe(
    "Only summarise samples recorded at or after this ISO-8601 time; all samples when omitted",
  ),
});

/** Arguments of the `summarise` method. */
export interface SummariseArgs {
  /** Only samples recorded at or after this ISO-8601 time count. */
  since?: string;
}

const _SummariseArgsMatch: Same<
  z.infer<typeof SummariseArgsSchema>,
  SummariseArgs
> = true;

// ---------------------------------------------------------------------------
// GetAppReviews: parsing and transport for summary and recent
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

/** A share of positive reviews, or null when there are none to share. */
export function share(positive: number, total: number): number | null {
  return total > 0 ? positive / total : null;
}

/** Reads one page of a GetAppReviews answer, `{response: {...}}`. */
export function parsePage(body: unknown): ReviewsPage {
  if (!isRecord(body) || !isRecord(body.response)) {
    throw new SteamReviewsError(
      "GetAppReviews: the answer has no response object",
      200,
    );
  }
  const response = body.response;
  const summary = isRecord(response.query_summary)
    ? response.query_summary
    : undefined;
  let score: ScoreSummary | undefined;
  const totalReviews = asInteger(summary?.total_reviews);
  if (summary !== undefined && totalReviews !== undefined) {
    const totalPositive = asInteger(summary.total_positive) ?? 0;
    score = {
      reviewScore: asInteger(summary.review_score) ?? 0,
      reviewScoreDesc: asString(summary.review_score_desc) ?? "",
      totalPositive,
      totalNegative: asInteger(summary.total_negative) ?? 0,
      totalReviews,
      positiveShare: share(totalPositive, totalReviews),
    };
  }
  const reviews = Array.isArray(response.reviews)
    ? response.reviews.filter(isRecord)
    : [];
  return {
    score,
    totalMatching: asInteger(response.total_matching),
    reviews,
    cursor: asString(response.cursor),
  };
}

/**
 * Reduces one review to what a `recent` resource keeps. The author and the
 * text are dropped unless asked for. Returns undefined for a review missing
 * its id, vote or creation time, which cannot be counted honestly.
 */
export function normalizeReview(
  raw: Record<string, unknown>,
  keepAuthor: boolean,
  keepText: boolean,
): Review | undefined {
  const id = asString(raw.recommendationid) ??
    (typeof raw.recommendationid === "number"
      ? String(raw.recommendationid)
      : undefined);
  const created = asInteger(raw.timestamp_created);
  if (id === undefined || typeof raw.voted_up !== "boolean") return undefined;
  if (created === undefined) return undefined;
  const review: Review = {
    recommendationId: id,
    votedUp: raw.voted_up,
    timestampCreated: created,
    language: asString(raw.language) ?? "unknown",
  };
  if (keepAuthor && isRecord(raw.author)) {
    const steamId = asString(raw.author.steamid);
    const playtime = asInteger(raw.author.playtime_at_review);
    if (steamId !== undefined) review.authorSteamId = steamId;
    if (playtime !== undefined) review.playtimeAtReviewMinutes = playtime;
  }
  if (keepText) {
    const text = asString(raw.review);
    if (text !== undefined) review.text = text.slice(0, TEXT_LIMIT);
  }
  return review;
}

/** Counts positive and negative reviews, overall and by language. */
export function countReviews(reviews: Review[]): RecentSummary {
  const byLanguage: Record<string, VoteCounts> = {};
  let positive = 0;
  for (const review of reviews) {
    const counts = byLanguage[review.language] ??= { positive: 0, negative: 0 };
    if (review.votedUp) {
      positive++;
      counts.positive++;
    } else {
      counts.negative++;
    }
  }
  return {
    count: reviews.length,
    positive,
    negative: reviews.length - positive,
    positiveShare: share(positive, reviews.length),
    byLanguage,
  };
}

/** Replaces every occurrence of the key, raw or URL-encoded, with a marker. */
export function redact(text: string, key: string | undefined): string {
  if (key === undefined || key === "") return text;
  let out = text;
  for (const form of new Set([key, encodeURIComponent(key)])) {
    out = out.split(form).join("[redacted]");
  }
  return out;
}

function retryAfterSeconds(headers: Headers): number | undefined {
  return asInteger(headers.get("Retry-After"));
}

/**
 * Calls GetAppReviews once with `input` as its input_json, and the key, when
 * one is set, as its own parameter. Returns the parsed page. Throws a
 * SteamReviewsError for a non-2xx status (a 429 carries Retry-After when the
 * answer gives it), and for an answer that is not JSON or has no response.
 * Neither the key nor the URL that carries it is ever logged or thrown.
 */
export async function fetchPage(
  globalArgs: GlobalArgs,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ReviewsPage> {
  const url = new URL(API_URL);
  url.searchParams.set("input_json", JSON.stringify(input));
  if (globalArgs.key !== undefined) url.searchParams.set("key", globalArgs.key);
  const label = `GetAppReviews for app ${globalArgs.appId}`;
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: combined,
    });
  } catch (error) {
    // A cancelled run stays a cancellation; anything else, a request that
    // outlived the timeout included, is the network.
    if (signal?.aborted) throw error;
    // A network error's message can quote the URL, and the URL carries the
    // key: report the failure without it.
    const detail = error instanceof Error ? error.message : String(error);
    throw new SteamReviewsError(
      `${label}: request failed: ${redact(detail, globalArgs.key)}`,
      0,
    );
  }
  const text = await response.text();
  if (!response.ok) {
    const eresult = response.headers.get("x-eresult");
    const hint = STATUS_HINTS[response.status];
    const seconds = response.status === 429
      ? retryAfterSeconds(response.headers)
      : undefined;
    const detail = [
      `${response.status} ${response.statusText}`.trim(),
      eresult === null ? undefined : `eresult ${eresult}`,
      hint === undefined ? undefined : `(${hint})`,
      seconds === undefined ? undefined : `retry after ${seconds} seconds`,
    ]
      .filter((part) => part !== undefined)
      .join(", ");
    throw new SteamReviewsError(
      `${label}: ${detail}`,
      response.status,
      seconds,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SteamReviewsError(`${label}: answer was not JSON`, 200);
  }
  return parsePage(parsed);
}

function baseInput(appId: number, filters: ReviewFilters): Record<
  string,
  unknown
> {
  return {
    appid: appId,
    languages: filters.languages,
    review_type: REVIEW_TYPE_ALL,
    purchase_type: PURCHASE_TYPES[filters.purchaseType],
    filter_offtopic_activity: !filters.includeOfftopic,
  };
}

function filtersOf(args: ReviewFilters): ReviewFilters {
  return {
    languages: args.languages,
    purchaseType: args.purchaseType,
    includeOfftopic: args.includeOfftopic,
  };
}

// ---------------------------------------------------------------------------
// appreviews: transport and history for sample and summarise
// ---------------------------------------------------------------------------

/** The data name an app's samples are written under. */
export function sampleName(appId: number): string {
  return `app-${appId}`;
}

/** The data name an app's summary is written under. */
export function summaryName(appId: number): string {
  return `summary-${appId}`;
}

/** The URL `sample` requests for one app: every language and purchase type, no review bodies. */
export function reviewsUrl(appId: number): string {
  const url = new URL(`${REVIEWS_URL}${appId}`);
  url.searchParams.set("json", "1");
  url.searchParams.set("language", "all");
  url.searchParams.set("purchase_type", "all");
  url.searchParams.set("num_per_page", "0");
  return url.toString();
}

/**
 * Positive reviews over positive and negative reviews, or null when there are
 * none to divide by.
 */
export function positiveRatio(
  totalPositive: number,
  totalNegative: number,
): number | null {
  const rated = totalPositive + totalNegative;
  return rated === 0 ? null : totalPositive / rated;
}

/** A non-negative integer field of `query_summary`, or undefined when it is not one. */
function count(
  fields: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = fields[key];
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

/**
 * Reads one app's review score and counts from Steam. Throws a specific error
 * for a network failure, a rate limit, a server error, a response Steam marks
 * unsuccessful, or a body that is not the documented shape.
 */
export async function fetchReviews(
  fetcher: Fetcher,
  appId: number,
  signal?: AbortSignal,
): Promise<Reviews> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const where = `appreviews for app ${appId}`;
  let response: Response;
  try {
    response = await fetcher(reviewsUrl(appId), {
      method: "GET",
      headers: { accept: "application/json" },
      signal: combined,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${where}: request failed: ${detail}`);
  }
  if (response.status === 429) {
    await response.body?.cancel();
    const retryAfter = response.headers.get("retry-after");
    throw new Error(
      `${where}: Steam rate limited the request (HTTP 429)` +
        (retryAfter ? `, retry after ${retryAfter} seconds` : ""),
    );
  }
  if (response.status >= 500) {
    const text = await response.text();
    throw new Error(
      `${where}: Steam is unavailable (HTTP ${response.status}), a transient failure, retry later: ${
        text.slice(0, 200)
      }`,
    );
  }
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(
      `${where}: HTTP ${response.status}, body is not JSON: ${
        text.slice(0, 200)
      }`,
    );
  }
  const top = body !== null && typeof body === "object"
    ? body as Record<string, unknown>
    : undefined;
  if (top === undefined) {
    throw new Error(
      `${where}: HTTP ${response.status}, unexpected response ${
        text.slice(0, 200)
      }`,
    );
  }
  if (top.success !== 1) {
    throw new Error(
      `${where}: Steam reported no reviews for this app (HTTP ${response.status}, success ${
        JSON.stringify(top.success)
      }); check that the app id exists on Steam`,
    );
  }
  const summary = top.query_summary;
  const fields = summary !== null && typeof summary === "object"
    ? summary as Record<string, unknown>
    : undefined;
  if (!response.ok || fields === undefined) {
    throw new Error(
      `${where}: HTTP ${response.status}, no "query_summary" object in ${
        text.slice(0, 200)
      }`,
    );
  }
  const reviewScore = count(fields, "review_score");
  const totalPositive = count(fields, "total_positive");
  const totalNegative = count(fields, "total_negative");
  const totalReviews = count(fields, "total_reviews");
  const reviewScoreDesc = fields.review_score_desc;
  if (
    reviewScore === undefined || totalPositive === undefined ||
    totalNegative === undefined || totalReviews === undefined ||
    typeof reviewScoreDesc !== "string"
  ) {
    throw new Error(
      `${where}: HTTP ${response.status}, unexpected query_summary ${
        JSON.stringify(fields).slice(0, 200)
      }`,
    );
  }
  return {
    reviewScore,
    reviewScoreDesc,
    totalPositive,
    totalNegative,
    totalReviews,
  };
}

/**
 * Summarises samples: the first and latest by recording time, the minimum and
 * maximum positive ratio among samples that have reviews (the earliest on a
 * tie), and the latest minus the first. Throws when there are no samples.
 */
export function summarise(
  appId: number,
  samples: readonly Sample[],
  since: string | null,
  summarisedAt: string,
): Summary {
  const ordered = [...samples].sort((a, b) =>
    Date.parse(a.sampledAt) - Date.parse(b.sampledAt)
  );
  const first = ordered[0];
  const latest = ordered[ordered.length - 1];
  if (first === undefined || latest === undefined) {
    throw new Error(`No samples to summarise for app ${appId}`);
  }
  const point = (sample: Sample): Point => ({
    reviewScore: sample.reviewScore,
    reviewScoreDesc: sample.reviewScoreDesc,
    totalPositive: sample.totalPositive,
    totalNegative: sample.totalNegative,
    totalReviews: sample.totalReviews,
    positiveRatio: sample.positiveRatio,
    sampledAt: sample.sampledAt,
  });
  let min: Sample | null = null;
  let max: Sample | null = null;
  for (const sample of ordered) {
    const ratio = sample.positiveRatio;
    if (ratio === null) {
      continue;
    }
    if (
      min === null || min.positiveRatio === null || ratio < min.positiveRatio
    ) {
      min = sample;
    }
    if (
      max === null || max.positiveRatio === null || ratio > max.positiveRatio
    ) {
      max = sample;
    }
  }
  const ratioChange =
    first.positiveRatio === null || latest.positiveRatio === null
      ? null
      : latest.positiveRatio - first.positiveRatio;
  return {
    appId,
    samples: ordered.length,
    since,
    first: point(first),
    latest: point(latest),
    min: min === null ? null : point(min),
    max: max === null ? null : point(max),
    change: {
      positiveRatio: ratioChange,
      reviewScore: latest.reviewScore - first.reviewScore,
      totalPositive: latest.totalPositive - first.totalPositive,
      totalNegative: latest.totalNegative - first.totalNegative,
      totalReviews: latest.totalReviews - first.totalReviews,
    },
    summarisedAt,
  };
}

// ---------------------------------------------------------------------------
// Behavior
// ---------------------------------------------------------------------------

/**
 * The behavior definition Swamp registers. Global arguments are `appId` and
 * an optional `key` (sensitive); see the README for each method, the resource
 * it writes and the instance name it writes it under.
 */
export const behavior = {
  // String literals, not constants: the registry catalog reads them from the
  // source.
  type: "@reset/steam-reviews",
  version: "2026.10.30.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    score: {
      description:
        "The app's review score and positive, negative and total counts, as GetAppReviews reports them for the filters",
      schema: ScoreResourceSchema,
      lifetime: "infinite",
      garbageCollection: 90,
    },
    recent: {
      description:
        "Reviews created in a window: counts overall and by language, and each review's id, vote, time and language",
      schema: RecentResourceSchema,
      lifetime: "30d",
      garbageCollection: 10,
    },
    sample: {
      description:
        "One app's review score and review counts at one moment; every sample is a new version",
      schema: SampleSchema,
      lifetime: "infinite",
      garbageCollection: "365d",
    },
    summary: {
      description:
        "The first, latest, minimum and maximum positive ratio of an app's recorded samples and the change between first and latest",
      schema: SummarySchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    summary: {
      description:
        "Read the app's review score and totals for a set of filters with one GetAppReviews call. Writes score.",
      arguments: SummaryArgsSchema,
      execute: async (
        args: SummaryArgs,
        context: MethodContext,
      ): Promise<MethodResult> => {
        const { globalArgs, signal, logger } = context;
        const filters = filtersOf(args);
        logger.info("Reading the review summary of app {appId}", {
          appId: globalArgs.appId,
          filters,
        });
        const page = await fetchPage(
          globalArgs,
          {
            ...baseInput(globalArgs.appId, filters),
            filter: FILTER_RECENT,
            num_per_page: 1,
            cursor: "*",
          },
          signal,
        );
        if (page.score === undefined) {
          // Steam answers {"response": {}} for an app with no store page
          // (Spacewar, 480, is one), and that is not a score of zero.
          const empty = page.reviews.length === 0 && page.cursor === undefined;
          throw new SteamReviewsError(
            `GetAppReviews for app ${globalArgs.appId}: the answer carries no score fields` +
              (empty
                ? "; Steam returned an empty response, which it does for an app with no store page"
                : ""),
            200,
          );
        }
        const handle = await context.writeResource("score", "score", {
          fetchedAt: new Date().toISOString(),
          appId: globalArgs.appId,
          filters,
          ...page.score,
        });
        logger.info(
          "App {appId}: {desc}, {positive} positive of {total}",
          {
            appId: globalArgs.appId,
            desc: page.score.reviewScoreDesc,
            positive: page.score.totalPositive,
            total: page.score.totalReviews,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    recent: {
      description:
        "Page through the reviews created in a window, newest first, and count positive and negative overall and by language. Writes recent.",
      arguments: RecentArgsSchema,
      execute: async (
        args: RecentArgs,
        context: MethodContext,
      ): Promise<MethodResult> => {
        const { globalArgs, signal, logger } = context;
        const filters = filtersOf(args);
        const until = args.until ?? Math.floor(Date.now() / 1000);
        const since = args.since ?? Math.floor(until - args.days * 86_400);
        if (since >= until) {
          throw new SteamReviewsError(
            "recent: the window is empty, since must be before until",
            0,
          );
        }
        logger.info(
          "Reading reviews of app {appId} created from {since} to {until}",
          { appId: globalArgs.appId, since, until, filters },
        );
        const reviews: Review[] = [];
        const seenIds = new Set<string>();
        const seenCursors = new Set<string>();
        let cursor = "*";
        let pagesFetched = 0;
        let stopReason: StopReason = "pageLimit";
        let skipped = 0;
        paging: while (pagesFetched < args.maxPages) {
          seenCursors.add(cursor);
          const page = await fetchPage(
            globalArgs,
            {
              ...baseInput(globalArgs.appId, filters),
              filter: FILTER_RECENT,
              num_per_page: args.perPage,
              cursor,
              date_range_start: since,
              date_range_end: until,
            },
            signal,
          );
          pagesFetched++;
          logger.debug("Page {page}: {count} reviews", {
            page: pagesFetched,
            count: page.reviews.length,
          });
          if (page.reviews.length === 0) {
            stopReason = "empty";
            break;
          }
          for (const raw of page.reviews) {
            const review = normalizeReview(raw, args.keepAuthor, args.keepText);
            if (review === undefined) {
              skipped++;
              continue;
            }
            // Newest first: one review older than the window ends it, in
            // case the server ignored the date range.
            if (review.timestampCreated < since) {
              stopReason = "window";
              break paging;
            }
            if (review.timestampCreated > until) continue;
            if (seenIds.has(review.recommendationId)) continue;
            seenIds.add(review.recommendationId);
            reviews.push(review);
          }
          if (page.cursor === undefined || seenCursors.has(page.cursor)) {
            stopReason = "cursorRepeat";
            break;
          }
          cursor = page.cursor;
        }
        if (skipped > 0) {
          logger.warning(
            "Skipped {skipped} reviews missing an id, vote or creation time",
            { skipped },
          );
        }
        const truncated = stopReason === "pageLimit";
        if (truncated) {
          logger.warning(
            "Stopped after {pages} pages with the window not exhausted; counts cover the newest {count} reviews only",
            { pages: pagesFetched, count: reviews.length },
          );
        }
        const counts = countReviews(reviews);
        const handle = await context.writeResource("recent", "recent", {
          fetchedAt: new Date().toISOString(),
          appId: globalArgs.appId,
          filters,
          since,
          until,
          pagesFetched,
          stopReason,
          truncated,
          ...counts,
          keptAuthor: args.keepAuthor,
          keptText: args.keepText,
          reviews,
        });
        logger.info(
          "App {appId}: {positive} positive and {negative} negative reviews in the window",
          {
            appId: globalArgs.appId,
            positive: counts.positive,
            negative: counts.negative,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    sample: {
      description:
        "Read the app's review score and counts from Steam's public store endpoint and record them as a new version",
      arguments: SampleArgsSchema,
      execute: async (
        args: Injected,
        context: MethodContext,
      ): Promise<MethodResult> => {
        const { globalArgs, logger } = context;
        const fetcher = args._fetch ?? globalThis.fetch;
        const now = args._now ?? (() => new Date());
        logger.info("Reading the review summary of app {appId}", {
          appId: globalArgs.appId,
        });
        const reviews = await fetchReviews(
          fetcher,
          globalArgs.appId,
          context.signal,
        );
        const data: Sample = {
          appId: globalArgs.appId,
          ...reviews,
          positiveRatio: positiveRatio(
            reviews.totalPositive,
            reviews.totalNegative,
          ),
          sampledAt: now().toISOString(),
        };
        const handle = await context.writeResource(
          "sample",
          sampleName(globalArgs.appId),
          { ...data },
        );
        logger.info(
          "App {appId} is {reviewScoreDesc}: {totalPositive} positive, {totalNegative} negative of {totalReviews} reviews",
          {
            appId: globalArgs.appId,
            reviewScoreDesc: data.reviewScoreDesc,
            totalPositive: data.totalPositive,
            totalNegative: data.totalNegative,
            totalReviews: data.totalReviews,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    summarise: {
      description:
        "Summarise the recorded samples: count, first, latest, minimum and maximum positive ratio and the change over the period",
      arguments: SummariseArgsSchema,
      execute: async (
        args: SummariseArgs & Injected,
        context: MethodContext,
      ): Promise<MethodResult> => {
        const { globalArgs, logger } = context;
        const now = args._now ?? (() => new Date());
        const since = args.since ?? null;
        if (context.queryData === undefined) {
          throw new Error(
            "summarise needs swamp's queryData to read the recorded samples; upgrade swamp",
          );
        }
        logger.info("Reading the recorded samples of app {appId}", {
          appId: globalArgs.appId,
        });
        const name = sampleName(globalArgs.appId);
        const predicate = `modelId == ${JSON.stringify(context.modelId)} && ` +
          `specName == "sample" && name == ${
            JSON.stringify(name)
          } && version >= 0`;
        const records = await context.queryData(predicate);
        const sinceMs = since === null ? -Infinity : Date.parse(since);
        const samples: Sample[] = [];
        let skipped = 0;
        for (const record of records) {
          const attributes = record !== null && typeof record === "object"
            ? (record as Partial<DataRecord>).attributes
            : undefined;
          const parsed = SampleSchema.safeParse(attributes);
          if (!parsed.success || parsed.data.appId !== globalArgs.appId) {
            skipped += 1;
            continue;
          }
          if (Date.parse(parsed.data.sampledAt) >= sinceMs) {
            samples.push(parsed.data);
          }
        }
        if (skipped > 0) {
          logger.warning(
            "Skipped {skipped} stored samples that are not a sample of app {appId}",
            { skipped, appId: globalArgs.appId },
          );
        }
        if (samples.length === 0) {
          throw new Error(
            `No samples of app ${globalArgs.appId} recorded` +
              (since === null ? "" : ` since ${since}`) +
              "; run the sample method first",
          );
        }
        const data = summarise(
          globalArgs.appId,
          samples,
          since,
          now().toISOString(),
        );
        const handle = await context.writeResource(
          "summary",
          summaryName(globalArgs.appId),
          { ...data },
        );
        logger.info(
          "Summarised {samples} samples of app {appId}: positive ratio {first} to {latest}, change {change}",
          {
            samples: data.samples,
            appId: globalArgs.appId,
            first: data.first.positiveRatio,
            latest: data.latest.positiveRatio,
            change: data.change.positiveRatio,
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
        "Joins the two lines of this extension: instances made on 2026.10.21.1 (summary, recent) and on 2026.10.22.x (sample, summarise) keep their appId and optional key as written, and every method is available to both; the summary method now writes the score resource",
      upgradeAttributes: (old: Record<string, unknown>): Record<
        string,
        unknown
      > => old,
    },
  ],
};
