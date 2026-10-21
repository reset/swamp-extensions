/**
 * A Swamp behavior that reads a socialq deployment through its HTTP API with a
 * Cloudflare Access service token: health, who the token is, the accounts,
 * the calendar and the recorder's coverage of it, the wrap-up report, the
 * day's activity, the job ledger and the taxonomy. Every method writes what
 * it read as a resource, so a workflow can assert on it with CEL. It is
 * read-only by construction: the transport sends GET and nothing else, and
 * socialq refuses a service token every write anyway. Resources keep ids,
 * networks, the organization's own handles, counts, dates and job states,
 * never a post's text, media, a person's name or email, or an error's text.
 *
 * @module
 */

import { z } from "npm:zod@4";

const ID_HEADER = "CF-Access-Client-Id";
const SECRET_HEADER = "CF-Access-Client-Secret";
const RETRY_HEADERS = ["Retry-After"];
const DAY_MS = 86_400_000;

/** The calendar route answers at most 62 days. */
const CALENDAR_MAX_DAYS = 62;
/** The calendar range read when none is given: today and the 30 days before. */
const CALENDAR_DEFAULT_DAYS = 31;
/** The reports route answers at most 366 days. */
const REPORT_MAX_DAYS = 366;
/** The jobs route lists 100 jobs unless asked for up to 500. */
const JOBS_DEFAULT_LIMIT = 100;
const JOBS_MAX_LIMIT = 500;
/** The job states the ledger knows. */
const JOB_STATES = [
  "due",
  "leased",
  "done",
  "failed",
  "unknown",
  "dead",
] as const;
/** The states the jobs method lists unless told otherwise: what needs a person. */
const DEFAULT_JOB_STATES = "failed,dead,unknown";
/** The account statuses socialq documents. */
const ACCOUNT_STATUSES = [
  "connected",
  "needs_reconnect",
  "disconnected",
] as const;

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** What a status means when the answer carries no message of its own. */
const STATUS_HINTS: Record<number, string> = {
  302: "Cloudflare Access turned the request away before socialq saw it: " +
    "the service token is missing, wrong or not admitted to this host",
  401: "the service token was refused",
  403: "the token is not a publisher member of this organization, or " +
    "asked for what only an administrator reads",
  404: "no such route, or no organization answers on this hostname",
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Global arguments every method reads from the behavior definition. */
export interface GlobalArgs {
  /** Origin of the deployment, such as https://socialq.example.com, or an organization's own host. */
  host: string;
  /** Client id of the Cloudflare Access service token, sent as CF-Access-Client-Id. Sensitive. */
  clientId: string;
  /** Client secret of the service token, sent as CF-Access-Client-Secret. Sensitive. */
  clientSecret: string;
}

/** The logger methods this behavior calls. */
export interface Logger {
  /** Internal detail, such as a route fetched. */
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

/** A range of UTC days, as the calendar and report methods take it. */
export interface RangeArgs {
  /** First day, YYYY-MM-DD. */
  from?: string;
  /** Last day, YYYY-MM-DD, inclusive. */
  to?: string;
}

/** Arguments of the `jobs` method. */
export interface JobsArgs {
  /** Job states to list, comma separated: due, leased, done, failed, unknown, dead. */
  state: string;
  /** How many jobs to list at most, newest change first. */
  limit: number;
}

/** Arguments of the `taxonomy` method. */
export interface TaxonomyArgs {
  /** Include archived collections and tags. */
  archived: boolean;
}

/** One organization the token belongs to, as the `me` resource keeps it. */
export interface OrgRef {
  /** The organization's id. */
  id: string;
  /** The organization's slug, the first label of its own host. */
  slug: string;
  /** The token's role there, when the answer states it. */
  role?: string;
}

/** One of the organization's network accounts, as the `accounts` resource keeps it. */
export interface Account {
  /** The account's id in socialq. */
  id: string;
  /** Network: bluesky, threads, instagram, youtube, x or tiktok. */
  network: string;
  /** The organization's handle on the network. */
  handle: string;
  /** connected, needs_reconnect or disconnected. */
  status: string;
  /** When the account was first connected, when reported. */
  createdAt?: string;
  /** When the account's row last changed, when reported. */
  updatedAt?: string;
}

/** Account counts by status, as the `accounts` resource keeps them. */
export interface AccountStatusCounts {
  /** Accounts the recorder reads. */
  connected: number;
  /** Accounts whose credential needs an administrator to reconnect. */
  needsReconnect: number;
  /** Accounts an administrator disconnected. */
  disconnected: number;
}

/** One variant placed on a day, reduced to what a calendar count needs. */
export interface CalendarItem {
  /** The variant's id. */
  variantId: string;
  /** The post's id. */
  postId: string;
  /** The account the variant is on. */
  accountId: string;
  /** The account's network. */
  network: string;
  /** The organization's handle on the network. */
  handle: string;
  /** The variant's format, as the network names it. */
  format: string;
  /** published, scheduled or another status socialq keeps. */
  status: string;
  /** Where the variant came from: composed here or recorded from the network. */
  origin: string;
  /** The UTC day the variant sits on. */
  day: string;
  /** How many files the variant carries. */
  attachments: number;
  /** How many tags the post carries. */
  tags: number;
}

/** How far the recorder has read one account, as the `coverage` resource keeps it. */
export interface AccountCoverage {
  /** The account's id. */
  accountId: string;
  /** The account's network. */
  network: string;
  /** The organization's handle on the network. */
  handle: string;
  /** connected, needs_reconnect or disconnected. */
  status: string;
  /** Days in the range on which a posts collection finished. */
  daysWithData: number;
  /** When the recorder last finished reading the account's posts. Absent when never. */
  lastCollectedAt?: string;
  /** Whole days between that read and this one. Absent when never read. */
  readAgeDays?: number;
  /** The backfill of older posts is not finished. */
  backfillPending: boolean;
}

/** Metric totals by name, null where the network reports no such number. */
export type MetricTotals = Record<string, number | null>;

/** One (network, source) row of the report, as the `report` resource keeps it. */
export interface ReportRow {
  /** The network. */
  network: string;
  /** Where the numbers came from: the network, or an import. */
  source: string;
  /** Accounts of the network, how many had a follower count, and the counts at the range's ends. */
  followers: {
    /** Accounts of the network. */
    accounts: number;
    /** Accounts with a count on or before the range's end. */
    measured: number;
    /** Followers at the range's end, summed over measured accounts. */
    atEnd: number | null;
    /** Followers before the range's start, summed over measured accounts. */
    atStart: number | null;
  };
  /** Day numbers summed over the range. */
  daily: {
    /** Day rows summed. */
    rows: number;
    /** Variants the rows cover. */
    variants: number;
    /** Days the rows cover. */
    days: number;
    /** The sums by metric. */
    metrics: MetricTotals;
  };
  /** Lifetime numbers of the variants published in the range, read at its end. */
  lifetime: {
    /** Variants published in the range. */
    published: number;
    /** Of those, how many had a lifetime number by the end. */
    measured: number;
    /** The sums by metric. */
    metrics: MetricTotals;
  };
}

/** One account's follower count at the range's ends, as the `report` resource keeps it. */
export interface AccountReport {
  /** The account's id. */
  accountId: string;
  /** The account's network. */
  network: string;
  /** The organization's handle on the network. */
  handle: string;
  /** connected, needs_reconnect or disconnected. */
  status: string;
  /** Where the numbers came from. */
  source: string;
  /** The latest reading on or before the range's end, when there is one. */
  atEnd?: FollowerReading;
  /** The latest reading before the range's start, when there is one. */
  atStart?: FollowerReading;
}

/** One follower count on one day. */
export interface FollowerReading {
  /** The UTC day of the reading. */
  day: string;
  /** The count, null when the network did not report it. */
  followers: number | null;
}

/** Job counts by state. */
export interface JobStateCounts {
  /** Waiting for the minute cron. */
  due: number;
  /** Running under a consumer's lease. */
  leased: number;
  /** Ended well. */
  done: number;
  /** Refused by the network or invalid. */
  failed: number;
  /** Stopped after a write with an uncertain outcome; needs an operator. */
  unknown: number;
  /** Gave up after its retries. */
  dead: number;
}

/** One job as the `activity` resource keeps it: its state and outcome, never its error text. */
export interface ActivityJob {
  /** The job's id. */
  id: string;
  /** collect_posts, collect_account, collect_metrics, publish, refresh_token or reconcile. */
  kind: string;
  /** due, leased, done, failed, unknown or dead. */
  state: string;
  /** Attempts made so far. */
  attempts: number;
  /** The latest attempt's classified outcome, when one has ended. */
  outcome?: string;
  /** When the job was made. */
  createdAt?: string;
  /** When the job last changed. */
  updatedAt?: string;
  /** When the job is next due. */
  nextRunAt?: string;
  /** The collection run the job opened, for a recorder's job that has one. */
  run?: {
    /** ok, partial, failed or running. */
    status: string;
    /** Items the run wrote. */
    items: number;
    /** When the run ended, when it has. */
    endedAt?: string;
  };
}

/** One account's jobs for the day, as the `activity` resource keeps them. */
export interface AccountActivity {
  /** The account's id. */
  accountId: string;
  /** The account's network. */
  network: string;
  /** The organization's handle on the network. */
  handle: string;
  /** connected, needs_reconnect or disconnected. */
  status: string;
  /** The day's collection jobs on the account, in the order they run. */
  jobs: ActivityJob[];
}

/** One job of the ledger, as the `jobs` resource keeps it: never its error, handle or requester. */
export interface Job {
  /** The job's id. */
  id: string;
  /** The job's kind. */
  kind: string;
  /** due, leased, done, failed, unknown or dead. */
  state: string;
  /** What the job works on: an account, a variant or a credential, by id. */
  targetId?: string;
  /** The key that makes the same work one row, such as collect_posts:<account>:<day>. */
  operationKey?: string;
  /** Attempts made so far. */
  attempts: number;
  /** When the job is next due. */
  nextRunAt?: string;
  /** When the job was made. */
  createdAt?: string;
  /** When the job last changed. */
  updatedAt?: string;
}

/** One tag collection, as the `taxonomy` resource keeps it. */
export interface Collection {
  /** The collection's id. */
  id: string;
  /** The collection it is inside, when it is inside one. */
  parentId?: string;
  /** The collection's name. */
  name: string;
  /** The collection is archived. */
  archived: boolean;
}

/** One tag, label or campaign, as the `taxonomy` resource keeps it: never its brief or creator. */
export interface Tag {
  /** The tag's id. */
  id: string;
  /** The collection it is in, when it is in one. */
  collectionId?: string;
  /** label or campaign. */
  kind: string;
  /** The tag's name. */
  name: string;
  /** A campaign's first day, when set. */
  startsOn?: string;
  /** A campaign's last day, when set. */
  endsOn?: string;
  /** How many posts carry the tag. */
  posts: number;
  /** The tag is archived. */
  archived: boolean;
}

/** Counts over the taxonomy. */
export interface TaxonomyCounts {
  /** Collections listed. */
  collections: number;
  /** Tags listed, labels and campaigns together. */
  tags: number;
  /** Tags of kind label. */
  labels: number;
  /** Tags of kind campaign. */
  campaigns: number;
}

/**
 * An answer the API refused, with its HTTP status. A 429 answer also carries
 * the seconds until the limit lifts, read from Retry-After.
 */
export class SocialqError extends Error {
  /** HTTP status of the answer. */
  readonly status: number;
  /** Seconds to wait before trying again, on a 429 answer. */
  readonly retryAfterSeconds: number | undefined;

  /** Builds the error. `retryAfterSeconds` is set for a 429 answer only. */
  constructor(message: string, status: number, retryAfterSeconds?: number) {
    super(message);
    this.name = "SocialqError";
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
    .describe(
      "Origin of the deployment (https://socialq.example.com) or an organization's own host.",
    ),
  clientId: z
    .string()
    .min(1)
    .meta({ sensitive: true })
    .describe(
      "Client id of the Cloudflare Access service token, sent as CF-Access-Client-Id.",
    ),
  clientSecret: z
    .string()
    .min(1)
    .meta({ sensitive: true })
    .describe(
      "Client secret of the service token, sent as CF-Access-Client-Secret.",
    ),
}) satisfies z.ZodType<GlobalArgs>;

const EmptyArgsSchema = z.object({});

const DaySchema = z
  .string()
  .regex(DAY_PATTERN, "a day is YYYY-MM-DD");

const RangeArgsSchema = z.object({
  from: DaySchema.optional().describe(
    "First day, YYYY-MM-DD. Defaults to 30 days before to.",
  ),
  to: DaySchema.optional().describe(
    "Last day, YYYY-MM-DD, inclusive. Defaults to today, UTC.",
  ),
}) satisfies z.ZodType<RangeArgs>;

const JobsArgsSchema = z.object({
  state: z
    .string()
    .default(DEFAULT_JOB_STATES)
    .describe(
      "Job states to list, comma separated: due, leased, done, failed, unknown, dead.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(JOBS_MAX_LIMIT)
    .default(JOBS_DEFAULT_LIMIT)
    .describe("How many jobs to list at most, newest change first."),
}) satisfies z.ZodType<JobsArgs>;

const TaxonomyArgsSchema = z.object({
  archived: z
    .boolean()
    .default(false)
    .describe("Include archived collections and tags."),
}) satisfies z.ZodType<TaxonomyArgs>;

const OrgRefSchema = z.object({
  id: z.string(),
  slug: z.string(),
  role: z.string().optional(),
}) satisfies z.ZodType<OrgRef>;

const HealthResourceSchema = z.object({
  fetchedAt: z.iso.datetime(),
  host: z.string(),
  ok: z.boolean(),
  app: z.string(),
  version: z.string(),
});

const MeResourceSchema = z.object({
  fetchedAt: z.iso.datetime(),
  host: z.string(),
  console: z.boolean(),
  role: z.string().optional(),
  operator: z.boolean(),
  org: OrgRefSchema.optional(),
  orgs: z.array(OrgRefSchema).optional(),
});

const AccountSchema = z.object({
  id: z.string(),
  network: z.string(),
  handle: z.string(),
  status: z.string(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
}) satisfies z.ZodType<Account>;

const AccountStatusCountsSchema = z.object({
  connected: z.number().int(),
  needsReconnect: z.number().int(),
  disconnected: z.number().int(),
}) satisfies z.ZodType<AccountStatusCounts>;

const AccountsResourceSchema = z.object({
  fetchedAt: z.iso.datetime(),
  host: z.string(),
  count: z.number().int(),
  byStatus: AccountStatusCountsSchema,
  accounts: z.array(AccountSchema),
});

const CalendarItemSchema = z.object({
  variantId: z.string(),
  postId: z.string(),
  accountId: z.string(),
  network: z.string(),
  handle: z.string(),
  format: z.string(),
  status: z.string(),
  origin: z.string(),
  day: z.string(),
  attachments: z.number().int(),
  tags: z.number().int(),
}) satisfies z.ZodType<CalendarItem>;

const CalendarResourceSchema = z.object({
  fetchedAt: z.iso.datetime(),
  host: z.string(),
  from: z.string(),
  to: z.string(),
  count: z.number().int(),
  byStatus: z.record(z.string(), z.number().int()),
  items: z.array(CalendarItemSchema),
});

const AccountCoverageSchema = z.object({
  accountId: z.string(),
  network: z.string(),
  handle: z.string(),
  status: z.string(),
  daysWithData: z.number().int(),
  lastCollectedAt: z.string().optional(),
  readAgeDays: z.number().int().optional(),
  backfillPending: z.boolean(),
}) satisfies z.ZodType<AccountCoverage>;

const CoverageResourceSchema = z.object({
  fetchedAt: z.iso.datetime(),
  host: z.string(),
  from: z.string(),
  to: z.string(),
  days: z.number().int(),
  connected: z.number().int(),
  neverRead: z.number().int(),
  oldestReadAgeDays: z.number().int(),
  oldestReadHandle: z.string().optional(),
  accounts: z.array(AccountCoverageSchema),
});

const MetricTotalsSchema = z.record(z.string(), z.number().nullable());

const ReportRowSchema = z.object({
  network: z.string(),
  source: z.string(),
  followers: z.object({
    accounts: z.number().int(),
    measured: z.number().int(),
    atEnd: z.number().nullable(),
    atStart: z.number().nullable(),
  }),
  daily: z.object({
    rows: z.number().int(),
    variants: z.number().int(),
    days: z.number().int(),
    metrics: MetricTotalsSchema,
  }),
  lifetime: z.object({
    published: z.number().int(),
    measured: z.number().int(),
    metrics: MetricTotalsSchema,
  }),
}) satisfies z.ZodType<ReportRow>;

const FollowerReadingSchema = z.object({
  day: z.string(),
  followers: z.number().nullable(),
}) satisfies z.ZodType<FollowerReading>;

const AccountReportSchema = z.object({
  accountId: z.string(),
  network: z.string(),
  handle: z.string(),
  status: z.string(),
  source: z.string(),
  atEnd: FollowerReadingSchema.optional(),
  atStart: FollowerReadingSchema.optional(),
}) satisfies z.ZodType<AccountReport>;

const ReportResourceSchema = z.object({
  fetchedAt: z.iso.datetime(),
  host: z.string(),
  from: z.string(),
  to: z.string(),
  rowCount: z.number().int(),
  accountCount: z.number().int(),
  rows: z.array(ReportRowSchema),
  accounts: z.array(AccountReportSchema),
});

const JobStateCountsSchema = z.object({
  due: z.number().int(),
  leased: z.number().int(),
  done: z.number().int(),
  failed: z.number().int(),
  unknown: z.number().int(),
  dead: z.number().int(),
}) satisfies z.ZodType<JobStateCounts>;

const ActivityJobSchema = z.object({
  id: z.string(),
  kind: z.string(),
  state: z.string(),
  attempts: z.number().int(),
  outcome: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  nextRunAt: z.string().optional(),
  run: z
    .object({
      status: z.string(),
      items: z.number().int(),
      endedAt: z.string().optional(),
    })
    .optional(),
}) satisfies z.ZodType<ActivityJob>;

const AccountActivitySchema = z.object({
  accountId: z.string(),
  network: z.string(),
  handle: z.string(),
  status: z.string(),
  jobs: z.array(ActivityJobSchema),
}) satisfies z.ZodType<AccountActivity>;

const ActivityResourceSchema = z.object({
  fetchedAt: z.iso.datetime(),
  host: z.string(),
  day: z.string(),
  running: z.number().int(),
  jobCount: z.number().int(),
  byState: JobStateCountsSchema,
  accounts: z.array(AccountActivitySchema),
});

const JobSchema = z.object({
  id: z.string(),
  kind: z.string(),
  state: z.string(),
  targetId: z.string().optional(),
  operationKey: z.string().optional(),
  attempts: z.number().int(),
  nextRunAt: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
}) satisfies z.ZodType<Job>;

const JobsResourceSchema = z.object({
  fetchedAt: z.iso.datetime(),
  host: z.string(),
  states: z.array(z.string()),
  limit: z.number().int(),
  count: z.number().int(),
  truncated: z.boolean(),
  byState: JobStateCountsSchema,
  jobs: z.array(JobSchema),
});

const CollectionSchema = z.object({
  id: z.string(),
  parentId: z.string().optional(),
  name: z.string(),
  archived: z.boolean(),
}) satisfies z.ZodType<Collection>;

const TagSchema = z.object({
  id: z.string(),
  collectionId: z.string().optional(),
  kind: z.string(),
  name: z.string(),
  startsOn: z.string().optional(),
  endsOn: z.string().optional(),
  posts: z.number().int(),
  archived: z.boolean(),
}) satisfies z.ZodType<Tag>;

const TaxonomyCountsSchema = z.object({
  collections: z.number().int(),
  tags: z.number().int(),
  labels: z.number().int(),
  campaigns: z.number().int(),
}) satisfies z.ZodType<TaxonomyCounts>;

const TaxonomyResourceSchema = z.object({
  fetchedAt: z.iso.datetime(),
  host: z.string(),
  archived: z.boolean(),
  counts: TaxonomyCountsSchema,
  collections: z.array(CollectionSchema),
  tags: z.array(TagSchema),
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

/** A number the network may not have reported: null stays null, anything else is a number or absent. */
function asNullableNumber(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function recordOf(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function rowsOf(result: unknown, key: string): unknown[] {
  if (isRecord(result) && Array.isArray(result[key])) {
    return result[key] as unknown[];
  }
  return [];
}

/** Drops undefined values so a resource holds only what the API answered. */
function compact<T extends Record<string, unknown>>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) out[key] = entry;
  }
  return out as T;
}

/** The UTC day of an instant, YYYY-MM-DD. */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** The day `n` days after `day`, YYYY-MM-DD. */
export function plusDays(day: string, n: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + n);
  return utcDay(date);
}

/** Whole days from `since` to `now`, never negative; undefined when `since` is not a date. */
export function ageDays(since: string, now: Date): number | undefined {
  const then = Date.parse(since);
  if (Number.isNaN(then)) return undefined;
  return Math.max(0, Math.floor((now.getTime() - then) / DAY_MS));
}

/**
 * The range a calendar or report method reads: the arguments when given,
 * else today and the 30 days before it. Throws before any request when a
 * day is not a calendar day, `to` is before `from`, or the range is longer
 * than the route allows.
 */
export function resolveRange(
  args: RangeArgs,
  maxDays: number,
  now: Date,
): { from: string; to: string; days: number } {
  const to = args.to ?? utcDay(now);
  const from = args.from ?? plusDays(to, -(CALENDAR_DEFAULT_DAYS - 1));
  for (const day of [from, to]) {
    if (!DAY_PATTERN.test(day) || plusDays(day, 0) !== day) {
      throw new Error(`${day} is not a calendar day (YYYY-MM-DD)`);
    }
  }
  if (to < from) throw new Error(`to ${to} is before from ${from}`);
  const days = Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
      DAY_MS,
  ) + 1;
  if (days > maxDays) {
    throw new Error(
      `${from} to ${to} is ${days} days; the route answers at most ${maxDays}`,
    );
  }
  return { from, to, days };
}

/** Reduces an org answer to its id, slug and the token's role there. */
function normalizeOrg(raw: unknown): OrgRef | undefined {
  if (!isRecord(raw)) return undefined;
  const id = asString(raw.id);
  const slug = asString(raw.slug);
  if (id === undefined || slug === undefined) return undefined;
  return compact({ id, slug, role: asString(raw.role) });
}

/** Reduces an account answer to its id, network, handle, status and dates. */
export function normalizeAccount(raw: unknown): Account {
  if (!isRecord(raw)) throw new Error("account answer is not an object");
  const id = asString(raw.id);
  if (id === undefined) throw new Error("account answer carries no id");
  return compact({
    id,
    network: asString(raw.network) ?? "",
    handle: asString(raw.handle) ?? "",
    status: asString(raw.status) ?? "unknown",
    createdAt: asString(raw.created_at),
    updatedAt: asString(raw.updated_at),
  });
}

/** Counts accounts by the statuses socialq documents. */
export function countAccounts(
  accounts: readonly Account[],
): AccountStatusCounts {
  const counts: AccountStatusCounts = {
    connected: 0,
    needsReconnect: 0,
    disconnected: 0,
  };
  for (const account of accounts) {
    if (account.status === "connected") counts.connected++;
    else if (account.status === "needs_reconnect") counts.needsReconnect++;
    else if (account.status === "disconnected") counts.disconnected++;
  }
  return counts;
}

/**
 * Reduces a calendar item to ids, network, handle, format, status, origin,
 * day and two counts. The text, permalink and tag names are never kept.
 */
export function normalizeCalendarItem(raw: unknown): CalendarItem {
  if (!isRecord(raw)) throw new Error("calendar item is not an object");
  const variantId = asString(raw.variant_id);
  if (variantId === undefined) {
    throw new Error("calendar item carries no variant_id");
  }
  return {
    variantId,
    postId: asString(raw.post_id) ?? "",
    accountId: asString(raw.account_id) ?? "",
    network: asString(raw.network) ?? "",
    handle: asString(raw.handle) ?? "",
    format: asString(raw.format) ?? "",
    status: asString(raw.status) ?? "unknown",
    origin: asString(raw.origin) ?? "",
    day: asString(raw.day) ?? (asString(raw.at) ?? "").slice(0, 10),
    attachments: asInteger(raw.attachments) ?? 0,
    tags: Array.isArray(raw.tags) ? raw.tags.length : 0,
  };
}

/** Reduces a coverage row to the account, its day count and when it was last read. */
export function normalizeCoverage(raw: unknown, now: Date): AccountCoverage {
  if (!isRecord(raw)) throw new Error("coverage row is not an object");
  const accountId = asString(raw.account_id);
  if (accountId === undefined) {
    throw new Error("coverage row carries no account_id");
  }
  const lastCollectedAt = asString(raw.last_collected_at);
  return compact({
    accountId,
    network: asString(raw.network) ?? "",
    handle: asString(raw.handle) ?? "",
    status: asString(raw.status) ?? "unknown",
    daysWithData: Array.isArray(raw.days) ? raw.days.length : 0,
    lastCollectedAt,
    readAgeDays: lastCollectedAt === undefined
      ? undefined
      : ageDays(lastCollectedAt, now),
    backfillPending: asBoolean(raw.backfill_pending) ?? false,
  });
}

/**
 * What the coverage resource says about the connected accounts: how many
 * there are, how many the recorder has never read, and the oldest last
 * read among those it has, in whole days (0 when there is none to measure).
 */
export function summarizeCoverage(accounts: readonly AccountCoverage[]): {
  connected: number;
  neverRead: number;
  oldestReadAgeDays: number;
  oldestReadHandle?: string;
} {
  let connected = 0;
  let neverRead = 0;
  let oldestReadAgeDays = 0;
  let oldestReadHandle: string | undefined;
  for (const account of accounts) {
    if (account.status !== "connected") continue;
    connected++;
    if (account.readAgeDays === undefined) {
      neverRead++;
    } else if (
      oldestReadHandle === undefined ||
      account.readAgeDays > oldestReadAgeDays
    ) {
      oldestReadAgeDays = account.readAgeDays;
      oldestReadHandle = account.handle;
    }
  }
  return compact({ connected, neverRead, oldestReadAgeDays, oldestReadHandle });
}

function normalizeTotals(raw: unknown): MetricTotals {
  const totals: MetricTotals = {};
  for (const [metric, value] of Object.entries(recordOf(raw))) {
    const number = asNullableNumber(value);
    if (number !== undefined) totals[metric] = number;
  }
  return totals;
}

/** Reduces a report row to its counts and sums, in camelCase. */
export function normalizeReportRow(raw: unknown): ReportRow {
  if (!isRecord(raw)) throw new Error("report row is not an object");
  const followers = recordOf(raw.followers);
  const daily = recordOf(raw.daily);
  const lifetime = recordOf(raw.lifetime);
  return {
    network: asString(raw.network) ?? "",
    source: asString(raw.source) ?? "",
    followers: {
      accounts: asInteger(followers.accounts) ?? 0,
      measured: asInteger(followers.measured) ?? 0,
      atEnd: asNullableNumber(followers.at_end) ?? null,
      atStart: asNullableNumber(followers.at_start) ?? null,
    },
    daily: {
      rows: asInteger(daily.rows) ?? 0,
      variants: asInteger(daily.variants) ?? 0,
      days: asInteger(daily.days) ?? 0,
      metrics: normalizeTotals(daily.metrics),
    },
    lifetime: {
      published: asInteger(lifetime.published) ?? 0,
      measured: asInteger(lifetime.measured) ?? 0,
      metrics: normalizeTotals(lifetime.metrics),
    },
  };
}

function normalizeReading(raw: unknown): FollowerReading | undefined {
  if (!isRecord(raw)) return undefined;
  const day = asString(raw.day);
  if (day === undefined) return undefined;
  return { day, followers: asNullableNumber(raw.followers) ?? null };
}

/** Reduces an account's report row to its follower readings. */
export function normalizeAccountReport(raw: unknown): AccountReport {
  if (!isRecord(raw)) throw new Error("account report is not an object");
  const accountId = asString(raw.account_id);
  if (accountId === undefined) {
    throw new Error("account report carries no account_id");
  }
  return compact({
    accountId,
    network: asString(raw.network) ?? "",
    handle: asString(raw.handle) ?? "",
    status: asString(raw.status) ?? "unknown",
    source: asString(raw.source) ?? "",
    atEnd: normalizeReading(raw.at_end),
    atStart: normalizeReading(raw.at_start),
  });
}

/** Counts jobs by state over any list of things with a state. */
export function countJobStates(
  jobs: readonly { state: string }[],
): JobStateCounts {
  const counts: JobStateCounts = {
    due: 0,
    leased: 0,
    done: 0,
    failed: 0,
    unknown: 0,
    dead: 0,
  };
  for (const job of jobs) {
    if (job.state in counts) counts[job.state as keyof JobStateCounts]++;
  }
  return counts;
}

/**
 * Reduces a job of the activity answer to its state and outcome. The error
 * text and who asked for the job are never kept.
 */
export function normalizeActivityJob(raw: unknown): ActivityJob {
  if (!isRecord(raw)) throw new Error("activity job is not an object");
  const id = asString(raw.id);
  if (id === undefined) throw new Error("activity job carries no id");
  const run = isRecord(raw.run)
    ? compact({
      status: asString(raw.run.status) ?? "unknown",
      items: asInteger(raw.run.items) ?? 0,
      endedAt: asString(raw.run.ended_at),
    })
    : undefined;
  return compact({
    id,
    kind: asString(raw.kind) ?? "",
    state: asString(raw.state) ?? "unknown",
    attempts: asInteger(raw.attempts) ?? 0,
    outcome: asString(raw.outcome),
    createdAt: asString(raw.created_at),
    updatedAt: asString(raw.updated_at),
    nextRunAt: asString(raw.next_run_at),
    run,
  });
}

/** Reduces an account's activity to the account and its jobs. */
export function normalizeAccountActivity(raw: unknown): AccountActivity {
  if (!isRecord(raw)) throw new Error("account activity is not an object");
  const accountId = asString(raw.account_id);
  if (accountId === undefined) {
    throw new Error("account activity carries no account_id");
  }
  return {
    accountId,
    network: asString(raw.network) ?? "",
    handle: asString(raw.handle) ?? "",
    status: asString(raw.status) ?? "unknown",
    jobs: (Array.isArray(raw.jobs) ? raw.jobs : []).map(normalizeActivityJob),
  };
}

/**
 * Reduces a ledger job to its kind, state, key, attempts and dates. The
 * error text, the handle, the lease and who asked for the job are never kept.
 */
export function normalizeJob(raw: unknown): Job {
  if (!isRecord(raw)) throw new Error("job answer is not an object");
  const id = asString(raw.id);
  if (id === undefined) throw new Error("job answer carries no id");
  return compact({
    id,
    kind: asString(raw.kind) ?? "",
    state: asString(raw.state) ?? "unknown",
    targetId: asString(raw.target_id),
    operationKey: asString(raw.operation_key),
    attempts: asInteger(raw.attempts) ?? 0,
    nextRunAt: asString(raw.next_run_at),
    createdAt: asString(raw.created_at),
    updatedAt: asString(raw.updated_at),
  });
}

/** Reduces a collection to its id, parent, name and whether it is archived. */
export function normalizeCollection(raw: unknown): Collection {
  if (!isRecord(raw)) throw new Error("collection answer is not an object");
  const id = asString(raw.id);
  if (id === undefined) throw new Error("collection answer carries no id");
  return compact({
    id,
    parentId: asString(raw.parent_id),
    name: asString(raw.name) ?? "",
    archived: typeof raw.archived_at === "string",
  });
}

/** Reduces a tag to its id, collection, kind, name, days, post count and archive state. */
export function normalizeTag(raw: unknown): Tag {
  if (!isRecord(raw)) throw new Error("tag answer is not an object");
  const id = asString(raw.id);
  if (id === undefined) throw new Error("tag answer carries no id");
  return compact({
    id,
    collectionId: asString(raw.collection_id),
    kind: asString(raw.kind) ?? "",
    name: asString(raw.name) ?? "",
    startsOn: asString(raw.starts_on),
    endsOn: asString(raw.ends_on),
    posts: asInteger(raw.posts) ?? 0,
    archived: typeof raw.archived_at === "string",
  });
}

/** Parses the `state` argument of `jobs` into the states it names, refusing unknown ones. */
export function parseJobStates(value: string): string[] {
  const states = value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const state of states) {
    if (!(JOB_STATES as readonly string[]).includes(state)) {
      throw new Error(
        `unknown job state '${state}': one of ${JOB_STATES.join(", ")}`,
      );
    }
  }
  return states;
}

function messageOf(parsed: unknown): string | undefined {
  return isRecord(parsed) ? asString(parsed.error) : undefined;
}

function retryAfterSeconds(headers: Headers): number | undefined {
  for (const header of RETRY_HEADERS) {
    const seconds = asInteger(headers.get(header));
    if (seconds !== undefined) return seconds;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Transport: GET and nothing else
// ---------------------------------------------------------------------------

/**
 * Sends one GET with the service token headers and returns the parsed JSON
 * answer. There is no way to send another method: this behavior never
 * writes, and socialq would refuse the token if it tried.
 *
 * Redirects are not followed: Cloudflare Access answers a refused token with
 * one, to its sign-in page, and that is reported as a refusal rather than
 * parsed as an answer. Throws a SocialqError for a 3xx, 4xx or 5xx status
 * and for a body that is not JSON. A 429 error carries `retryAfterSeconds`.
 */
export async function request(
  globalArgs: GlobalArgs,
  path: string,
  query: Record<string, string | number | undefined> = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const url = new URL(globalArgs.host.replace(/\/+$/, "") + path);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, {
    method: "GET",
    headers: {
      [ID_HEADER]: globalArgs.clientId,
      [SECRET_HEADER]: globalArgs.clientSecret,
      Accept: "application/json",
    },
    redirect: "manual",
    signal,
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text === "" ? undefined : JSON.parse(text);
  } catch {
    parsed = undefined;
  }

  const label = `GET ${path}`;
  if (response.status === 429) {
    const seconds = retryAfterSeconds(response.headers);
    const wait = seconds === undefined
      ? ""
      : `, retry after ${seconds} seconds`;
    throw new SocialqError(`${label}: rate limited (429)${wait}`, 429, seconds);
  }
  const message = messageOf(parsed);
  if (!response.ok) {
    const hint = STATUS_HINTS[response.status] ??
      (response.status >= 300 && response.status < 400
        ? STATUS_HINTS[302]
        : undefined);
    const detail = [
      message ??
        (text === "" || parsed === undefined
          ? response.statusText
          : text.slice(0, 200)),
      hint === undefined ? undefined : `(${hint})`,
    ]
      .filter((part) => part !== undefined && part !== "")
      .join(" ");
    throw new SocialqError(
      `${label}: ${response.status} ${detail}`.trimEnd(),
      response.status,
    );
  }
  if (parsed === undefined) {
    throw new SocialqError(
      `${label}: answer was not JSON (${STATUS_HINTS[302]})`,
      response.status,
    );
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Behavior
// ---------------------------------------------------------------------------

/**
 * The behavior definition Swamp registers. Global arguments are `host`,
 * `clientId` and `clientSecret` (both sensitive); see the README for each
 * method, the resource it writes and what that resource keeps.
 */
export const behavior = {
  // String literals, not constants: the registry catalog reads them from the
  // source.
  type: "@reset/socialq",
  version: "2026.10.21.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    health: {
      description: "Whether the deployment answers, and which build it runs",
      schema: HealthResourceSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    me: {
      description: "What the service token is: its role, the organization " +
        "it reads, and on the console the organizations it belongs to",
      schema: MeResourceSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    accounts: {
      description: "The organization's network accounts: id, network, " +
        "handle and status, with counts by status",
      schema: AccountsResourceSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    calendar: {
      description: "The variants placed on each day of a range, as ids, " +
        "statuses and counts; never a post's text",
      schema: CalendarResourceSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    coverage: {
      description: "Per account, how many days of the range have a posts " +
        "collection and how long ago the recorder last read it, with the " +
        "connected, never-read and oldest-read counts for CEL asserts",
      schema: CoverageResourceSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    report: {
      description: "The wrap-up report over a range: followers, daily and " +
        "lifetime sums per network and source, and each account's readings",
      schema: ReportResourceSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    activity: {
      description: "Today's collection jobs per account with their states " +
        "and outcomes, and counts by state; never an error's text",
      schema: ActivityResourceSchema,
      lifetime: "30d",
      garbageCollection: 20,
    },
    jobs: {
      description: "Jobs of the ledger in the asked-for states, by kind, " +
        "key and attempts; never an error, a handle or a requester",
      schema: JobsResourceSchema,
      lifetime: "30d",
      garbageCollection: 20,
    },
    taxonomy: {
      description: "Collections and tags with the number of posts each " +
        "carries; never a brief or who made a tag",
      schema: TaxonomyResourceSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    health: {
      description: "Read /api/health, the one route without a token. " +
        "Writes health.",
      arguments: EmptyArgsSchema,
      execute: async (
        _args: Record<string, never>,
        context: Context,
      ): Promise<MethodResult> => {
        const { globalArgs, signal, logger } = context;
        logger.info("Reading health of {host}", { host: globalArgs.host });
        const raw = recordOf(
          await request(globalArgs, "/api/health", {}, signal),
        );
        const ok = asBoolean(raw.ok) ?? false;
        const version = asString(raw.version) ?? "";
        const handle = await context.writeResource("health", "health", {
          fetchedAt: new Date().toISOString(),
          host: globalArgs.host,
          ok,
          app: asString(raw.app) ?? "",
          version,
        });
        logger.info("{host} answers ok={ok}, build {version}", {
          host: globalArgs.host,
          ok,
          version,
        });
        return { dataHandles: [handle] };
      },
    },
    me: {
      description: "Read /api/me: the token's role and organization, and " +
        "on the deployment's domain the organizations it reads. Writes me.",
      arguments: EmptyArgsSchema,
      execute: async (
        _args: Record<string, never>,
        context: Context,
      ): Promise<MethodResult> => {
        const { globalArgs, signal, logger } = context;
        logger.info("Reading who the token is on {host}", {
          host: globalArgs.host,
        });
        const raw = recordOf(await request(globalArgs, "/api/me", {}, signal));
        const isConsole = asBoolean(raw.console) ?? false;
        const orgs = Array.isArray(raw.orgs)
          ? raw.orgs.map(normalizeOrg).filter((o) => o !== undefined)
          : undefined;
        const me = compact({
          console: isConsole,
          role: asString(raw.role),
          operator: asBoolean(raw.operator) ?? false,
          org: normalizeOrg(raw.org),
          orgs: isConsole ? orgs ?? [] : undefined,
        });
        const handle = await context.writeResource("me", "me", {
          fetchedAt: new Date().toISOString(),
          host: globalArgs.host,
          ...me,
        });
        logger.info(
          "The token is a {role} of {org}{console}",
          {
            role: me.role ?? "non-member",
            org: me.org?.slug ?? "no organization",
            console: isConsole ? ` (console, ${me.orgs?.length} orgs)` : "",
          },
        );
        return { dataHandles: [handle] };
      },
    },
    accounts: {
      description: "List the organization's network accounts with their " +
        "status. Writes accounts.",
      arguments: EmptyArgsSchema,
      execute: async (
        _args: Record<string, never>,
        context: Context,
      ): Promise<MethodResult> => {
        const { globalArgs, signal, logger } = context;
        logger.info("Listing accounts of {host}", { host: globalArgs.host });
        const raw = await request(globalArgs, "/api/accounts", {}, signal);
        const accounts = rowsOf(raw, "accounts").map(normalizeAccount);
        const byStatus = countAccounts(accounts);
        const handle = await context.writeResource("accounts", "accounts", {
          fetchedAt: new Date().toISOString(),
          host: globalArgs.host,
          count: accounts.length,
          byStatus,
          accounts,
        });
        logger.info("Listed {count} accounts, {connected} connected", {
          count: accounts.length,
          connected: byStatus.connected,
        });
        return { dataHandles: [handle] };
      },
    },
    calendar: {
      description: "Read the calendar over a range of at most 62 days " +
        "(default: today and the 30 days before) and the recorder's " +
        "coverage of each account. Writes calendar and coverage.",
      arguments: RangeArgsSchema,
      execute: async (
        args: RangeArgs,
        context: Context,
      ): Promise<MethodResult> => {
        const { globalArgs, signal, logger } = context;
        const now = new Date();
        const range = resolveRange(args, CALENDAR_MAX_DAYS, now);
        logger.info("Reading the calendar of {host} from {from} to {to}", {
          host: globalArgs.host,
          from: range.from,
          to: range.to,
        });
        const raw = await request(
          globalArgs,
          "/api/calendar",
          { from: range.from, to: range.to },
          signal,
        );
        const items = rowsOf(raw, "items").map(normalizeCalendarItem);
        const byStatus: Record<string, number> = {};
        for (const item of items) {
          byStatus[item.status] = (byStatus[item.status] ?? 0) + 1;
        }
        const accounts = rowsOf(raw, "coverage").map((row) =>
          normalizeCoverage(row, now)
        );
        const summary = summarizeCoverage(accounts);
        const fetchedAt = now.toISOString();
        const calendarHandle = await context.writeResource(
          "calendar",
          "calendar",
          {
            fetchedAt,
            host: globalArgs.host,
            from: range.from,
            to: range.to,
            count: items.length,
            byStatus,
            items,
          },
        );
        const coverageHandle = await context.writeResource(
          "coverage",
          "coverage",
          {
            fetchedAt,
            host: globalArgs.host,
            from: range.from,
            to: range.to,
            days: range.days,
            ...summary,
            accounts,
          },
        );
        logger.info(
          "Read {count} items; {connected} connected accounts, {neverRead} never read, oldest read {age} days ago",
          {
            count: items.length,
            connected: summary.connected,
            neverRead: summary.neverRead,
            age: summary.oldestReadAgeDays,
          },
        );
        return { dataHandles: [calendarHandle, coverageHandle] };
      },
    },
    report: {
      description: "Read the wrap-up report over a range of at most 366 " +
        "days (default: today and the 30 days before). Writes report.",
      arguments: RangeArgsSchema,
      execute: async (
        args: RangeArgs,
        context: Context,
      ): Promise<MethodResult> => {
        const { globalArgs, signal, logger } = context;
        const range = resolveRange(args, REPORT_MAX_DAYS, new Date());
        logger.info("Reading the report of {host} from {from} to {to}", {
          host: globalArgs.host,
          from: range.from,
          to: range.to,
        });
        const raw = await request(
          globalArgs,
          "/api/reports",
          { from: range.from, to: range.to },
          signal,
        );
        const rows = rowsOf(raw, "rows").map(normalizeReportRow);
        const accounts = rowsOf(raw, "accounts").map(normalizeAccountReport);
        const handle = await context.writeResource("report", "report", {
          fetchedAt: new Date().toISOString(),
          host: globalArgs.host,
          from: range.from,
          to: range.to,
          rowCount: rows.length,
          accountCount: accounts.length,
          rows,
          accounts,
        });
        logger.info("Read {rows} report rows over {accounts} accounts", {
          rows: rows.length,
          accounts: accounts.length,
        });
        return { dataHandles: [handle] };
      },
    },
    activity: {
      description: "Read today's collection jobs per account with their " +
        "states and outcomes. Writes activity.",
      arguments: EmptyArgsSchema,
      execute: async (
        _args: Record<string, never>,
        context: Context,
      ): Promise<MethodResult> => {
        const { globalArgs, signal, logger } = context;
        logger.info("Reading today's activity on {host}", {
          host: globalArgs.host,
        });
        const raw = recordOf(
          await request(globalArgs, "/api/activity", {}, signal),
        );
        const accounts = rowsOf(raw, "accounts").map(
          normalizeAccountActivity,
        );
        const jobs = accounts.flatMap((account) => account.jobs);
        const byState = countJobStates(jobs);
        const handle = await context.writeResource("activity", "activity", {
          fetchedAt: new Date().toISOString(),
          host: globalArgs.host,
          day: asString(raw.day) ?? utcDay(new Date()),
          running: asInteger(raw.running) ?? byState.due + byState.leased,
          jobCount: jobs.length,
          byState,
          accounts,
        });
        logger.info(
          "Read {count} jobs on {accounts} accounts: {failed} failed, {unknown} unknown, {dead} dead",
          {
            count: jobs.length,
            accounts: accounts.length,
            failed: byState.failed,
            unknown: byState.unknown,
            dead: byState.dead,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    jobs: {
      description: "List the ledger's jobs in the given states (default " +
        "failed, dead and unknown), newest change first. Administrators " +
        "only on socialq, which a service token never is: see the README. " +
        "Writes jobs.",
      arguments: JobsArgsSchema,
      execute: async (
        args: JobsArgs,
        context: Context,
      ): Promise<MethodResult> => {
        const { globalArgs, signal, logger } = context;
        const states = parseJobStates(args.state);
        logger.info("Listing {states} jobs on {host}, up to {limit}", {
          states: states.length === 0 ? "all" : states.join(", "),
          host: globalArgs.host,
          limit: args.limit,
        });
        const raw = await request(
          globalArgs,
          "/api/jobs",
          {
            state: states.length === 0 ? undefined : states.join(","),
            limit: args.limit,
          },
          signal,
        );
        const jobs = rowsOf(raw, "jobs").map(normalizeJob);
        const byState = countJobStates(jobs);
        const handle = await context.writeResource("jobs", "jobs", {
          fetchedAt: new Date().toISOString(),
          host: globalArgs.host,
          states,
          limit: args.limit,
          count: jobs.length,
          truncated: jobs.length >= args.limit,
          byState,
          jobs,
        });
        logger.info("Listed {count} jobs ({dead} dead, {unknown} unknown)", {
          count: jobs.length,
          dead: byState.dead,
          unknown: byState.unknown,
        });
        return { dataHandles: [handle] };
      },
    },
    taxonomy: {
      description: "Read the collections and tags, archived ones when " +
        "asked, with how many posts carry each tag. Writes taxonomy.",
      arguments: TaxonomyArgsSchema,
      execute: async (
        args: TaxonomyArgs,
        context: Context,
      ): Promise<MethodResult> => {
        const { globalArgs, signal, logger } = context;
        logger.info("Reading the taxonomy of {host}", {
          host: globalArgs.host,
        });
        const raw = await request(
          globalArgs,
          "/api/taxonomy",
          { archived: args.archived ? 1 : undefined },
          signal,
        );
        const collections = rowsOf(raw, "collections").map(
          normalizeCollection,
        );
        const tags = rowsOf(raw, "tags").map(normalizeTag);
        const counts: TaxonomyCounts = {
          collections: collections.length,
          tags: tags.length,
          labels: tags.filter((t) => t.kind === "label").length,
          campaigns: tags.filter((t) => t.kind === "campaign").length,
        };
        const handle = await context.writeResource("taxonomy", "taxonomy", {
          fetchedAt: new Date().toISOString(),
          host: globalArgs.host,
          archived: args.archived,
          counts,
          collections,
          tags,
        });
        logger.info(
          "Read {collections} collections, {labels} labels and {campaigns} campaigns",
          counts,
        );
        return { dataHandles: [handle] };
      },
    },
  },
};

/** The account statuses socialq documents, for callers that count them. */
export const accountStatuses: readonly string[] = ACCOUNT_STATUSES;
/** The job states the ledger knows, for callers that filter on them. */
export const jobStates: readonly string[] = JOB_STATES;
