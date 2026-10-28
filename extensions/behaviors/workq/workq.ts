/**
 * A Swamp behavior for workq's HTTP API under `/api/v1`: who the caller is,
 * an org's projects, a project's items with the API's filters, one item, its
 * history, creating and changing items, commenting, and a project's releases
 * and sprints. Every method writes what it read as a resource, so a workflow
 * can assert on it with CEL. Resources keep keys, titles, statuses, status
 * groups, dates, counts and people's ids: never an item body, a comment body
 * or an email address.
 *
 * The caller is a machine: it sends its caller token as `Authorization:
 * Bearer ct_…`, or a Cloudflare Access service token as `CF-Access-Client-Id`
 * and `CF-Access-Client-Secret` where Access still fronts the deployment, and
 * the deployment must list the token's SHA-256 or the client id as a service
 * caller with grants (README). The lease
 * and fence protocol under `…/items/{key}/lease` is not in this version.
 *
 * @module
 */

import { z } from "npm:zod@4";

const API_PREFIX = "/api/v1";
const AUTHORIZATION_HEADER = "Authorization";
const CLIENT_ID_HEADER = "CF-Access-Client-Id";
const CLIENT_SECRET_HEADER = "CF-Access-Client-Secret";
const REPLAYED_HEADER = "Replayed";
const RETRY_HEADER = "Retry-After";

/** The API lists 50 items per page unless a limit is given, 200 at most. */
const ITEMS_PAGE_SIZE = 50;
const ITEMS_PAGE_MAX = 200;

const STATUS_GROUPS = [
  "backlog",
  "unstarted",
  "started",
  "completed",
  "cancelled",
] as const;
const PRIORITIES = ["highest", "high", "medium", "low", "lowest"] as const;
const ORDERS = ["newest", "rank"] as const;

/**
 * History fields whose old and new values the `history` resource keeps: names,
 * numbers, keys and dates. A title, body, assignee, link or attachment change
 * is kept as the field name alone, since its values are text or people.
 */
const KEPT_HISTORY_VALUES = new Set([
  "status",
  "type",
  "priority",
  "labels",
  "dueDate",
  "parent",
  "release",
  "sprint",
  "milestone",
  "rank",
]);

/** What a status code means when the answer carries no message of its own. */
const STATUS_HINTS: Record<number, string> = {
  401:
    "no one was admitted: the caller token or the service token is missing or does not verify",
  403:
    "the caller is not a listed service caller, or its grants do not cover this",
  404: "not found, or not visible to the caller's grants",
};

