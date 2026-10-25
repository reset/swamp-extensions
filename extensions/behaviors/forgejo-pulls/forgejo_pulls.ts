/**
 * A Swamp behavior for pull requests on a Forgejo forge (Gitea answers the
 * same routes): list and read pull requests, read a commit's statuses by
 * context, list and post comments, and ask the repository's merge bot to merge
 * by posting the marker line it listens for. Every method writes what it read
 * as a resource, so a workflow can gate the ask on the statuses with CEL.
 * Resources keep numbers, titles, states, shas, branch names, status contexts
 * and states, timestamps and counts: never a body, and nothing about a person.
 *
 * @module
 */

import { z } from "npm:zod@4";

const API_PREFIX = "/api/v1";
const ACCESS_ID_HEADER = "CF-Access-Client-Id";
const ACCESS_SECRET_HEADER = "CF-Access-Client-Secret";
const DEFAULT_MERGE_MARKER = "=merge=";
const DEFAULT_RUSH_MARKER = "=rush=";

/** Forgejo answers at most 50 rows per page unless the site raises the cap. */
const PAGE_SIZE = 50;
/** Pages of statuses read for one commit before the resource is marked truncated. */
const STATUS_PAGES = 10;
/** Longest status description a resource keeps. */
const DESCRIPTION_LIMIT = 200;

/**
 * An owner or repository name as Forgejo allows it: letters, digits, `-`, `_`
 * and `.`, never `.` or `..` alone. It goes into the request path as written,
 * so nothing that could move the request (and its token) to another route
 * gets through.
 */
const NAME_PATTERN = /^(?!\.\.?$)[\w.-]+$/;

const PULL_STATES = ["open", "closed", "all"] as const;
const ASKS = ["merge", "rush", "none"] as const;

