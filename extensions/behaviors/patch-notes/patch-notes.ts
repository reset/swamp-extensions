/**
 * A Swamp behavior that drafts patch notes from merged pull requests. It reads
 * a Forgejo or Gitea repository through its `/api/v1` REST API, or a GitHub
 * repository through the GitHub REST API, resolves two refs (tags, branches or
 * commits) to their commit dates, and gathers the pull requests merged into the
 * base branch between them. Pull requests are classified by their labels with a
 * configurable prefix (`patch:fix` is category `fix`), drafted as Markdown
 * grouped by category, and the draft can be rendered as Steam announcement
 * BBCode. Every method writes what it produced as a resource, so a workflow can
 * assert on it with CEL. Author logins are kept only when asked for.
 *
 * @module
 */

import { z } from "npm:zod@4";

const GITHUB_API = "https://api.github.com";
/** GitHub's largest page. */
const GITHUB_PAGE_SIZE = 100;
/** Forgejo's default MAX_RESPONSE_ITEMS; a server may allow fewer. */
const FORGEJO_PAGE_SIZE = 50;
/** Category of a pull request with no label under the prefix. */
const UNCATEGORIZED = "uncategorized";
/** How far before the start commit the pull listing keeps reading. */
const STOP_SLACK_MS = 24 * 60 * 60 * 1000;

