/**
 * A Swamp behavior for a Steam app's news feed, read through the Steam Web
 * API's documented ISteamNews/GetNewsForApp (public, no key) or
 * GetNewsForAppAuthed (publisher key, which also answers for an app that is not
 * released yet). It has two pairs of methods:
 *
 * - `news` lists the newest posts and `find` checks whether a post naming a
 *   given text, such as a release's version, went out since a date: the check
 *   a studio makes after promoting a build, that its patch notes announcement
 *   is live on the store.
 * - `fetch` records the newest posts as a new version of the app's `news`
 *   resource, flagging each post whose gid the previous version did not hold,
 *   and `list` reads every recorded version back, filters the posts (patch
 *   notes only, one feed, one tag, a time window) and writes the matches with
 *   a count per feed.
 *
 * Every method writes what it read as a resource, so a workflow can assert on
 * it with CEL. Post authors are kept only when asked for, and `news` keeps
 * bodies only when asked for. `fetch` is injectable through the `_fetch` and
 * `_now` method arguments so tests never reach Steam.
 *
 * @module
 */

import { z } from "npm:zod@4";

/** The public Steam Web API method this behavior reads without a key. */
export const NEWS_URL =
  "https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/";

/** The publisher method read when a Web API key is set. */
export const AUTHED_URL =
  "https://partner.steam-api.com/ISteamNews/GetNewsForAppAuthed/v2/";

/** How long one request to Steam may take before it is abandoned. */
export const REQUEST_TIMEOUT_MS = 15_000;

/** How many posts `fetch` asks for when no count is given. */
export const DEFAULT_COUNT = 10;

/** The most posts one request asks for. */
export const MAX_COUNT = 100;

/** Most requests `find` makes while paging back to its start date. */
const MAX_PAGES = 10;

/** The Steam tag that marks a post as patch notes. */
export const PATCH_NOTES_TAG = "patchnotes";

/** What a status code means when the answer carries no message of its own. */
const STATUS_HINTS: Record<number, string> = {
  401: "the publisher key was refused",
  403: "the app is unknown, has no public news, or the key does not own it",
  429: "rate limited by the Web API; try again later",
};

/** `true` only when the zod output type and the hand-written interface describe the same shape. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

// ---------------------------------------------------------------------------
// Context and global arguments
// ---------------------------------------------------------------------------

/** Global arguments every method reads from the behavior definition. */
export interface GlobalArgs {
  /** The Steam AppID whose news is read. */
  appId: number;
  /**
   * Steamworks Web API publisher key. When set, GetNewsForAppAuthed is called
   * instead of the public method, so an unreleased app answers. Sensitive.
   */
  webApiKey?: string;
}