/** What a status code means when the answer carries no message of its own. */
const STATUS_HINTS: Record<number, string> = {
  401: "the token is missing or invalid",
  403: "the token lacks the scope, or its user cannot act on the repository",
  404: "not found, or the token cannot see the repository",
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Global arguments every method reads from the behavior definition. */
export interface GlobalArgs {
  /** Base URL of the forge, such as https://forge.example.com. */
  host: string;
  /** Access token, sent as `Authorization: token ...`. Sensitive. */
  token: string;
  /** Default repository owner. A method argument overrides it. */
  owner?: string;
  /** Default repository name. A method argument overrides it. */
  repo?: string;
  /** Cloudflare Access service token id, sent as CF-Access-Client-Id. */
  accessClientId?: string;
  /** Cloudflare Access service token secret, sent as CF-Access-Client-Secret. Sensitive. */
  accessClientSecret?: string;
  /** The line the merge bot reads as a merge ask. */
  mergeMarker: string;
  /** The line the merge bot reads as an untested merge ask. */
  rushMarker: string;
}

/** The two marker lines, as `asksOf` reads them. */
export interface Markers {
  /** The merge ask. */
  mergeMarker: string;
  /** The untested merge ask. */
  rushMarker: string;
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

/** Which marker a text asks with: `rush` wins over `merge`. */
export type Ask = "merge" | "rush" | "none";

/** One pull request as the `pulls` and `pull` resources keep it. */
export interface Pull {
  /** The pull request's number in its repository. */
  number: number;
  /** The title. */
  title: string;
  /** open or closed. A merged pull request is closed with `merged` true. */
  state: string;
  /** Marked as a draft, which the merge bot does not merge. */
  draft: boolean;
  /** Merged already. */
  merged: boolean;
  /** The forge's verdict on whether it can merge, when it has one. */
  mergeable?: boolean;
  /** Head branch name. */
  headRef: string;
  /** Head commit, the one statuses are reported against. */
  headSha: string;
  /** Base branch name. */
  baseRef: string;
  /** Base branch tip when the forge answered. */
  baseSha: string;
  /** Opened at, as the forge reports it. */
  createdAt: string;
  /** Last change, as the forge reports it. */
  updatedAt: string;
  /** Closed at, when closed. */
  closedAt?: string;
  /** Merged at, when merged. */
  mergedAt?: string;
  /** The merge commit, when merged. */
  mergeCommitSha?: string;
  /** How many comments it has. */
  comments: number;
  /** Where to read it. */
  htmlUrl: string;
  /** Which marker the body asks with, read as the merge bot reads it. */
  asks: Ask;
}

/** One commit status, the latest for its context. */
export interface Status {
  /** The status id. */
  id: number;
  /** The reporter's context, such as `buildq`. */
  context: string;
  /** pending, success, error, failure, warning or skipped. */
  state: string;
  /** The reporter's one-line description, cut to 200 characters. */
  description?: string;
  /** Where the reporter points, such as the build's page. */
  targetUrl?: string;
  /** Reported at. */
  createdAt?: string;
  /** Last change. */
  updatedAt?: string;
}

/** Whether every required context reports success. */
export interface StatusGate {
  /** The contexts the gate requires. */
  contexts: string[];
  /** Every required context reports success. True when none is required. */
  passed: boolean;
  /** Required contexts that are missing or not successful, with their state. */
  unmet: string[];
}

/** One comment as the `comments` resource keeps it: never its text. */
export interface CommentRef {
  /** The comment id. */
  id: number;
  /** Posted at. */
  createdAt: string;
  /** Last edit. */
  updatedAt: string;
  /** Which marker the comment asks with. */
  asks: Ask;
}

/** How many comments ask with each marker. */
export interface AskCounts {
  /** Comments whose line starts with the merge marker. */
  merge: number;
  /** Comments whose line starts with the rush marker. */
  rush: number;
}

/** Arguments naming a repository. Each falls back to the global of its name. */
export interface RepoArgs {
  /** Repository owner. */
  owner?: string;
  /** Repository name. */
  repo?: string;
}

/** Arguments of the `pulls` method. */
export interface PullsArgs extends RepoArgs {
  /** open, closed or all. */
  state: "open" | "closed" | "all";
  /** First page to fetch, 1-based. */
  page: number;
  /** How many pages of 50 to fetch. */
  pages: number;
}

/** Arguments naming one pull request. */
export interface PullArgs extends RepoArgs {
  /** The pull request's number. */
  number: number;
}

/** Arguments of the `statuses` method. Exactly one of number or sha. */
export interface StatusesArgs extends RepoArgs {
  /** The pull request whose head commit to read. */
  number?: number;
  /** The commit to read, as a hex sha. */
  sha?: string;
  /** Contexts that must report success for the gate to pass. */
  required: string[];
}

/** Arguments of the `comment` method. */
export interface CommentArgs extends PullArgs {
  /** The comment's text. Posted, never stored. */
  body: string;
}

/** One request to the API. */
export interface RequestOptions {
  /** HTTP method. */
  method: "GET" | "POST";
  /** Path under /api/v1, starting with a slash. */
  path: string;
  /** Query parameters. Undefined values are left out. */
  query?: Record<string, string | number | undefined>;
  /** JSON body for POST. */
  body?: Record<string, unknown>;
}

/** What one request answered. */
export interface Answer {
  /** The parsed JSON body, or undefined for an empty body. */
  data: unknown;
  /** The answer's headers, for X-Total-Count. */
  headers: Headers;
}

/**
 * An answer the forge refused, with its HTTP status. A 429 answer also carries
 * the seconds until the rate-limit window resets, read from Retry-After.
 */
export class ForgejoError extends Error {
  /** HTTP status of the answer. */
  readonly status: number;
  /** Seconds to wait before trying again, on a 429 answer. */
  readonly retryAfterSeconds: number | undefined;

  /** Builds the error. `retryAfterSeconds` is set for a 429 answer only. */
  constructor(message: string, status: number, retryAfterSeconds?: number) {
    super(message);
    this.name = "ForgejoError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// ---------------------------------------------------------------------------
// Schemas (private: the exported interfaces above are the public types, and
// `satisfies` keeps each schema in step with its interface)
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  host: z.url()
    .describe("Base URL of the forge, such as https://forge.example.com."),
  token: z.string()
    .min(1)
    .meta({ sensitive: true })
    .describe(
      "Access token, sent as Authorization: token. Reading needs read:repository; comment, ask-merge and ask-rush need write:issue.",
    ),
  owner: z.string()
    .min(1)
    .regex(NAME_PATTERN)
    .optional()
    .describe("Default repository owner. A method argument overrides it."),
  repo: z.string()
    .min(1)
    .regex(NAME_PATTERN)
    .optional()
    .describe("Default repository name. A method argument overrides it."),
  accessClientId: z.string()
    .min(1)
    .optional()
    .describe(
      "Cloudflare Access service token id, sent as CF-Access-Client-Id when the forge sits behind Access. Set both or neither.",
    ),
  accessClientSecret: z.string()
    .min(1)
    .optional()
    .meta({ sensitive: true })
    .describe(
      "Cloudflare Access service token secret, sent as CF-Access-Client-Secret. Set both or neither.",
    ),
  mergeMarker: z.string()
    .min(1)
    .default(DEFAULT_MERGE_MARKER)
    .describe("The line the merge bot reads as a merge ask."),
  rushMarker: z.string()
    .min(1)
    .default(DEFAULT_RUSH_MARKER)
    .describe("The line the merge bot reads as an untested merge ask."),
}) satisfies z.ZodType<GlobalArgs>;

const PullsArgsSchema = z.object({
  owner: z.string()
    .min(1)
    .regex(NAME_PATTERN)
    .optional()
    .describe("Repository owner. Falls back to the global owner."),
  repo: z.string()
    .min(1)
    .regex(NAME_PATTERN)
    .optional()
    .describe("Repository name. Falls back to the global repo."),
  state: z.enum(PULL_STATES)
    .default("open")
    .describe("open, closed or all."),
  page: z.number()
    .int()
    .min(1)
    .default(1)
    .describe("First page to fetch, 1-based."),
  pages: z.number()
    .int()
    .min(1)
    .max(20)
    .default(1)
    .describe("How many pages of 50 pull requests to fetch."),
}) satisfies z.ZodType<PullsArgs>;

const PullArgsSchema = z.object({
  owner: z.string()
    .min(1)
    .regex(NAME_PATTERN)
    .optional()
    .describe("Repository owner. Falls back to the global owner."),
  repo: z.string()
    .min(1)
    .regex(NAME_PATTERN)
    .optional()
    .describe("Repository name. Falls back to the global repo."),
  number: z.number()
    .int()
    .positive()
    .describe("The pull request's number."),
}) satisfies z.ZodType<PullArgs>;

const StatusesArgsSchema = z.object({
  owner: z.string()
    .min(1)
    .regex(NAME_PATTERN)
    .optional()
    .describe("Repository owner. Falls back to the global owner."),
  repo: z.string()
    .min(1)
    .regex(NAME_PATTERN)
    .optional()
    .describe("Repository name. Falls back to the global repo."),
  number: z.number()
    .int()
    .positive()
    .optional()
    .describe("The pull request whose head commit to read."),
  sha: z.string()
    .regex(/^[0-9a-f]{7,64}$/i)
    .optional()
    .describe("The commit to read, as a hex sha."),
  required: z.array(z.string().min(1))
    .default([])
    .describe(
      "Contexts that must report success for the gate to pass, such as buildq.",
    ),
})
  .refine(
    (value) => (value.number === undefined) !== (value.sha === undefined),
    {
      message: "Give exactly one of number or sha.",
    },
  ) satisfies z.ZodType<StatusesArgs>;

const CommentArgsSchema = z.object({
  owner: z.string()
    .min(1)
    .regex(NAME_PATTERN)
    .optional()
    .describe("Repository owner. Falls back to the global owner."),
  repo: z.string()
    .min(1)
    .regex(NAME_PATTERN)
    .optional()
    .describe("Repository name. Falls back to the global repo."),
  number: z.number()
    .int()
    .positive()
    .describe("The pull request's number."),
  body: z.string()
    .min(1)
    .describe("The comment's text. Posted, never stored."),
}) satisfies z.ZodType<CommentArgs>;

const AskSchema = z.enum(ASKS);

const PullSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  state: z.string(),
  draft: z.boolean(),
  merged: z.boolean(),
  mergeable: z.boolean().optional(),
  headRef: z.string(),
  headSha: z.string(),
  baseRef: z.string(),
  baseSha: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  closedAt: z.string().optional(),
  mergedAt: z.string().optional(),
  mergeCommitSha: z.string().optional(),
  comments: z.number().int(),
  htmlUrl: z.string(),
  asks: AskSchema,
}) satisfies z.ZodType<Pull>;