/** What a status code means when the answer carries no message of its own. */
const STATUS_HINTS: Record<number, string> = {
  401: "the token is missing, malformed or expired",
  403: "the token lacks access, or the rate limit is spent",
  404: "no such repository or ref, or it is private to the token",
  429: "rate limited: wait before trying again",
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Which forge API the behavior speaks. */
export type Forge = "forgejo" | "github";

/** Global arguments every method reads from the behavior definition. */
export interface GlobalArgs {
  /** `forgejo` (also Gitea) or `github`. */
  forge: Forge;
  /** API root: https://api.github.com, or a Forgejo host's .../api/v1. */
  apiUrl?: string;
  /** Repository owner, a user or an organization. */
  owner: string;
  /** Repository name. */
  repo: string;
  /** Branch the pull requests were merged into. */
  base: string;
  /** Access token with read access to the repository. Optional for public repositories. Sensitive. */
  token?: string;
  /** Label prefix that names a category, such as `patch:`. */
  labelPrefix: string;
  /** Keep each pull request's author login. Off by default: logins are personal data. */
  keepAuthors: boolean;
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

/** The handle a resource or file write returns. */
export interface DataHandle {
  /** Instance name of the written data. */
  name: string;
}

/** A writer for one file instance. */
export interface FileWriter {
  /** Writes the whole file as UTF-8 text. */
  writeText(text: string): Promise<DataHandle>;
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
  /** Reads the latest version of one of this behavior's resources. */
  readResource?: (
    name: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;
  /** Creates a writer for a file spec. */
  createFileWriter: (specName: string, name: string) => FileWriter;
}

/** What every method returns. */
export interface MethodResult {
  /** Handles of the data the method wrote. */
  dataHandles: DataHandle[];
}

/** A ref resolved to its commit. */
export interface ResolvedRef {
  /** The ref as given: a tag, branch or commit. */
  ref: string;
  /** The commit it names. */
  sha: string;
  /** The commit's committer date, ISO 8601. */
  date: string;
}

/** One merged pull request, as the `gather` resource keeps it. */
export interface Pull {
  /** The pull request's number. */
  number: number;
  /** Its title. */
  title: string;
  /** Every label name on it. */
  labels: string[];
  /** Its category: the first label under the prefix, without the prefix. */
  category: string;
  /** When it was merged, ISO 8601. */
  mergedAt: string;
  /** Its web page. */
  url: string;
  /** The commit the merge put on the base branch, when the forge reports it. */
  mergeCommit?: string;
  /** Author login, kept only when `keepAuthors` is set. */
  author?: string;
}

/** Arguments of `gather`. */
export interface GatherArgs {
  /** Ref the notes start after: the previous release's tag, usually. */
  start: string;
  /** Ref the notes end at, inclusive. Defaults to the base branch. */
  end?: string;
  /** Most pages of pull requests to read before stopping. */
  maxPages: number;
}

/** Arguments of `draft`. */
export interface DraftArgs {
  /** Heading of the notes. */
  title: string;
  /** Categories in the order they appear; any others follow alphabetically. */
  order: string[];
  /** Categories left out of the notes, such as `internal`. */
  exclude: string[];
  /** Whether each line ends with the pull request's number. */
  numbers: boolean;
}

/** Arguments of `bbcode`. */
export interface BbcodeArgs {
  /** Markdown to convert. Defaults to the latest draft's Markdown. */
  markdown?: string;
}

/** One category of a draft. */
export interface DraftCategory {
  /** The category, as the label names it. */
  name: string;
  /** Its heading in the notes. */
  heading: string;
  /** Pull requests under it. */
  count: number;
}

/** Thrown for a refused, failed or unreadable API answer. */
export class ForgeError extends Error {
  /** HTTP status of the answer, 0 when there was none. */
  readonly status: number;

  /** Builds the error. */
  constructor(message: string, status: number) {
    super(message);
    this.name = "ForgeError";
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Schemas (private: the exported interfaces above are the public types, and
// `satisfies` keeps each schema in step with its interface)
// ---------------------------------------------------------------------------

const NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

const GlobalArgsSchema = z.object({
  forge: z.enum(["forgejo", "github"])
    .default("github")
    .describe("forgejo (Forgejo or Gitea, /api/v1) or github."),
  apiUrl: z.url()
    .optional()
    .describe(
      "API root. Defaults to https://api.github.com for github; required for forgejo, such as https://codeberg.org/api/v1.",
    ),
  owner: z.string()
    .regex(NAME_PATTERN)
    .describe("Repository owner, a user or an organization."),
  repo: z.string().regex(NAME_PATTERN).describe("Repository name."),
  base: z.string()
    .min(1)
    .default("main")
    .describe("Branch the pull requests were merged into."),
  token: z.string().min(1).optional().meta({ sensitive: true }).describe(
    "Access token with read access to the repository; optional for a public one. Sent as a bearer token to GitHub and as `token` to Forgejo.",
  ),
  labelPrefix: z.string()
    .default("patch:")
    .describe("Label prefix that names a category: patch:fix is category fix."),
  keepAuthors: z.boolean()
    .default(false)
    .describe(
      "Keep each pull request's author login. Off by default, since a login is personal data.",
    ),
}) satisfies z.ZodType<GlobalArgs>;

const GatherArgsSchema = z.object({
  start: z.string()
    .min(1)
    .describe("Ref the notes start after, such as the previous release tag."),
  end: z.string()
    .min(1)
    .optional()
    .describe("Ref the notes end at, inclusive. Defaults to the base branch."),
  maxPages: z.number()
    .int()
    .positive()
    .max(100)
    .default(10)
    .describe("Most pages of pull requests to read before stopping."),
}) satisfies z.ZodType<GatherArgs>;

const DraftArgsSchema = z.object({
  title: z.string().min(1).default("Patch notes").describe(
    "Heading of the notes.",
  ),
  order: z.array(z.string())
    .default([])
    .describe(
      "Categories in the order they appear; any others follow alphabetically, uncategorized last.",
    ),
  exclude: z.array(z.string())
    .default([])
    .describe("Categories left out of the notes, such as internal."),
  numbers: z.boolean()
    .default(true)
    .describe("Whether each line ends with the pull request's number."),
}) satisfies z.ZodType<DraftArgs>;

const BbcodeArgsSchema = z.object({
  markdown: z.string()
    .optional()
    .describe("Markdown to convert. Defaults to the latest draft's Markdown."),
}) satisfies z.ZodType<BbcodeArgs>;

const ResolvedRefSchema = z.object({
  ref: z.string(),
  sha: z.string(),
  date: z.string(),
}) satisfies z.ZodType<ResolvedRef>;

const PullSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  labels: z.array(z.string()),
  category: z.string(),
  mergedAt: z.string(),
  url: z.string(),
  mergeCommit: z.string().optional(),
  author: z.string().optional(),
}) satisfies z.ZodType<Pull>;

const DraftCategorySchema = z.object({
  name: z.string(),
  heading: z.string(),
  count: z.number().int(),
}) satisfies z.ZodType<DraftCategory>;

const GatherResourceSchema = z.object({
  fetchedAt: z.string().pipe(z.iso.datetime()),
  forge: z.string(),
  repository: z.string(),
  base: z.string(),
  start: ResolvedRefSchema,
  end: ResolvedRefSchema,
  commits: z.number().int(),
  pagesFetched: z.number().int(),
  count: z.number().int(),
  truncated: z.boolean(),
  byCategory: z.record(z.string(), z.number().int()),
  pulls: z.array(PullSchema),
});

const DraftResourceSchema = z.object({
  createdAt: z.string().pipe(z.iso.datetime()),
  repository: z.string(),
  range: z.string(),
  title: z.string(),
  count: z.number().int(),
  excluded: z.number().int(),
  truncated: z.boolean(),
  categories: z.array(DraftCategorySchema),
  markdown: z.string(),
});

const BbcodeResourceSchema = z.object({
  createdAt: z.string().pipe(z.iso.datetime()),
  source: z.enum(["draft", "argument"]),
  length: z.number().int(),
  bbcode: z.string(),
});

// ---------------------------------------------------------------------------
// Upgrades
// ---------------------------------------------------------------------------

/** Every global argument the drafter has taken since its first version. */
const DRAFTER_ARGUMENTS = [
  "forge",
  "apiUrl",
  "owner",
  "repo",
  "base",
  "token",
  "labelPrefix",
  "keepAuthors",
];

/** The global arguments every drafter instance names. */
const REQUIRED_ARGUMENTS = ["owner", "repo"];

/**
 * The upgrade to 2026.10.31.1. A drafter instance (2026.10.21.1) keeps its
 * arguments as written. Swamp hands an upgrade the arguments and not the
 * version they were written for, so arguments are judged by their names: any
 * name the drafter never took, or a missing `owner` or `repo`, means they were
 * written for something else, such as the Discord announcer that held this name
 * at 2026.10.22.1, and the upgrade throws an error naming the change instead of
 * dropping them. Pure: the same arguments give the same result.
 */
export function upgradeArguments(
  old: Record<string, unknown>,
): Record<string, unknown> {
  const foreign = Object.keys(old)
    .filter((name) => !DRAFTER_ARGUMENTS.includes(name))
    .sort();
  const missing = REQUIRED_ARGUMENTS.filter((name) => !(name in old));
  if (foreign.length === 0 && missing.length === 0) {
    return old;
  }
  const problems = [
    ...(foreign.length > 0
      ? [`arguments it does not take (${foreign.join(", ")})`]
      : []),
    ...(missing.length > 0 ? [`no ${missing.join(" or ")}`] : []),
  ];
  throw new Error(
    `@reset/patch-notes 2026.10.31.1 drafts patch notes from merged pull ` +
      `requests, and this instance has ${problems.join(" and ")}. ` +
      `2026.10.22.1 was a Discord announcer published under this name by ` +
      `mistake and is retired: announce a Steam game's patch notes with ` +
      `@reset/steam-news and a Discord post, and give a patch-notes instance ` +
      `owner and repo to draft notes.`,
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** The API root for the configured forge, without a trailing slash. */
export function apiRoot(globalArgs: GlobalArgs): string {
  if (globalArgs.apiUrl !== undefined) {
    return globalArgs.apiUrl.replace(/\/+$/, "");
  }
  if (globalArgs.forge === "github") return GITHUB_API;
  throw new ForgeError(
    "apiUrl is required for forgejo, such as https://codeberg.org/api/v1",
    0,
  );
}

function repoPath(globalArgs: GlobalArgs): string {
  return `/repos/${encodeURIComponent(globalArgs.owner)}/${
    encodeURIComponent(globalArgs.repo)
  }`;
}

/**
 * Sends one GET with the forge's auth and accept headers and returns the
 * parsed JSON body. Throws a ForgeError for a 4xx or 5xx status (naming the
 * rate-limit reset when GitHub reports one) and for a body that is not JSON.
 */
export async function request(
  globalArgs: GlobalArgs,
  path: string,
  query: Record<string, string | number | undefined>,
  signal?: AbortSignal,
): Promise<unknown> {
  const url = new URL(apiRoot(globalArgs) + path);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const headers: Record<string, string> = {};
  if (globalArgs.forge === "github") {
    headers.Accept = "application/vnd.github+json";
    headers["X-GitHub-Api-Version"] = "2022-11-28";
    if (globalArgs.token !== undefined) {
      headers.Authorization = `Bearer ${globalArgs.token}`;
    }
  } else {
    headers.Accept = "application/json";
    if (globalArgs.token !== undefined) {
      headers.Authorization = `token ${globalArgs.token}`;
    }
  }
  const response = await fetch(url, { method: "GET", headers, signal });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text === "" ? undefined : JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const label = `GET ${path}`;
  if (!response.ok) {
    const message = isRecord(parsed) ? asString(parsed.message) : undefined;
    const parts = [
      message ?? (text === "" ? response.statusText : text.slice(0, 200)),
    ];
    const hint = STATUS_HINTS[response.status];
    if (hint !== undefined) parts.push(`(${hint})`);
    if (response.headers.get("x-ratelimit-remaining") === "0") {
      const reset = Number(response.headers.get("x-ratelimit-reset"));
      if (Number.isFinite(reset) && reset > 0) {
        parts.push(
          `rate limit spent until ${new Date(reset * 1000).toISOString()}`,
        );
      }
    }
    throw new ForgeError(
      `${label}: ${response.status} ${parts.filter((p) => p !== "").join(" ")}`,
      response.status,
    );
  }
  if (parsed === undefined) {
    throw new ForgeError(`${label}: answer was not JSON`, response.status);
  }
  return parsed;
}

/** Resolves a tag, branch or commit to its commit sha and committer date. */
export async function resolveRef(
  globalArgs: GlobalArgs,
  ref: string,
  signal?: AbortSignal,
): Promise<ResolvedRef> {
  let commit: unknown;
  if (globalArgs.forge === "github") {
    const encoded = ref.split("/").map(encodeURIComponent).join("/");
    commit = await request(
      globalArgs,
      `${repoPath(globalArgs)}/commits/${encoded}`,
      {},
      signal,
    );
  } else {
    const rows = await request(
      globalArgs,
      `${repoPath(globalArgs)}/commits`,
      {
        sha: ref,
        limit: 1,
        stat: "false",
        verification: "false",
        files: "false",
      },
      signal,
    );
    commit = Array.isArray(rows) ? rows[0] : undefined;
  }
  const sha = isRecord(commit) ? asString(commit.sha) : undefined;
  const inner = isRecord(commit) && isRecord(commit.commit)
    ? commit.commit
    : undefined;
  const committer = inner !== undefined && isRecord(inner.committer)
    ? inner.committer
    : undefined;
  const date = committer === undefined ? undefined : asString(committer.date);
  if (sha === undefined || date === undefined || isNaN(Date.parse(date))) {
    throw new ForgeError(`ref ${ref}: no commit with a date in the answer`, 0);
  }
  return { ref, sha, date: new Date(date).toISOString() };
}

/**
 * Lists the commits reachable from `head` and not from `base` through the
 * forge's compare endpoint. `complete` is false when the forge reported more
 * commits than were listed, or `maxPages` stopped the listing.
 */
export async function compareCommits(
  globalArgs: GlobalArgs,
  base: string,
  head: string,
  maxPages: number,
  signal?: AbortSignal,
): Promise<{ shas: Set<string>; total: number; complete: boolean }> {
  const path = `${repoPath(globalArgs)}/compare/${encodeURIComponent(base)}...${
    encodeURIComponent(head)
  }`;
  const shas = new Set<string>();
  let total = 0;
  const pages = globalArgs.forge === "github" ? maxPages : 1;
  for (let page = 1; page <= pages; page++) {
    const query: Record<string, number | undefined> = globalArgs.forge ===
        "github"
      ? { per_page: GITHUB_PAGE_SIZE, page }
      : {};
    const answer = await request(globalArgs, path, query, signal);
    if (!isRecord(answer) || !Array.isArray(answer.commits)) {
      throw new ForgeError(`GET ${path}: answer has no commits list`, 0);
    }
    if (typeof answer.total_commits === "number") total = answer.total_commits;
    for (const commit of answer.commits) {
      const sha = isRecord(commit) ? asString(commit.sha) : undefined;
      if (sha !== undefined) shas.add(sha);
    }
    if (answer.commits.length === 0 || shas.size >= total) break;
  }
  total = Math.max(total, shas.size);
  return { shas, total, complete: shas.size >= total };
}

/** The category a pull request's labels give it under the prefix. */
export function categoryOf(labels: string[], prefix: string): string {
  for (const label of labels) {
    if (prefix === "" || label.startsWith(prefix)) {
      const name = label.slice(prefix.length).trim();
      if (name !== "") return name;
    }
  }
  return UNCATEGORIZED;
}

/**
 * Reduces one pull request from either API to what the notes need. Returns
 * undefined for one that was closed without merging or merged into another
 * branch.
 */
export function normalizePull(
  row: unknown,
  base: string,
  prefix: string,
  keepAuthors: boolean,
): Pull | undefined {
  if (!isRecord(row)) return undefined;
  const mergedAt = asString(row.merged_at);
  if (mergedAt === undefined || isNaN(Date.parse(mergedAt))) return undefined;
  const baseRef = isRecord(row.base) ? asString(row.base.ref) : undefined;
  if (baseRef !== undefined && baseRef !== base) return undefined;
  const number = typeof row.number === "number" ? row.number : undefined;
  if (number === undefined) return undefined;
  const labels = Array.isArray(row.labels)
    ? row.labels
      .map((label) => isRecord(label) ? asString(label.name) : undefined)
      .filter((name): name is string => name !== undefined)
    : [];
  const pull: Pull = {
    number,
    title: (asString(row.title) ?? "").trim(),
    labels,
    category: categoryOf(labels, prefix),
    mergedAt: new Date(mergedAt).toISOString(),
    url: asString(row.html_url) ?? "",
  };
  const mergeCommit = asString(row.merge_commit_sha);
  if (mergeCommit !== undefined && mergeCommit !== "") {
    pull.mergeCommit = mergeCommit;
  }
  if (keepAuthors && isRecord(row.user)) {
    const login = asString(row.user.login);
    if (login !== undefined) pull.author = login;
  }
  return pull;
}

/** Heading text for a category: `new-content` reads `New content`. */
export function headingOf(category: string): string {
  const words = category.replace(/[-_]+/g, " ").trim();
  return words === "" ? category : words[0].toUpperCase() + words.slice(1);
}

/** Orders categories: `order` first, the rest alphabetically, uncategorized last. */
export function orderCategories(names: string[], order: string[]): string[] {
  const unique = [...new Set(names)];
  const ranked = order.filter((name) => unique.includes(name));
  const rest = unique
    .filter((name) => !order.includes(name) && name !== UNCATEGORIZED)
    .sort();
  const tail = unique.includes(UNCATEGORIZED) && !order.includes(UNCATEGORIZED)
    ? [UNCATEGORIZED]
    : [];
  return [...ranked, ...rest, ...tail];
}

/** Writes the Markdown notes for a set of pull requests. */
export function renderMarkdown(
  pulls: Pull[],
  args: DraftArgs,
): { markdown: string; categories: DraftCategory[]; excluded: number } {
  const kept = pulls.filter((pull) => !args.exclude.includes(pull.category));
  const names = orderCategories(kept.map((pull) => pull.category), args.order);
  const lines = [`# ${args.title}`, ""];
  const categories: DraftCategory[] = [];
  for (const name of names) {
    const group = kept
      .filter((pull) => pull.category === name)
      .sort((a, b) => a.mergedAt.localeCompare(b.mergedAt));
    const heading = headingOf(name);
    categories.push({ name, heading, count: group.length });
    lines.push(`## ${heading}`, "");
    for (const pull of group) {
      lines.push(`- ${pull.title}${args.numbers ? ` (#${pull.number})` : ""}`);
    }
    lines.push("");
  }
  return {
    markdown: lines.join("\n").replace(/\n+$/, "\n"),
    categories,
    excluded: pulls.length - kept.length,
  };
}

function inlineBbcode(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "[url=$2]$1[/url]")
    .replace(/\*\*([^*]+)\*\*/g, "[b]$1[/b]")
    .replace(/__([^_]+)__/g, "[b]$1[/b]")
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*/g, "$1[i]$2[/i]")
    .replace(/(^|[^_\w])_([^_\s][^_]*)_/g, "$1[i]$2[/i]")
    .replace(/~~([^~]+)~~/g, "[strike]$1[/strike]")
    .replace(/`([^`]+)`/g, "$1");
}

/**
 * Converts the Markdown subset a draft uses to Steam announcement BBCode:
 * headings to [h1] to [h3], bullet and numbered lists to [list] and [olist],
 * bold, italic, strike and links inline, and a horizontal rule to [hr].
 * Anything else passes through as plain text.
 */
export function markdownToBbcode(markdown: string): string {
  const out: string[] = [];
  let list: "list" | "olist" | undefined;
  const close = () => {
    if (list !== undefined) out.push(`[/${list}]`);
    list = undefined;
  };
  for (const raw of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet !== null || numbered !== null) {
      const kind = bullet !== null ? "list" : "olist";
      if (list !== kind) {
        close();
        out.push(`[${kind}]`);
        list = kind;
      }
      out.push(`[*]${inlineBbcode((bullet ?? numbered)![1])}`);
      continue;
    }
    close();
    if (heading !== null) {
      const level = Math.min(heading[1].length, 3);
      out.push(`[h${level}]${inlineBbcode(heading[2])}[/h${level}]`);
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push("[hr][/hr]");
    } else {
      out.push(inlineBbcode(line));
    }
  }
  close();
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

// ---------------------------------------------------------------------------
// Behavior definition
// ---------------------------------------------------------------------------

/**
 * The behavior definition Swamp registers. Global arguments are `forge`,
 * `apiUrl`, `owner`, `repo`, `base`, `token` (sensitive, optional),
 * `labelPrefix` and `keepAuthors`; see the README for each method, the data it
 * writes and the instance name it writes it under.
 */
export const behavior = {
  // String literals, not constants: the registry catalog reads them from the
  // source.
  type: "@reset/patch-notes",
  version: "2026.10.31.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.10.31.1",
      description:
        "Takes the name back from the Discord announcer published as 2026.10.22.1: drafter instances keep their arguments as written, and arguments the drafter never took fail with an error naming the change",
      upgradeAttributes: (old: Record<string, unknown>): Record<
        string,
        unknown
      > => upgradeArguments(old),
    },
  ],
  resources: {
    gather: {
      description: "The pull requests merged into the base branch between " +
        "two refs: number, title, labels, category, merge time and URL",
      schema: GatherResourceSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    draft: {
      description: "Markdown notes drafted from the latest gather, with " +
        "counts per category",
      schema: DraftResourceSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    bbcode: {
      description: "The draft, or given Markdown, as Steam announcement BBCode",
      schema: BbcodeResourceSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  files: {
    notes: {
      description: "The drafted notes as a Markdown file",
      contentType: "text/markdown",
      lifetime: "infinite",
      garbageCollection: 20,
    },
    steam: {
      description: "The notes as a Steam announcement BBCode file",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    gather: {
      description: "Resolve two refs to commit dates and gather the pull " +
        "requests merged into the base branch after start and up to end. " +
        "Writes gather.",
      arguments: GatherArgsSchema,
      execute: async (
        args: GatherArgs,
        context: Context,
      ): Promise<MethodResult> => {
        const { globalArgs, signal, logger } = context;
        const repository = `${globalArgs.owner}/${globalArgs.repo}`;
        const start = await resolveRef(globalArgs, args.start, signal);
        const end = await resolveRef(
          globalArgs,
          args.end ?? globalArgs.base,
          signal,
        );
        if (Date.parse(end.date) < Date.parse(start.date)) {
          throw new ForgeError(
            `end ${end.ref} (${end.date}) is older than start ${start.ref} (${start.date})`,
            0,
          );
        }
        logger.info(
          "Gathering pull requests merged into {base} of {repository} after {start} up to {end}",
          {
            base: globalArgs.base,
            repository,
            start: start.date,
            end: end.date,
          },
        );
        const github = globalArgs.forge === "github";
        const pageSize = github ? GITHUB_PAGE_SIZE : FORGEJO_PAGE_SIZE;
        const range = await compareCommits(
          globalArgs,
          start.sha,
          end.sha,
          args.maxPages,
          signal,
        );
        logger.debug("{count} commits between the refs", {
          count: range.total,
        });
        const startTime = Date.parse(start.date);
        const endTime = Date.parse(end.date);
        // Rows last updated a day before the start commit cannot hold a merge
        // after it; the day absorbs clock skew between commit and merge times.
        const stopTime = startTime - STOP_SLACK_MS;
        const pulls: Pull[] = [];
        let pagesFetched = 0;
        let reachedStart = false;
        for (let page = 1; page <= args.maxPages; page++) {
          const query: Record<string, string | number> = github
            ? {
              state: "closed",
              base: globalArgs.base,
              sort: "updated",
              direction: "desc",
              per_page: pageSize,
              page,
            }
            : {
              state: "closed",
              base: globalArgs.base,
              sort: "recentupdate",
              limit: pageSize,
              page,
            };
          const rows = await request(
            globalArgs,
            `${repoPath(globalArgs)}/pulls`,
            query,
            signal,
          );
          if (!Array.isArray(rows)) {
            throw new ForgeError(
              `GET ${repoPath(globalArgs)}/pulls: answer was not a list`,
              0,
            );
          }
          pagesFetched++;
          for (const row of rows) {
            // Sorted by last update, newest first, and a merge is an update:
            // once a row was last touched before start, every later row was
            // merged (if at all) before start too.
            const updated = isRecord(row)
              ? Date.parse(asString(row.updated_at) ?? "")
              : NaN;
            if (!isNaN(updated) && updated <= stopTime) reachedStart = true;
            const pull = normalizePull(
              row,
              globalArgs.base,
              globalArgs.labelPrefix,
              globalArgs.keepAuthors,
            );
            if (pull === undefined) continue;
            // Membership is by ancestry: the merge commit lies between the
            // refs. Only a forge that reports no merge commit falls back to
            // the merge time.
            const merged = Date.parse(pull.mergedAt);
            const inRange = pull.mergeCommit !== undefined
              ? range.shas.has(pull.mergeCommit)
              : merged > startTime && merged <= endTime;
            if (inRange) pulls.push(pull);
          }
          logger.debug("Page {page}: {count} pull requests", {
            page,
            count: rows.length,
          });
          if (reachedStart || rows.length < pageSize) {
            reachedStart = true;
            break;
          }
        }
        if (!reachedStart) {
          logger.warning(
            "Stopped after {pages} pages before reaching {start}: raise maxPages",
            { pages: pagesFetched, start: start.ref },
          );
        }
        if (!range.complete) {
          logger.warning(
            "The forge listed {listed} of {total} commits between the refs",
            { listed: range.shas.size, total: range.total },
          );
        }
        const truncated = !reachedStart || !range.complete;
        const seen = new Set<number>();
        const unique = pulls
          .filter((pull) => !seen.has(pull.number) && seen.add(pull.number))
          .sort((a, b) => a.mergedAt.localeCompare(b.mergedAt));
        const byCategory: Record<string, number> = {};
        for (const pull of unique) {
          byCategory[pull.category] = (byCategory[pull.category] ?? 0) + 1;
        }
        const handle = await context.writeResource("gather", "gather", {
          fetchedAt: new Date().toISOString(),
          forge: globalArgs.forge,
          repository,
          base: globalArgs.base,
          start,
          end,
          commits: range.total,
          pagesFetched,
          count: unique.length,
          truncated,
          byCategory,
          pulls: unique,
        });
        logger.info(
          "Gathered {count} merged pull requests in {pages} pages (truncated={truncated})",
          { count: unique.length, pages: pagesFetched, truncated },
        );
        return { dataHandles: [handle] };
      },
    },
    draft: {
      description: "Draft Markdown notes from the latest gather, grouped by " +
        "category. Writes the draft resource and the notes file.",
      arguments: DraftArgsSchema,
      execute: async (
        args: DraftArgs,
        context: Context,
      ): Promise<MethodResult> => {
        const stored = await context.readResource?.("gather");
        const parsed = GatherResourceSchema.safeParse(stored);
        if (!parsed.success) {
          throw new ForgeError(
            "draft needs a gather: run the gather method first",
            0,
          );
        }
        const gathered = parsed.data;
        const { markdown, categories, excluded } = renderMarkdown(
          gathered.pulls,
          args,
        );
        if (gathered.truncated) {
          context.logger.warning(
            "The gather was truncated: the draft may miss pull requests",
          );
        }
        const notes = await context
          .createFileWriter("notes", "notes")
          .writeText(markdown);
        const handle = await context.writeResource("draft", "draft", {
          createdAt: new Date().toISOString(),
          repository: gathered.repository,
          range: `${gathered.start.ref}..${gathered.end.ref}`,
          title: args.title,
          count: gathered.count - excluded,
          excluded,
          truncated: gathered.truncated,
          categories,
          markdown,
        });
        context.logger.info(
          "Drafted {count} pull requests in {categories} categories, {excluded} excluded",
          {
            count: gathered.count - excluded,
            categories: categories.length,
            excluded,
          },
        );
        return { dataHandles: [handle, notes] };
      },
    },
    bbcode: {
      description: "Render the latest draft, or given Markdown, as Steam " +
        "announcement BBCode. Writes the bbcode resource and the steam file.",
      arguments: BbcodeArgsSchema,
      execute: async (
        args: BbcodeArgs,
        context: Context,
      ): Promise<MethodResult> => {
        let markdown = args.markdown;
        let source: "draft" | "argument" = "argument";
        if (markdown === undefined) {
          const stored = await context.readResource?.("draft");
          const parsed = DraftResourceSchema.safeParse(stored);
          if (!parsed.success) {
            throw new ForgeError(
              "bbcode needs a draft or a markdown argument: run draft first",
              0,
            );
          }
          markdown = parsed.data.markdown;
          source = "draft";
        }
        const bbcode = markdownToBbcode(markdown);
        const file = await context
          .createFileWriter("steam", "steam")
          .writeText(bbcode);
        const handle = await context.writeResource("bbcode", "bbcode", {
          createdAt: new Date().toISOString(),
          source,
          length: bbcode.length,
          bbcode,
        });
        context.logger.info(
          "Rendered {length} characters of BBCode from {source}",
          {
            length: bbcode.length,
            source,
          },
        );
        return { dataHandles: [handle, file] };
      },
    },
  },
};
