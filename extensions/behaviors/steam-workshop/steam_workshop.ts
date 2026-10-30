/**
 * Records a Steam Workshop item's public statistics over time and summarises
 * the history. `sample` reads Steam's public, keyless Web API method
 * `ISteamRemoteStorage/GetPublishedFileDetails/v1` once and writes the item's
 * title, app, creator, creation and update times, subscription, favourite and
 * view counts, file size and tags as a new version of the item's `sample`
 * resource; `summarise` reads every recorded version back and writes the
 * first and latest value of each count, the change between them, and when the
 * item was last updated.
 *
 * No API key or credential is involved: the method is public and answers a
 * form POST. Every request names this extension and its version in its
 * User-Agent. `fetch` is injectable through the `_fetch` method argument so
 * tests never reach Steam.
 *
 * @module
 */

import { z } from "npm:zod@4";

/** This extension's version, sent in the User-Agent of every request. */
export const VERSION = "2026.10.30.1";

/** The User-Agent every request sends: the extension's name and version. */
export const USER_AGENT = `@reset/steam-workshop/${VERSION} (swamp extension)`;

/** The Steam Web API method this behavior reads, with a form POST. */
export const DETAILS_URL =
  "https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/";

/** How long one request to Steam may take before it is abandoned. */
export const REQUEST_TIMEOUT_MS = 15_000;

/** Steam's result code for success, in the response and in each item. */
const RESULT_OK = 1;

/** Steam's result code for an item it has no public record of. */
const RESULT_FILE_NOT_FOUND = 9;

/** `true` only when the zod output type and the hand-written interface describe the same shape. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

const GlobalArgsSchema = z.object({
  itemId: z.string().regex(/^[1-9]\d{0,19}$/).describe(
    "Steam Workshop item id to sample, the id= number in the item's page address, e.g. 104691717",
  ),
});

/** Global arguments of a behavior instance: the one Workshop item it samples. */
export interface GlobalArgs {
  /** Steam Workshop item id (Steam's publishedfileid), as a decimal string. */
  itemId: string;
}

const _GlobalArgsMatch: Same<z.infer<typeof GlobalArgsSchema>, GlobalArgs> =
  true;

const count = () => z.number().int().nonnegative();

const SampleSchema = z.object({
  itemId: z.string().min(1),
  title: z.string(),
  appId: z.number().int().positive(),
  creator: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  subscriptions: count(),
  lifetimeSubscriptions: count(),
  favorited: count(),
  lifetimeFavorited: count(),
  views: count(),
  fileSize: count(),
  tags: z.array(z.string()),
  sampledAt: z.iso.datetime(),
});

/** One recorded reading, as stored in one version of the `sample` resource. */
export interface Sample {
  /** Steam Workshop item id. */
  itemId: string;
  /** The item's title. */
  title: string;
  /** Id of the app the item is for (Steam's consumer_app_id). */
  appId: number;
  /** The SteamID64 of the account that published the item. */
  creator: string;
  /** ISO-8601 time the item was first published. */
  createdAt: string;
  /** ISO-8601 time the item was last updated by its creator. */
  updatedAt: string;
  /** Current subscribers. */
  subscriptions: number;
  /** Everyone who has ever subscribed. */
  lifetimeSubscriptions: number;
  /** Current favourites. */
  favorited: number;
  /** Everyone who has ever favourited it. */
  lifetimeFavorited: number;
  /** Page views. */
  views: number;
  /** Size of the item's content in bytes. */
  fileSize: number;
  /** The item's tags, in Steam's order. */
  tags: string[];
  /** ISO-8601 time the statistics were read. */
  sampledAt: string;
}

const _SampleMatch: Same<z.infer<typeof SampleSchema>, Sample> = true;

/** The fields of a sample that `summarise` reports first, latest and change for. */
export const COUNTS = [
  "subscriptions",
  "lifetimeSubscriptions",
  "favorited",
  "lifetimeFavorited",
  "views",
  "fileSize",
] as const;

/** One of the fields in {@link COUNTS}. */
export type CountName = typeof COUNTS[number];

const ChangeSchema = z.object({
  first: z.number(),
  latest: z.number(),
  change: z.number(),
});

/** One count across the summarised samples. */
export interface Change {
  /** Its value in the earliest summarised sample. */
  first: number;
  /** Its value in the most recent summarised sample. */
  latest: number;
  /** `latest` minus `first`. */
  change: number;
}

const _ChangeMatch: Same<z.infer<typeof ChangeSchema>, Change> = true;

const ChangesSchema = z.object({
  subscriptions: ChangeSchema,
  lifetimeSubscriptions: ChangeSchema,
  favorited: ChangeSchema,
  lifetimeFavorited: ChangeSchema,
  views: ChangeSchema,
  fileSize: ChangeSchema,
});

/** Every count's first, latest and change. */
export type Changes = Record<CountName, Change>;

