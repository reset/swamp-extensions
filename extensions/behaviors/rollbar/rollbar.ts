/**
 * A Swamp behavior for a Rollbar-compatible crash-reporting API: api.rollbar.com
 * itself, or a service that answers the same item, occurrence and deploy
 * endpoints, such as crashq, with one host change. It lists and reads items and
 * their occurrences, resolves, mutes and assigns items, records and lists
 * deploys, reads the three reports (occurrence counts, activated counts and the
 * top active items) and an item's events, and tests a project's fingerprint
 * rules against one occurrence. Every method writes what it read as a resource,
 * so a workflow can assert on it with CEL. Occurrence resources keep ids,
 * timestamps, versions and the exception class and message only, never the
 * reported payload; report resources keep counts, bucket timestamps, item ids,
 * counters, levels and titles.
 *
 * @module
 */

import { z } from "npm:zod@4";

const DEFAULT_HOST = "https://api.rollbar.com";
const TOKEN_HEADER = "X-Rollbar-Access-Token";
const RETRY_HEADERS = ["X-Rate-Limit-Remaining-Seconds", "Retry-After"];

/** Rollbar lists 100 items per page. */
const ITEMS_PAGE_SIZE = 100;
/** Rollbar lists 20 deploys per page. */
const DEPLOYS_PAGE_SIZE = 20;
/** Rollbar lists 20 occurrences per page unless a limit is given. */
const OCCURRENCES_PAGE_SIZE = 20;
/** Longest exception message, event value or title a resource keeps. */
const MESSAGE_LIMIT = 300;
/** activated_counts answers 2 to 366 daily buckets, 60 by default. */
const ACTIVATED_BUCKETS_MIN = 2;
const ACTIVATED_BUCKETS_MAX = 366;
const ACTIVATED_BUCKETS_DEFAULT = 60;
/** top_active_items looks back 1 to 168 hours, 24 by default. */
const TOP_HOURS_MIN = 1;
const TOP_HOURS_MAX = 168;
const TOP_HOURS_DEFAULT = 24;

const LEVELS = ["debug", "info", "warning", "error", "critical"] as const;
const STATUSES = ["active", "resolved", "muted", "archived"] as const;
const DEPLOY_STATUSES = [
  "started",
  "succeeded",
  "failed",
  "timed_out",
] as const;

/** Rollbar's numeric levels, which older answers still use. */
const LEVEL_NAMES: Record<number, string> = {
  10: "debug",
  20: "info",
  30: "warning",
  40: "error",
  50: "critical",
};

