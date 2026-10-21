/**
 * A Swamp behavior for a Steam app's public user reviews, read through
 * Steamworks' documented Web API method IUserReviewsService/GetAppReviews,
 * which replaces store.steampowered.com/appreviews. `summary` keeps the
 * review score and totals; `recent` pages through the reviews created in a
 * window, newest first, and counts positive and negative reviews overall and
 * by language. Every method writes what it read as a resource, so a workflow
 * can assert on it with CEL.
 *
 * Reviews are data about players: each one carries its author's SteamID,
 * playtime and free text. A `recent` resource keeps the review id, whether it
 * was positive, when it was written and its language. The author's SteamID
 * and playtime, and the review text, are kept only when the method is asked
 * to keep them.
 *
 * @module
 */

import { z } from "npm:zod@4";

const API_URL =
  "https://api.steampowered.com/IUserReviewsService/GetAppReviews/v1/";

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

// ---------------------------------------------------------------------------
// Public types
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

/** The parts of Swamp's method context this behavior uses. */
export interface Context {
  /** Parsed global arguments of the behavior definition. */
  globalArgs: GlobalArgs;
  /** Cancels requests in flight when the run is cancelled. */
  signal: AbortSignal;
  /** Structured logger. */
  logger: Logger;
  /** Writes a resource validated against its spec and returns its handle. */
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<DataHandle>;
}

/** What every method returns. */
export interface MethodResult {
  /** Handles of the resources the method wrote. */
  dataHandles: DataHandle[];
}

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
// Schemas (private: the exported interfaces above are the public types, and
// `satisfies` keeps each schema in step with its interface)
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  appId: z
    .number()
    .int()
    .positive()
    .describe("The Steam app id whose reviews are read."),
  key: z
    .string()
    .min(1)
    .optional()
    .meta({ sensitive: true })
    .describe(
      "Optional Steamworks Web API publisher key associated with the app, for the higher rate limit. Reviews are public without it.",
    ),
}) satisfies z.ZodType<GlobalArgs>;

const FilterShape = {
  languages: z
    .array(z.string().min(1))
    .min(1)
    .default(["all"])
    .describe(
      "API language codes to read, such as english or schinese; all means every language.",
    ),
  purchaseType: z
    .enum(["steam", "all", "nonSteam"])
    .default("steam")
    .describe(
      "steam counts reviews by Steam purchasers, as the store's score does; all counts every review; nonSteam only keys bought elsewhere.",
    ),
  includeOfftopic: z
    .boolean()
    .default(false)
    .describe(
      "Include reviews Steam filtered as off-topic activity (review bombs).",
    ),
};

const SummaryArgsSchema = z.object(FilterShape) satisfies z.ZodType<
  SummaryArgs
>;

const RecentArgsSchema = z
  .object({
    ...FilterShape,
    since: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Unix seconds of the window's start. Overrides days."),
    until: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Unix seconds of the window's end. Defaults to now."),
    days: z
      .number()
      .positive()
      .max(3650)
      .default(7)
      .describe("Window length in days, when since is not given."),
    perPage: z
      .number()
      .int()
      .min(1)
      .max(MAX_PER_PAGE)
      .default(100)
      .describe("Reviews per page, at most 100."),
    maxPages: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(10)
      .describe("Most pages to fetch; reaching it sets truncated."),
    keepAuthor: z
      .boolean()
      .default(false)
      .describe(
        "Keep each review's author SteamID and playtime at review, which are personal data.",
      ),
    keepText: z
      .boolean()
      .default(false)
      .describe(
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

const SummaryResourceSchema = z.object({
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
// Answer parsing
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

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

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
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal,
    });
  } catch (error) {
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
  version: "2026.10.21.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    summary: {
      description: "The app's review score and positive, negative and total " +
        "counts, as Steam reports them for the filters",
      schema: SummaryResourceSchema,
      lifetime: "infinite",
      garbageCollection: 90,
    },
    recent: {
      description: "Reviews created in a window: counts overall and by " +
        "language, and each review's id, vote, time and language",
      schema: RecentResourceSchema,
      lifetime: "30d",
      garbageCollection: 10,
    },
  },
  methods: {
    summary: {
      description: "Read the app's review score and totals with one " +
        "GetAppReviews call. Writes summary.",
      arguments: SummaryArgsSchema,
      execute: async (
        args: SummaryArgs,
        context: Context,
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
        const handle = await context.writeResource("summary", "summary", {
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
      description: "Page through the reviews created in a window, newest " +
        "first, and count positive and negative overall and by language. " +
        "Writes recent.",
      arguments: RecentArgsSchema,
      execute: async (
        args: RecentArgs,
        context: Context,
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
  },
};