const _ChangesMatch: Same<z.infer<typeof ChangesSchema>, Changes> = true;

const SummarySchema = z.object({
  itemId: z.string().min(1),
  title: z.string(),
  appId: z.number().int().positive(),
  samples: z.number().int().positive(),
  since: z.iso.datetime().nullable(),
  firstSampledAt: z.iso.datetime(),
  latestSampledAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  updatedSinceFirst: z.boolean(),
  changes: ChangesSchema,
  summarisedAt: z.iso.datetime(),
});

/** The summary of an item's recorded samples. */
export interface Summary {
  /** Steam Workshop item id. */
  itemId: string;
  /** The item's title in the most recent sample. */
  title: string;
  /** The item's app in the most recent sample. */
  appId: number;
  /** How many samples were summarised. */
  samples: number;
  /** The lower bound on recording time, or null when every sample counted. */
  since: string | null;
  /** When the earliest summarised sample was recorded. */
  firstSampledAt: string;
  /** When the most recent summarised sample was recorded. */
  latestSampledAt: string;
  /** When the item was first published, from the most recent sample. */
  createdAt: string;
  /** When the item was last updated, from the most recent sample. */
  updatedAt: string;
  /** Whether that update time differs from the earliest summarised sample's. */
  updatedSinceFirst: boolean;
  /** Each count's first and latest value and the change. */
  changes: Changes;
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

/** The subset of `fetch` the `sample` method uses. Tests replace it. */
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

/** The data name an item's samples are written under. */
export function sampleName(itemId: string): string {
  return `item-${itemId}`;
}

/** The data name an item's summary is written under. */
export function summaryName(itemId: string): string {
  return `summary-${itemId}`;
}

/** The form body `sample` posts for one item. */
export function detailsForm(itemId: string): URLSearchParams {
  return new URLSearchParams({ itemcount: "1", "publishedfileids[0]": itemId });
}

/** A field as an object's properties, or undefined when it is not an object. */
function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * A count as Steam sends it, a non-negative integer or a decimal string of one
 * (Steam sends `file_size` as a string), or undefined when it is neither or is
 * past the largest integer a number holds exactly.
 */
export function parseCount(value: unknown): number | undefined {
  let parsed: number;
  if (typeof value === "number") {
    parsed = value;
  } else if (typeof value === "string" && /^\d+$/.test(value)) {
    parsed = Number(value);
  } else {
    return undefined;
  }
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/** A Unix time in seconds as an ISO-8601 string, or undefined when it is not one. */
export function parseUnixTime(value: unknown): string | undefined {
  const seconds = parseCount(value);
  return seconds === undefined
    ? undefined
    : new Date(seconds * 1000).toISOString();
}

/**
 * Reads one Workshop item's public details from Steam. Throws a specific error
 * for a network failure, a rate limit, a server error, an item Steam has no
 * public record of, or a body that is not the documented shape.
 */
export async function fetchDetails(
  fetcher: Fetcher,
  itemId: string,
  sampledAt: string,
  signal?: AbortSignal,
): Promise<Sample> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const where = `GetPublishedFileDetails for item ${itemId}`;
  let response: Response;
  try {
    response = await fetcher(DETAILS_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": USER_AGENT,
      },
      body: detailsForm(itemId).toString(),
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
  const envelope = asObject(asObject(body)?.response);
  const list = envelope?.publishedfiledetails;
  if (
    !response.ok || envelope?.result !== RESULT_OK || !Array.isArray(list) ||
    list.length !== 1
  ) {
    throw new Error(
      `${where}: HTTP ${response.status}, no single "response.publishedfiledetails" entry in ${
        text.slice(0, 200)
      }`,
    );
  }
  const item = asObject(list[0]);
  if (item?.publishedfileid !== itemId) {
    throw new Error(
      `${where}: HTTP ${response.status}, Steam answered for another item: ${
        JSON.stringify(list[0]).slice(0, 200)
      }`,
    );
  }
  if (item.result === RESULT_FILE_NOT_FOUND) {
    throw new Error(
      `${where}: Steam has no public Workshop item with this id (result 9); check the id, and that the item is public and not removed`,
    );
  }
  if (item.result !== RESULT_OK) {
    throw new Error(
      `${where}: Steam refused the item with result ${
        JSON.stringify(item.result)
      }`,
    );
  }
  const unexpected = (field: string): Error =>
    new Error(
      `${where}: HTTP ${response.status}, unexpected ${field}: ${
        JSON.stringify(item[field]) ?? "missing"
      }`,
    );
  const counted = (field: string): number => {
    const value = parseCount(item[field]);
    if (value === undefined) throw unexpected(field);
    return value;
  };
  const timed = (field: string): string => {
    const value = parseUnixTime(item[field]);
    if (value === undefined) throw unexpected(field);
    return value;
  };
  const stringField = (field: string): string => {
    const value = item[field];
    if (typeof value !== "string") throw unexpected(field);
    return value;
  };
  const appId = counted("consumer_app_id");
  if (appId === 0) throw unexpected("consumer_app_id");
  const rawTags = item.tags ?? [];
  if (!Array.isArray(rawTags)) throw unexpected("tags");
  const tags: string[] = [];
  for (const entry of rawTags) {
    const tag = asObject(entry)?.tag;
    if (typeof tag !== "string") throw unexpected("tags");
    tags.push(tag);
  }
  return {
    itemId,
    title: stringField("title"),
    appId,
    creator: stringField("creator"),
    createdAt: timed("time_created"),
    updatedAt: timed("time_updated"),
    subscriptions: counted("subscriptions"),
    lifetimeSubscriptions: counted("lifetime_subscriptions"),
    favorited: counted("favorited"),
    lifetimeFavorited: counted("lifetime_favorited"),
    views: counted("views"),
    fileSize: counted("file_size"),
    tags,
    sampledAt,
  };
}

/**
 * Summarises samples: each count's first and latest value and the change, and
 * when the item was last updated. Throws when there are no samples.
 */
export function summarise(
  itemId: string,
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
    throw new Error(`No samples to summarise for item ${itemId}`);
  }
  const change = (name: CountName): Change => ({
    first: first[name],
    latest: latest[name],
    change: latest[name] - first[name],
  });
  return {
    itemId,
    title: latest.title,
    appId: latest.appId,
    samples: ordered.length,
    since,
    firstSampledAt: first.sampledAt,
    latestSampledAt: latest.sampledAt,
    createdAt: latest.createdAt,
    updatedAt: latest.updatedAt,
    updatedSinceFirst: latest.updatedAt !== first.updatedAt,
    changes: {
      subscriptions: change("subscriptions"),
      lifetimeSubscriptions: change("lifetimeSubscriptions"),
      favorited: change("favorited"),
      lifetimeFavorited: change("lifetimeFavorited"),
      views: change("views"),
      fileSize: change("fileSize"),
    },
    summarisedAt,
  };
}

/** The Steam Workshop item statistics behavior. */
export const behavior = {
  type: "@reset/steam-workshop",
  version: "2026.10.30.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    sample: {
      description:
        "One Workshop item's public statistics at one moment; every sample is a new version",
      schema: SampleSchema,
      lifetime: "infinite",
      garbageCollection: "365d",
    },
    summary: {
      description:
        "Each count's first and latest value and the change, and when the item was last updated",
      schema: SummarySchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    sample: {
      description:
        "Read the item's public statistics from Steam's Web API and record them as a new version",
      arguments: SampleArgsSchema,
      execute: async (
        args: Injected,
        context: MethodContext,
      ): Promise<MethodResult> => {
        const { globalArgs, logger } = context;
        const fetcher = args._fetch ?? globalThis.fetch;
        const now = args._now ?? (() => new Date());
        logger.info("Reading the statistics of Workshop item {itemId}", {
          itemId: globalArgs.itemId,
        });
        const data = await fetchDetails(
          fetcher,
          globalArgs.itemId,
          now().toISOString(),
          context.signal,
        );
        const handle = await context.writeResource(
          "sample",
          sampleName(globalArgs.itemId),
          { ...data },
        );
        logger.info(
          "Workshop item {itemId} ({title}) has {subscriptions} subscriptions",
          {
            itemId: data.itemId,
            title: data.title,
            subscriptions: data.subscriptions,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    summarise: {
      description:
        "Summarise the recorded samples: each count's first, latest and change, and when the item was last updated",
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
        logger.info("Reading the recorded samples of Workshop item {itemId}", {
          itemId: globalArgs.itemId,
        });
        const name = sampleName(globalArgs.itemId);
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
          if (!parsed.success || parsed.data.itemId !== globalArgs.itemId) {
            skipped += 1;
            continue;
          }
          if (Date.parse(parsed.data.sampledAt) >= sinceMs) {
            samples.push(parsed.data);
          }
        }
        if (skipped > 0) {
          logger.warning(
            "Skipped {skipped} stored samples that are not a sample of item {itemId}",
            { skipped, itemId: globalArgs.itemId },
          );
        }
        if (samples.length === 0) {
          throw new Error(
            `No samples of Workshop item ${globalArgs.itemId} recorded` +
              (since === null ? "" : ` since ${since}`) +
              "; run the sample method first",
          );
        }
        const data = summarise(
          globalArgs.itemId,
          samples,
          since,
          now().toISOString(),
        );
        const handle = await context.writeResource(
          "summary",
          summaryName(globalArgs.itemId),
          { ...data },
        );
        logger.info(
          "Summarised {samples} samples of item {itemId}: {subscriptions} subscriptions, {change} since the first",
          {
            samples: data.samples,
            itemId: data.itemId,
            subscriptions: data.changes.subscriptions.latest,
            change: data.changes.subscriptions.change,
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