const PullsResourceSchema = z.object({
  fetchedAt: z.iso.datetime(),
  host: z.string(),
  owner: z.string(),
  repo: z.string(),
  state: z.string(),
  firstPage: z.number().int(),
  pagesFetched: z.number().int(),
  count: z.number().int(),
  truncated: z.boolean(),
  pulls: z.array(PullSchema),
});

const PullResourceSchema = PullSchema.extend({
  fetchedAt: z.iso.datetime(),
  host: z.string(),
  owner: z.string(),
  repo: z.string(),
});

const StatusSchema = z.object({
  id: z.number().int(),
  context: z.string(),
  state: z.string(),
  description: z.string().optional(),
  targetUrl: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
}) satisfies z.ZodType<Status>;

const StatusGateSchema = z.object({
  contexts: z.array(z.string()),
  passed: z.boolean(),
  unmet: z.array(z.string()),
}) satisfies z.ZodType<StatusGate>;

const StatusesResourceSchema = z.object({
  fetchedAt: z.iso.datetime(),
  host: z.string(),
  owner: z.string(),
  repo: z.string(),
  number: z.number().int().optional(),
  sha: z.string(),
  state: z.string(),
  count: z.number().int(),
  truncated: z.boolean(),
  required: StatusGateSchema,
  statuses: z.array(StatusSchema),
});

const CommentRefSchema = z.object({
  id: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  asks: AskSchema,
}) satisfies z.ZodType<CommentRef>;

const AskCountsSchema = z.object({
  merge: z.number().int(),
  rush: z.number().int(),
}) satisfies z.ZodType<AskCounts>;

const CommentsResourceSchema = z.object({
  fetchedAt: z.iso.datetime(),
  host: z.string(),
  owner: z.string(),
  repo: z.string(),
  number: z.number().int(),
  count: z.number().int(),
  asks: AskCountsSchema,
  comments: z.array(CommentRefSchema),
});

