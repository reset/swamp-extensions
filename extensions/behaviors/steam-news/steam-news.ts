/**
 * A Swamp behavior for a Steam app's news feed, read through the Steam Web
 * API's documented ISteamNews/GetNewsForApp (public, no key) or
 * GetNewsForAppAuthed (publisher key, which also answers for an app that is not
 * released yet). It lists the newest posts and checks whether a post naming a
 * given text, such as a release's version, went out since a date: the check a
 * studio makes after promoting a build, that its patch notes announcement is
 * live on the store. Every method writes what it read as a resource, so a
 * workflow can assert on it with CEL. Post authors are not kept unless asked
 * for, and post bodies only when asked for.
 *
 * @module
 */

import { z } from "npm:zod@4";

const PUBLIC_URL = "https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/";
const AUTHED_URL =
  "https://partner.steam-api.com/ISteamNews/GetNewsForAppAuthed/v2/";

/** Most posts one request asks for. */
const MAX_COUNT = 100;
/** Most requests `find` makes while paging back to its start date. */
const MAX_PAGES = 10;

/** What a status code means when the answer carries no message of its own. */
const STATUS_HINTS: Record<number, string> = {
  401: "the publisher key was refused",
  403: "the app is unknown, has no public news, or the key does not own it",
  429: "rate limited by the Web API; try again later",
};

// ---------------------------------------------------------------------------
// Public types
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

/** One news post as the resources keep it. */
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
// Schemas (private: the exported interfaces above are the public types, and
// `satisfies` keeps each schema in step with its interface)
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  appId: z
    .number()
    .int()
    .positive()
    .describe("The Steam AppID whose news is read."),
  webApiKey: z
    .string()
    .min(1)
    .optional()
    .meta({ sensitive: true })
    .describe(
      "Steamworks Web API publisher key. When set, GetNewsForAppAuthed is called, so an unreleased app answers.",
    ),
}) satisfies z.ZodType<GlobalArgs>;

const FeedsSchema = z
  .array(z.string().min(1))
  .optional()
  .describe(
    "Feed names to keep, such as steam_community_announcements. Empty keeps every feed.",
  );

const NewsArgsSchema = z.object({
  count: z
    .number()
    .int()
    .min(1)
    .max(MAX_COUNT)
    .default(20)
    .describe("How many of the newest posts to read, 1 to 100."),
  feeds: FeedsSchema,
  before: z.iso
    .datetime({ offset: true })
    .optional()
    .describe("Only posts at or before this ISO-8601 time."),
  maxLength: z
    .number()
    .int()
    .min(0)
    .default(300)
    .describe("Longest body to keep, in characters; 0 keeps the full body."),
  includeContents: z
    .boolean()
    .default(false)
    .describe("Keep each post's body or the blurb Steam generates."),
  includeAuthor: z
    .boolean()
    .default(false)
    .describe("Keep each post's author, which names a person."),
}) satisfies z.ZodType<NewsArgs>;

const FindArgsSchema = z.object({
  text: z
    .string()
    .min(1)
    .describe(
      "Text a matching post's title, or body with searchContents, contains.",
    ),
  since: z.iso
    .datetime({ offset: true })
    .describe("Only posts published at or after this ISO-8601 time."),
  feeds: FeedsSchema,
  searchContents: z
    .boolean()
    .default(false)
    .describe("Also search each post's full body, not only its title."),
  caseSensitive: z
    .boolean()
    .default(false)
    .describe("Match case exactly."),
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

const NewsResourceSchema = z.object({
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
// Transport and normalization
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
  const url = new URL(authed ? AUTHED_URL : PUBLIC_URL);
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
  let response: Response;
  let text: string;
  try {
    response = await fetch(url, { method: "GET", headers, signal });
    text = await response.text();
  } catch (error) {
    // A cancelled run stays a cancellation; anything else is the network.
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
// Behavior
// ---------------------------------------------------------------------------

/** The Steam news behavior: `news` lists posts, `find` checks one went out. */
export const behavior = {
  // String literals, not constants: the registry catalog reads them from the
  // source.
  type: "@reset/steam-news",
  version: "2026.10.21.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    news: {
      description: "The newest posts of the app's news, with the feeds and " +
        "count they were read with",
      schema: NewsResourceSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    find: {
      description: "Whether a post naming the text went out since the date, " +
        "the matches, and whether the whole window was searched",
      schema: FindResourceSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    news: {
      description: "List the app's newest posts, optionally only some feeds " +
        "and only before a time. Bodies and authors are kept only when " +
        "asked for. Writes news.",
      arguments: NewsArgsSchema,
      execute: async (
        args: NewsArgs,
        context: Context,
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
        const handle = await context.writeResource("news", "news", {
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
      description: "Check whether a post whose title (or body, with " +
        "searchContents) contains the text was published since a time, " +
        "paging back up to 1,000 posts. Writes find, with complete false " +
        "when the window could not be searched to its start.",
      arguments: FindArgsSchema,
      execute: async (
        args: FindArgs,
        context: Context,
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
  },
};