const KEY_PATTERN = /^[A-Z][A-Z0-9]{0,9}-[1-9][0-9]*$/;
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,99}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Global arguments every method reads from the behavior definition. */
export interface GlobalArgs {
  /** Base URL of the deployment, such as https://workq.example.com. */
  host: string;
  /** The caller token, sent as Authorization: Bearer. Sensitive. Either this or both halves of the service token. */
  token?: string;
  /** Client id of the Access service token, sent as CF-Access-Client-Id. */
  clientId?: string;
  /** Client secret of the Access service token, sent as CF-Access-Client-Secret. Sensitive. */
  clientSecret?: string;
  /** Default org for every method that takes one. A method argument overrides it. */
  org?: string;
  /** Default project slug for every method that takes one. A method argument overrides it. */
  project?: string;
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

/** An org as the `me` resource keeps it. */
export interface OrgRef {
  /** The org's slug. */
  id: string;
  /** The org's name. */
  name: string;
  /** The caller's role on the org itself, when they hold one. */
  role?: string;
}

/** A project as the `me` and `projects` resources keep it. */
export interface Project {
  /** The project's id. */
  id: string;
  /** Slug of the org it belongs to. */
  org: string;
  /** The project's slug, unique within its org. */
  slug: string;
  /** Prefix of its item keys (ROG in ROG-12). */
  keyPrefix: string;
  /** The project's name. */
  name: string;
  /** Whether the project has an issue tracker; off, it is a wiki only. */
  tracker: boolean;
  /** The caller's role on the project: admin or member. */
  role: string;
  /** When the project was created, when the API reports it. */
  createdAt?: string;
}

/** The caller as the `me` resource keeps them: ids and roles, never the address. */
export interface Me {
  /** The caller's person id. */
  id: string;
  /** The caller's name. */
  name: string;
  /** Whether the caller administers the service. */
  serviceAdmin: boolean;
  /** How many directory groups the last sync found the caller in. */
  groups: number;
  /** Every org the caller can see. */
  orgs: OrgRef[];
  /** Every project the caller can see, with the role on each. */
  projects: Project[];
}

/** One item as the `items` resource keeps it: no body, no links, no people beyond ids. */
export interface ItemSummary {
  /** The item's numeric id. */
  id: number;
  /** The item's key, such as ROG-12. */
  key: string;
  /** Slug of its org. */
  org: string;
  /** Slug of its project. */
  project: string;
  /** Its number within the project. */
  number: number;
  /** Type name, such as Bug. */
  type: string;
  /** Status name, such as In Progress. */
  status: string;
  /** What the status means: backlog, unstarted, started, completed or cancelled. */
  statusGroup: string;
  /** The item's title. */
  title: string;
  /** Priority: highest, high, medium, low or lowest. */
  priority: string;
  /** Person id of the assignee, when there is one. */
  assigneeId?: string;
  /** Label names, sorted. */
  labels: string[];
  /** Due date, YYYY-MM-DD, when set. */
  dueDate?: string;
  /** Key of the parent item, when it has one. */
  parent?: string;
  /** Place in the backlog, when ranked. */
  rank?: number;
  /** Version of the release it first shipped in, when it has. */
  release?: string;
  /** Number of the sprint it is planned into, when it is. */
  sprint?: number;
  /** Slug of the milestone it is under, when it is. */
  milestone?: string;
  /** Counts every change; a write names the revision it read. */
  revision: number;
  /** Person id of the creator. */
  createdById: string;
  /** When it was created. */
  createdAt: string;
  /** When it last changed. */
  updatedAt: string;
  /** When its status last moved into the completed group, while it is there. */
  completedAt?: string;
}

/** A link from an item to another, as the `item` resource keeps it. */
export interface ItemLink {
  /** The link's id. */
  id: string;
  /** relates, blocks, duplicates or action. */
  kind: string;
  /** out: this item is the link's subject; in: the other is. */
  direction: string;
  /** Key of the other item. */
  key: string;
  /** Status of the other item, when the caller may see its project. */
  status?: string;
  /** True when the caller may not see the other item's project. */
  restricted: boolean;
}

/** One item in full as the `item` resource keeps it: counts and links, never the body. */
export interface Item extends ItemSummary {
  /** How many comments it has. */
  comments: number;
  /** How many attachments it has. */
  attachments: number;
  /** Its links to other items. */
  links: ItemLink[];
}

/** The filters an `items` snapshot was taken with. The assignee filter is not kept. */
export interface ItemFilters {
  /** Saved view applied first, by slug. */
  view?: string;
  /** Status name. */
  status?: string;
  /** Status group. */
  group?: string;
  /** Type name. */
  type?: string;
  /** Label name. */
  label?: string;
  /** Only children of this item key. */
  parent?: string;
  /** Only unranked items. */
  unranked?: boolean;
  /** Release version, or none. */
  release?: string;
  /** Sprint number, none or current. */
  sprint?: string;
  /** Milestone slug, or none. */
  milestone?: string;
  /** Search query. */
  query?: string;
  /** newest or rank. */
  order?: string;
}

/** Item counts by status group, as the `summary` resource keeps them. */
export interface GroupCounts {
  /** Not yet planned. */
  backlog: number;
  /** Planned, not under way. */
  unstarted: number;
  /** Under way. */
  started: number;
  /** Finished. */
  completed: number;
  /** Abandoned. */
  cancelled: number;
}

/** Counts over a list of items. */
export interface ItemsSummary {
  /** Counts by status group. */
  byGroup: GroupCounts;
  /** Counts by status name. */
  byStatus: Record<string, number>;
  /** Counts by priority. */
  byPriority: Record<string, number>;
  /** Items in the backlog, unstarted or started groups: the work still open. */
  unfinished: number;
  /** Items with no assignee. */
  unassigned: number;
}

/** A comment as the `comment` resource keeps it: ids and length, never the body. */
export interface Comment {
  /** The comment's id. */
  id: number;
  /** Key of the item it is on. */
  key: string;
  /** Person id of the author. */
  authorId: string;
  /** When it was posted. */
  createdAt: string;
  /** Length of the Markdown body in characters. */
  bodyLength: number;
}

/** One change to an item, as the `history` resource keeps it. */
export interface HistoryEvent {
  /** The event's id. */
  id: number;
  /** When the change was made. */
  at: string;
  /** Person id of who made it. */
  actorId: string;
  /** The revision the write produced. */
  revision: number;
  /** The field changed: created, status, title, labels, rank, link, and so on. */
  field: string;
  /** The value before, for status, type, priority, labels, dates, keys and numbers. */
  old?: unknown;
  /** The value after, for the same fields. */
  new?: unknown;
}

/** The release of another project a release was built with. */
export interface BuiltWith {
  /** The other project's slug, when the caller may see it. */
  project?: string;
  /** Its version, when the caller may see it. */
  version?: string;
  /** True when the caller may not see that project. */
  restricted: boolean;
}

/** One release as the `releases` and `release` resources keep it. */
export interface Release {
  /** The release's id. */
  id: string;
  /** The version, as the product names it. */
  version: string;
  /** The git tag the build came from. */
  tag: string;
  /** release or hotfix. */
  kind: string;
  /** When the build was promoted to the main channel. */
  shippedAt: string;
  /** Where its notes are, when recorded. */
  notesUrl?: string;
  /** The release it was built with, when one is named. */
  builtWith?: BuiltWith;
  /** How many steps remain after the promotion. */
  steps: number;
  /** How many of those are done. */
  stepsDone: number;
  /** How many items first shipped in it. */
  items: number;
  /** Person id of who recorded it. */
  createdById: string;
  /** When it was recorded. */
  createdAt: string;
  /** When it last changed. */
  updatedAt: string;
}

/** One sprint as the `sprints` resource keeps it. */
export interface Sprint {
  /** The sprint's id. */
  id: string;
  /** Its number within the project. */
  number: number;
  /** Its first day, YYYY-MM-DD. */
  startsOn: string;
  /** Its last day, inclusive. */
  endsOn: string;
  /** upcoming, current or past. */
  state: string;
  /** Its goal, when set. */
  goal?: string;
  /** The git tag of the build it produced, when set. */
  tag?: string;
  /** Its dev-notes page, when set. */
  notesUrl?: string;
  /** Its planning notes, when set. */
  planningUrl?: string;
  /** How many items are planned into it. */
  items: number;
  /** How many of those are in a completed status. */
  completed: number;
  /** Person id of who made it. */
  createdById: string;
  /** When it was made. */
  createdAt: string;
  /** When it last changed. */
  updatedAt: string;
}

/** Arguments naming a project. Each falls back to the global argument. */
export interface ProjectArgs {
  /** The org's slug. */
  org?: string;
  /** The project's slug. */
  project?: string;
}

/** Arguments naming an item by key within an org. */
export interface ItemArgs {
  /** The org's slug. Falls back to the global org. */
  org?: string;
  /** The item's key, such as ROG-12. */
  key: string;
}

/** Arguments of the `list_items` method: the API's filters and paging. */
export interface ListItemsArgs extends ProjectArgs {
  /** A saved view, by slug; its filter applies first. */
  view?: string;
  /** Only items with this status name. */
  status?: string;
  /** Only items in this status group. */
  group?: string;
  /** Only items of this type name. */
  type?: string;
  /** Only items assigned to this email. Sent, never kept in the resource. */
  assignee?: string;
  /** Only items with this label. */
  label?: string;
  /** Only children of this item key. */
  parent?: string;
  /** Only unranked items: the triage view. */
  unranked?: boolean;
  /** Only items that first shipped in this version, or none. */
  release?: string;
  /** Only items in this sprint number, or none, or current. */
  sprint?: string | number;
  /** Only items under this milestone slug, or none. */
  milestone?: string;
  /** A search over titles, bodies and comments. */
  query?: string;
  /** newest or rank. */
  order?: string;
  /** Items per page, up to 200. */
  limit: number;
  /** Items to skip before the first page. */
  offset: number;
  /** How many pages to fetch. */
  pages: number;
}

/** Arguments of the `create_item` method. */
export interface CreateItemArgs extends ProjectArgs {
  /** The title. */
  title: string;
  /** The body, Markdown. */
  body?: string;
  /** Type name; the project's default when left out. */
  type?: string;
  /** Status name; the project's default when left out. */
  status?: string;
  /** Priority; medium when left out. */
  priority?: string;
  /** A member's email. */
  assignee?: string;
  /** Label names, each existing in the project. */
  labels?: string[];
  /** Due date, YYYY-MM-DD. */
  dueDate?: string;
  /** Key of the parent item, in the same project. */
  parent?: string;
  /** Sprint number to plan it into. */
  sprint?: number;
  /** Milestone slug to put it under. */
  milestone?: string;
  /** With externalId, makes the create idempotent. */
  externalSource?: string;
  /** The source's id for the item: the same pair again answers the first item. */
  externalId?: string;
}

/** Arguments of the `change_item` method. A field left out stays as it is. */
export interface ChangeItemArgs extends ItemArgs {
  /** The revision read; the item is read first when left out. */
  revision?: number;
  /** A UUID kept for this write, so a resend answers the first outcome. One is made when left out. */
  requestId?: string;
  /** New title. */
  title?: string;
  /** New body, Markdown. */
  body?: string;
  /** New type name. */
  type?: string;
  /** New status name: a move the workflow must allow. */
  status?: string;
  /** New priority. */
  priority?: string;
  /** A member's email, or null for nobody. */
  assignee?: string | null;
  /** The whole label set. */
  labels?: string[];
  /** Due date, or null for none. */
  dueDate?: string | null;
  /** Parent key, or null for none. */
  parent?: string | null;
  /** Release version it first shipped in, or null for not yet. */
  release?: string | null;
  /** Sprint number, or null for none. */
  sprint?: number | null;
  /** Milestone slug, or null for none. */
  milestone?: string | null;
}

/** Arguments of the `comment` method. */
export interface CommentArgs extends ItemArgs {
  /** The comment, Markdown. */
  body: string;
  /** With externalId, makes the create idempotent. */
  externalSource?: string;
  /** The source's id for the comment. */
  externalId?: string;
}

/** Arguments of the `release` method. */
export interface ReleaseArgs extends ProjectArgs {
  /** The release's version. */
  version: string;
}

/** One request to the API. */
export interface RequestOptions {
  /** HTTP method. */
  method: "GET" | "POST" | "PATCH";
  /** Path under /api/v1, starting with a slash. */
  path: string;
  /** Query parameters. Undefined values are left out. */
  query?: Record<string, string | number | boolean | undefined>;
  /** JSON body for POST and PATCH. Undefined values are left out, nulls are sent. */
  body?: Record<string, unknown>;
}

/** What one request answered. */
export interface Answer {
  /** HTTP status: 200, or 201 for a create. */
  status: number;
  /** True when the API answered from the receipt of an earlier request with the same id. */
  replayed: boolean;
  /** The parsed JSON body. */
  body: unknown;
}

/**
 * An answer the API refused, with its HTTP status and, for a 409, the
 * `details.code` it carried: `revision` (with the item as it stands in
 * `current`), `transition`, `duplicate`, `in-use`, `no-tracker`, `no-default`,
 * `overlap`, `held`, `stale`, `pending`, `fence` or `request`. A 429 carries
 * the seconds Retry-After asked for.
 */
export class WorkqError extends Error {
  /** HTTP status of the answer. */
  readonly status: number;
  /** The 409's details.code, when the answer carried one. */
  readonly code: string | undefined;
  /** The item as it stands, on a 409 revision refusal. */
  readonly current: Item | undefined;
  /** Seconds to wait before trying again, on a 429 answer. */
  readonly retryAfterSeconds: number | undefined;