const CommentResourceSchema = z.object({
  postedAt: z.iso.datetime(),
  host: z.string(),
  owner: z.string(),
  repo: z.string(),
  number: z.number().int(),
  id: z.number().int(),
  htmlUrl: z.string(),
  asks: AskSchema,
});

// ---------------------------------------------------------------------------
// Answer parsing
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
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

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** Drops undefined values so a resource holds only what the forge answered. */
function compact<T extends Record<string, unknown>>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) out[key] = entry;
  }
  return out as T;
}

/**
 * Reads a text the way a marker-driven merge bot does: a line that starts
 * with a marker, after any indentation and with text after it allowed, asks.
 * A marker mid-line, in a list item, a quote, backticks or a fenced code block
 * does not. The rush marker wins when both are present.
 */
export function asksOf(text: string, markers: Markers): Ask {
  let fenced = false;
  let ask: Ask = "none";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("```") || line.startsWith("~~~")) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (line.startsWith(markers.rushMarker)) return "rush";
    if (line.startsWith(markers.mergeMarker)) ask = "merge";
  }
  return ask;
}

/** Reduces a pull request answer to the fields the `pulls` and `pull` resources keep. */
export function normalizePull(raw: unknown, markers: Markers): Pull {
  if (!isRecord(raw)) throw new Error("pull request answer is not an object");
  const number = asInteger(raw.number);
  if (number === undefined) {
    throw new Error("pull request answer carries no number");
  }
  const head = isRecord(raw.head) ? raw.head : {};
  const base = isRecord(raw.base) ? raw.base : {};
  return compact({
    number,
    title: asString(raw.title) ?? "",
    state: asString(raw.state) ?? "unknown",
    draft: asBoolean(raw.draft) ?? false,
    merged: asBoolean(raw.merged) ?? false,
    mergeable: asBoolean(raw.mergeable),
    headRef: asString(head.ref) ?? "",
    headSha: asString(head.sha) ?? "",
    baseRef: asString(base.ref) ?? "",
    baseSha: asString(base.sha) ?? "",
    createdAt: asString(raw.created_at) ?? "",
    updatedAt: asString(raw.updated_at) ?? "",
    closedAt: asString(raw.closed_at),
    mergedAt: asString(raw.merged_at),
    mergeCommitSha: asString(raw.merge_commit_sha),
    comments: asInteger(raw.comments) ?? 0,
    htmlUrl: asString(raw.html_url) ?? "",
    asks: asksOf(asString(raw.body) ?? "", markers),
  });
}

/** Reduces a commit status answer to the fields the `statuses` resource keeps. */
export function normalizeStatus(raw: unknown): Status {
  if (!isRecord(raw)) throw new Error("status answer is not an object");
  const id = asInteger(raw.id);
  if (id === undefined) throw new Error("status answer carries no id");
  const description = asString(raw.description);
  return compact({
    id,
    context: asString(raw.context) ?? "",
    state: asString(raw.status) ?? asString(raw.state) ?? "unknown",
    description: description === undefined
      ? undefined
      : description.slice(0, DESCRIPTION_LIMIT),
    targetUrl: asString(raw.target_url),
    createdAt: asString(raw.created_at),
    updatedAt: asString(raw.updated_at),
  });
}

/** Reduces a comment answer to its id, timestamps and ask. The text is dropped. */
export function normalizeComment(raw: unknown, markers: Markers): CommentRef {
  if (!isRecord(raw)) throw new Error("comment answer is not an object");
  const id = asInteger(raw.id);
  if (id === undefined) throw new Error("comment answer carries no id");
  return {
    id,
    createdAt: asString(raw.created_at) ?? "",
    updatedAt: asString(raw.updated_at) ?? "",
    asks: asksOf(asString(raw.body) ?? "", markers),
  };
}

/** Judges the required contexts against the statuses read for a commit. */
export function gateOf(
  statuses: readonly Status[],
  contexts: readonly string[],
): StatusGate {
  const unmet: string[] = [];
  for (const context of contexts) {
    const status = statuses.find((s) => s.context === context);
    if (status === undefined) unmet.push(`${context}: missing`);
    else if (status.state !== "success") {
      unmet.push(`${context}: ${status.state}`);
    }
  }
  return { contexts: [...contexts], passed: unmet.length === 0, unmet };
}

/** Counts the comments that ask with each marker. */
export function countAsks(comments: readonly CommentRef[]): AskCounts {
  const counts: AskCounts = { merge: 0, rush: 0 };
  for (const comment of comments) {
    if (comment.asks !== "none") counts[comment.asks]++;
  }
  return counts;
}

function messageOf(parsed: unknown): string | undefined {
  return isRecord(parsed) ? asString(parsed.message) : undefined;
}

function totalCountOf(headers: Headers): number | undefined {
  return asInteger(headers.get("X-Total-Count"));
}

/**
 * Whether the answer's Link header offers a next page, or undefined without a
 * Link header. Forgejo offers one exactly while rows lie beyond this page,
 * counted in the page size it served, which a site may cap below 50.
 */