/** What a status code means when the answer carries no message of its own. */
const STATUS_HINTS: Record<number, string> = {
  401: "the token is missing or malformed",
  403: "the token is unknown, disabled or lacks the scope",
  404: "not found, or outside the token's project",
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Global arguments every method reads from the behavior definition. */
export interface GlobalArgs {
  /** Base URL of the API, such as https://api.rollbar.com or a crashq host. */
  host: string;
  /** Project access token, sent as X-Rollbar-Access-Token. Sensitive. */
  token: string;
  /** Default environment filter for items, deploys and reports. A method argument overrides it. */
  environment?: string;
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

/** One item (a grouped error) as the `items` and `item` resources keep it. */
export interface Item {
  /** The item's id, used in URLs. */
  id: number;
  /** The item's counter, the number shown in the project's UI. */
  counter: number;
  /** The item's title. */
  title: string;
  /** Level name: debug, info, warning, error or critical. */
  level: string;
  /** Status: active, resolved, muted or archived. */
  status: string;
  /** Environment the item's occurrences were reported from. */
  environment: string;
  /** Occurrences counted so far. */
  totalOccurrences: number;
  /** Distinct install ids seen, when the API reports it. */
  uniqueOccurrences?: number;
  /** Unix seconds of the first occurrence, when the API reports it. */
  firstOccurrenceTimestamp?: number;
  /** Unix seconds of the last occurrence, when the API reports it. */
  lastOccurrenceTimestamp?: number;
  /** First code version seen, when the API reports it (crashq does). */
  firstVersion?: string;
  /** Last code version seen, when the API reports it (crashq does). */
  lastVersion?: string;
  /** Id of the assigned user, when one is assigned. */
  assignedUserId?: number;
  /** Version the item was resolved in, when one was given. */
  resolvedInVersion?: string;
}

/** The filters an `items` snapshot was taken with. */
export interface ItemFilters {
  /** Status filter, when one was given. */
  status?: string;
  /** Level filter, when one was given. */
  level?: string;
  /** Environment filter, when one was given or set globally. */
  environment?: string;
  /** Search query, when one was given. */
  query?: string;
}

/** Item counts by level, as the `summary` resource keeps them. */
export interface LevelCounts {
  /** Items at level debug. */
  debug: number;
  /** Items at level info. */
  info: number;
  /** Items at level warning. */
  warning: number;
  /** Items at level error. */
  error: number;
  /** Items at level critical. */
  critical: number;
}

/** Item counts by status, as the `summary` resource keeps them. */
export interface StatusCounts {
  /** Active items. */
  active: number;
  /** Resolved items. */
  resolved: number;
  /** Muted items. */
  muted: number;
  /** Archived items. */
  archived: number;
}

/** Counts over a list of items. */
export interface ItemSummary {
  /** Counts by level. */
  byLevel: LevelCounts;
  /** Counts by status. */
  byStatus: StatusCounts;
  /** Active items at level error or critical: the crash backlog. */
  activeErrors: number;
}

/** One occurrence, reduced to what triage needs. The payload is never kept. */
export interface Occurrence {
  /** The occurrence's id. */
  id: number;
  /** Unix seconds the server received it, when reported. */
  timestamp?: number;
  /** Environment it was reported from, when reported. */
  environment?: string;
  /** Code version it was reported from, when reported. */
  codeVersion?: string;
  /** Level name, when reported. */
  level?: string;
  /** Exception class, for an exception report. */
  exceptionClass?: string;
  /** Exception or log message, cut to 300 characters. */
  exceptionMessage?: string;
}

/** One deploy as the `deploys` resource keeps it. */
export interface Deploy {
  /** The deploy's id. */
  id: number;
  /** Environment deployed to. */
  environment: string;
  /** Revision deployed, a commit hash or version. */
  revision: string;
  /** started, succeeded, failed or timed_out, when reported. */
  status?: string;
  /** Who recorded it, when reported. */
  localUsername?: string;
  /** Free-text comment, when reported. */
  comment?: string;
  /** Unix seconds the deploy started, when reported. */
  startTime?: number;
  /** Unix seconds the deploy finished, when reported. */
  finishTime?: number;
}

/** Arguments of the `items` method. */
export interface ItemsArgs {
  /** Only items with this status. */
  status?: string;
  /** Only items at this level. */
  level?: string;
  /** Only items from this environment. Overrides the global environment. */
  environment?: string;
  /** Rollbar search query: free text, `#counter` or `field:value` terms. */
  query?: string;
  /** First page to fetch, 1-based. */
  page: number;
  /** How many pages of 100 to fetch. */
  pages: number;
}

/** Arguments naming one item by id or by counter. Exactly one is required. */
export interface ItemRef {
  /** The item's id. */
  id?: number;
  /** The item's counter. */
  counter?: number;
}

/** Arguments of the `occurrences` method. */
export interface OccurrencesArgs extends ItemRef {
  /** Occurrences per page, up to 5000 where the API allows it. */
  limit: number;
  /** Page to fetch, 1-based, newest first. */
  page: number;
}

/** Arguments of the `resolve` method. */
export interface ResolveArgs extends ItemRef {
  /** The version that carries the fix. The item reopens on a later version. */
  resolvedInVersion?: string;
}

/** Arguments of the `assign` method. */
export interface AssignArgs extends ItemRef {
  /** Id of the user to assign the item to. */
  assignedUserId: number;
}

/** Arguments of the `deploy` method. */
export interface DeployArgs {
  /** Environment deployed to. Falls back to the global environment. */
  environment?: string;
  /** Revision deployed, a commit hash or version. */
  revision: string;
  /** Who is recording the deploy. */
  localUsername?: string;
  /** Free-text comment. */
  comment?: string;
  /** started, succeeded, failed or timed_out. The API defaults to succeeded. */
  status?: string;
}

/** Arguments of the `deploys` method. */
export interface DeploysArgs {
  /** Only deploys to this environment. Overrides the global environment. */
  environment?: string;
  /** Page to fetch, 1-based, newest first. */
  page: number;
}

/** One bucket of a report: its start and what it counted. */
export interface CountBucket {
  /** Unix seconds the bucket starts at, aligned to the bucket size in UTC. */
  timestamp: number;
  /** Occurrences, or activated items, in the bucket. */
  count: number;
}

/** Arguments of the `occurrence-counts` method. */
export interface OccurrenceCountsArgs {
  /** Bucket size in seconds: 60, 3600 or 86400. */
  bucketSize: number;
  /** Only occurrences from these environments. Falls back to the global environment. */
  environments?: string[];
  /** Lowest level counted. The API defaults to error. */
  minLevel?: string;
  /** Highest level counted. */
  maxLevel?: string;
  /** Only one item's occurrences. */
  itemId?: number;
}

/** Arguments of the `activated-counts` method. */
export interface ActivatedCountsArgs {
  /** How many daily buckets, 2 to 366. */
  buckets: number;
  /** Only items from these environments. Falls back to the global environment. */
  environments?: string[];
}

/** Arguments of the `top-active` method. */
export interface TopActiveArgs {
  /** How many recent hours to count, 1 to 168. */
  hours: number;
  /** Only items from these environments. Falls back to the global environment. */
  environments?: string[];
  /** Order by occurrences alone, instead of by level and then occurrences. */
  byOccurrences: boolean;
}

/** One row of the `top-active` resource: an item and its hourly counts. */
export interface TopActiveItem {
  /** The item's id. */
  id: number;
  /** The item's counter. */
  counter: number;
  /** The item's title, cut to 300 characters. */
  title: string;
  /** Level name. */
  level: string;
  /** Environment the item's occurrences were reported from. */
  environment: string;
  /** Occurrences in the window: the API's count, or the sum of `counts`. */
  occurrences: number;
  /** Occurrences counted over the item's life, when the API reports it (crashq does). */
  totalOccurrences?: number;
  /** Distinct install ids seen, when the API reports it. */
  uniqueOccurrences?: number;
  /** Unix seconds of the last occurrence, when the API reports it. */
  lastOccurrenceTimestamp?: number;
  /** Status, when the API reports it (crashq does; the items are active). */
  status?: string;
  /** Occurrences per hour of the window, oldest first. */
  counts: number[];
}

/** One event of an item's history, as the `events` resource keeps it. */
export interface ItemEvent {
  /** The event's id. */
  id: number;
  /** Unix seconds the event happened, when reported. */
  timestamp?: number;
  /** What changed: status, level, assigned_user_id, title, resolved_in_version or comment. */
  type: string;
  /** The value before, cut to 300 characters, when there was one. */
  oldValue?: string;
  /** The value after, or the comment, cut to 300 characters, when there is one. */
  newValue?: string;
  /** Id of the user who made the change, when a person did. */
  userId?: number;
  /** Id of the occurrence that caused the change, when one did. */
  occurrenceId?: number;
}

/** Arguments of the `fingerprint-test` method. */
export interface FingerprintTestArgs {
  /** The token's project id. */
  projectId: number;
  /** Id of the occurrence to group. */
  instance: number;
  /** Rules to try instead of the stored ones, in the API's rule format. */
  rules?: Record<string, unknown>[];
  /** Whether to skip a fingerprint the client sent, when trying rules. */
  ignoreClientFingerprint?: boolean;
}

/** One request to the API. */
export interface RequestOptions {
  /** HTTP method. */
  method: "GET" | "POST" | "PATCH";
  /** Path under the host, starting with /api/1/. */
  path: string;
  /** Query parameters. Undefined values are left out. */
  query?: Record<string, string | number | undefined>;
  /** JSON body for POST and PATCH. Undefined values are left out. */
  body?: Record<string, unknown>;
}

/**
 * An answer the API refused, with its HTTP status. A 429 answer also carries
 * the seconds until the rate-limit window resets, read from
 * X-Rate-Limit-Remaining-Seconds or Retry-After.
 */
export class RollbarError extends Error {
  /** HTTP status of the answer. */
  readonly status: number;
  /** Seconds to wait before trying again, on a 429 answer. */
  readonly retryAfterSeconds: number | undefined;

  /** Builds the error. `retryAfterSeconds` is set for a 429 answer only. */
  constructor(message: string, status: number, retryAfterSeconds?: number) {
    super(message);
    this.name = "RollbarError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// ---------------------------------------------------------------------------
// Schemas (private: the exported interfaces above are the public types, and
// `satisfies` keeps each schema in step with its interface)
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  host: z
    .url()
    .default(DEFAULT_HOST)
    .describe(
      "Base URL of the API: https://api.rollbar.com, or your crashq host.",
    ),
  token: z
    .string()
    .min(1)
    .meta({ sensitive: true })
    .describe(
      "Project access token, sent as X-Rollbar-Access-Token. Read scope lists and reads, write resolves, mutes and assigns, post_server_item records deploys.",
    ),
  environment: z
    .string()
    .optional()
    .describe(
      "Default environment filter for items, deploys and reports. A method argument overrides it.",
    ),
}) satisfies z.ZodType<GlobalArgs>;

const ItemRefShape = {
  id: z.number().int().positive().optional().describe("The item's id."),
  counter: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("The item's counter, the number the project's UI shows."),
};

const oneOfIdOrCounter = (value: ItemRef): boolean =>
  (value.id === undefined) !== (value.counter === undefined);

const ITEM_REF_MESSAGE = "Give exactly one of id or counter.";

const ItemRefSchema = z.object(ItemRefShape).refine(oneOfIdOrCounter, {
  message: ITEM_REF_MESSAGE,
}) satisfies z.ZodType<ItemRef>;

const ItemsArgsSchema = z.object({
  status: z.enum(STATUSES).optional().describe("Only items with this status."),
  level: z.enum(LEVELS).optional().describe("Only items at this level."),
  environment: z
    .string()
    .optional()
    .describe(
      "Only items from this environment. Overrides the global environment.",
    ),
  query: z
    .string()
    .optional()
    .describe(
      "Rollbar search query: free text, #counter or field:value terms.",
    ),
  page: z
    .number()
    .int()
    .min(1)
    .default(1)
    .describe("First page to fetch, 1-based."),
  pages: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(1)
    .describe("How many pages of 100 items to fetch."),
}) satisfies z.ZodType<ItemsArgs>;

const OccurrencesArgsSchema = z
  .object({
    ...ItemRefShape,
    limit: z
      .number()
      .int()
      .min(1)
      .max(5000)
      .default(OCCURRENCES_PAGE_SIZE)
      .describe("Occurrences per page, up to 5000 where the API allows it."),
    page: z
      .number()
      .int()
      .min(1)
      .default(1)
      .describe("Page to fetch, 1-based, newest first."),
  })
  .refine(oneOfIdOrCounter, {
    message: ITEM_REF_MESSAGE,
  }) satisfies z.ZodType<OccurrencesArgs>;

const ResolveArgsSchema = z
  .object({
    ...ItemRefShape,
    resolvedInVersion: z
      .string()
      .optional()
      .describe(
        "The version that carries the fix. The item reopens on a later version.",
      ),
  })
  .refine(oneOfIdOrCounter, {
    message: ITEM_REF_MESSAGE,
  }) satisfies z.ZodType<ResolveArgs>;

const AssignArgsSchema = z
  .object({
    ...ItemRefShape,
    assignedUserId: z
      .number()
      .int()
      .positive()
      .describe("Id of the user to assign the item to."),
  })
  .refine(oneOfIdOrCounter, {
    message: ITEM_REF_MESSAGE,
  }) satisfies z.ZodType<AssignArgs>;

const DeployArgsSchema = z.object({
  environment: z
    .string()
    .optional()
    .describe("Environment deployed to. Falls back to the global environment."),
  revision: z
    .string()
    .min(1)
    .describe("Revision deployed, a commit hash or version."),
  localUsername: z.string().optional().describe("Who is recording the deploy."),
  comment: z.string().optional().describe("Free-text comment."),
  status: z
    .enum(DEPLOY_STATUSES)
    .optional()
    .describe(
      "started, succeeded, failed or timed_out. The API defaults to succeeded.",
    ),
}) satisfies z.ZodType<DeployArgs>;

const DeploysArgsSchema = z.object({
  environment: z
    .string()
    .optional()
    .describe(
      "Only deploys to this environment. Overrides the global environment.",
    ),
  page: z
    .number()
    .int()
    .min(1)
    .default(1)
    .describe("Page to fetch, 1-based, newest first."),
}) satisfies z.ZodType<DeploysArgs>;

const EnvironmentsShape = {
  environments: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Only these environments. Falls back to the global environment; empty means any.",
    ),
};

const OccurrenceCountsArgsSchema = z.object({
  bucketSize: z
    .union([z.literal(60), z.literal(3600), z.literal(86400)])
    .default(86400)
    .describe("Bucket size in seconds: 60, 3600 or 86400 (a day)."),
  ...EnvironmentsShape,
  minLevel: z
    .enum(LEVELS)
    .optional()
    .describe("Lowest level counted. The API defaults to error."),
  maxLevel: z.enum(LEVELS).optional().describe("Highest level counted."),
  itemId: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Only this item's occurrences."),
}) satisfies z.ZodType<OccurrenceCountsArgs>;

const ActivatedCountsArgsSchema = z.object({
  buckets: z
    .number()
    .int()
    .min(ACTIVATED_BUCKETS_MIN)
    .max(ACTIVATED_BUCKETS_MAX)
    .default(ACTIVATED_BUCKETS_DEFAULT)
    .describe("How many daily buckets, 2 to 366."),
  ...EnvironmentsShape,
}) satisfies z.ZodType<ActivatedCountsArgs>;

const TopActiveArgsSchema = z.object({
  hours: z
    .number()
    .int()
    .min(TOP_HOURS_MIN)
    .max(TOP_HOURS_MAX)
    .default(TOP_HOURS_DEFAULT)
    .describe("How many recent hours to count, 1 to 168."),
  ...EnvironmentsShape,
  byOccurrences: z
    .boolean()
    .default(false)
    .describe(
      "Order by occurrences alone, instead of by level and then occurrences.",
    ),
}) satisfies z.ZodType<TopActiveArgs>;

const FingerprintTestArgsSchema = z.object({
  projectId: z
    .number()
    .int()
    .positive()
    .describe("The token's project id."),
  instance: z
    .number()
    .int()
    .positive()
    .describe("Id of the occurrence to group."),
  rules: z
    .array(z.record(z.string(), z.unknown()))
    .optional()
    .describe(
      "Rules to try instead of the stored ones: condition, fingerprint, title.",
    ),
  ignoreClientFingerprint: z
    .boolean()
    .optional()
    .describe("Skip a fingerprint the client sent, when trying rules."),
}) satisfies z.ZodType<FingerprintTestArgs>;

const ItemSchema = z.object({
  id: z.number().int(),
  counter: z.number().int(),
  title: z.string(),
  level: z.string(),
  status: z.string(),
  environment: z.string(),
  totalOccurrences: z.number().int(),
  uniqueOccurrences: z.number().int().optional(),
  firstOccurrenceTimestamp: z.number().int().optional(),
  lastOccurrenceTimestamp: z.number().int().optional(),
  firstVersion: z.string().optional(),
  lastVersion: z.string().optional(),
  assignedUserId: z.number().int().optional(),
  resolvedInVersion: z.string().optional(),
}) satisfies z.ZodType<Item>;

const ItemFiltersSchema = z.object({
  status: z.string().optional(),
  level: z.string().optional(),
  environment: z.string().optional(),
  query: z.string().optional(),
}) satisfies z.ZodType<ItemFilters>;

const LevelCountsSchema = z.object({
  debug: z.number().int(),
  info: z.number().int(),
  warning: z.number().int(),
  error: z.number().int(),
  critical: z.number().int(),
}) satisfies z.ZodType<LevelCounts>;

const StatusCountsSchema = z.object({
  active: z.number().int(),
  resolved: z.number().int(),
  muted: z.number().int(),
  archived: z.number().int(),
}) satisfies z.ZodType<StatusCounts>;

const ItemsResourceSchema = z.object({
  fetchedAt: z.iso.datetime(),
  host: z.string(),
  filters: ItemFiltersSchema,
  firstPage: z.number().int(),
  pagesFetched: z.number().int(),
  count: z.number().int(),
  truncated: z.boolean(),
  items: z.array(ItemSchema),
});

const SummaryResourceSchema = z.object({
  fetchedAt: z.iso.datetime(),
  host: z.string(),
  filters: ItemFiltersSchema,
  count: z.number().int(),
  truncated: z.boolean(),
  byLevel: LevelCountsSchema,
  byStatus: StatusCountsSchema,
  activeErrors: z.number().int(),
});

const ItemResourceSchema = ItemSchema.extend({
  fetchedAt: z.iso.datetime(),
  host: z.string(),
});

const OccurrenceSchema = z.object({
  id: z.number().int(),
  timestamp: z.number().int().optional(),
  environment: z.string().optional(),
  codeVersion: z.string().optional(),
  level: z.string().optional(),
  exceptionClass: z.string().optional(),
  exceptionMessage: z.string().optional(),
}) satisfies z.ZodType<Occurrence>;

const OccurrencesResourceSchema = z.object({
  fetchedAt: z.iso.datetime(),
  host: z.string(),
  itemId: z.number().int(),
  counter: z.number().int(),
  page: z.number().int(),
  limit: z.number().int(),
  count: z.number().int(),
  truncated: z.boolean(),
  occurrences: z.array(OccurrenceSchema),
});

const DeployResourceSchema = z.object({
  recordedAt: z.iso.datetime(),
  host: z.string(),
  id: z.number().int(),
  environment: z.string(),
  revision: z.string(),
  status: z.string(),
  localUsername: z.string().optional(),
  comment: z.string().optional(),
});

const DeploySchema = z.object({
  id: z.number().int(),
  environment: z.string(),
  revision: z.string(),
  status: z.string().optional(),
  localUsername: z.string().optional(),
  comment: z.string().optional(),
  startTime: z.number().int().optional(),
  finishTime: z.number().int().optional(),
}) satisfies z.ZodType<Deploy>;

const DeploysResourceSchema = z.object({
  fetchedAt: z.iso.datetime(),
  host: z.string(),
  environment: z.string().optional(),
  page: z.number().int(),
  count: z.number().int(),
  truncated: z.boolean(),
  deploys: z.array(DeploySchema),
});

const CountBucketSchema = z.object({
  timestamp: z.number().int(),
  count: z.number().int(),
}) satisfies z.ZodType<CountBucket>;

/** What both count reports share: the buckets, their sum and the newest one. */
const CountsShape = {
  fetchedAt: z.iso.datetime(),
  host: z.string(),
  environments: z.array(z.string()),
  count: z.number().int(),
  total: z.number().int(),
  newestTimestamp: z.number().int().optional(),
  newestCount: z.number().int().optional(),
  buckets: z.array(CountBucketSchema),
};

const OccurrenceCountsResourceSchema = z.object({
  ...CountsShape,
  bucketSize: z.number().int(),
  minLevel: z.string(),
  maxLevel: z.string().optional(),
  itemId: z.number().int().optional(),
});

const ActivatedCountsResourceSchema = z.object({
  ...CountsShape,
  bucketsRequested: z.number().int(),
});

const TopActiveItemSchema = z.object({
  id: z.number().int(),
  counter: z.number().int(),
  title: z.string(),
  level: z.string(),
  environment: z.string(),
  occurrences: z.number().int(),
  totalOccurrences: z.number().int().optional(),
  uniqueOccurrences: z.number().int().optional(),
  lastOccurrenceTimestamp: z.number().int().optional(),
  status: z.string().optional(),
  counts: z.array(z.number().int()),
}) satisfies z.ZodType<TopActiveItem>;

const TopActiveResourceSchema = z.object({
  fetchedAt: z.iso.datetime(),
  host: z.string(),
  hours: z.number().int(),
  environments: z.array(z.string()),
  sort: z.string(),
  count: z.number().int(),
  items: z.array(TopActiveItemSchema),
});

const ItemEventSchema = z.object({
  id: z.number().int(),
  timestamp: z.number().int().optional(),
  type: z.string(),
  oldValue: z.string().optional(),
  newValue: z.string().optional(),
  userId: z.number().int().optional(),
  occurrenceId: z.number().int().optional(),
}) satisfies z.ZodType<ItemEvent>;

const EventsResourceSchema = z.object({
  fetchedAt: z.iso.datetime(),
  host: z.string(),
  itemId: z.number().int(),
  counter: z.number().int(),
  count: z.number().int(),
  events: z.array(ItemEventSchema),
});

const FingerprintTestResourceSchema = z.object({
  testedAt: z.iso.datetime(),
  host: z.string(),
  projectId: z.number().int(),
  instance: z.number().int(),
  rulesSent: z.boolean(),
  rule: z.number().int().optional(),
  fingerprint: z.string(),
  hash: z.string(),
  title: z.string(),
  itemId: z.number().int().optional(),
  counter: z.number().int().optional(),
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

/** Drops undefined values so a resource holds only what the API answered. */
function compact<T extends Record<string, unknown>>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) out[key] = entry;
  }
  return out as T;
}