  /** Builds the error; `code`, `current` and `retryAfterSeconds` are set when the answer carried them. */
  constructor(
    message: string,
    status: number,
    extra: { code?: string; current?: Item; retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.name = "WorkqError";
    this.status = status;
    this.code = extra.code;
    this.current = extra.current;
    this.retryAfterSeconds = extra.retryAfterSeconds;
  }
}

// ---------------------------------------------------------------------------
// Schemas (private: the exported interfaces above are the public types, and
// `satisfies` keeps each schema in step with its interface)
// ---------------------------------------------------------------------------

/** A caller token as the deployment's auth library mints it. */
const CALLER_TOKEN_PATTERN = /^ct_[A-Za-z0-9_-]{32,}$/;

/** The caller token, or both halves of the service token. */
function hasCredential(args: GlobalArgs): boolean {
  return args.token !== undefined ||
    (args.clientId !== undefined && args.clientSecret !== undefined);
}

/**
 * The caller token alone when there is one: the deployment reads the bearer
 * before any Access assertion, so the service token would be a second
 * credential sent for nothing.
 */
function credentialHeaders(args: GlobalArgs): Record<string, string> {
  if (args.token !== undefined) {
    return { [AUTHORIZATION_HEADER]: `Bearer ${args.token}` };
  }
  if (args.clientId === undefined || args.clientSecret === undefined) {
    throw new Error("give the caller token, or both clientId and clientSecret");
  }
  return {
    [CLIENT_ID_HEADER]: args.clientId,
    [CLIENT_SECRET_HEADER]: args.clientSecret,
  };
}

const GlobalArgsSchema = z.object({
  host: z.url()
    .describe("Base URL of the deployment, such as https://workq.example.com."),
  token: z.string()
    .regex(CALLER_TOKEN_PATTERN)
    .optional()
    .meta({ sensitive: true })
    .describe(
      "The caller token (ct_…), sent as Authorization: Bearer. The deployment must list its SHA-256 as a service caller. Given, the service token is not sent.",
    ),
  clientId: z.string()
    .min(1)
    .optional()
    .meta({ sensitive: true })
    .describe(
      "Client id of the Access service token, sent as CF-Access-Client-Id when no caller token is given. The deployment must list it as a service caller.",
    ),
  clientSecret: z.string()
    .min(1)
    .optional()
    .meta({ sensitive: true })
    .describe(
      "Client secret of the Access service token, sent as CF-Access-Client-Secret when no caller token is given.",
    ),
  org: z.string().regex(SLUG_PATTERN).optional().describe(
    "Default org for every method that takes one: lowercase letters, digits and hyphens.",
  ),
  project: z.string().regex(SLUG_PATTERN).optional().describe(
    "Default project for every method that takes one: lowercase letters, digits and hyphens.",
  ),
}).refine(hasCredential, {
  message: "give the caller token, or both clientId and clientSecret",
}) satisfies z.ZodType<GlobalArgs>;

const ProjectArgsSchema = z.object({
  org: z.string().regex(SLUG_PATTERN).optional().describe(
    "The org, overriding the global org: lowercase letters, digits and hyphens.",
  ),
  project: z.string().regex(SLUG_PATTERN).optional().describe(
    "The project, overriding the global project: lowercase letters, digits and hyphens.",
  ),
}) satisfies z.ZodType<ProjectArgs>;

const ItemArgsSchema = z.object({
  org: z.string().regex(SLUG_PATTERN).optional().describe(
    "The org, overriding the global org: lowercase letters, digits and hyphens.",
  ),
  key: z.string()
    .regex(KEY_PATTERN)
    .describe("The item's key, such as ROG-12."),
}) satisfies z.ZodType<ItemArgs>;

const NameSchema = z.string().trim().min(1).max(100);

const ListItemsArgsSchema = z.object({
  org: z.string().regex(SLUG_PATTERN).optional().describe(
    "The org, overriding the global org: lowercase letters, digits and hyphens.",
  ),
  project: z.string().regex(SLUG_PATTERN).optional().describe(
    "The project, overriding the global project: lowercase letters, digits and hyphens.",
  ),
  view: z.string()
    .optional()
    .describe("A saved view, by slug; its filter applies first."),
  status: z.string().optional().describe("Only items with this status name."),
  group: z.enum(STATUS_GROUPS)
    .optional()
    .describe("Only items in this status group."),
  type: z.string().optional().describe("Only items of this type name."),
  assignee: z.string()
    .optional()
    .describe(
      "Only items assigned to this email. Sent to the API, never kept in the resource.",
    ),
  label: z.string().optional().describe("Only items with this label."),
  parent: z.string()
    .regex(KEY_PATTERN)
    .optional()
    .describe("Only children of this item key."),
  unranked: z.boolean()
    .optional()
    .describe("Only unranked items: the triage view."),
  release: z.string()
    .optional()
    .describe("Only items that first shipped in this version, or none."),
  sprint: z.union([
    z.number().int().min(1),
    z.string().regex(/^(?:none|current|[1-9][0-9]*)$/),
  ])
    .optional()
    .describe("Only items in this sprint number, or none, or current."),
  milestone: z.string()
    .optional()
    .describe("Only items under this milestone slug, or none."),
  query: z.string()
    .max(500)
    .optional()
    .describe("A search over titles, bodies and comments."),
  order: z.enum(ORDERS)
    .optional()
    .describe("newest (the default) or rank, the backlog order."),
  limit: z.number()
    .int()
    .min(1)
    .max(ITEMS_PAGE_MAX)
    .default(ITEMS_PAGE_SIZE)
    .describe("Items per page, up to 200."),
  offset: z.number()
    .int()
    .min(0)
    .default(0)
    .describe("Items to skip before the first page."),
  pages: z.number()
    .int()
    .min(1)
    .max(50)
    .default(1)
    .describe("How many pages to fetch."),
}) satisfies z.ZodType<ListItemsArgs>;

const externalPair = (value: {
  externalSource?: string;
  externalId?: string;
}): boolean =>
  (value.externalSource === undefined) === (value.externalId === undefined);

const EXTERNAL_MESSAGE = "externalSource and externalId go together.";

const CreateItemArgsSchema = z.object({
  org: z.string().regex(SLUG_PATTERN).optional().describe(
    "The org, overriding the global org: lowercase letters, digits and hyphens.",
  ),
  project: z.string().regex(SLUG_PATTERN).optional().describe(
    "The project, overriding the global project: lowercase letters, digits and hyphens.",
  ),
  title: z.string().trim().min(1).max(500).describe("The title."),
  body: z.string().max(1_000_000).optional().describe("The body, Markdown."),
  type: z.string().trim().min(1).max(100).optional().describe(
    "Type name; the project's default when left out.",
  ),
  status: z.string().trim().min(1).max(100).optional().describe(
    "Status name; the project's default when left out.",
  ),
  priority: z.enum(PRIORITIES).optional().describe(
    "Priority; medium when left out.",
  ),
  assignee: z.email().optional().describe("A member's email."),
  labels: z.array(NameSchema)
    .optional()
    .describe("Label names, each existing in the project."),
  dueDate: z.string().regex(DATE_PATTERN).optional().describe("YYYY-MM-DD."),
  parent: z.string()
    .regex(KEY_PATTERN)
    .optional()
    .describe("Key of the parent item, in the same project."),
  sprint: z.number()
    .int()
    .min(1)
    .optional()
    .describe("Sprint number to plan it into."),
  milestone: z.string().regex(SLUG_PATTERN).optional().describe(
    "Milestone to put it under: lowercase letters, digits and hyphens.",
  ),
  externalSource: z.string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .describe("With externalId, makes the create idempotent."),
  externalId: z.string()
    .trim()
    .min(1)
    .max(256)
    .optional()
    .describe(
      "The source's id for the item: the same pair again answers the first item.",
    ),
})
  .refine(externalPair, { message: EXTERNAL_MESSAGE }) satisfies z.ZodType<
    CreateItemArgs
  >;

const CHANGE_FIELDS = [
  "title",
  "body",
  "type",
  "status",
  "priority",
  "assignee",
  "labels",
  "dueDate",
  "parent",
  "release",
  "sprint",
  "milestone",
] as const;

const ChangeItemArgsSchema = z.object({
  org: z.string().regex(SLUG_PATTERN).optional().describe(
    "The org, overriding the global org: lowercase letters, digits and hyphens.",
  ),
  key: z.string()
    .regex(KEY_PATTERN)
    .describe("The item's key, such as ROG-12."),
  revision: z.number()
    .int()
    .min(0)
    .optional()
    .describe("The revision read; the item is read first when left out."),
  requestId: z.uuid()
    .optional()
    .describe(
      "A UUID kept for this write, so a resend answers the first outcome. One is made when left out.",
    ),
  title: z.string().trim().min(1).max(500).optional().describe("New title."),
  body: z.string().max(1_000_000).optional().describe("New body, Markdown."),
  type: z.string().trim().min(1).max(100).optional().describe(
    "New type name.",
  ),
  status: z.string().trim().min(1).max(100).optional().describe(
    "New status name: a move the workflow must allow.",
  ),
  priority: z.enum(PRIORITIES).optional().describe("New priority."),
  assignee: z.email()
    .nullable()
    .optional()
    .describe("A member's email, or null for nobody."),
  labels: z.array(NameSchema)
    .optional()
    .describe("The whole label set; what is not named is removed."),
  dueDate: z.string()
    .regex(DATE_PATTERN)
    .nullable()
    .optional()
    .describe("YYYY-MM-DD."),
  parent: z.string()
    .regex(KEY_PATTERN)
    .nullable()
    .optional()
    .describe("Parent key, or null for none."),
  release: z.string()
    .regex(VERSION_PATTERN)
    .nullable()
    .optional()
    .describe("Release version it first shipped in, or null for not yet."),
  sprint: z.number()
    .int()
    .min(1)
    .nullable()
    .optional()
    .describe("Sprint number, or null for none."),
  milestone: z.string()
    .regex(SLUG_PATTERN)
    .nullable()
    .optional()
    .describe("Milestone slug, or null for none."),
})
  .refine(
    (value) => CHANGE_FIELDS.some((field) => value[field] !== undefined),
    { message: "Give at least one field to change." },
  ) satisfies z.ZodType<ChangeItemArgs>;

const CommentArgsSchema = z.object({
  org: z.string().regex(SLUG_PATTERN).optional().describe(
    "The org, overriding the global org: lowercase letters, digits and hyphens.",
  ),
  key: z.string()
    .regex(KEY_PATTERN)
    .describe("The item's key, such as ROG-12."),
  body: z.string()
    .trim()
    .min(1)
    .max(1_000_000)
    .describe("The comment, Markdown."),
  externalSource: z.string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .describe("With externalId, makes the create idempotent."),
  externalId: z.string()
    .trim()
    .min(1)
    .max(256)
    .optional()
    .describe("The source's id for the comment."),
})
  .refine(externalPair, { message: EXTERNAL_MESSAGE }) satisfies z.ZodType<
    CommentArgs
  >;

const ReleaseArgsSchema = z.object({
  org: z.string().regex(SLUG_PATTERN).optional().describe(
    "The org, overriding the global org: lowercase letters, digits and hyphens.",
  ),
  project: z.string().regex(SLUG_PATTERN).optional().describe(
    "The project, overriding the global project: lowercase letters, digits and hyphens.",
  ),
  version: z.string()
    .regex(VERSION_PATTERN)
    .describe("The release's version, such as 1.8.2."),
}) satisfies z.ZodType<ReleaseArgs>;

const OrgRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string().optional(),
}) satisfies z.ZodType<OrgRef>;