function hasNextLink(headers: Headers): boolean | undefined {
  const link = headers.get("Link");
  if (link === null) return undefined;
  return link.split(",").some((part) =>
    /;\s*rel="?next"?(\s*;|\s*$)/.test(part)
  );
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** The headers every request carries. The secrets go nowhere else. */
function headersOf(globalArgs: GlobalArgs): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `token ${globalArgs.token}`,
    Accept: "application/json",
  };
  const id = globalArgs.accessClientId;
  const secret = globalArgs.accessClientSecret;
  if ((id === undefined) !== (secret === undefined)) {
    throw new Error(
      "accessClientId and accessClientSecret go together: set both or neither",
    );
  }
  if (id !== undefined && secret !== undefined) {
    headers[ACCESS_ID_HEADER] = id;
    headers[ACCESS_SECRET_HEADER] = secret;
  }
  return headers;
}

/**
 * Sends one request under /api/v1 with the token and, when set, the Cloudflare
 * Access headers, and returns the parsed answer with its headers.
 *
 * Throws a ForgejoError for a 4xx or 5xx status, for a redirect (an access
 * proxy in front of the forge sends one when the Access headers are missing),
 * and for a body that is not JSON. A 429 error carries `retryAfterSeconds`.
 */
export async function request(
  globalArgs: GlobalArgs,
  options: RequestOptions,
  signal?: AbortSignal,
): Promise<Answer> {
  const url = new URL(
    globalArgs.host.replace(/\/+$/, "") + API_PREFIX + options.path,
  );
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const headers = headersOf(globalArgs);
  const body = options.body === undefined
    ? undefined
    : JSON.stringify(options.body);
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const response = await fetch(url, {
    method: options.method,
    headers,
    body,
    signal,
    redirect: "manual",
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text === "" ? undefined : JSON.parse(text);
  } catch {
    parsed = undefined;
  }

  const label = `${options.method} ${API_PREFIX}${options.path}`;
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("Location") ?? "";
    let target = "elsewhere";
    try {
      target = new URL(location, url).host;
    } catch {
      // A relative or malformed Location: the host is enough of a hint.
    }
    throw new ForgejoError(
      `${label}: redirected (${response.status}) to ${target}; an access proxy in front of the forge answers this way when accessClientId and accessClientSecret are missing or wrong`,
      response.status,
    );
  }
  if (response.status === 429) {
    const seconds = asInteger(response.headers.get("Retry-After"));
    const wait = seconds === undefined
      ? ""
      : `, retry after ${seconds} seconds`;
    throw new ForgejoError(`${label}: rate limited (429)${wait}`, 429, seconds);
  }
  if (!response.ok) {
    const hint = STATUS_HINTS[response.status];
    const detail = [
      messageOf(parsed) ??
        (text === "" ? response.statusText : text.slice(0, 200)),
      hint === undefined ? undefined : `(${hint})`,
    ]
      .filter((part) => part !== undefined && part !== "")
      .join(" ");
    throw new ForgejoError(
      `${label}: ${response.status} ${detail}`,
      response.status,
    );
  }
  if (text !== "" && parsed === undefined) {
    throw new ForgejoError(`${label}: answer was not JSON`, response.status);
  }
  return { data: parsed, headers: response.headers };
}

/** The repository a method acts on: its arguments, else the globals. */
export function repoOf(
  args: RepoArgs,
  globalArgs: GlobalArgs,
): { owner: string; repo: string } {
  const owner = args.owner ?? globalArgs.owner;
  const repo = args.repo ?? globalArgs.repo;
  if (owner === undefined || repo === undefined) {
    throw new Error(
      "the method needs a repository: pass owner and repo, or set them as global arguments",
    );
  }
  for (const [field, value] of [["owner", owner], ["repo", repo]]) {
    if (!NAME_PATTERN.test(value)) {
      throw new Error(
        `${field} ${
          JSON.stringify(value)
        } is not a Forgejo name: letters, digits, -, _ and . only, and not . or ..`,
      );
    }
  }
  return { owner, repo };
}

/** Fetches one pull request by number. */
async function fetchPull(
  context: Context,
  owner: string,
  repo: string,
  number: number,
): Promise<Pull> {
  const { globalArgs, signal } = context;
  const answer = await request(
    globalArgs,
    { method: "GET", path: `/repos/${owner}/${repo}/pulls/${number}` },
    signal,
  );
  return normalizePull(answer.data, globalArgs);
}

/** Writes the `pull` resource for one pull request. */
function writePull(
  context: Context,
  owner: string,
  repo: string,
  pull: Pull,
): Promise<DataHandle> {
  return context.writeResource(
    "pull",
    `pull-${owner}-${repo}-${pull.number}`,
    {
      fetchedAt: new Date().toISOString(),
      host: context.globalArgs.host,
      owner,
      repo,
      ...pull,
    },
  );
}