/**
 * Renders item filters for a log line, `status=active, query="x"`, or
 * `(none)`. A logger turns an object into `[object Object]`, so the line
 * carries this string instead. Filters never hold the token.
 */
export function describeFilters(filters: ItemFilters): string {
  const parts = Object.entries(filters)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) =>
      key === "query" ? `${key}=${JSON.stringify(value)}` : `${key}=${value}`
    );
  return parts.length === 0 ? "(none)" : parts.join(", ");
}

/**
 * Names a level the API reported as a string or as Rollbar's number
 * (10 debug, 20 info, 30 warning, 40 error, 50 critical).
 */
export function levelName(value: unknown): string {
  if (typeof value === "number") return LEVEL_NAMES[value] ?? String(value);
  if (typeof value === "string" && value !== "") return value.toLowerCase();
  return "unknown";
}

/** Reduces an item answer to the fields the `items` and `item` resources keep. */
export function normalizeItem(raw: unknown): Item {
  if (!isRecord(raw)) throw new Error("item answer is not an object");
  const id = asInteger(raw.id);
  const counter = asInteger(raw.counter);
  if (id === undefined || counter === undefined) {
    throw new Error("item answer carries no id and counter");
  }
  return compact({
    id,
    counter,
    title: asString(raw.title) ?? "",
    level: levelName(raw.level),
    status: asString(raw.status) ?? "unknown",
    environment: asString(raw.environment) ?? "",
    totalOccurrences: asInteger(raw.total_occurrences) ?? 0,
    uniqueOccurrences: asInteger(raw.unique_occurrences),
    firstOccurrenceTimestamp: asInteger(raw.first_occurrence_timestamp),
    lastOccurrenceTimestamp: asInteger(raw.last_occurrence_timestamp),
    firstVersion: asString(raw.first_version),
    lastVersion: asString(raw.last_version),
    assignedUserId: asInteger(raw.assigned_user_id) ?? undefined,
    resolvedInVersion: asString(raw.resolved_in_version),
  });
}