const ProjectSchema = z.object({
  id: z.string(),
  org: z.string(),
  slug: z.string(),
  keyPrefix: z.string(),
  name: z.string(),
  tracker: z.boolean(),
  role: z.string(),
  createdAt: z.string().optional(),
}) satisfies z.ZodType<Project>;

const MeResourceSchema = z.object({
  fetchedAt: z.iso.datetime(),
  host: z.string(),
  id: z.string(),
  name: z.string(),
  serviceAdmin: z.boolean(),
  groups: z.number().int(),
  orgs: z.array(OrgRefSchema),
  projects: z.array(ProjectSchema),
});

const ProjectsResourceSchema = z.object({
  fetchedAt: z.iso.datetime(),
  host: z.string(),
  org: z.string(),
  count: z.number().int(),
  projects: z.array(ProjectSchema),
});

const ItemSummaryShape = {
  id: z.number().int(),
  key: z.string(),
  org: z.string(),
  project: z.string(),
  number: z.number().int(),
  type: z.string(),
  status: z.string(),
  statusGroup: z.string(),
  title: z.string(),
  priority: z.string(),
  assigneeId: z.string().optional(),
  labels: z.array(z.string()),
  dueDate: z.string().optional(),
  parent: z.string().optional(),
  rank: z.number().optional(),
  release: z.string().optional(),
  sprint: z.number().int().optional(),
  milestone: z.string().optional(),
  revision: z.number().int(),
  createdById: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().optional(),
};

const ItemSummarySchema = z.object(ItemSummaryShape) satisfies z.ZodType<
  ItemSummary
>;

const ItemLinkSchema = z.object({
  id: z.string(),
  kind: z.string(),
  direction: z.string(),
  key: z.string(),
  status: z.string().optional(),
  restricted: z.boolean(),
}) satisfies z.ZodType<ItemLink>;

const ItemSchema = z.object({
  ...ItemSummaryShape,
  comments: z.number().int(),
  attachments: z.number().int(),
  links: z.array(ItemLinkSchema),
}) satisfies z.ZodType<Item>;

const ItemFiltersSchema = z.object({
  view: z.string().optional(),
  status: z.string().optional(),
  group: z.string().optional(),
  type: z.string().optional(),
  label: z.string().optional(),
  parent: z.string().optional(),
  unranked: z.boolean().optional(),
  release: z.string().optional(),
  sprint: z.string().optional(),
  milestone: z.string().optional(),
  query: z.string().optional(),
  order: z.string().optional(),
}) satisfies z.ZodType<ItemFilters>;

const GroupCountsSchema = z.object({
  backlog: z.number().int(),
  unstarted: z.number().int(),
  started: z.number().int(),
  completed: z.number().int(),
  cancelled: z.number().int(),
}) satisfies z.ZodType<GroupCounts>;

const ItemsResourceSchema = z.object({
  fetchedAt: z.iso.datetime(),
  host: z.string(),
  org: z.string(),
  project: z.string(),
  filters: ItemFiltersSchema,
  offset: z.number().int(),
  limit: z.number().int(),
  pagesFetched: z.number().int(),
  count: z.number().int(),
  truncated: z.boolean(),
  items: z.array(ItemSummarySchema),
});

const SummaryResourceSchema = z.object({
  fetchedAt: z.iso.datetime(),
  host: z.string(),
  org: z.string(),
  project: z.string(),
  filters: ItemFiltersSchema,
  count: z.number().int(),
  truncated: z.boolean(),
  byGroup: GroupCountsSchema,
  byStatus: z.record(z.string(), z.number().int()),
  byPriority: z.record(z.string(), z.number().int()),
  unfinished: z.number().int(),
  unassigned: z.number().int(),
});

const ItemResourceSchema = ItemSchema.extend({
  fetchedAt: z.iso.datetime(),
  host: z.string(),
});

const CommentResourceSchema = z.object({
  fetchedAt: z.iso.datetime(),
  host: z.string(),
  id: z.number().int(),
  key: z.string(),
  authorId: z.string(),
  createdAt: z.string(),
  bodyLength: z.number().int(),
});