/** Posts one comment and writes the `comment` resource. */
async function postComment(
  context: Context,
  owner: string,
  repo: string,
  number: number,
  body: string,
): Promise<DataHandle> {
  const { globalArgs, signal, logger } = context;
  const answer = await request(
    globalArgs,
    {
      method: "POST",
      path: `/repos/${owner}/${repo}/issues/${number}/comments`,
      body: { body },
    },
    signal,
  );
  if (!isRecord(answer.data)) {
    throw new Error(
      `POST /api/v1/repos/${owner}/${repo}/issues/${number}/comments: answer is not a comment`,
    );
  }
  const id = asInteger(answer.data.id);
  if (id === undefined) {
    throw new Error(
      `POST /api/v1/repos/${owner}/${repo}/issues/${number}/comments: answer carries no comment id`,
    );
  }
  const asks = asksOf(body, globalArgs);
  const handle = await context.writeResource(
    "comment",
    `comment-${owner}-${repo}-${id}`,
    {
      postedAt: new Date().toISOString(),
      host: globalArgs.host,
      owner,
      repo,
      number,
      id,
      htmlUrl: asString(answer.data.html_url) ?? "",
      asks,
    },
  );
  logger.info("Posted comment {id} on {owner}/{repo}#{number} (asks {asks})", {
    id,
    owner,
    repo,
    number,
    asks,
  });
  return handle;
}

/**
 * Posts a marker as a comment on an open, unmerged pull request, then
 * re-reads the pull request. Writes `comment` and `pull`.
 */
async function ask(
  args: PullArgs,
  context: Context,
  marker: string,
  verb: string,
): Promise<MethodResult> {
  const { globalArgs, logger } = context;
  const { owner, repo } = repoOf(args, globalArgs);
  const before = await fetchPull(context, owner, repo, args.number);
  if (before.merged) {
    throw new Error(
      `${owner}/${repo}#${args.number} is already merged (${
        before.mergeCommitSha ?? "merge commit unknown"
      })`,
    );
  }
  if (before.state !== "open") {
    throw new Error(
      `${owner}/${repo}#${args.number} is ${before.state}, not open`,
    );
  }
  logger.info("{verb} {owner}/{repo}#{number} on {host}: {title}", {
    verb,
    owner,
    repo,
    number: args.number,
    host: globalArgs.host,
    title: before.title,
  });
  const commentHandle = await postComment(
    context,
    owner,
    repo,
    args.number,
    marker,
  );
  const after = await fetchPull(context, owner, repo, args.number);
  const pullHandle = await writePull(context, owner, repo, after);
  logger.info(
    "{owner}/{repo}#{number} is {state} with {comments} comments after the ask",
    {
      owner,
      repo,
      number: after.number,
      state: after.merged ? "merged" : after.state,
      comments: after.comments,
    },
  );
  return { dataHandles: [commentHandle, pullHandle] };
}

// ---------------------------------------------------------------------------
// Behavior
// ---------------------------------------------------------------------------

/**
 * The behavior definition Swamp registers. Global arguments are `host`,
 * `token` (sensitive), optional `owner` and `repo` defaults, optional
 * Cloudflare Access credentials and the two markers; see the README for each
 * method, the resource it writes and the instance name it writes it under.
 */