/** The exception class and message of an occurrence body, if it has one. */
function exceptionOf(body: Record<string, unknown>): {
  exceptionClass?: string;
  exceptionMessage?: string;
} {
  let trace: unknown = body.trace;
  if (Array.isArray(body.trace_chain) && body.trace_chain.length > 0) {
    trace = body.trace_chain[0];
  }
  if (isRecord(trace) && isRecord(trace.exception)) {
    return {
      exceptionClass: asString(trace.exception.class),
      exceptionMessage: asString(trace.exception.message),
    };
  }
  if (isRecord(body.message)) {
    return { exceptionMessage: asString(body.message.body) };
  }
  return {};
}

/**
 * Reduces an occurrence answer to ids, timestamps, versions and the exception
 * class and message. Nothing else of the payload is kept: it is data about the
 * player who hit the crash.
 */
export function normalizeOccurrence(raw: unknown): Occurrence {
  if (!isRecord(raw)) throw new Error("occurrence answer is not an object");
  const id = asInteger(raw.id);
  if (id === undefined) throw new Error("occurrence answer carries no id");
  const data = isRecord(raw.data) ? raw.data : {};
  const body = isRecord(data.body) ? data.body : {};
  const exception = exceptionOf(body);
  const message = exception.exceptionMessage;
  const level = data.level ?? raw.level;
  return compact({
    id,
    timestamp: asInteger(raw.timestamp) ?? asInteger(data.timestamp),
    environment: asString(data.environment) ?? asString(raw.environment),
    codeVersion: asString(data.code_version),
    level: level === undefined ? undefined : levelName(level),
    exceptionClass: exception.exceptionClass,
    exceptionMessage: message === undefined
      ? undefined
      : message.slice(0, MESSAGE_LIMIT),
  });
}