const GlobalArgsSchema = z.object({
  appId: z.number().int().positive().describe(
    "Steam app id whose news is read, e.g. 440 for Team Fortress 2",
  ),
  webApiKey: z.string().min(1).optional().meta({ sensitive: true }).describe(
    "Steamworks Web API publisher key; when set every method calls GetNewsForAppAuthed, so an unreleased app answers",
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
  /** Id of this behavior instance, used to find its own recorded news. */
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

/** The subset of `fetch` the `fetch` method uses. Tests replace it. */
export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

/** Injectable dependencies, set by tests and otherwise defaulted to the runtime. */
export interface Injected {
  /** Replaces the global `fetch`. */
  _fetch?: Fetcher;
  /** Replaces the clock, returning the current time. */
  _now?: () => Date;
}

/**
 * A refused or unreadable answer from the Web API, with its HTTP status (0 for
 * an answer that was not the expected JSON).
 */
export class SteamNewsError extends Error {
  /** HTTP status of the answer. */
  readonly status: number;

  /** Builds the error. */
  constructor(message: string, status: number) {
    super(message);
    this.name = "SteamNewsError";
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// news and find: types and schemas
// ---------------------------------------------------------------------------

/** One news post as the `posts` resource keeps it. */
export interface NewsItem {
  /** The post's global id. */
  gid: string;
  /** The post's title. */
  title: string;
  /** Link to the post. */
  url: string;
  /** Whether the link leaves the Steam store. */
  isExternalUrl: boolean;
  /** When the post was published, ISO-8601. */
  date: string;
  /** When the post was published, Unix seconds, as the API answers it. */
  dateUnix: number;
  /** Feed name, such as steam_community_announcements. */
  feedName: string;
  /** Feed label shown on the store, such as Community Announcements. */
  feedLabel: string;
  /** Tags the post carries, such as patchnotes. */
  tags: string[];
  /** Account name of the poster, kept only with includeAuthor. */
  author?: string;
  /** Body or the blurb Steam generated, kept only with includeContents. */
  contents?: string;
}

/** Arguments of the `news` method. */
export interface NewsArgs {
  /** How many of the newest posts to read, 1 to 100. */
  count: number;
  /** Feed names to keep, such as steam_community_announcements. Empty keeps all. */
  feeds?: string[];
  /** Only posts at or before this ISO-8601 time. */
  before?: string;
  /** Longest body to keep, in characters; 0 keeps the full body. */
  maxLength: number;
  /** Keep each post's body or blurb. */
  includeContents: boolean;
  /** Keep each post's author, which names a person. */
  includeAuthor: boolean;
}

/** Arguments of the `find` method. */
export interface FindArgs {
  /** Text a matching post's title (or body, with searchContents) contains. */
  text: string;
  /** Only posts published at or after this ISO-8601 time. */
  since: string;
  /** Feed names to search. Empty searches every feed. */
  feeds?: string[];
  /** Also search each post's full body, not only its title. */
  searchContents: boolean;
  /** Match case exactly. */
  caseSensitive: boolean;
}

/** A post `find` matched, without its body. */
export interface Match {
  /** The post's global id. */
  gid: string;
  /** The post's title. */
  title: string;
  /** Link to the post. */
  url: string;
  /** When the post was published, ISO-8601. */
  date: string;
  /** Feed name. */
  feedName: string;
  /** Whether the text was found in the title (else in the body). */
  inTitle: boolean;
}

/** One page of GetNewsForApp, normalized. */
export interface NewsPage {
  /** Posts on the page, newest first, already filtered to the feeds asked for. */
  items: NewsItem[];
  /** Posts the API returned before the feed filter. */
  returned: number;
  /** Posts the API says the feed holds, when it says so. */
  totalCount?: number;
}

// Each argument is written out in its own schema, on a line that starts
// `name: z.<type>(`, with a literal `.describe("...")`: the registry catalogs
// arguments from the source text and drops any it cannot read that way.
const NewsArgsSchema = z.object({
  count: z.number().int().min(1).max(MAX_COUNT).default(20).describe(
    "How many of the newest posts to read, 1 to 100.",
  ),
  feeds: z.array(z.string().min(1)).optional().describe(
    "Feed names to keep, such as steam_community_announcements. Empty keeps every feed.",
  ),
  before: z.string().pipe(z.iso.datetime({ offset: true })).optional()
    .describe("Only posts at or before this ISO-8601 time."),
  maxLength: z.number().int().min(0).default(300).describe(
    "Longest body to keep, in characters; 0 keeps the full body.",
  ),
  includeContents: z.boolean().default(false).describe(
    "Keep each post's body or the blurb Steam generates.",
  ),
  includeAuthor: z.boolean().default(false).describe(
    "Keep each post's author, which names a person.",
  ),
}) satisfies z.ZodType<NewsArgs>;

const FindArgsSchema = z.object({
  text: z.string().min(1).describe(
    "Text a matching post's title, or body with searchContents, contains.",
  ),
  since: z.string().pipe(z.iso.datetime({ offset: true })).describe(
    "Only posts published at or after this ISO-8601 time.",
  ),
  feeds: z.array(z.string().min(1)).optional().describe(
    "Feed names to search, such as steam_community_announcements. Empty searches every feed.",
  ),
  searchContents: z.boolean().default(false).describe(
    "Also search each post's full body, not only its title.",
  ),
  caseSensitive: z.boolean().default(false).describe("Match case exactly."),
}) satisfies z.ZodType<FindArgs>;

const NewsItemSchema = z.object({
  gid: z.string(),
  title: z.string(),
  url: z.string(),
  isExternalUrl: z.boolean(),
  date: z.iso.datetime(),
  dateUnix: z.number().int(),
  feedName: z.string(),
  feedLabel: z.string(),
  tags: z.array(z.string()),
  author: z.string().optional(),
  contents: z.string().optional(),
}) satisfies z.ZodType<NewsItem>;

const MatchSchema = z.object({
  gid: z.string(),
  title: z.string(),
  url: z.string(),
  date: z.iso.datetime(),
  feedName: z.string(),
  inTitle: z.boolean(),
}) satisfies z.ZodType<Match>;

const PostsResourceSchema = z.object({
  fetchedAt: z.iso.datetime(),
  appId: z.number().int(),
  authed: z.boolean(),
  feeds: z.array(z.string()),
  before: z.string().optional(),
  requested: z.number().int(),
  count: z.number().int(),
  totalCount: z.number().int().optional(),
  truncated: z.boolean(),
  items: z.array(NewsItemSchema),
});

const FindResourceSchema = z.object({
  fetchedAt: z.iso.datetime(),
  appId: z.number().int(),
  authed: z.boolean(),
  text: z.string(),
  since: z.string(),
  feeds: z.array(z.string()),
  searchContents: z.boolean(),
  caseSensitive: z.boolean(),
  found: z.boolean(),
  matchCount: z.number().int(),
  matches: z.array(MatchSchema),
  searched: z.number().int(),
  pagesFetched: z.number().int(),
  complete: z.boolean(),
});

// ---------------------------------------------------------------------------
// fetch and list: types and schemas
// ---------------------------------------------------------------------------

const PostSummarySchema = z.object({
  gid: z.string().min(1),
  title: z.string(),
  url: z.string(),
  feedName: z.string(),
  feedLabel: z.string(),
  publishedAt: z.iso.datetime(),
  tags: z.array(z.string()),
  isPatchNotes: z.boolean(),
});

/** The fields of a post that `list` reports. */
export interface PostSummary {
  /** Steam's id for the post, stable across reads. */
  gid: string;
  /** The post's title. */
  title: string;
  /** Where the post can be read. */
  url: string;
  /** Steam's internal feed name, e.g. `steam_community_announcements`. */
  feedName: string;
  /** The feed's display label, e.g. `Community Announcements`. */
  feedLabel: string;
  /** ISO-8601 time Steam dates the post. */
  publishedAt: string;
  /** Steam's tags for the post; empty when it has none. */
  tags: string[];
  /** Whether the post carries Steam's `patchnotes` tag. */
  isPatchNotes: boolean;
}

const _PostSummaryMatch: Same<
  z.infer<typeof PostSummarySchema>,
  PostSummary
> = true;

const PostSchema = PostSummarySchema.extend({
  isExternalUrl: z.boolean(),
  author: z.string().optional(),
  contents: z.string(),
  feedType: z.number().int(),
  isNew: z.boolean(),
});

/** One news post as stored in a version of the `news` resource. */
export interface Post extends PostSummary {
  /** Whether `url` points outside Steam's own news pages. */
  isExternalUrl: boolean;
  /**
   * The author Steam names, kept only with includeAuthor; versions recorded
   * before 2026.10.30.1 hold it always, empty when Steam named none.
   */
  author?: string;
  /** The post's body, cut to the requested maximum length by Steam. */
  contents: string;
  /** Steam's feed type number. */
  feedType: number;
  /** Whether the previous recorded version lacked this post's gid. */
  isNew: boolean;
}

const _PostMatch: Same<z.infer<typeof PostSchema>, Post> = true;

const NewsSchema = z.object({
  appId: z.number().int().positive(),
  fetchedAt: z.iso.datetime(),
  totalPosts: z.number().int().nonnegative(),
  previousFetchedAt: z.iso.datetime().nullable(),
  newCount: z.number().int().nonnegative(),
  newGids: z.array(z.string()),
  posts: z.array(PostSchema),
});

/** One read of an app's news, as stored in one version of the `news` resource. */
export interface News {
  /** Steam app id the posts belong to. */
  appId: number;
  /** ISO-8601 time the posts were read. */
  fetchedAt: string;
  /** How many posts Steam holds for the app in all, beyond the ones read. */
  totalPosts: number;
  /** When the previous version was read, or null when this is the first. */
  previousFetchedAt: string | null;
  /** How many posts are new since the previous version. */
  newCount: number;
  /** The gids of the new posts, newest first. */
  newGids: string[];
  /** The posts read, newest first. */
  posts: Post[];
}

const _NewsMatch: Same<z.infer<typeof NewsSchema>, News> = true;

const FilterSchema = z.object({
  patchNotesOnly: z.boolean(),
  feedName: z.string().nullable(),
  tag: z.string().nullable(),
  since: z.iso.datetime().nullable(),
  limit: z.number().int().positive().nullable(),
});

/** The filter a listing was made with; null means that filter was not applied. */
export interface Filter {
  /** Only posts tagged `patchnotes` were kept. */
  patchNotesOnly: boolean;
  /** Only posts of this feed name were kept. */
  feedName: string | null;
  /** Only posts carrying this tag were kept. */
  tag: string | null;
  /** Only posts dated at or after this ISO-8601 time were kept. */
  since: string | null;
  /** At most this many posts were listed. */
  limit: number | null;
}

const _FilterMatch: Same<z.infer<typeof FilterSchema>, Filter> = true;

const ListingSchema = z.object({
  appId: z.number().int().positive(),
  filter: FilterSchema,
  recordedPosts: z.number().int().nonnegative(),
  matched: z.number().int().nonnegative(),
  byFeed: z.record(z.string(), z.number().int().positive()),
  newestAt: z.iso.datetime().nullable(),
  oldestAt: z.iso.datetime().nullable(),
  posts: z.array(PostSummarySchema),
  listedAt: z.iso.datetime(),
});

/** The posts recorded for an app that match a filter. */
export interface Listing {
  /** Steam app id the posts belong to. */
  appId: number;
  /** The filter applied. */
  filter: Filter;
  /** Distinct posts across every recorded version, before filtering. */
  recordedPosts: number;
  /** Posts that matched the filter, before the limit. */
  matched: number;
  /** Matched posts per feed label. */
  byFeed: Record<string, number>;
  /** Date of the newest matched post, or null when nothing matched. */
  newestAt: string | null;
  /** Date of the oldest matched post, or null when nothing matched. */
  oldestAt: string | null;
  /** The matched posts, newest first, cut to the limit. */
  posts: PostSummary[];
  /** ISO-8601 time the listing was written. */
  listedAt: string;
}

const _ListingMatch: Same<z.infer<typeof ListingSchema>, Listing> = true;

const FetchArgsSchema = z.object({
  count: z.number().int().min(1).max(MAX_COUNT).optional().describe(
    "How many of the newest posts to read, 1 to 100; 10 when omitted",
  ),
  maxLength: z.number().int().nonnegative().optional().describe(
    "Cut each post's contents to this many characters; 0 or omitted keeps the full contents",
  ),
  includeAuthor: z.boolean().optional().describe(
    "Keep each post's author, which names a person; left out when omitted",
  ),
});

/** Arguments of the `fetch` method. */
export interface FetchArgs {
  /** How many of the newest posts to read. */
  count?: number;
  /** Cut each post's contents to this many characters; 0 keeps them whole. */
  maxLength?: number;
  /** Keep each post's author. */
  includeAuthor?: boolean;
}

const _FetchArgsMatch: Same<z.infer<typeof FetchArgsSchema>, FetchArgs> = true;

const ListArgsSchema = z.object({
  patchNotesOnly: z.boolean().optional().describe(
    "Only list posts Steam tags as patch notes",
  ),
  feedName: z.string().min(1).optional().describe(
    "Only list posts of this feed name, e.g. steam_community_announcements",
  ),
  tag: z.string().min(1).optional().describe(
    "Only list posts carrying this Steam tag",
  ),
  since: z.string().pipe(z.iso.datetime()).optional().describe(
    "Only list posts dated at or after this ISO-8601 time; every post when omitted",
  ),
  limit: z.number().int().positive().optional().describe(
    "List at most this many of the newest matches; all when omitted",
  ),
});

/** Arguments of the `list` method. */
export interface ListArgs {
  /** Only posts tagged `patchnotes`. */
  patchNotesOnly?: boolean;
  /** Only posts of this feed name. */
  feedName?: string;
  /** Only posts carrying this tag. */
  tag?: string;
  /** Only posts dated at or after this ISO-8601 time. */
  since?: string;
  /** At most this many of the newest matches. */
  limit?: number;
}

const _ListArgsMatch: Same<z.infer<typeof ListArgsSchema>, ListArgs> = true;

const RawItemSchema = z.object({
  gid: z.string().min(1),
  title: z.string(),
  url: z.string(),
  is_external_url: z.boolean().optional(),
  author: z.string().optional(),
  contents: z.string().optional(),
  feedlabel: z.string().optional(),
  date: z.number().int().nonnegative(),
  feedname: z.string().optional(),
  feed_type: z.number().int().optional(),
  tags: z.array(z.string()).optional(),
});

const RawNewsSchema = z.object({
  appnews: z.object({
    newsitems: z.array(RawItemSchema),
    count: z.number().int().nonnegative().optional(),
  }),
});

/** What one read of Steam returns: the posts, without novelty, and Steam's total. */
export interface FetchedNews {
  /** The posts Steam returned, newest first. */
  posts: Omit<Post, "isNew">[];
  /** How many posts Steam holds for the app in all. */
  totalPosts: number;
}

// ---------------------------------------------------------------------------
// Transport and normalization for news and find
// ---------------------------------------------------------------------------

/** Options of one GetNewsForApp request. */
export interface PageRequest {
  /** Posts to ask for. */
  count: number;
  /** Longest body to ask for; 0 asks for the full body. */
  maxLength: number;
  /** Feed names to ask for and to keep. Empty asks for every feed. */
  feeds: string[];
  /** Only posts at or before this Unix second. */
  endDate?: number;
}

/**
 * Reads one page of the app's news, newest first. The Web API ignores a feed
 * name it does not know and answers with every feed, so the feed filter is
 * applied again to what comes back.
 *
 * Throws a SteamNewsError for a failed request, for a status other than 200
 * (Steam answers 403 with `{}` for an unknown app or one without public news),
 * and for an answer without `appnews.newsitems` or with a post that lacks its
 * gid or date.
 */
export async function fetchPage(
  globalArgs: GlobalArgs,
  page: PageRequest,
  signal?: AbortSignal,
): Promise<NewsPage> {
  const authed = globalArgs.webApiKey !== undefined;
  const url = new URL(authed ? AUTHED_URL : NEWS_URL);
  url.searchParams.set("appid", String(globalArgs.appId));
  url.searchParams.set("count", String(page.count));
  url.searchParams.set("maxlength", String(page.maxLength));
  if (page.feeds.length > 0) {
    url.searchParams.set("feeds", page.feeds.join(","));
  }
  if (page.endDate !== undefined) {
    url.searchParams.set("enddate", String(page.endDate));
  }
  const headers: Record<string, string> = { Accept: "application/json" };
  // The key goes in a header, never the URL, so it stays out of logs that
  // record the request line. The Web API documents x-webapi-key for this.
  if (authed) headers["x-webapi-key"] = globalArgs.webApiKey as string;

  const label = authed ? "GetNewsForAppAuthed" : "GetNewsForApp";
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  let text: string;
  try {
    response = await fetch(url, { method: "GET", headers, signal: combined });
    text = await response.text();
  } catch (error) {
    // A cancelled run stays a cancellation; anything else, a request that
    // outlived the timeout included, is the network.
    if (signal?.aborted) throw error;
    throw new SteamNewsError(
      `${label} for app ${globalArgs.appId}: request failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      0,
    );
  }
  if (!response.ok) {
    const hint = STATUS_HINTS[response.status];
    const body = text.trim();
    const detail = body === "" || body === "{}"
      ? ""
      : `: ${body.slice(0, 200)}`;
    throw new SteamNewsError(
      `${label} for app ${globalArgs.appId}: ${response.status}` +
        (hint === undefined ? "" : ` (${hint})`) + detail,
      response.status,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SteamNewsError(`${label}: the answer was not JSON`, 0);
  }
  const appnews = isRecord(parsed) ? parsed.appnews : undefined;
  if (!isRecord(appnews) || !Array.isArray(appnews.newsitems)) {
    throw new SteamNewsError(
      `${label}: the answer had no appnews.newsitems`,
      0,
    );
  }
  const wanted = new Set(page.feeds);
  for (const raw of appnews.newsitems) {
    // find decides whether its window is covered from post dates and drops
    // repeats by gid, so a post without either cannot be trusted.
    if (
      !isRecord(raw) || asInteger(raw.date) === undefined ||
      (typeof raw.gid !== "string" && typeof raw.gid !== "number")
    ) {
      throw new SteamNewsError(`${label}: a post had no gid or date`, 0);
    }
  }
  const items = (appnews.newsitems as Record<string, unknown>[])
    .map(normalizeItem)
    .filter((item) => wanted.size === 0 || wanted.has(item.feedName));
  return {
    items,
    returned: appnews.newsitems.length,
    totalCount: asInteger(appnews.count),
  };
}

/**
 * Turns one post from the API into a NewsItem with its body and author kept.
 * The methods drop those unless asked for.
 */
export function normalizeItem(raw: Record<string, unknown>): NewsItem {
  const dateUnix = asInteger(raw.date) ?? 0;
  const item: NewsItem = {
    gid: String(raw.gid ?? ""),
    title: asString(raw.title) ?? "",
    url: asString(raw.url) ?? "",
    isExternalUrl: raw.is_external_url === true,
    date: new Date(dateUnix * 1000).toISOString(),
    dateUnix,
    feedName: asString(raw.feedname) ?? "",
    feedLabel: asString(raw.feedlabel) ?? "",
    tags: Array.isArray(raw.tags)
      ? raw.tags.filter((tag): tag is string => typeof tag === "string")
      : [],
  };
  const author = asString(raw.author);
  if (author !== undefined) item.author = author;
  const contents = asString(raw.contents);
  if (contents !== undefined) item.contents = contents;
  return item;
}

/**
 * Whether a post matches the text, and where: in the title, in the body, or
 * not at all.
 */
export function matchItem(
  item: NewsItem,
  text: string,
  searchContents: boolean,
  caseSensitive: boolean,
): "title" | "contents" | undefined {
  const fold = (s: string) => caseSensitive ? s : s.toLowerCase();
  const needle = fold(text);
  if (fold(item.title).includes(needle)) return "title";
  if (searchContents && fold(item.contents ?? "").includes(needle)) {
    return "contents";
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : undefined;
}

function unixSeconds(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000);
}

// ---------------------------------------------------------------------------
// Transport and history for fetch and list
// ---------------------------------------------------------------------------

/** The data name an app's news is written under. */
export function newsName(appId: number): string {
  return `app-${appId}`;
}

/** The data name an app's listing is written under. */
export function listingName(appId: number): string {
  return `listing-${appId}`;
}

/**
 * Reads the newest `count` posts of one app from Steam, through
 * GetNewsForAppAuthed with the key in the `x-webapi-key` header when one is
 * given. Throws a specific error for a network failure, a rate limit, an app
 * Steam refuses, or a body that is not the documented shape. The author is
 * kept only when `includeAuthor` is set.
 */
export async function fetchNews(
  fetcher: Fetcher,
  appId: number,
  count: number,
  maxLength: number,
  signal?: AbortSignal,
  options: { webApiKey?: string; includeAuthor?: boolean } = {},
): Promise<FetchedNews> {
  const authed = options.webApiKey !== undefined;
  const url = new URL(authed ? AUTHED_URL : NEWS_URL);
  url.searchParams.set("appid", String(appId));
  url.searchParams.set("count", String(count));
  url.searchParams.set("maxlength", String(maxLength));
  const headers: Record<string, string> = { accept: "application/json" };
  if (authed) headers["x-webapi-key"] = options.webApiKey as string;
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const where = `${
    authed ? "GetNewsForAppAuthed" : "GetNewsForApp"
  } for app ${appId}`;
  let response: Response;
  try {
    response = await fetcher(url.toString(), {
      method: "GET",
      headers,
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
  const text = await response.text();
  if (response.status >= 500) {
    throw new Error(
      `${where}: Steam is unavailable (HTTP ${response.status}), a transient failure, retry later: ${
        text.slice(0, 200)
      }`,
    );
  }
  if (response.status >= 400) {
    throw new Error(
      `${where}: Steam refused the request (HTTP ${response.status}); ` +
        `check that the app id exists on Steam` +
        (authed ? " and the key owns it" : "") + `: ${text.slice(0, 200)}`,
    );
  }
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
  const parsed = RawNewsSchema.safeParse(body);
  if (!response.ok || !parsed.success) {
    throw new Error(
      `${where}: HTTP ${response.status}, unexpected response ${
        text.slice(0, 200)
      }`,
    );
  }
  const items = parsed.data.appnews.newsitems;
  const posts = items.map((item) => {
    const tags = item.tags ?? [];
    const post: Omit<Post, "isNew"> = {
      gid: item.gid,
      title: item.title,
      url: item.url,
      feedName: item.feedname ?? "",
      feedLabel: item.feedlabel ?? "",
      publishedAt: new Date(item.date * 1000).toISOString(),
      tags,
      isPatchNotes: tags.includes(PATCH_NOTES_TAG),
      isExternalUrl: item.is_external_url ?? false,
      contents: item.contents ?? "",
      feedType: item.feed_type ?? 0,
    };
    if (options.includeAuthor) post.author = item.author ?? "";
    return post;
  });
  return { posts, totalPosts: parsed.data.appnews.count ?? posts.length };
}

/** A stored `news` version that parsed, with its version number. */
export interface RecordedNews {
  /** The record's version number. */
  version: number;
  /** The record's content. */
  news: News;
}

/**
 * Parses query results into recorded news of one app, oldest version first,
 * and counts the records that are not news of that app.
 */
export function parseRecorded(
  appId: number,
  records: readonly unknown[],
): { recorded: RecordedNews[]; skipped: number } {
  const recorded: RecordedNews[] = [];
  let skipped = 0;
  for (const record of records) {
    const fields = record !== null && typeof record === "object"
      ? record as Partial<DataRecord>
      : undefined;
    const parsed = NewsSchema.safeParse(fields?.attributes);
    if (
      !parsed.success || parsed.data.appId !== appId ||
      typeof fields?.version !== "number"
    ) {
      skipped += 1;
      continue;
    }
    recorded.push({ version: fields.version, news: parsed.data });
  }
  recorded.sort((a, b) => a.version - b.version);
  return { recorded, skipped };
}

/**
 * Marks each fetched post new when the previous version's posts lack its gid.
 * Every post is new when there is no previous version.
 */
export function markNew(
  appId: number,
  fetched: FetchedNews,
  previous: News | null,
  fetchedAt: string,
): News {
  const seen = new Set(previous?.posts.map((post) => post.gid) ?? []);
  const posts = fetched.posts.map((post) => ({
    ...post,
    isNew: !seen.has(post.gid),
  }));
  const newGids = posts.filter((post) => post.isNew).map((post) => post.gid);
  return {
    appId,
    fetchedAt,
    totalPosts: fetched.totalPosts,
    previousFetchedAt: previous?.fetchedAt ?? null,
    newCount: newGids.length,
    newGids,
    posts,
  };
}

/**
 * Lists the distinct posts across recorded versions that match a filter,
 * newest first. A post recorded in several versions is taken from the latest.
 */
export function listPosts(
  appId: number,
  recorded: readonly RecordedNews[],
  args: ListArgs,
  listedAt: string,
): Listing {
  const byGid = new Map<string, Post>();
  for (const { news } of [...recorded].sort((a, b) => a.version - b.version)) {
    for (const post of news.posts) {
      byGid.set(post.gid, post);
    }
  }
  const sinceMs = args.since === undefined ? -Infinity : Date.parse(args.since);
  const matches = [...byGid.values()]
    .filter((post) =>
      (!args.patchNotesOnly || post.isPatchNotes) &&
      (args.feedName === undefined || post.feedName === args.feedName) &&
      (args.tag === undefined || post.tags.includes(args.tag)) &&
      Date.parse(post.publishedAt) >= sinceMs
    )
    .sort((a, b) =>
      Date.parse(b.publishedAt) - Date.parse(a.publishedAt) ||
      b.gid.localeCompare(a.gid)
    );
  const byFeed: Record<string, number> = {};
  for (const post of matches) {
    const label = post.feedLabel || post.feedName || "unknown";
    byFeed[label] = (byFeed[label] ?? 0) + 1;
  }
  const listed = args.limit === undefined
    ? matches
    : matches.slice(0, args.limit);
  return {
    appId,
    filter: {
      patchNotesOnly: args.patchNotesOnly ?? false,
      feedName: args.feedName ?? null,
      tag: args.tag ?? null,
      since: args.since ?? null,
      limit: args.limit ?? null,
    },
    recordedPosts: byGid.size,
    matched: matches.length,
    byFeed,
    newestAt: matches[0]?.publishedAt ?? null,
    oldestAt: matches[matches.length - 1]?.publishedAt ?? null,
    posts: listed.map((post) => ({
      gid: post.gid,
      title: post.title,
      url: post.url,
      feedName: post.feedName,
      feedLabel: post.feedLabel,
      publishedAt: post.publishedAt,
      tags: post.tags,
      isPatchNotes: post.isPatchNotes,
    })),
    listedAt,
  };
}

/** Reads every recorded version of the instance's news, or throws without queryData. */
async function readRecorded(
  method: string,
  context: MethodContext,
): Promise<RecordedNews[]> {
  const { globalArgs, logger } = context;
  if (context.queryData === undefined) {
    throw new Error(
      `${method} needs swamp's queryData to read the recorded news; upgrade swamp`,
    );
  }
  const predicate = `modelId == ${JSON.stringify(context.modelId)} && ` +
    `specName == "news" && name == ${
      JSON.stringify(newsName(globalArgs.appId))
    } && version >= 0`;
  const { recorded, skipped } = parseRecorded(
    globalArgs.appId,
    await context.queryData(predicate),
  );
  if (skipped > 0) {
    logger.warning(
      "Skipped {skipped} stored records that are not news of app {appId}",
      { skipped, appId: globalArgs.appId },
    );
  }
  return recorded;
}

// ---------------------------------------------------------------------------
// Behavior
// ---------------------------------------------------------------------------

/**
 * The Steam news behavior: `news` lists posts and `find` checks one went out;
 * `fetch` records posts over time and `list` filters what was recorded.
 */
export const behavior = {
  // String literals, not constants: the registry catalog reads them from the
  // source.
  type: "@reset/steam-news",
  version: "2026.10.30.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    posts: {
      description:
        "The newest posts of the app's news, with the feeds and count they were read with",
      schema: PostsResourceSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    find: {
      description:
        "Whether a post naming the text went out since the date, the matches, and whether the whole window was searched",
      schema: FindResourceSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    news: {
      description:
        "One read of an app's newest news posts, each flagged new or seen; every read is a new version",
      schema: NewsSchema,
      lifetime: "infinite",
      garbageCollection: "365d",
    },
    listing: {
      description:
        "The recorded posts of an app that match a filter, newest first, with a count per feed",
      schema: ListingSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    news: {
      description:
        "List the app's newest posts, optionally only some feeds and only before a time. Bodies and authors are kept only when asked for. Writes posts.",
      arguments: NewsArgsSchema,
      execute: async (
        args: NewsArgs,
        context: MethodContext,
      ): Promise<MethodResult> => {
        const { globalArgs, signal, logger } = context;
        const feeds = args.feeds ?? [];
        logger.info("Reading {count} posts of app {appId}, feeds {feeds}", {
          count: args.count,
          appId: globalArgs.appId,
          feeds: feeds.length === 0 ? "all" : feeds.join(","),
        });
        const page = await fetchPage(
          globalArgs,
          {
            count: args.count,
            // A body that is not kept is asked for as a one-character blurb.
            maxLength: args.includeContents ? args.maxLength : 1,
            feeds,
            endDate: args.before === undefined
              ? undefined
              : unixSeconds(args.before),
          },
          signal,
        );
        if (page.returned > page.items.length) {
          logger.warning(
            "{dropped} posts came from feeds not asked for; is a feed name misspelled?",
            { dropped: page.returned - page.items.length },
          );
        }
        const items = page.items.map((item) => {
          const kept: NewsItem = { ...item };
          if (!args.includeContents) delete kept.contents;
          if (!args.includeAuthor) delete kept.author;
          return kept;
        });
        const truncated = page.totalCount === undefined
          ? page.returned >= args.count
          : items.length < page.totalCount;
        const handle = await context.writeResource("posts", "posts", {
          fetchedAt: new Date().toISOString(),
          appId: globalArgs.appId,
          authed: globalArgs.webApiKey !== undefined,
          feeds,
          before: args.before,
          requested: args.count,
          count: items.length,
          totalCount: page.totalCount,
          truncated,
          items,
        });
        logger.info("Read {count} posts (truncated={truncated})", {
          count: items.length,
          truncated,
        });
        return { dataHandles: [handle] };
      },
    },
    find: {
      description:
        "Check whether a post whose title (or body, with searchContents) contains the text was published since a time, paging back up to 1,000 posts. Writes find, with complete false when the window could not be searched to its start.",
      arguments: FindArgsSchema,
      execute: async (
        args: FindArgs,
        context: MethodContext,
      ): Promise<MethodResult> => {
        const { globalArgs, signal, logger } = context;
        const feeds = args.feeds ?? [];
        const since = unixSeconds(args.since);
        logger.info(
          "Looking for {text} in posts of app {appId} since {since}, feeds {feeds}",
          {
            text: args.text,
            appId: globalArgs.appId,
            since: args.since,
            feeds: feeds.length === 0 ? "all" : feeds.join(","),
          },
        );
        const seen = new Set<string>();
        const matches: Match[] = [];
        let searched = 0;
        let pagesFetched = 0;
        let complete = false;
        let endDate: number | undefined;
        while (pagesFetched < MAX_PAGES) {
          const page = await fetchPage(
            globalArgs,
            {
              count: MAX_COUNT,
              maxLength: args.searchContents ? 0 : 1,
              feeds,
              endDate,
            },
            signal,
          );
          pagesFetched++;
          let oldest: number | undefined;
          let fresh = 0;
          for (const item of page.items) {
            oldest = oldest === undefined
              ? item.dateUnix
              : Math.min(oldest, item.dateUnix);
            // enddate is inclusive, so a page repeats the previous page's
            // oldest second; the gid set drops the repeat.
            if (seen.has(item.gid)) continue;
            seen.add(item.gid);
            fresh++;
            if (item.dateUnix < since) continue;
            searched++;
            const where = matchItem(
              item,
              args.text,
              args.searchContents,
              args.caseSensitive,
            );
            if (where !== undefined) {
              matches.push({
                gid: item.gid,
                title: item.title,
                url: item.url,
                date: item.date,
                feedName: item.feedName,
                inTitle: where === "title",
              });
            }
          }
          logger.debug("Page {page}: {returned} posts, {fresh} new", {
            page: pagesFetched,
            returned: page.returned,
            fresh,
          });
          // The window is covered once a post older than its start was seen,
          // or the feed ran out.
          if (
            (oldest !== undefined && oldest < since) ||
            page.returned < MAX_COUNT
          ) {
            complete = true;
            break;
          }
          if (fresh === 0 || oldest === undefined) {
            // A full page with nothing new: more posts share one second
            // than a page holds. Stop rather than loop.
            break;
          }
          endDate = oldest;
        }
        if (!complete) {
          logger.warning(
            "Searched {searched} posts in {pages} pages without reaching {since}; found={found} covers only those",
            {
              searched,
              pages: pagesFetched,
              since: args.since,
              found: matches.length > 0,
            },
          );
        }
        const handle = await context.writeResource("find", "find", {
          fetchedAt: new Date().toISOString(),
          appId: globalArgs.appId,
          authed: globalArgs.webApiKey !== undefined,
          text: args.text,
          since: args.since,
          feeds,
          searchContents: args.searchContents,
          caseSensitive: args.caseSensitive,
          found: matches.length > 0,
          matchCount: matches.length,
          matches,
          searched,
          pagesFetched,
          complete,
        });
        logger.info("Found {matches} matching posts among {searched}", {
          matches: matches.length,
          searched,
        });
        return { dataHandles: [handle] };
      },
    },
    fetch: {
      description:
        "Read the app's newest news posts from Steam's Web API and record them as a new version, flagging the new ones",
      arguments: FetchArgsSchema,
      execute: async (
        args: FetchArgs & Injected,
        context: MethodContext,
      ): Promise<MethodResult> => {
        const { globalArgs, logger } = context;
        const fetcher = args._fetch ?? globalThis.fetch;
        const now = args._now ?? (() => new Date());
        const recorded = await readRecorded("fetch", context);
        const previous = recorded[recorded.length - 1]?.news ?? null;
        logger.info("Reading the news of app {appId}", {
          appId: globalArgs.appId,
        });
        const fetched = await fetchNews(
          fetcher,
          globalArgs.appId,
          args.count ?? DEFAULT_COUNT,
          args.maxLength ?? 0,
          context.signal,
          {
            webApiKey: globalArgs.webApiKey,
            includeAuthor: args.includeAuthor ?? false,
          },
        );
        const data = markNew(
          globalArgs.appId,
          fetched,
          previous,
          now().toISOString(),
        );
        const handle = await context.writeResource(
          "news",
          newsName(globalArgs.appId),
          { ...data },
        );
        logger.info(
          "App {appId}: read {posts} posts, {newCount} new since the previous read",
          {
            appId: globalArgs.appId,
            posts: data.posts.length,
            newCount: data.newCount,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    list: {
      description:
        "List the recorded posts that match a filter (patch notes, feed, tag, since), newest first, with a count per feed",
      arguments: ListArgsSchema,
      execute: async (
        args: ListArgs & Injected,
        context: MethodContext,
      ): Promise<MethodResult> => {
        const { globalArgs, logger } = context;
        const now = args._now ?? (() => new Date());
        logger.info("Reading the recorded news of app {appId}", {
          appId: globalArgs.appId,
        });
        const recorded = await readRecorded("list", context);
        if (recorded.length === 0) {
          throw new Error(
            `No news of app ${globalArgs.appId} recorded; run the fetch method first`,
          );
        }
        const data = listPosts(
          globalArgs.appId,
          recorded,
          args,
          now().toISOString(),
        );
        const handle = await context.writeResource(
          "listing",
          listingName(globalArgs.appId),
          { ...data },
        );
        logger.info(
          "Listed {listed} of {matched} matching posts of app {appId}, from {recordedPosts} recorded",
          {
            listed: data.posts.length,
            matched: data.matched,
            appId: globalArgs.appId,
            recordedPosts: data.recordedPosts,
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
        "Joins the two lines of this extension: instances made on 2026.10.21.1 (news, find) and on 2026.10.22.x (fetch, list) keep their appId and optional webApiKey as written, and every method is available to both",
      upgradeAttributes: (old: Record<string, unknown>): Record<
        string,
        unknown
      > => old,
    },
  ],
};