export const behavior = {
  // String literals, not constants: the registry catalog reads them from the
  // source. The collective is provisional, rename it here.
  type: "@reset/forgejo-pulls",
  version: "2026.10.24.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    pulls: {
      description: "A page range of one repository's pull requests with the " +
        "state filter it was taken with",
      schema: PullsResourceSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    pull: {
      description: "One pull request, written by pull, ask-merge and ask-rush",
      schema: PullResourceSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    statuses: {
      description: "The latest status of each context on one commit, the " +
        "combined state, and whether every required context passed",
      schema: StatusesResourceSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    comments: {
      description: "One pull request's comments: ids, timestamps and which " +
        "marker each asks with, never the text",
      schema: CommentsResourceSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    comment: {
      description: "A comment this behavior posted: its id, where it is " +
        "and which marker it asks with, never the text",
      schema: CommentResourceSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    pulls: {
      description: "List a repository's pull requests, 50 per page, open by " +
        "default. Writes pulls-<owner>-<repo>.",
      arguments: PullsArgsSchema,
      execute: async (
        args: PullsArgs,
        context: Context,
      ): Promise<MethodResult> => {
        const { globalArgs, signal, logger } = context;
        const { owner, repo } = repoOf(args, globalArgs);
        logger.info(
          "Listing {state} pull requests of {owner}/{repo} on {host}: pages {first} to {last}",
          {
            state: args.state,
            owner,
            repo,
            host: globalArgs.host,
            first: args.page,
            last: args.page + args.pages - 1,
          },
        );
        const pulls: Pull[] = [];
        let more = false;
        let pagesFetched = 0;
        for (let page = args.page; page < args.page + args.pages; page++) {
          const answer = await request(
            globalArgs,
            {
              method: "GET",
              path: `/repos/${owner}/${repo}/pulls`,
              query: { state: args.state, page, limit: PAGE_SIZE },
            },
            signal,
          );
          const rows = Array.isArray(answer.data) ? answer.data : [];
          pagesFetched++;
          for (const row of rows) pulls.push(normalizePull(row, globalArgs));
          logger.debug("Page {page}: {count} pull requests", {
            page,
            count: rows.length,
          });
          // Whether rows lie beyond this page. X-Total-Count counts every
          // page, not those from args.page on, so it is compared with this
          // page's last row. The Link header, when sent, decides first: it
          // counts in the page size the site served, which may be below 50.
          const totalCount = totalCountOf(answer.headers);
          const end = (page - 1) * PAGE_SIZE + rows.length;
          more = rows.length > 0 &&
            (hasNextLink(answer.headers) ??
              (totalCount === undefined
                ? rows.length >= PAGE_SIZE
                : end < totalCount));
          if (!more) break;
        }
        const truncated = more;
        const handle = await context.writeResource(
          "pulls",
          `pulls-${owner}-${repo}`,
          {
            fetchedAt: new Date().toISOString(),
            host: globalArgs.host,
            owner,
            repo,
            state: args.state,
            firstPage: args.page,
            pagesFetched,
            count: pulls.length,
            truncated,
            pulls,
          },
        );
        logger.info(
          "Listed {count} pull requests of {owner}/{repo} (truncated={truncated})",
          { count: pulls.length, owner, repo, truncated },
        );
        return { dataHandles: [handle] };
      },
    },
    pull: {
      description: "Read one pull request: state, mergeable, head and base, " +
        "and which marker its body asks with. Writes " +
        "pull-<owner>-<repo>-<number>.",
      arguments: PullArgsSchema,
      execute: async (
        args: PullArgs,
        context: Context,
      ): Promise<MethodResult> => {
        const { globalArgs, logger } = context;
        const { owner, repo } = repoOf(args, globalArgs);
        logger.info("Reading {owner}/{repo}#{number} from {host}", {
          owner,
          repo,
          number: args.number,
          host: globalArgs.host,
        });
        const pull = await fetchPull(context, owner, repo, args.number);
        const handle = await writePull(context, owner, repo, pull);
        logger.info(
          "Read {owner}/{repo}#{number}: {title} ({state}, mergeable={mergeable}, asks {asks})",
          {
            owner,
            repo,
            number: pull.number,
            title: pull.title,
            state: pull.merged ? "merged" : pull.state,
            mergeable: pull.mergeable ?? "unknown",
            asks: pull.asks,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    statuses: {
      description: "Read the latest status of each context on a pull " +
        "request's head commit or on a sha, with the combined state and " +
        "whether every required context passed. Writes " +
        "statuses-<owner>-<repo>-<number or sha>.",
      arguments: StatusesArgsSchema,
      execute: async (
        args: StatusesArgs,
        context: Context,
      ): Promise<MethodResult> => {
        const { globalArgs, signal, logger } = context;
        const { owner, repo } = repoOf(args, globalArgs);
        let sha = args.sha;
        if (args.number !== undefined) {
          const pull = await fetchPull(context, owner, repo, args.number);
          if (pull.headSha === "") {
            throw new Error(
              `${owner}/${repo}#${args.number} reports no head commit`,
            );
          }
          sha = pull.headSha;
        }
        if (sha === undefined) {
          throw new Error("Give exactly one of number or sha.");
        }
        logger.info(
          "Reading statuses of {sha} in {owner}/{repo} on {host}, required {required}",
          {
            sha,
            owner,
            repo,
            host: globalArgs.host,
            required: args.required,
          },
        );
        const statuses: Status[] = [];
        let state: string | undefined;
        let totalCount: number | undefined;
        let lastPageFull = false;
        let pagesFetched = 0;
        for (let page = 1; page <= STATUS_PAGES; page++) {
          const answer = await request(
            globalArgs,
            {
              method: "GET",
              path: `/repos/${owner}/${repo}/commits/${sha}/status`,
              query: { page, limit: PAGE_SIZE },
            },
            signal,
          );
          const combined = isRecord(answer.data) ? answer.data : {};
          const rows = Array.isArray(combined.statuses)
            ? combined.statuses
            : [];
          state ??= asString(combined.state);
          // The body's total_count counts this page's rows only; the header
          // counts every context (Forgejo routers/api/v1/repo/status.go).
          totalCount = totalCountOf(answer.headers) ?? totalCount;
          pagesFetched++;
          for (const row of rows) statuses.push(normalizeStatus(row));
          logger.debug("Page {page}: {count} statuses", {
            page,
            count: rows.length,
          });
          lastPageFull = rows.length >= PAGE_SIZE;
          const more = rows.length > 0 && totalCount !== undefined
            ? statuses.length < totalCount
            : lastPageFull;
          if (!more) break;
        }
        const truncated = totalCount === undefined
          ? lastPageFull
          : statuses.length < totalCount;
        const required = gateOf(statuses, args.required);
        const instance = args.number === undefined
          ? `statuses-${owner}-${repo}-${sha}`
          : `statuses-${owner}-${repo}-${args.number}`;
        const handle = await context.writeResource("statuses", instance, {
          fetchedAt: new Date().toISOString(),
          host: globalArgs.host,
          owner,
          repo,
          ...compact({ number: args.number }),
          sha,
          state: state ?? (statuses.length === 0 ? "none" : "unknown"),
          count: statuses.length,
          truncated,
          required,
          statuses,
        });
        logger.info(
          "Read {count} statuses of {sha} over {pages} pages: combined {state}, required passed={passed} {unmet}",
          {
            count: statuses.length,
            sha,
            pages: pagesFetched,
            state: state ?? "none",
            passed: required.passed,
            unmet: required.unmet,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    comments: {
      description: "List a pull request's comments: ids, timestamps and " +
        "which marker each asks with, never the text. Writes " +
        "comments-<owner>-<repo>-<number>.",
      arguments: PullArgsSchema,
      execute: async (
        args: PullArgs,
        context: Context,
      ): Promise<MethodResult> => {
        const { globalArgs, signal, logger } = context;
        const { owner, repo } = repoOf(args, globalArgs);
        logger.info("Listing comments of {owner}/{repo}#{number} from {host}", {
          owner,
          repo,
          number: args.number,
          host: globalArgs.host,
        });
        const answer = await request(
          globalArgs,
          {
            method: "GET",
            path: `/repos/${owner}/${repo}/issues/${args.number}/comments`,
          },
          signal,
        );
        const rows = Array.isArray(answer.data) ? answer.data : [];
        const comments = rows.map((row) => normalizeComment(row, globalArgs));
        const asks = countAsks(comments);
        const handle = await context.writeResource(
          "comments",
          `comments-${owner}-${repo}-${args.number}`,
          {
            fetchedAt: new Date().toISOString(),
            host: globalArgs.host,
            owner,
            repo,
            number: args.number,
            count: comments.length,
            asks,
            comments,
          },
        );
        logger.info(
          "Listed {count} comments of {owner}/{repo}#{number}: {merge} ask to merge, {rush} to rush",
          {
            count: comments.length,
            owner,
            repo,
            number: args.number,
            merge: asks.merge,
            rush: asks.rush,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    comment: {
      description: "Post a comment on a pull request. Needs write:issue. " +
        "Writes comment-<owner>-<repo>-<id>.",
      arguments: CommentArgsSchema,
      execute: async (
        args: CommentArgs,
        context: Context,
      ): Promise<MethodResult> => {
        const { globalArgs, logger } = context;
        const { owner, repo } = repoOf(args, globalArgs);
        logger.info(
          "Commenting on {owner}/{repo}#{number} on {host} ({length} characters)",
          {
            owner,
            repo,
            number: args.number,
            host: globalArgs.host,
            length: args.body.length,
          },
        );
        const handle = await postComment(
          context,
          owner,
          repo,
          args.number,
          args.body,
        );
        return { dataHandles: [handle] };
      },
    },
    "ask-merge": {
      description: "Ask the merge bot to merge an open pull request once its " +
        "required checks pass, by posting the merge marker as a comment, " +
        "then re-read the pull request. Needs write:issue. Writes " +
        "comment-<owner>-<repo>-<id> and pull-<owner>-<repo>-<number>.",
      arguments: PullArgsSchema,
      execute: (args: PullArgs, context: Context): Promise<MethodResult> =>
        ask(args, context, context.globalArgs.mergeMarker, "Asking to merge"),
    },
    "ask-rush": {
      description: "Ask the merge bot to merge an open pull request NOW, " +
        "UNTESTED, past its required checks, by posting the rush marker as " +
        "a comment, then re-read the pull request. The bot takes it from a " +
        "repository administrator only. Writes comment-<owner>-<repo>-<id> " +
        "and pull-<owner>-<repo>-<number>.",
      arguments: PullArgsSchema,
      execute: (args: PullArgs, context: Context): Promise<MethodResult> =>
        ask(
          args,
          context,
          context.globalArgs.rushMarker,
          "Asking to merge untested",
        ),
    },
  },
  upgrades: [
    {
      toVersion: "2026.10.24.1",
      description:
        "Write every argument where the registry reads it, so its catalog lists them with their descriptions; refuse an owner or repo that is not a Forgejo name; pulls marks a later page truncated only when rows lie beyond it, and statuses reads every page of contexts. Stored attributes carry over unchanged",
      upgradeAttributes: (old: Record<string, unknown>): Record<
        string,
        unknown
      > => old,
    },
  ],
};