/** Reduces a deploy answer to the fields the `deploys` resource keeps. */
export function normalizeDeploy(raw: unknown): Deploy {
  if (!isRecord(raw)) throw new Error("deploy answer is not an object");
  const id = asInteger(raw.id);
  if (id === undefined) throw new Error("deploy answer carries no id");
  return compact({
    id,
    environment: asString(raw.environment) ?? "",
    revision: asString(raw.revision) ?? "",
    status: asString(raw.status),
    localUsername: asString(raw.local_username),
    comment: asString(raw.comment),
    startTime: asInteger(raw.start_time),
    finishTime: asInteger(raw.finish_time),
  });
}

/**
 * Reduces one report row to a bucket. Rollbar answers `[timestamp, count]`
 * pairs; an object with `timestamp` and `count` is read the same way.
 */
export function normalizeBucket(raw: unknown): CountBucket {
  const timestamp = Array.isArray(raw)
    ? asInteger(raw[0])
    : isRecord(raw)
    ? asInteger(raw.timestamp)
    : undefined;
  const count = Array.isArray(raw)
    ? asInteger(raw[1])
    : isRecord(raw)
    ? asInteger(raw.count)
    : undefined;
  if (timestamp === undefined || count === undefined) {
    throw new Error("report row is not a [timestamp, count] pair");
  }
  return { timestamp, count };
}

/** The sum and the newest bucket of a report, for the resource's flat fields. */
function bucketTotals(buckets: readonly CountBucket[]): {
  total: number;
  newestTimestamp?: number;
  newestCount?: number;
} {
  const newest = buckets.reduce<CountBucket | undefined>(
    (best, bucket) =>
      best === undefined || bucket.timestamp > best.timestamp ? bucket : best,
    undefined,
  );
  return compact({
    total: buckets.reduce((sum, bucket) => sum + bucket.count, 0),
    newestTimestamp: newest?.timestamp,
    newestCount: newest?.count,
  });
}

/**
 * Reduces one top_active_items row, `{item, counts}`, to the fields the
 * `top-active` resource keeps. Rollbar's item carries `occurrences` for the
 * window and a numeric level; crashq's is the item as the item calls answer
 * it, so the window's occurrences are the sum of `counts`.
 */
export function normalizeTopActive(raw: unknown): TopActiveItem {
  if (!isRecord(raw) || !isRecord(raw.item)) {
    throw new Error("top active row carries no item");
  }
  const item = raw.item;
  const id = asInteger(item.id);
  const counter = asInteger(item.counter);
  if (id === undefined || counter === undefined) {
    throw new Error("top active item carries no id and counter");
  }
  const counts = (Array.isArray(raw.counts) ? raw.counts : [])
    .map(asInteger)
    .filter((count): count is number => count !== undefined);
  return compact({
    id,
    counter,
    title: (asString(item.title) ?? "").slice(0, MESSAGE_LIMIT),
    level: levelName(item.level),
    environment: asString(item.environment) ?? "",
    occurrences: asInteger(item.occurrences) ??
      counts.reduce((sum, count) => sum + count, 0),
    totalOccurrences: asInteger(item.total_occurrences),
    uniqueOccurrences: asInteger(item.unique_occurrences),
    lastOccurrenceTimestamp: asInteger(item.last_occurrence_timestamp),
    status: asString(item.status),
    counts,
  });
}

/** A value an event carries, as text cut to the message limit. */
function eventValue(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.slice(0, MESSAGE_LIMIT);
}

/** Reduces one item event to the fields the `events` resource keeps. */
export function normalizeEvent(raw: unknown): ItemEvent {
  if (!isRecord(raw)) throw new Error("event answer is not an object");
  const id = asInteger(raw.id);
  if (id === undefined) throw new Error("event answer carries no id");
  return compact({
    id,
    timestamp: asInteger(raw.timestamp),
    type: asString(raw.type) ?? "unknown",
    oldValue: eventValue(raw.old_value),
    newValue: eventValue(raw.new_value),
    userId: asInteger(raw.user_id) ?? undefined,
    occurrenceId: asInteger(raw.occurrence_id) ?? undefined,
  });
}

/**
 * The environments a report is filtered to: the argument, else the global
 * environment, else none (any environment).
 */
function environmentsOf(
  args: { environments?: string[] },
  globalArgs: GlobalArgs,
): string[] {
  if (args.environments !== undefined) return args.environments;
  return globalArgs.environment === undefined ? [] : [globalArgs.environment];
}

/** The `environments` query value: comma-separated, or left out when empty. */
function environmentsQuery(
  environments: readonly string[],
): string | undefined {
  return environments.length === 0 ? undefined : environments.join(",");
}

/** Counts items by level and status, and the active error or critical ones. */
export function summarize(items: readonly Item[]): ItemSummary {
  const byLevel: LevelCounts = {
    debug: 0,
    info: 0,
    warning: 0,
    error: 0,
    critical: 0,
  };
  const byStatus: StatusCounts = {
    active: 0,
    resolved: 0,
    muted: 0,
    archived: 0,
  };
  let activeErrors = 0;
  for (const item of items) {
    if (item.level in byLevel) byLevel[item.level as keyof LevelCounts]++;
    if (item.status in byStatus) {
      byStatus[item.status as keyof StatusCounts]++;
    }
    if (
      item.status === "active" &&
      (item.level === "error" || item.level === "critical")
    ) {
      activeErrors++;
    }
  }
  return { byLevel, byStatus, activeErrors };
}

/** The rows of a list answer, under `key` or as a bare array. */
function rowsOf(result: unknown, key: string): unknown[] {
  if (Array.isArray(result)) return result;
  if (isRecord(result) && Array.isArray(result[key])) {
    return result[key] as unknown[];
  }
  return [];
}

function totalCountOf(result: unknown): number | undefined {
  return isRecord(result) ? asInteger(result.total_count) : undefined;
}

function messageOf(parsed: unknown): string | undefined {
  return isRecord(parsed) ? asString(parsed.message) : undefined;
}