const HistoryEventSchema = z.object({
  id: z.number().int(),
  at: z.string(),
  actorId: z.string(),
  revision: z.number().int(),
  field: z.string(),
  old: z.unknown().optional(),
  new: z.unknown().optional(),
}) satisfies z.ZodType<HistoryEvent>;

const HistoryResourceSchema = z.object({
  fetchedAt: z.iso.datetime(),
  host: z.string(),
  key: z.string(),
  revision: z.number().int(),
  count: z.number().int(),
  events: z.array(HistoryEventSchema),
});

const BuiltWithSchema = z.object({
  project: z.string().optional(),
  version: z.string().optional(),
  restricted: z.boolean(),
}) satisfies z.ZodType<BuiltWith>;

const ReleaseSchema = z.object({
  id: z.string(),
  version: z.string(),
  tag: z.string(),
  kind: z.string(),
  shippedAt: z.string(),
  notesUrl: z.string().optional(),
  builtWith: BuiltWithSchema.optional(),
  steps: z.number().int(),
  stepsDone: z.number().int(),
  items: z.number().int(),
  createdById: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
}) satisfies z.ZodType<Release>;

const ReleasesResourceSchema = z.object({
  fetchedAt: z.iso.datetime(),
  host: z.string(),
  org: z.string(),
  project: z.string(),
  count: z.number().int(),
  releases: z.array(ReleaseSchema),
});

const ReleaseResourceSchema = ReleaseSchema.extend({
  fetchedAt: z.iso.datetime(),
  host: z.string(),
  org: z.string(),
  project: z.string(),
});

const SprintSchema = z.object({
  id: z.string(),
  number: z.number().int(),
  startsOn: z.string(),
  endsOn: z.string(),
  state: z.string(),
  goal: z.string().optional(),
  tag: z.string().optional(),
  notesUrl: z.string().optional(),
  planningUrl: z.string().optional(),
  items: z.number().int(),
  completed: z.number().int(),
  createdById: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
}) satisfies z.ZodType<Sprint>;