function retryAfterSeconds(headers: Headers): number | undefined {
  for (const header of RETRY_HEADERS) {
    const seconds = asInteger(headers.get(header));
    if (seconds !== undefined) return seconds;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/**
 * Sends one request with the token header and returns the unwrapped answer:
 * `result` from Rollbar's `{err: 0, result}` envelope, or the body itself when
 * there is no envelope (the deploy POST answers `{data: {deploy_id}}`).
 *
 * Throws a RollbarError for a 4xx or 5xx status, for `{err: 1, message}`, and
 * for a body that is not JSON. A 429 error carries `retryAfterSeconds`.
 */
export async function request(
  globalArgs: GlobalArgs,
  options: RequestOptions,
  signal?: AbortSignal,
): Promise<unknown> {
  const url = new URL(globalArgs.host.replace(/\/+$/, "") + options.path);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const headers: Record<string, string> = {
    [TOKEN_HEADER]: globalArgs.token,
    Accept: "application/json",
  };
  const body = options.body === undefined
    ? undefined
    : JSON.stringify(compact(options.body));
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const response = await fetch(url, {
    method: options.method,
    headers,
    body,
    signal,
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text === "" ? undefined : JSON.parse(text);
  } catch {
    parsed = undefined;
  }

  const label = `${options.method} ${options.path}`;
  if (response.status === 429) {
    const seconds = retryAfterSeconds(response.headers);
    const wait = seconds === undefined
      ? ""
      : `, retry after ${seconds} seconds`;
    throw new RollbarError(`${label}: rate limited (429)${wait}`, 429, seconds);
  }
  const message = messageOf(parsed);
  if (!response.ok) {
    const hint = STATUS_HINTS[response.status];
    const detail = [
      message ?? (text === "" ? response.statusText : text.slice(0, 200)),
      hint === undefined ? undefined : `(${hint})`,
    ]
      .filter((part) => part !== undefined && part !== "")
      .join(" ");
    throw new RollbarError(
      `${label}: ${response.status} ${detail}`,
      response.status,
    );
  }
  if (parsed === undefined) {
    throw new RollbarError(`${label}: answer was not JSON`, response.status);
  }
  if (isRecord(parsed) && typeof parsed.err === "number") {
    if (parsed.err !== 0) {
      throw new RollbarError(
        `${label}: ${message ?? `err ${parsed.err}`}`,
        response.status,
      );
    }
    return parsed.result;
  }
  return parsed;
}

/** Fetches one item by id, or by counter through item_by_counter's redirect. */
async function fetchItem(
  globalArgs: GlobalArgs,
  ref: ItemRef,
  signal: AbortSignal,
): Promise<Item> {
  const path = ref.id !== undefined
    ? `/api/1/item/${ref.id}`
    : `/api/1/item_by_counter/${ref.counter}`;
  return normalizeItem(
    await request(globalArgs, { method: "GET", path }, signal),
  );
}

/** Patches one item, re-reads it and writes the `item` resource. */
async function patchItem(
  args: ItemRef,
  context: Context,
  patch: Record<string, unknown>,
  verb: string,
): Promise<MethodResult> {
  const { globalArgs, signal, logger } = context;
  const id = args.id ?? (await fetchItem(globalArgs, args, signal)).id;
  logger.info("{verb} item {id} on {host}", {
    verb,
    id,
    host: globalArgs.host,
  });
  await request(
    globalArgs,
    {
      method: "PATCH",
      path: `/api/1/item/${id}`,
      body: patch,
    },
    signal,
  );
  const item = await fetchItem(globalArgs, { id }, signal);
  const handle = await context.writeResource("item", `item-${item.counter}`, {
    fetchedAt: new Date().toISOString(),
    host: globalArgs.host,
    ...item,
  });
  logger.info("Item #{counter} is now {status}", {
    counter: item.counter,
    status: item.status,
  });
  return { dataHandles: [handle] };
}

// ---------------------------------------------------------------------------
// Behavior
// ---------------------------------------------------------------------------

/**
 * The behavior definition Swamp registers. Global arguments are `host`,
 * `token` (sensitive) and an optional `environment`; see the README for each
 * method, the resource it writes and the instance name it writes it under.
 */
export const behavior = {
  // String literals, not constants: the registry catalog reads them from the
  // source. The collective is provisional, rename it here.
  type: "@reset/rollbar",
  version: "2026.10.21.2",
  globalArguments: GlobalArgsSchema,
  resources: {
    items: {
      description: "A page range of items with the filters it was taken with",
      schema: ItemsResourceSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    summary: {
      description: "Counts by level and status over the same items, and the " +
        "active error or critical count, for CEL asserts",
      schema: SummaryResourceSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    item: {
      description: "One item, written by item, resolve, mute and assign",
      schema: ItemResourceSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    occurrences: {
      description: "One page of an item's occurrences: ids, timestamps, " +
        "versions and the exception class and message, never the payload",
      schema: OccurrencesResourceSchema,
      lifetime: "30d",
      garbageCollection: 5,
    },
    deploy: {
      description: "A deploy this behavior recorded",
      schema: DeployResourceSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    deploys: {
      description: "One page of deploys, newest first",
      schema: DeploysResourceSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "occurrence-counts": {
      description: "Occurrences per bucket, with the sum and the newest " +
        "bucket flat for CEL asserts",
      schema: OccurrenceCountsResourceSchema,
      lifetime: "infinite",
      garbageCollection: 60,
    },
    "activated-counts": {
      description: "Items first seen or reactivated per day, with the sum " +
        "and the newest day flat for CEL asserts",
      schema: ActivatedCountsResourceSchema,
      lifetime: "infinite",
      garbageCollection: 60,
    },
    "top-active": {
      description: "The busiest active items of a window with their hourly " +
        "counts: ids, counters, levels and titles, never occurrences",
      schema: TopActiveResourceSchema,
      lifetime: "infinite",
      garbageCollection: 60,
    },
    events: {
      description: "One item's history: status, level, assignee, title and " +
        "version changes and comments",
      schema: EventsResourceSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "fingerprint-test": {
      description: "What one occurrence groups by: the rule, fingerprint, " +
        "hash and title, never the occurrence",
      schema: FingerprintTestResourceSchema,
      lifetime: "30d",
      garbageCollection: 5,
    },
  },
  methods: {
    items: {
      description: "List items, 100 per page, with optional status, level, " +
        "environment and query filters. Writes items and summary.",
      arguments: ItemsArgsSchema,
      execute: async (
        args: ItemsArgs,
        context: Context,
      ): Promise<MethodResult> => {
        const { globalArgs, signal, logger } = context;
        const filters: ItemFilters = compact({
          status: args.status,
          level: args.level,
          environment: args.environment ?? globalArgs.environment,
          query: args.query,
        });
        logger.info(
          "Listing items from {host}: pages {first} to {last}, filters {filters}",
          {
            host: globalArgs.host,
            first: args.page,
            last: args.page + args.pages - 1,
            filters: describeFilters(filters),
          },
        );
        const items: Item[] = [];
        let totalCount: number | undefined;
        let lastPageFull = false;
        let pagesFetched = 0;
        for (let page = args.page; page < args.page + args.pages; page++) {
          const result = await request(
            globalArgs,
            {
              method: "GET",
              path: "/api/1/items/",
              query: { ...filters, page },
            },
            signal,
          );
          const rows = rowsOf(result, "items");
          totalCount = totalCountOf(result) ?? totalCount;
          pagesFetched++;
          for (const row of rows) items.push(normalizeItem(row));
          logger.debug("Page {page}: {count} items", {
            page,
            count: rows.length,
          });
          lastPageFull = rows.length >= ITEMS_PAGE_SIZE;
          if (!lastPageFull) break;
        }
        const truncated = totalCount === undefined
          ? lastPageFull
          : items.length < totalCount;
        const summary = summarize(items);
        const fetchedAt = new Date().toISOString();
        const itemsHandle = await context.writeResource("items", "items", {
          fetchedAt,
          host: globalArgs.host,
          filters,
          firstPage: args.page,
          pagesFetched,
          count: items.length,
          truncated,
          items,
        });
        const summaryHandle = await context.writeResource(
          "summary",
          "summary",
          {
            fetchedAt,
            host: globalArgs.host,
            filters,
            count: items.length,
            truncated,
            ...summary,
          },
        );
        logger.info(
          "Listed {count} items ({activeErrors} active at error or critical, truncated={truncated})",
          {
            count: items.length,
            activeErrors: summary.activeErrors,
            truncated,
          },
        );
        return { dataHandles: [itemsHandle, summaryHandle] };
      },
    },
    item: {
      description: "Read one item by id or counter. Writes item-<counter>.",
      arguments: ItemRefSchema,
      execute: async (
        args: ItemRef,
        context: Context,
      ): Promise<MethodResult> => {
        const { globalArgs, signal, logger } = context;
        logger.info("Reading item {ref} from {host}", {
          ref: args.id !== undefined ? `id ${args.id}` : `#${args.counter}`,
          host: globalArgs.host,
        });
        const item = await fetchItem(globalArgs, args, signal);
        const handle = await context.writeResource(
          "item",
          `item-${item.counter}`,
          {
            fetchedAt: new Date().toISOString(),
            host: globalArgs.host,
            ...item,
          },
        );
        logger.info("Read item #{counter}: {title} ({level}, {status})", {
          counter: item.counter,
          title: item.title,
          level: item.level,
          status: item.status,
        });
        return { dataHandles: [handle] };
      },
    },
    occurrences: {
      description: "List one page of an item's occurrences, newest first, " +
        "keeping ids, timestamps, versions and the exception class and " +
        "message only. Writes occurrences-<counter>.",
      arguments: OccurrencesArgsSchema,
      execute: async (
        args: OccurrencesArgs,
        context: Context,
      ): Promise<MethodResult> => {
        const { globalArgs, signal, logger } = context;
        const item = await fetchItem(globalArgs, args, signal);
        logger.info(
          "Listing occurrences of item #{counter} from {host}: page {page}, limit {limit}",
          {
            counter: item.counter,
            host: globalArgs.host,
            page: args.page,
            limit: args.limit,
          },
        );
        const result = await request(
          globalArgs,
          {
            method: "GET",
            path: `/api/1/item/${item.id}/instances/`,
            query: { page: args.page, limit: args.limit },
          },
          signal,
        );
        const rows = rowsOf(result, "instances");
        const occurrences = rows.map(normalizeOccurrence);
        const truncated =
          rows.length >= Math.min(args.limit, OCCURRENCES_PAGE_SIZE);
        const handle = await context.writeResource(
          "occurrences",
          `occurrences-${item.counter}`,
          {
            fetchedAt: new Date().toISOString(),
            host: globalArgs.host,
            itemId: item.id,
            counter: item.counter,
            page: args.page,
            limit: args.limit,
            count: occurrences.length,
            truncated,
            occurrences,
          },
        );
        logger.info("Listed {count} occurrences of item #{counter}", {
          count: occurrences.length,
          counter: item.counter,
        });
        return { dataHandles: [handle] };
      },
    },
    resolve: {
      description: "Mark an item resolved, in a version when given. Needs a " +
        "write token. Writes item-<counter>.",
      arguments: ResolveArgsSchema,
      execute: (args: ResolveArgs, context: Context): Promise<MethodResult> =>
        patchItem(
          args,
          context,
          {
            status: "resolved",
            resolved_in_version: args.resolvedInVersion,
          },
          "Resolving",
        ),
    },
    mute: {
      description: "Mute an item: it keeps counting and stays out of the " +
        "active list. Needs a write token. Writes item-<counter>.",
      arguments: ItemRefSchema,
      execute: (args: ItemRef, context: Context): Promise<MethodResult> =>
        patchItem(args, context, { status: "muted" }, "Muting"),
    },
    assign: {
      description: "Assign an item to a user by id. Needs a write token. " +
        "Writes item-<counter>.",
      arguments: AssignArgsSchema,
      execute: (args: AssignArgs, context: Context): Promise<MethodResult> =>
        patchItem(
          args,
          context,
          { assigned_user_id: args.assignedUserId },
          "Assigning",
        ),
    },
    deploy: {
      description: "Record a deploy of a revision to an environment. Needs a " +
        "post_server_item token. Writes deploy-<id>.",
      arguments: DeployArgsSchema,
      execute: async (
        args: DeployArgs,
        context: Context,
      ): Promise<MethodResult> => {
        const { globalArgs, signal, logger } = context;
        const environment = args.environment ?? globalArgs.environment;
        if (environment === undefined) {
          throw new Error(
            "deploy needs an environment: pass the environment argument or " +
              "set the global environment",
          );
        }
        logger.info(
          "Recording deploy of {revision} to {environment} on {host}",
          { revision: args.revision, environment, host: globalArgs.host },
        );
        const result = await request(
          globalArgs,
          {
            method: "POST",
            path: "/api/1/deploy/",
            body: {
              environment,
              revision: args.revision,
              local_username: args.localUsername,
              comment: args.comment,
              status: args.status,
            },
          },
          signal,
        );
        const data = isRecord(result) && isRecord(result.data)
          ? result.data
          : result;
        const id = isRecord(data)
          ? (asInteger(data.deploy_id) ?? asInteger(data.id))
          : undefined;
        if (id === undefined) {
          throw new Error("POST /api/1/deploy/: answer carries no deploy id");
        }
        const handle = await context.writeResource("deploy", `deploy-${id}`, {
          recordedAt: new Date().toISOString(),
          host: globalArgs.host,
          id,
          environment,
          revision: args.revision,
          status: args.status ?? "succeeded",
          ...compact({
            localUsername: args.localUsername,
            comment: args.comment,
          }),
        });
        logger.info("Recorded deploy {id}", { id });
        return { dataHandles: [handle] };
      },
    },
    deploys: {
      description: "List one page of deploys, 20 per page, newest first, " +
        "for an environment when given. Writes deploys.",
      arguments: DeploysArgsSchema,
      execute: async (
        args: DeploysArgs,
        context: Context,
      ): Promise<MethodResult> => {
        const { globalArgs, signal, logger } = context;
        const environment = args.environment ?? globalArgs.environment;
        logger.info(
          "Listing deploys from {host}: page {page}, environment {environment}",
          {
            host: globalArgs.host,
            page: args.page,
            environment: environment ?? "(all)",
          },
        );
        const result = await request(
          globalArgs,
          {
            method: "GET",
            path: "/api/1/deploys/",
            query: { environment, page: args.page },
          },
          signal,
        );
        const rows = rowsOf(result, "deploys");
        const deploys = rows.map(normalizeDeploy);
        const handle = await context.writeResource("deploys", "deploys", {
          fetchedAt: new Date().toISOString(),
          host: globalArgs.host,
          ...compact({ environment }),
          page: args.page,
          count: deploys.length,
          truncated: rows.length >= DEPLOYS_PAGE_SIZE,
          deploys,
        });
        logger.info("Listed {count} deploys", { count: deploys.length });
        return { dataHandles: [handle] };
      },
    },
    "occurrence-counts": {
      description: "Occurrences per bucket of a minute, an hour or a day " +
        "(60 buckets), at or above a level, for environments or one item. " +
        "Writes occurrence-counts.",
      arguments: OccurrenceCountsArgsSchema,
      execute: async (
        args: OccurrenceCountsArgs,
        context: Context,
      ): Promise<MethodResult> => {
        const { globalArgs, signal, logger } = context;
        const environments = environmentsOf(args, globalArgs);
        const minLevel = args.minLevel ?? "error";
        logger.info(
          "Reading occurrence counts from {host}: buckets of {bucketSize}s, levels {minLevel} to {maxLevel}, environments {environments}",
          {
            host: globalArgs.host,
            bucketSize: args.bucketSize,
            minLevel,
            maxLevel: args.maxLevel ?? "critical",
            environments: environments.length === 0 ? "(any)" : environments,
          },
        );
        const result = await request(
          globalArgs,
          {
            method: "GET",
            path: "/api/1/reports/occurrence_counts",
            query: {
              bucket_size: args.bucketSize,
              environments: environmentsQuery(environments),
              min_level: minLevel,
              max_level: args.maxLevel,
              item_id: args.itemId,
            },
          },
          signal,
        );
        const buckets = rowsOf(result, "result").map(normalizeBucket);
        const totals = bucketTotals(buckets);
        const handle = await context.writeResource(
          "occurrence-counts",
          "occurrence-counts",
          {
            fetchedAt: new Date().toISOString(),
            host: globalArgs.host,
            environments,
            bucketSize: args.bucketSize,
            minLevel,
            ...compact({ maxLevel: args.maxLevel, itemId: args.itemId }),
            count: buckets.length,
            ...totals,
            buckets,
          },
        );
        logger.info(
          "Read {count} buckets: {total} occurrences, {newest} in the newest",
          {
            count: buckets.length,
            total: totals.total,
            newest: totals.newestCount ?? 0,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    "activated-counts": {
      description: "Items first seen or reactivated per day, 2 to 366 days " +
        "(60 by default), for environments. Writes activated-counts.",
      arguments: ActivatedCountsArgsSchema,
      execute: async (
        args: ActivatedCountsArgs,
        context: Context,
      ): Promise<MethodResult> => {
        const { globalArgs, signal, logger } = context;
        const environments = environmentsOf(args, globalArgs);
        logger.info(
          "Reading activated counts from {host}: {buckets} days, environments {environments}",
          {
            host: globalArgs.host,
            buckets: args.buckets,
            environments: environments.length === 0 ? "(any)" : environments,
          },
        );
        const result = await request(
          globalArgs,
          {
            method: "GET",
            path: "/api/1/reports/activated_counts",
            query: {
              buckets: args.buckets,
              environments: environmentsQuery(environments),
            },
          },
          signal,
        );
        const buckets = rowsOf(result, "result").map(normalizeBucket);
        const totals = bucketTotals(buckets);
        const handle = await context.writeResource(
          "activated-counts",
          "activated-counts",
          {
            fetchedAt: new Date().toISOString(),
            host: globalArgs.host,
            environments,
            bucketsRequested: args.buckets,
            count: buckets.length,
            ...totals,
            buckets,
          },
        );
        logger.info(
          "Read {count} buckets: {total} items activated, {newest} in the newest",
          {
            count: buckets.length,
            total: totals.total,
            newest: totals.newestCount ?? 0,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    "top-active": {
      description: "The ten active items with the most occurrences over " +
        "1 to 168 recent hours (24 by default), each with its hourly " +
        "counts. Writes top-active.",
      arguments: TopActiveArgsSchema,
      execute: async (
        args: TopActiveArgs,
        context: Context,
      ): Promise<MethodResult> => {
        const { globalArgs, signal, logger } = context;
        const environments = environmentsOf(args, globalArgs);
        const sort = args.byOccurrences ? "occurrences" : "level";
        logger.info(
          "Reading top active items from {host}: {hours} hours, by {sort}, environments {environments}",
          {
            host: globalArgs.host,
            hours: args.hours,
            sort,
            environments: environments.length === 0 ? "(any)" : environments,
          },
        );
        const result = await request(
          globalArgs,
          {
            method: "GET",
            path: "/api/1/reports/top_active_items",
            query: {
              hours: args.hours,
              environments: environmentsQuery(environments),
              sort: args.byOccurrences ? "occurrences" : undefined,
            },
          },
          signal,
        );
        const items = rowsOf(result, "result").map(normalizeTopActive);
        const handle = await context.writeResource("top-active", "top-active", {
          fetchedAt: new Date().toISOString(),
          host: globalArgs.host,
          hours: args.hours,
          environments,
          sort,
          count: items.length,
          items,
        });
        logger.info("Read {count} top active items, busiest #{counter}", {
          count: items.length,
          counter: items[0]?.counter ?? "(none)",
        });
        return { dataHandles: [handle] };
      },
    },
    events: {
      description: "Read one item's history by id or counter: status, " +
        "level, assignee, title and version changes and comments, oldest " +
        "first. Writes events-<counter>.",
      arguments: ItemRefSchema,
      execute: async (
        args: ItemRef,
        context: Context,
      ): Promise<MethodResult> => {
        const { globalArgs, signal, logger } = context;
        const item = await fetchItem(globalArgs, args, signal);
        logger.info("Reading events of item #{counter} from {host}", {
          counter: item.counter,
          host: globalArgs.host,
        });
        const result = await request(
          globalArgs,
          { method: "GET", path: `/api/1/item/${item.id}/events` },
          signal,
        );
        const events = rowsOf(result, "events").map(normalizeEvent);
        const handle = await context.writeResource(
          "events",
          `events-${item.counter}`,
          {
            fetchedAt: new Date().toISOString(),
            host: globalArgs.host,
            itemId: item.id,
            counter: item.counter,
            count: events.length,
            events,
          },
        );
        logger.info("Read {count} events of item #{counter}", {
          count: events.length,
          counter: item.counter,
        });
        return { dataHandles: [handle] };
      },
    },
    "fingerprint-test": {
      description: "Group one occurrence by the project's fingerprint rules, " +
        "or by rules given to try, and keep the rule, fingerprint, hash and " +
        "title it gets. crashq only. Writes fingerprint-test-<instance>.",
      arguments: FingerprintTestArgsSchema,
      execute: async (
        args: FingerprintTestArgs,
        context: Context,
      ): Promise<MethodResult> => {
        const { globalArgs, signal, logger } = context;
        const rulesSent = args.rules !== undefined ||
          args.ignoreClientFingerprint !== undefined;
        logger.info(
          "Testing fingerprint rules of project {projectId} on {host} against occurrence {instance} ({rules})",
          {
            projectId: args.projectId,
            host: globalArgs.host,
            instance: args.instance,
            rules: rulesSent ? "rules given" : "stored rules",
          },
        );
        const result = await request(
          globalArgs,
          {
            method: "POST",
            path: `/api/1/project/${args.projectId}/fingerprint_rules/test`,
            body: {
              instance: args.instance,
              rules: args.rules,
              ignore_client_fingerprint: args.ignoreClientFingerprint,
            },
          },
          signal,
        );
        if (!isRecord(result)) {
          throw new Error("fingerprint test answer is not an object");
        }
        const fingerprint = asString(result.fingerprint);
        const hash = asString(result.hash);
        if (fingerprint === undefined || hash === undefined) {
          throw new Error("fingerprint test answer carries no fingerprint");
        }
        const item = isRecord(result.item) ? result.item : {};
        const handle = await context.writeResource(
          "fingerprint-test",
          `fingerprint-test-${args.instance}`,
          {
            testedAt: new Date().toISOString(),
            host: globalArgs.host,
            projectId: args.projectId,
            instance: args.instance,
            rulesSent,
            ...compact({
              rule: asInteger(result.rule) ?? undefined,
              itemId: asInteger(item.id),
              counter: asInteger(item.counter),
            }),
            fingerprint,
            hash,
            title: (asString(result.title) ?? "").slice(0, MESSAGE_LIMIT),
          },
        );
        logger.info(
          "Occurrence {instance} groups by {grouping} as {fingerprint}",
          {
            instance: args.instance,
            grouping: asInteger(result.rule) === undefined
              ? "the default grouping"
              : `rule ${asInteger(result.rule)}`,
            fingerprint: fingerprint.slice(0, 80),
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
  upgrades: [
    {
      toVersion: "2026.10.21.1",
      description: "Add the occurrence-counts, activated-counts, top-active, " +
        "events and fingerprint-test methods; global arguments unchanged",
      upgradeAttributes: (old: Record<string, unknown>): Record<
        string,
        unknown
      > => old,
    },
    {
      toVersion: "2026.10.21.2",
      description: "Log the items filters as text instead of " +
        "[object Object]; global arguments unchanged",
      upgradeAttributes: (old: Record<string, unknown>): Record<
        string,
        unknown
      > => old,
    },
  ],
};