const SprintsResourceSchema = z.object({
  fetchedAt: z.iso.datetime(),
  host: z.string(),
  org: z.string(),
  project: z.string(),
  count: z.number().int(),
  current: z.number().int().optional(),
  sprints: z.array(SprintSchema),
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

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
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

function asStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/** The id of a person reference, or of a bare id string. */
function personId(value: unknown): string | undefined {
  if (isRecord(value)) return asString(value.id);
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

function requireRecord(raw: unknown, what: string): Record<string, unknown> {
  if (!isRecord(raw)) throw new Error(`${what} answer is not an object`);
  return raw;
}

/** Reduces a project answer to the fields the `me` and `projects` resources keep. */
export function normalizeProject(raw: unknown): Project {
  const record = requireRecord(raw, "project");
  const slug = asString(record.slug);
  if (slug === undefined) throw new Error("project answer carries no slug");
  return compact({
    id: asString(record.id) ?? "",
    org: asString(record.org) ?? "",
    slug,
    keyPrefix: asString(record.keyPrefix) ?? "",
    name: asString(record.name) ?? "",
    tracker: asBoolean(record.tracker) ?? true,
    role: asString(record.role) ?? "member",
    createdAt: asString(record.createdAt),
  });
}

/** Reduces the `/me` answer to ids, roles and counts. The address is not kept. */
export function normalizeMe(raw: unknown): Me {
  const record = requireRecord(raw, "me");
  const id = asString(record.id);
  if (id === undefined) throw new Error("me answer carries no id");
  const orgs = Array.isArray(record.orgs) ? record.orgs : [];
  const projects = Array.isArray(record.projects) ? record.projects : [];
  return {
    id,
    name: asString(record.name) ?? "",
    serviceAdmin: asBoolean(record.serviceAdmin) ?? false,
    groups: asStrings(record.groups).length,
    orgs: orgs.map((org) => {
      const entry = requireRecord(org, "org");
      return compact({
        id: asString(entry.id) ?? "",
        name: asString(entry.name) ?? "",
        role: asString(entry.role),
      });
    }),
    projects: projects.map(normalizeProject),
  };
}

/** Reduces an item answer to the fields the `items` resource keeps: no body, no people beyond ids. */
export function normalizeItemSummary(raw: unknown): ItemSummary {
  const record = requireRecord(raw, "item");
  const id = asInteger(record.id);
  const key = asString(record.key);
  const revision = asInteger(record.revision);
  if (id === undefined || key === undefined || revision === undefined) {
    throw new Error("item answer carries no id, key and revision");
  }
  return compact({
    id,
    key,
    org: asString(record.org) ?? "",
    project: asString(record.project) ?? "",
    number: asInteger(record.number) ?? 0,
    type: asString(record.type) ?? "",
    status: asString(record.status) ?? "",
    statusGroup: asString(record.statusGroup) ?? "unknown",
    title: asString(record.title) ?? "",
    priority: asString(record.priority) ?? "medium",
    assigneeId: personId(record.assignee),
    labels: asStrings(record.labels),
    dueDate: asString(record.dueDate),
    parent: asString(record.parent),
    rank: asNumber(record.rank),
    release: asString(record.release),
    sprint: asInteger(record.sprint),
    milestone: asString(record.milestone),
    revision,
    createdById: personId(record.createdBy) ?? "",
    createdAt: asString(record.createdAt) ?? "",
    updatedAt: asString(record.updatedAt) ?? "",
    completedAt: asString(record.completedAt),
  });
}

/** Reduces a full item answer: the summary plus counts and links, never the body. */
export function normalizeItem(raw: unknown): Item {
  const record = requireRecord(raw, "item");
  const links = Array.isArray(record.links) ? record.links : [];
  return {
    ...normalizeItemSummary(record),
    comments: asInteger(record.comments) ?? 0,
    attachments: asInteger(record.attachments) ?? 0,
    links: links.map((link) => {
      const entry = requireRecord(link, "link");
      const other = isRecord(entry.item) ? entry.item : {};
      return compact({
        id: asString(entry.id) ?? "",
        kind: asString(entry.kind) ?? "",
        direction: asString(entry.direction) ?? "",
        key: asString(other.key) ?? "",
        status: asString(other.status),
        restricted: asBoolean(other.restricted) ?? false,
      });
    }),
  };
}

/** Reduces a comment answer to ids and the body's length. The body is not kept. */
export function normalizeComment(raw: unknown, key: string): Comment {
  const record = requireRecord(raw, "comment");
  const id = asInteger(record.id);
  if (id === undefined) throw new Error("comment answer carries no id");
  return {
    id,
    key,
    authorId: personId(record.author) ?? "",
    createdAt: asString(record.createdAt) ?? "",
    bodyLength: (asString(record.body) ?? "").length,
  };
}

/**
 * Reduces a history entry to who, when, which field and the revision. Old and
 * new values are kept for statuses, types, priorities, labels, dates, keys
 * and numbers only.
 */
export function normalizeEvent(raw: unknown): HistoryEvent {
  const record = requireRecord(raw, "history");
  const id = asInteger(record.id);
  if (id === undefined) throw new Error("history answer carries no id");
  const field = asString(record.field) ?? "";
  const keepValues = KEPT_HISTORY_VALUES.has(field);
  return compact({
    id,
    at: asString(record.at) ?? "",
    actorId: personId(record.actor) ?? "",
    revision: asInteger(record.revision) ?? 0,
    field,
    old: keepValues && record.old !== null ? record.old : undefined,
    new: keepValues && record.new !== null ? record.new : undefined,
  });
}

/** Reduces a release answer to the fields the `releases` and `release` resources keep. */
export function normalizeRelease(raw: unknown): Release {
  const record = requireRecord(raw, "release");
  const version = asString(record.version);
  if (version === undefined) {
    throw new Error("release answer carries no version");
  }
  const steps = Array.isArray(record.steps) ? record.steps : [];
  const builtWith = isRecord(record.builtWith)
    ? compact({
      project: asString(record.builtWith.project),
      version: asString(record.builtWith.version),
      restricted: asBoolean(record.builtWith.restricted) ?? false,
    })
    : undefined;
  return compact({
    id: asString(record.id) ?? "",
    version,
    tag: asString(record.tag) ?? "",
    kind: asString(record.kind) ?? "release",
    shippedAt: asString(record.shippedAt) ?? "",
    notesUrl: asString(record.notesUrl),
    builtWith,
    steps: steps.length,
    stepsDone: steps.filter((step) => isRecord(step) && step.done === true)
      .length,
    items: asInteger(record.items) ?? 0,
    createdById: personId(record.createdBy) ?? "",
    createdAt: asString(record.createdAt) ?? "",
    updatedAt: asString(record.updatedAt) ?? "",
  });
}

/** Reduces a sprint answer to the fields the `sprints` resource keeps. */
export function normalizeSprint(raw: unknown): Sprint {
  const record = requireRecord(raw, "sprint");
  const number = asInteger(record.number);
  if (number === undefined) throw new Error("sprint answer carries no number");
  return compact({
    id: asString(record.id) ?? "",
    number,
    startsOn: asString(record.startsOn) ?? "",
    endsOn: asString(record.endsOn) ?? "",
    state: asString(record.state) ?? "unknown",
    goal: asString(record.goal),
    tag: asString(record.tag),
    notesUrl: asString(record.notesUrl),
    planningUrl: asString(record.planningUrl),
    items: asInteger(record.items) ?? 0,
    completed: asInteger(record.completed) ?? 0,
    createdById: personId(record.createdBy) ?? "",
    createdAt: asString(record.createdAt) ?? "",
    updatedAt: asString(record.updatedAt) ?? "",
  });
}

/** Counts items by status group, status name and priority, and the open and unassigned ones. */
export function summarize(items: readonly ItemSummary[]): ItemsSummary {
  const byGroup: GroupCounts = {
    backlog: 0,
    unstarted: 0,
    started: 0,
    completed: 0,
    cancelled: 0,
  };
  const byStatus: Record<string, number> = {};
  const byPriority: Record<string, number> = {};
  let unassigned = 0;
  for (const item of items) {
    if (item.statusGroup in byGroup) {
      byGroup[item.statusGroup as keyof GroupCounts]++;
    }
    byStatus[item.status] = (byStatus[item.status] ?? 0) + 1;
    byPriority[item.priority] = (byPriority[item.priority] ?? 0) + 1;
    if (item.assigneeId === undefined) unassigned++;
  }
  return {
    byGroup,
    byStatus,
    byPriority,
    unfinished: byGroup.backlog + byGroup.unstarted + byGroup.started,
    unassigned,
  };
}

function rowsOf(body: unknown, what: string): unknown[] {
  if (Array.isArray(body)) return body;
  throw new Error(`${what} answer is not a list`);
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** The org or project a method runs against: its argument, else the global one. */
export function scope(
  args: ProjectArgs,
  globalArgs: GlobalArgs,
): { org: string; project: string } {
  const org = args.org ?? globalArgs.org;
  const project = args.project ?? globalArgs.project;
  if (org === undefined || project === undefined) {
    throw new Error(
      "the method needs an org and a project: pass them as arguments or set the global org and project",
    );
  }
  return { org, project };
}

function orgOf(args: { org?: string }, globalArgs: GlobalArgs): string {
  const org = args.org ?? globalArgs.org;
  if (org === undefined) {
    throw new Error(
      "the method needs an org: pass the org argument or set the global org",
    );
  }
  return org;
}

/**
 * Sends one request with the caller's credential and returns the parsed
 * answer with its status and whether it was replayed from a request receipt.
 *
 * Throws a WorkqError for a 4xx or 5xx status, for a redirect (Access sending
 * an unadmitted caller to sign in) and for a body that is not JSON. A 409
 * carries the API's `details.code`, and a `revision` refusal the item as it
 * stands; a 429 carries `retryAfterSeconds`.
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
  const headers: Record<string, string> = {
    ...credentialHeaders(globalArgs),
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
    // Access answers an unadmitted caller with a redirect to its sign-in page;
    // following it would turn a refusal into an HTML page with status 200.
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
    throw new WorkqError(
      `${label}: redirected (${response.status}) to sign in; Access did not admit the credential`,
      response.status,
    );
  }
  if (response.status === 429) {
    const seconds = asInteger(response.headers.get(RETRY_HEADER));
    const wait = seconds === undefined
      ? ""
      : `, retry after ${seconds} seconds`;
    throw new WorkqError(`${label}: rate limited (429)${wait}`, 429, {
      retryAfterSeconds: seconds,
    });
  }
  const message = isRecord(parsed) ? asString(parsed.error) : undefined;
  const details = isRecord(parsed) && isRecord(parsed.details)
    ? parsed.details
    : undefined;
  if (!response.ok) {
    const code = details === undefined ? undefined : asString(details.code);
    let current: Item | undefined;
    let detail = message ??
      (text === "" ? response.statusText : text.slice(0, 200));
    if (code === "revision" && details !== undefined) {
      try {
        current = normalizeItem(details.current);
      } catch {
        current = undefined;
      }
      detail = current === undefined
        ? `stale revision (code revision); read the item again and retry`
        : `stale revision, the item is at revision ${current.revision} ` +
          `(status ${current.status}); read it again and retry`;
    } else if (code !== undefined) {
      detail = `${detail} (code ${code})`;
    }
    const hint = STATUS_HINTS[response.status];
    const parts = [detail, hint === undefined ? undefined : `(${hint})`]
      .filter((part) => part !== undefined && part !== "");
    throw new WorkqError(
      `${label}: ${response.status} ${parts.join(" ")}`,
      response.status,
      { code, current },
    );
  }
  if (parsed === undefined) {
    throw new WorkqError(`${label}: answer was not JSON`, response.status);
  }
  return {
    status: response.status,
    replayed: response.headers.get(REPLAYED_HEADER) === "true",
    body: parsed,
  };
}

async function fetchItem(
  globalArgs: GlobalArgs,
  org: string,
  key: string,
  signal: AbortSignal,
): Promise<Item> {
  const answer = await request(
    globalArgs,
    { method: "GET", path: `/orgs/${org}/items/${key}` },
    signal,
  );
  return normalizeItem(answer.body);
}

async function writeItem(context: Context, item: Item): Promise<DataHandle> {
  return await context.writeResource("item", `item-${item.key}`, {
    fetchedAt: new Date().toISOString(),
    host: context.globalArgs.host,
    ...item,
  });
}

// ---------------------------------------------------------------------------
// Behavior
// ---------------------------------------------------------------------------

/**
 * The behavior definition Swamp registers. Global arguments are `host`,
 * `clientId` and `clientSecret` (both sensitive) and optional `org` and
 * `project` defaults; see the README for each method, the resource it writes
 * and the instance name it writes it under.
 */
export const behavior = {
  // String literals, not constants: the registry catalog reads them from the
  // source.
  type: "@reset/workq",
  version: "2026.10.27.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    me: {
      description: "The caller: id, name, roles and the orgs and projects " +
        "they can see",
      schema: MeResourceSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    projects: {
      description: "The projects of an org the caller can see",
      schema: ProjectsResourceSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    items: {
      description: "A page range of a project's items with the filters it " +
        "was taken with: keys, titles, statuses, dates and ids, never bodies",
      schema: ItemsResourceSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    summary: {
      description: "Counts by status group, status and priority over the " +
        "same items, and the unfinished and unassigned counts, for CEL asserts",
      schema: SummaryResourceSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    item: {
      description: "One item with its counts and links, never its body; " +
        "written by item, create_item and change_item",
      schema: ItemResourceSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    comment: {
      description: "A comment this behavior posted: ids and length, never " +
        "the body",
      schema: CommentResourceSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    history: {
      description: "Who changed what on an item, oldest first, with values " +
        "for statuses, names, dates and numbers only",
      schema: HistoryResourceSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    releases: {
      description: "A project's releases, newest first",
      schema: ReleasesResourceSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    release: {
      description: "One release",
      schema: ReleaseResourceSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    sprints: {
      description: "A project's sprints, first to last, with the current " +
        "one's number",
      schema: SprintsResourceSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    me: {
      description: "Read who the service token is admitted as and what it " +
        "can see. Writes me.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: Context,
      ): Promise<MethodResult> => {
        const { globalArgs, signal, logger } = context;
        logger.info("Reading the caller from {host}", {
          host: globalArgs.host,
        });
        const answer = await request(
          globalArgs,
          { method: "GET", path: "/me" },
          signal,
        );
        const me = normalizeMe(answer.body);
        const handle = await context.writeResource("me", "me", {
          fetchedAt: new Date().toISOString(),
          host: globalArgs.host,
          ...me,
        });
        logger.info(
          "The caller is {name} ({id}): {orgs} orgs, {projects} projects",
          {
            name: me.name,
            id: me.id,
            orgs: me.orgs.length,
            projects: me.projects.length,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    projects: {
      description: "List the projects of an org the caller can see. " +
        "Writes projects-<org>.",
      arguments: z.object({
        org: z.string().regex(SLUG_PATTERN).optional().describe(
          "The org, overriding the global org: lowercase letters, digits and hyphens.",
        ),
      }),
      execute: async (
        args: { org?: string },
        context: Context,
      ): Promise<MethodResult> => {
        const { globalArgs, signal, logger } = context;
        const org = orgOf(args, globalArgs);
        logger.info("Listing projects of {org} from {host}", {
          org,
          host: globalArgs.host,
        });
        const answer = await request(
          globalArgs,
          { method: "GET", path: `/orgs/${org}/projects` },
          signal,
        );
        const projects = rowsOf(answer.body, "projects").map(normalizeProject);
        const handle = await context.writeResource(
          "projects",
          `projects-${org}`,
          {
            fetchedAt: new Date().toISOString(),
            host: globalArgs.host,
            org,
            count: projects.length,
            projects,
          },
        );
        logger.info("Listed {count} projects of {org}", {
          count: projects.length,
          org,
        });
        return { dataHandles: [handle] };
      },
    },
    list_items: {
      description: "List a project's items with the API's filters, a page " +
        "of up to 200 at a time. Writes items-<org>-<project> and " +
        "summary-<org>-<project>.",
      arguments: ListItemsArgsSchema,
      execute: async (
        args: ListItemsArgs,
        context: Context,
      ): Promise<MethodResult> => {
        const { globalArgs, signal, logger } = context;
        const { org, project } = scope(args, globalArgs);
        const sprint = args.sprint === undefined
          ? undefined
          : String(args.sprint);
        const filters: ItemFilters = compact({
          view: args.view,
          status: args.status,
          group: args.group,
          type: args.type,
          label: args.label,
          parent: args.parent,
          unranked: args.unranked === true ? true : undefined,
          release: args.release,
          sprint,
          milestone: args.milestone,
          query: args.query,
          order: args.order,
        });
        logger.info(
          "Listing items of {org}/{project} from {host}: {pages} pages of {limit} from offset {offset}, filters {filters}",
          {
            org,
            project,
            host: globalArgs.host,
            pages: args.pages,
            limit: args.limit,
            offset: args.offset,
            filters,
          },
        );
        const items: ItemSummary[] = [];
        let lastPageFull = false;
        let pagesFetched = 0;
        for (let page = 0; page < args.pages; page++) {
          const offset = args.offset + page * args.limit;
          const answer = await request(
            globalArgs,
            {
              method: "GET",
              path: `/orgs/${org}/projects/${project}/items`,
              query: {
                view: args.view,
                status: args.status,
                group: args.group,
                type: args.type,
                assignee: args.assignee,
                label: args.label,
                parent: args.parent,
                unranked: args.unranked === true ? true : undefined,
                release: args.release,
                sprint,
                milestone: args.milestone,
                q: args.query,
                order: args.order,
                limit: args.limit,
                offset,
              },
            },
            signal,
          );
          const rows = rowsOf(answer.body, "items");
          pagesFetched++;
          for (const row of rows) items.push(normalizeItemSummary(row));
          logger.debug("Offset {offset}: {count} items", {
            offset,
            count: rows.length,
          });
          lastPageFull = rows.length >= args.limit;
          if (!lastPageFull) break;
        }
        const summary = summarize(items);
        const fetchedAt = new Date().toISOString();
        const itemsHandle = await context.writeResource(
          "items",
          `items-${org}-${project}`,
          {
            fetchedAt,
            host: globalArgs.host,
            org,
            project,
            filters,
            offset: args.offset,
            limit: args.limit,
            pagesFetched,
            count: items.length,
            truncated: lastPageFull,
            items,
          },
        );
        const summaryHandle = await context.writeResource(
          "summary",
          `summary-${org}-${project}`,
          {
            fetchedAt,
            host: globalArgs.host,
            org,
            project,
            filters,
            count: items.length,
            truncated: lastPageFull,
            ...summary,
          },
        );
        logger.info(
          "Listed {count} items of {org}/{project} ({unfinished} unfinished, truncated={truncated})",
          {
            count: items.length,
            org,
            project,
            unfinished: summary.unfinished,
            truncated: lastPageFull,
          },
        );
        return { dataHandles: [itemsHandle, summaryHandle] };
      },
    },
    item: {
      description: "Read one item by key, with its counts and links. " +
        "Writes item-<key>.",
      arguments: ItemArgsSchema,
      execute: async (
        args: ItemArgs,
        context: Context,
      ): Promise<MethodResult> => {
        const { globalArgs, signal, logger } = context;
        const org = orgOf(args, globalArgs);
        logger.info("Reading item {key} of {org} from {host}", {
          key: args.key,
          org,
          host: globalArgs.host,
        });
        const item = await fetchItem(globalArgs, org, args.key, signal);
        const handle = await writeItem(context, item);
        logger.info(
          "Read item {key}: {title} ({status}, revision {revision})",
          {
            key: item.key,
            title: item.title,
            status: item.status,
            revision: item.revision,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    create_item: {
      description: "Create an item in a project; with externalSource and " +
        "externalId the same pair again answers the first item. " +
        "Writes item-<key>.",
      arguments: CreateItemArgsSchema,
      execute: async (
        args: CreateItemArgs,
        context: Context,
      ): Promise<MethodResult> => {
        const { globalArgs, signal, logger } = context;
        const { org, project } = scope(args, globalArgs);
        logger.info("Creating an item in {org}/{project} on {host}: {title}", {
          org,
          project,
          host: globalArgs.host,
          title: args.title,
        });
        const answer = await request(
          globalArgs,
          {
            method: "POST",
            path: `/orgs/${org}/projects/${project}/items`,
            body: {
              title: args.title,
              body: args.body,
              type: args.type,
              status: args.status,
              priority: args.priority,
              assignee: args.assignee,
              labels: args.labels,
              dueDate: args.dueDate,
              parent: args.parent,
              sprint: args.sprint,
              milestone: args.milestone,
              externalSource: args.externalSource,
              externalId: args.externalId,
            },
          },
          signal,
        );
        const item = normalizeItem(answer.body);
        const handle = await writeItem(context, item);
        if (answer.status === 201) {
          logger.info("Created item {key}: {title} ({status})", {
            key: item.key,
            title: item.title,
            status: item.status,
          });
        } else {
          logger.info(
            "Item {key} already existed for {source} {id}: nothing was created",
            {
              key: item.key,
              source: args.externalSource,
              id: args.externalId,
            },
          );
        }
        return { dataHandles: [handle] };
      },
    },
    change_item: {
      description: "Change an item's fields at the revision read, reading " +
        "it first when no revision is given; a 409 revision or transition " +
        "refusal fails the method with the item as it stands. Writes " +
        "item-<key>.",
      arguments: ChangeItemArgsSchema,
      execute: async (
        args: ChangeItemArgs,
        context: Context,
      ): Promise<MethodResult> => {
        const { globalArgs, signal, logger } = context;
        const org = orgOf(args, globalArgs);
        const fields = Object.fromEntries(
          CHANGE_FIELDS.filter((field) => args[field] !== undefined).map((
            field,
          ) => [field, args[field]]),
        );
        let revision = args.revision;
        if (revision === undefined) {
          revision = (await fetchItem(globalArgs, org, args.key, signal))
            .revision;
          logger.debug("Read item {key} at revision {revision}", {
            key: args.key,
            revision,
          });
        }
        const requestId = args.requestId ?? crypto.randomUUID();
        logger.info(
          "Changing item {key} of {org} on {host} at revision {revision}: {fields}, request {requestId}",
          {
            key: args.key,
            org,
            host: globalArgs.host,
            revision,
            fields: Object.keys(fields),
            requestId,
          },
        );
        const answer = await request(
          globalArgs,
          {
            method: "PATCH",
            path: `/orgs/${org}/items/${args.key}`,
            body: { revision, requestId, ...fields },
          },
          signal,
        );
        const item = normalizeItem(answer.body);
        if (answer.replayed) {
          logger.warning(
            "Request {requestId} was answered from its receipt: the change was made once, earlier",
            { requestId },
          );
        }
        const handle = await writeItem(context, item);
        logger.info("Item {key} is now at revision {revision} ({status})", {
          key: item.key,
          revision: item.revision,
          status: item.status,
        });
        return { dataHandles: [handle] };
      },
    },
    comment: {
      description: "Comment on an item in Markdown; with externalSource and " +
        "externalId the same pair again answers the first comment. " +
        "Writes comment-<key>-<id>.",
      arguments: CommentArgsSchema,
      execute: async (
        args: CommentArgs,
        context: Context,
      ): Promise<MethodResult> => {
        const { globalArgs, signal, logger } = context;
        const org = orgOf(args, globalArgs);
        logger.info(
          "Commenting on item {key} of {org} on {host} ({length} characters)",
          {
            key: args.key,
            org,
            host: globalArgs.host,
            length: args.body.length,
          },
        );
        const answer = await request(
          globalArgs,
          {
            method: "POST",
            path: `/orgs/${org}/items/${args.key}/comments`,
            body: {
              body: args.body,
              externalSource: args.externalSource,
              externalId: args.externalId,
            },
          },
          signal,
        );
        const comment = normalizeComment(answer.body, args.key);
        const handle = await context.writeResource(
          "comment",
          `comment-${args.key}-${comment.id}`,
          {
            fetchedAt: new Date().toISOString(),
            host: globalArgs.host,
            ...comment,
          },
        );
        logger.info(
          answer.status === 201
            ? "Posted comment {id} on {key}"
            : "Comment {id} on {key} already existed: nothing was posted",
          { id: comment.id, key: args.key },
        );
        return { dataHandles: [handle] };
      },
    },
    history: {
      description: "Read who changed what on an item, oldest first. " +
        "Writes history-<key>.",
      arguments: ItemArgsSchema,
      execute: async (
        args: ItemArgs,
        context: Context,
      ): Promise<MethodResult> => {
        const { globalArgs, signal, logger } = context;
        const org = orgOf(args, globalArgs);
        logger.info("Reading the history of item {key} of {org} from {host}", {
          key: args.key,
          org,
          host: globalArgs.host,
        });
        const answer = await request(
          globalArgs,
          { method: "GET", path: `/orgs/${org}/items/${args.key}/history` },
          signal,
        );
        const events = rowsOf(answer.body, "history").map(normalizeEvent);
        const revision = events.reduce(
          (latest, event) => Math.max(latest, event.revision),
          0,
        );
        const handle = await context.writeResource(
          "history",
          `history-${args.key}`,
          {
            fetchedAt: new Date().toISOString(),
            host: globalArgs.host,
            key: args.key,
            revision,
            count: events.length,
            events,
          },
        );
        logger.info(
          "Read {count} changes to {key}, latest revision {revision}",
          {
            count: events.length,
            key: args.key,
            revision,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    releases: {
      description: "List a project's releases, newest first. " +
        "Writes releases-<org>-<project>.",
      arguments: ProjectArgsSchema,
      execute: async (
        args: ProjectArgs,
        context: Context,
      ): Promise<MethodResult> => {
        const { globalArgs, signal, logger } = context;
        const { org, project } = scope(args, globalArgs);
        logger.info("Listing releases of {org}/{project} from {host}", {
          org,
          project,
          host: globalArgs.host,
        });
        const answer = await request(
          globalArgs,
          { method: "GET", path: `/orgs/${org}/projects/${project}/releases` },
          signal,
        );
        const releases = rowsOf(answer.body, "releases").map(normalizeRelease);
        const handle = await context.writeResource(
          "releases",
          `releases-${org}-${project}`,
          {
            fetchedAt: new Date().toISOString(),
            host: globalArgs.host,
            org,
            project,
            count: releases.length,
            releases,
          },
        );
        logger.info("Listed {count} releases of {org}/{project}", {
          count: releases.length,
          org,
          project,
        });
        return { dataHandles: [handle] };
      },
    },
    release: {
      description: "Read one release by version. " +
        "Writes release-<org>-<project>-<version>.",
      arguments: ReleaseArgsSchema,
      execute: async (
        args: ReleaseArgs,
        context: Context,
      ): Promise<MethodResult> => {
        const { globalArgs, signal, logger } = context;
        const { org, project } = scope(args, globalArgs);
        logger.info(
          "Reading release {version} of {org}/{project} from {host}",
          {
            version: args.version,
            org,
            project,
            host: globalArgs.host,
          },
        );
        const answer = await request(
          globalArgs,
          {
            method: "GET",
            path: `/orgs/${org}/projects/${project}/releases/${args.version}`,
          },
          signal,
        );
        const release = normalizeRelease(answer.body);
        const handle = await context.writeResource(
          "release",
          `release-${org}-${project}-${release.version}`,
          {
            fetchedAt: new Date().toISOString(),
            host: globalArgs.host,
            org,
            project,
            ...release,
          },
        );
        logger.info(
          "Release {version} ({kind}, tag {tag}) shipped {shippedAt} with {items} items",
          {
            version: release.version,
            kind: release.kind,
            tag: release.tag,
            shippedAt: release.shippedAt,
            items: release.items,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    sprints: {
      description: "List a project's sprints, first to last, with the " +
        "current one's number. Writes sprints-<org>-<project>.",
      arguments: ProjectArgsSchema,
      execute: async (
        args: ProjectArgs,
        context: Context,
      ): Promise<MethodResult> => {
        const { globalArgs, signal, logger } = context;
        const { org, project } = scope(args, globalArgs);
        logger.info("Listing sprints of {org}/{project} from {host}", {
          org,
          project,
          host: globalArgs.host,
        });
        const answer = await request(
          globalArgs,
          { method: "GET", path: `/orgs/${org}/projects/${project}/sprints` },
          signal,
        );
        const sprints = rowsOf(answer.body, "sprints").map(normalizeSprint);
        const current = sprints.find((sprint) => sprint.state === "current")
          ?.number;
        const handle = await context.writeResource(
          "sprints",
          `sprints-${org}-${project}`,
          {
            fetchedAt: new Date().toISOString(),
            host: globalArgs.host,
            org,
            project,
            count: sprints.length,
            ...compact({ current }),
            sprints,
          },
        );
        logger.info(
          "Listed {count} sprints of {org}/{project}, current {current}",
          {
            count: sprints.length,
            org,
            project,
            current: current ?? "(none)",
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
  upgrades: [
    {
      toVersion: "2026.10.24.1",
      description:
        "Write every argument where the registry reads it, so its catalog lists them with their descriptions; arguments and behavior unchanged",
      upgradeAttributes: (old: Record<string, unknown>): Record<
        string,
        unknown
      > => old,
    },
    {
      toVersion: "2026.10.27.1",
      description:
        "Take a caller token (token, sent as Authorization: Bearer) in place of the Access service token; an instance with clientId and clientSecret is unchanged",
      upgradeAttributes: (old: Record<string, unknown>): Record<
        string,
        unknown
      > => old,
    },
  ],
};
