/**
 * Records which build each of a Steam app's branches runs, and the app's
 * recent builds, from Valve's Steamworks partner Web API, and summarises how
 * the branches moved.
 *
 * `sample` calls
 * `GET https://partner.steam-api.com/ISteamApps/GetAppBetas/v1/` and then
 * `GET https://partner.steam-api.com/ISteamApps/GetAppBuilds/v1/`, one request
 * at a time, and writes each branch's live build and the recent builds as a
 * new version of the app's `builds` resource, flagging each branch whose live
 * build changed since the previous version. `summarise` reads every recorded
 * version back and writes each branch's build history, how often it moved,
 * and the newest build.
 *
 * Valve documents these methods and their parameters but not their answers.
 * The shapes read here were observed from real answers on 2026-10-23. The
 * `AccountIDCreator` of each build is a Steam account id, so it is read past
 * and never recorded. Valve returns whether a branch needs a password, never
 * the password.
 *
 * The key is a Steamworks publisher Web API key. It is a sensitive global
 * argument, supplied from a swamp vault, sent only in the `x-webapi-key`
 * request header and only to `https://partner.steam-api.com`, with redirects
 * refused so it cannot follow one to another host. It is never part of a URL,
 * never written to a record and never logged, and it is removed from any error
 * text. Every request names this extension and its version in its User-Agent.
 * `fetch` is injectable through the `_fetch` method argument so tests never
 * reach Valve.
 *
 * @module
 */

import { z } from "npm:zod@4";

/** This behavior's version, sent in the User-Agent of every request. */
export const VERSION = "2026.10.30.1";

/** The User-Agent every request sends, naming this extension and its version. */
export const USER_AGENT =
  `@reset/steamworks-builds/${VERSION} (swamp extension)`;

/** Valve's partner Web API host; the key is sent to no other origin. */
export const PARTNER_BASE = "https://partner.steam-api.com";

/** The request header Valve documents for passing a Web API key. */
export const KEY_HEADER = "x-webapi-key";

/** How long one request to Valve may take before it is abandoned. */
export const REQUEST_TIMEOUT_MS = 15_000;

/** How many recent builds `sample` asks for by default, Valve's own default. */
export const DEFAULT_COUNT = 10;

/** The most recent builds one sample may ask for. */
export const MAX_COUNT = 100;

/** The largest app id Valve's `uint32` field holds. */
export const MAX_APP_ID = 4_294_967_295;

/** `true` only when the zod output type and the hand-written interface describe the same shape. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

const GlobalArgsSchema = z.object({
  apiKey: z.string().min(1).meta({ sensitive: true }).describe(
    "Steamworks publisher Web API key that owns the app, supplied with a vault.get expression, never a literal. Sent only in the x-webapi-key header to partner.steam-api.com",
  ),
  appId: z.number().int().min(1).max(MAX_APP_ID).describe(
    "Steam app id whose branches and builds are recorded, e.g. 440",
  ),
});

/** Global arguments of a behavior instance: the key and the one app it records. */
export interface GlobalArgs {
  /** Publisher Web API key. Sensitive: supply it with a vault expression. */
  apiKey: string;
  /** Steam app id. */
  appId: number;
}

const _GlobalArgsMatch: Same<z.infer<typeof GlobalArgsSchema>, GlobalArgs> =
  true;

const DepotSchema = z.object({
  depotId: z.number().int().min(0),
  depotVersionGid: z.string().nullable(),
  totalOriginalBytes: z.string().nullable(),
  totalCompressedBytes: z.string().nullable(),
});

/** One depot of a build, with whichever of Valve's per-depot fields the answer carried. */
export interface Depot {
  /** Depot id. */
  depotId: number;
  /** The depot manifest's GID, a 64-bit number kept as Valve's decimal string, or null when absent. */
  depotVersionGid: string | null;
  /** Uncompressed size in bytes as Valve's decimal string, or null when absent. */
  totalOriginalBytes: string | null;
  /** Compressed size in bytes as Valve's decimal string, or null when absent. */
  totalCompressedBytes: string | null;
}

const _DepotMatch: Same<z.infer<typeof DepotSchema>, Depot> = true;

const BuildSchema = z.object({
  buildId: z.number().int().min(0),
  createdAt: z.string().pipe(z.iso.datetime()),
  description: z.string(),
  depots: z.array(DepotSchema),
});

/** One build of the app. The account that made it is not recorded. */
export interface Build {
  /** Build id. */
  buildId: number;
  /** ISO-8601 time the build was created. */
  createdAt: string;
  /** The build's description as set when it was uploaded. */
  description: string;
  /** The build's depots, in depot id order. */
  depots: Depot[];
}

const _BuildMatch: Same<z.infer<typeof BuildSchema>, Build> = true;

const BranchSchema = z.object({
  name: z.string(),
  description: z.string(),
  passwordRequired: z.boolean(),
  reqLocalCS: z.number().int(),
  buildId: z.number().int().min(0),
  buildCreatedAt: z.string().pipe(z.iso.datetime()).nullable(),
  buildDepots: z.array(DepotSchema).nullable(),
  previousBuildId: z.number().int().min(0).nullable(),
  changed: z.boolean(),
});

/** One branch and the build it runs. */
export interface Branch {
  /** Branch name, `public` for the default branch. */
  name: string;
  /** The branch's description. */
  description: string;
  /** Whether the branch needs a password. Valve returns the flag only, never the password. */
  passwordRequired: boolean;
  /** Valve's `ReqLocalCS` value as sent, 0 or 1. */
  reqLocalCS: number;
  /** The build the branch runs. */
  buildId: number;
  /** When that build was created, or null when it is not among the recent builds read. */
  buildCreatedAt: string | null;
  /** That build's depots, or null when it is not among the recent builds read. */
  buildDepots: Depot[] | null;
  /** The build the branch ran in the previous version, or null when it was not recorded there. */
  previousBuildId: number | null;
  /** Whether the previous version recorded the branch on a different build. */
  changed: boolean;
}

const _BranchMatch: Same<z.infer<typeof BranchSchema>, Branch> = true;

const BuildsRecordSchema = z.object({
  appId: z.number().int().positive(),
  fetchedAt: z.string().pipe(z.iso.datetime()),
  previousFetchedAt: z.string().pipe(z.iso.datetime()).nullable(),
  count: z.number().int().positive(),
  branches: z.array(BranchSchema),
  changedBranches: z.array(z.string()),
  removedBranches: z.array(z.string()),
  builds: z.array(BuildSchema),
});

/** One version of an app's `builds` resource: its branches and recent builds read at one moment. */
export interface BuildsRecord {
  /** Steam app id. */
  appId: number;
  /** ISO-8601 time the branches and builds were read. */
  fetchedAt: string;
  /** When the previous version was read, or null when this is the first. */
  previousFetchedAt: string | null;
  /** How many recent builds were asked for. */
  count: number;
  /** Every branch, in name order. */
  branches: Branch[];
  /** Names of the branches whose live build changed since the previous version. */
  changedBranches: string[];
  /** Names of the branches the previous version recorded and this one does not. */
  removedBranches: string[];
  /** The recent builds Valve returned, newest build id first. */
  builds: Build[];
}

const _BuildsRecordMatch: Same<
  z.infer<typeof BuildsRecordSchema>,
  BuildsRecord
> = true;

const HistoryEntrySchema = z.object({
  buildId: z.number().int().min(0),
  firstSeenAt: z.string().pipe(z.iso.datetime()),
});

/** One build a branch ran, and the first recorded version that showed it there. */
export interface HistoryEntry {
  /** Build id. */
  buildId: number;
  /** ISO-8601 time of the first version that recorded the branch on this build. */
  firstSeenAt: string;
}

const _HistoryEntryMatch: Same<
  z.infer<typeof HistoryEntrySchema>,
  HistoryEntry
> = true;

const BranchHistorySchema = z.object({
  name: z.string(),
  currentBuildId: z.number().int().min(0),
  inLatest: z.boolean(),
  moves: z.number().int().min(0),
  history: z.array(HistoryEntrySchema),
});

/** A branch's builds across the recorded versions. */
export interface BranchHistory {
  /** Branch name. */
  name: string;
  /** The build the branch ran when last recorded. */
  currentBuildId: number;
  /** Whether the latest version still recorded the branch. */
  inLatest: boolean;
  /** How many times the branch's live build changed across the versions. */
  moves: number;
  /** Each build in the order the branch ran it; a build it returned to appears again. */
  history: HistoryEntry[];
}

const _BranchHistoryMatch: Same<
  z.infer<typeof BranchHistorySchema>,
  BranchHistory
> = true;

const NewestBuildSchema = z.object({
  buildId: z.number().int().min(0),
  createdAt: z.string().pipe(z.iso.datetime()),
  description: z.string(),
});

/** The newest build any recorded version read. */
export interface NewestBuild {
  /** Build id. */
  buildId: number;
  /** ISO-8601 time the build was created. */
  createdAt: string;
  /** The build's description. */
  description: string;
}

const _NewestBuildMatch: Same<z.infer<typeof NewestBuildSchema>, NewestBuild> =
  true;

const SummarySchema = z.object({
  appId: z.number().int().positive(),
  branch: z.string().nullable(),
  samples: z.number().int().positive(),
  firstFetchedAt: z.string().pipe(z.iso.datetime()),
  lastFetchedAt: z.string().pipe(z.iso.datetime()),
  branches: z.array(BranchHistorySchema),
  newestBuild: NewestBuildSchema.nullable(),
  summarisedAt: z.string().pipe(z.iso.datetime()),
});

/** The summary of an app's recorded branches and builds. */
export interface Summary {
  /** The one branch asked for, or null when every branch counted. */
  branch: string | null;
  /** Steam app id. */
  appId: number;
  /** How many recorded versions were read. */
  samples: number;
  /** When the earliest version was read. */
  firstFetchedAt: string;
  /** When the latest version was read. */
  lastFetchedAt: string;
  /** Each branch's build history, in name order. */
  branches: BranchHistory[];
  /** The most recently created build any version read, or null when none read a build. */
  newestBuild: NewestBuild | null;
  /** ISO-8601 time the summary was written. */
  summarisedAt: string;
}

const _SummaryMatch: Same<z.infer<typeof SummarySchema>, Summary> = true;

const SampleArgsSchema = z.object({
  count: z.number().int().min(1).max(MAX_COUNT).optional().describe(
    "How many recent builds to ask GetAppBuilds for, 1 to 100; 10, Valve's default, when omitted",
  ),
});

/** Arguments of the `sample` method. */
export interface SampleArgs {
  /** How many recent builds to ask for. */
  count?: number;
}

const _SampleArgsMatch: Same<z.infer<typeof SampleArgsSchema>, SampleArgs> =
  true;

const SummariseArgsSchema = z.object({
  branch: z.string().min(1).optional().describe(
    "Only summarise this branch, e.g. public; every recorded branch when omitted",
  ),
});

/** Arguments of the `summarise` method. */
export interface SummariseArgs {
  /** Only this branch counts. */
  branch?: string;
}

const _SummariseArgsMatch: Same<
  z.infer<typeof SummariseArgsSchema>,
  SummariseArgs
> = true;

/** A decimal count Valve sends as a string, or as a number. */
const ApiCountSchema = z.union([z.string().regex(/^\d+$/), z.number().int()])
  .optional();

/** One depot of a build in GetAppBuilds, as observed. */
const ApiDepotSchema = z.object({
  DepotID: z.number().int().min(0).optional(),
  DepotVersionGID: ApiCountSchema,
  TotalOriginalBytes: ApiCountSchema,
  TotalCompressedBytes: ApiCountSchema,
});

/** One build in GetAppBuilds, as observed. `AccountIDCreator` is left out, so it is never kept. */
const ApiBuildSchema = z.object({
  BuildID: z.number().int().min(0),
  CreationTime: z.number().int().min(0),
  Description: z.string().default(""),
  depots: z.record(z.string(), ApiDepotSchema).default({}),
});

/** One branch in GetAppBetas, as observed. */
const ApiBetaSchema = z.object({
  BuildID: z.number().int().min(0),
  Description: z.string().default(""),
  ReqPassword: z.number().int().default(0),
  ReqLocalCS: z.number().int().default(0),
});

/** The envelope every ISteamApps answer was observed in. */
const ApiEnvelopeSchema = z.object({
  response: z.object({
    result: z.number().int(),
    message: z.string().optional(),
  }).loose(),
});

const ApiBetasSchema = z.object({
  betas: z.record(z.string(), ApiBetaSchema),
});

const ApiBuildsSchema = z.object({
  builds: z.record(z.string(), ApiBuildSchema),
});

/** The subset of `fetch` the methods use. Tests replace it. */
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
  /** Id of this behavior instance, used to find its own recorded versions. */
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

/** The data name an app's branches and builds are written under. */
export function buildsName(appId: number): string {
  return `builds-${appId}`;
}

/** The data name an app's summary is written under. */
export function summaryName(appId: number): string {
  return `summary-${appId}`;
}

/** The ISteamApps methods this extension calls. */
export type SteamAppsMethod = "GetAppBetas" | "GetAppBuilds";

/** The request URL for one method and app. The key is never part of it. */
export function methodUrl(
  method: SteamAppsMethod,
  appId: number,
  count?: number,
): string {
  const url = new URL(`${PARTNER_BASE}/ISteamApps/${method}/v1/`);
  url.searchParams.set("appid", String(appId));
  if (count !== undefined) {
    url.searchParams.set("count", String(count));
  }
  return url.toString();
}

/** Removes every occurrence of the key from a text before it is reported. */
function redact(text: string, apiKey: string): string {
  return apiKey.length === 0 ? text : text.split(apiKey).join("[redacted]");
}

/** What a status code means for these methods. */
const STATUS_HINTS: Record<number, string> = {
  400: "Valve rejected the request's parameters",
  401: "the key was not accepted",
  404: "no such method on the partner host",
};

/**
 * Sends one GET request with the key in the `x-webapi-key` header and returns
 * the inside of Valve's `response` envelope. Redirects are refused so the key
 * cannot follow one to another host. Throws a specific error for a network
 * failure, a refused key, a rate limit, a server error, another failing status,
 * a body that is not JSON or not the envelope, and a `result` other than 1,
 * naming Valve's `message`. No message contains the key.
 */
export async function callSteamApps(
  fetcher: Fetcher,
  apiKey: string,
  method: SteamAppsMethod,
  appId: number,
  count?: number,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const url = methodUrl(method, appId, count);
  const where = `${method} for app ${appId}`;
  if (!url.startsWith(`${PARTNER_BASE}/`)) {
    throw new Error(
      `${where}: refusing to send the key outside ${PARTNER_BASE}`,
    );
  }
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        "user-agent": USER_AGENT,
        [KEY_HEADER]: apiKey,
      },
      redirect: "error",
      signal: combined,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${where}: request failed: ${redact(detail, apiKey)}`);
  }
  const body = await response.text();
  const text = redact(body, apiKey).slice(0, 200);
  if (response.status === 403) {
    throw new Error(
      `${where}: HTTP 403, Valve refused the key: it must be a publisher Web API key that owns the app, and the calling address must be on the key's allow list when it has one. Valve rate-limits an address strictly after 403 answers, so fix the key before retrying`,
    );
  }
  if (response.status === 429) {
    const retryAfter = response.headers.get("retry-after");
    throw new Error(
      `${where}: Valve rate limited the request (HTTP 429)` +
        (retryAfter === null
          ? ", wait before retrying"
          : `, retry after ${retryAfter} seconds`),
    );
  }
  if (response.status >= 500) {
    throw new Error(
      `${where}: Valve is unavailable (HTTP ${response.status}), a transient failure, retry later: ${text}`,
    );
  }
  if (!response.ok) {
    const hint = STATUS_HINTS[response.status] ?? "unexpected status";
    throw new Error(`${where}: HTTP ${response.status}, ${hint}: ${text}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error(
      `${where}: HTTP ${response.status}, body is not JSON: ${text}`,
    );
  }
  const parsed = ApiEnvelopeSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `${where}: the answer has no response envelope with a result: ${text}`,
    );
  }
  const inner = parsed.data.response;
  if (inner.result !== 1) {
    const message = redact(inner.message ?? "", apiKey).slice(0, 200);
    throw new Error(
      `${where}: Valve answered result ${inner.result}: ${
        message === "" ? "no message" : message
      }`,
    );
  }
  return inner;
}

/** The issues of a failed parse, joined and cut short for an error message. */
function issues(error: z.ZodError): string {
  return error.issues.map((issue) =>
    `${issue.path.join(".")}: ${issue.message}`
  ).join("; ").slice(0, 300);
}

/** A count Valve sent, as a decimal string, or null when absent. */
function countText(value: string | number | undefined): string | null {
  return value === undefined ? null : String(value);
}

/** Converts an epoch-seconds time to ISO-8601. */
export function isoFromEpoch(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

/** The branches GetAppBetas returned, before comparison with the previous version. */
export interface ApiBranch {
  /** Branch name. */
  name: string;
  /** The branch's description. */
  description: string;
  /** Whether a password is required. */
  passwordRequired: boolean;
  /** Valve's `ReqLocalCS` value. */
  reqLocalCS: number;
  /** The live build id. */
  buildId: number;
}

/** Reads the app's branches with GetAppBetas. Throws on any failure. */
export async function fetchBranches(
  fetcher: Fetcher,
  apiKey: string,
  appId: number,
  signal?: AbortSignal,
): Promise<ApiBranch[]> {
  const inner = await callSteamApps(
    fetcher,
    apiKey,
    "GetAppBetas",
    appId,
    undefined,
    signal,
  );
  const parsed = ApiBetasSchema.safeParse(inner);
  if (!parsed.success) {
    throw new Error(
      `GetAppBetas for app ${appId}: the answer is not the observed betas map: ${
        issues(parsed.error)
      }`,
    );
  }
  return Object.entries(parsed.data.betas).map(([name, beta]) => ({
    name,
    description: beta.Description,
    passwordRequired: beta.ReqPassword !== 0,
    reqLocalCS: beta.ReqLocalCS,
    buildId: beta.BuildID,
  })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

/** Reads the app's recent builds with GetAppBuilds, newest build id first. Throws on any failure. */
export async function fetchBuilds(
  fetcher: Fetcher,
  apiKey: string,
  appId: number,
  count: number,
  signal?: AbortSignal,
): Promise<Build[]> {
  const inner = await callSteamApps(
    fetcher,
    apiKey,
    "GetAppBuilds",
    appId,
    count,
    signal,
  );
  const parsed = ApiBuildsSchema.safeParse(inner);
  if (!parsed.success) {
    throw new Error(
      `GetAppBuilds for app ${appId}: the answer is not the observed builds map: ${
        issues(parsed.error)
      }`,
    );
  }
  return Object.values(parsed.data.builds).map((build) => ({
    buildId: build.BuildID,
    createdAt: isoFromEpoch(build.CreationTime),
    description: build.Description,
    depots: Object.entries(build.depots).map(([key, depot]) => ({
      depotId: depot.DepotID ?? Number(key),
      depotVersionGid: countText(depot.DepotVersionGID),
      totalOriginalBytes: countText(depot.TotalOriginalBytes),
      totalCompressedBytes: countText(depot.TotalCompressedBytes),
    })).sort((a, b) => a.depotId - b.depotId),
  })).sort((a, b) => b.buildId - a.buildId);
}

/**
 * Joins the branches to the builds read with them and to the previous
 * version: a branch is changed when the previous version recorded it on a
 * different build. No branch is changed in the first version.
 */
export function compare(
  appId: number,
  branches: readonly ApiBranch[],
  builds: readonly Build[],
  previous: BuildsRecord | null,
  count: number,
  fetchedAt: string,
): BuildsRecord {
  const byId = new Map(builds.map((build) => [build.buildId, build]));
  const before = new Map(
    (previous?.branches ?? []).map((branch) => [branch.name, branch.buildId]),
  );
  const recorded: Branch[] = branches.map((branch) => {
    const build = byId.get(branch.buildId);
    const previousBuildId = before.get(branch.name) ?? null;
    return {
      ...branch,
      buildCreatedAt: build?.createdAt ?? null,
      buildDepots: build?.depots ?? null,
      previousBuildId,
      changed: previousBuildId !== null && previousBuildId !== branch.buildId,
    };
  });
  const names = new Set(branches.map((branch) => branch.name));
  return {
    appId,
    fetchedAt,
    previousFetchedAt: previous?.fetchedAt ?? null,
    count,
    branches: recorded,
    changedBranches: recorded.filter((branch) => branch.changed).map((
      branch,
    ) => branch.name),
    removedBranches: [...before.keys()].filter((name) => !names.has(name))
      .sort(),
    builds: [...builds],
  };
}

/** One recorded version and its number. */
export interface RecordedBuilds {
  /** The stored version number. */
  version: number;
  /** The version's content. */
  record: BuildsRecord;
}

/** Parses stored records, oldest version first, counting those that are not versions of this app. */
export function parseRecorded(
  appId: number,
  records: readonly unknown[],
): { recorded: RecordedBuilds[]; skipped: number } {
  const recorded: RecordedBuilds[] = [];
  let skipped = 0;
  for (const stored of records) {
    const fields = stored !== null && typeof stored === "object"
      ? stored as Partial<DataRecord>
      : undefined;
    const parsed = BuildsRecordSchema.safeParse(fields?.attributes);
    if (
      !parsed.success || parsed.data.appId !== appId ||
      typeof fields?.version !== "number"
    ) {
      skipped += 1;
      continue;
    }
    recorded.push({ version: fields.version, record: parsed.data });
  }
  recorded.sort((a, b) => a.version - b.version);
  return { recorded, skipped };
}

/**
 * Summarises recorded versions in the order they were read: each branch's
 * builds with the first version that showed each, how often it moved, and the
 * newest build any version read. Throws when no version, or no version of the
 * branch asked for, is left.
 */
export function summarise(
  appId: number,
  records: readonly BuildsRecord[],
  branch: string | null,
  summarisedAt: string,
): Summary {
  const ordered = [...records].sort((a, b) =>
    Date.parse(a.fetchedAt) - Date.parse(b.fetchedAt)
  );
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  if (first === undefined || last === undefined) {
    throw new Error(`No recorded builds of app ${appId}`);
  }
  const histories = new Map<string, HistoryEntry[]>();
  let newestBuild: NewestBuild | null = null;
  for (const version of ordered) {
    for (const recorded of version.branches) {
      if (branch !== null && recorded.name !== branch) {
        continue;
      }
      const history = histories.get(recorded.name) ?? [];
      if (history[history.length - 1]?.buildId !== recorded.buildId) {
        history.push({
          buildId: recorded.buildId,
          firstSeenAt: version.fetchedAt,
        });
      }
      histories.set(recorded.name, history);
    }
    for (const build of version.builds) {
      const newer = newestBuild === null ||
        build.createdAt > newestBuild.createdAt ||
        (build.createdAt === newestBuild.createdAt &&
          build.buildId > newestBuild.buildId);
      if (newer) {
        newestBuild = {
          buildId: build.buildId,
          createdAt: build.createdAt,
          description: build.description,
        };
      }
    }
  }
  if (branch !== null && !histories.has(branch)) {
    throw new Error(`No recorded version of app ${appId} has branch ${branch}`);
  }
  const latest = new Set(last.branches.map((recorded) => recorded.name));
  const branches = [...histories.entries()].map(([name, history]) => ({
    name,
    currentBuildId: history[history.length - 1]?.buildId ?? 0,
    inLatest: latest.has(name),
    moves: history.length - 1,
    history,
  })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return {
    appId,
    branch,
    samples: ordered.length,
    firstFetchedAt: first.fetchedAt,
    lastFetchedAt: last.fetchedAt,
    branches,
    newestBuild,
    summarisedAt,
  };
}

/** Reads every recorded version of the instance's builds, or throws without queryData. */
async function readRecorded(
  method: string,
  context: MethodContext,
): Promise<RecordedBuilds[]> {
  const { globalArgs, logger } = context;
  if (context.queryData === undefined) {
    throw new Error(
      `${method} needs swamp's queryData to read the recorded builds; upgrade swamp`,
    );
  }
  const predicate = `modelId == ${JSON.stringify(context.modelId)} && ` +
    `specName == "builds" && name == ${
      JSON.stringify(buildsName(globalArgs.appId))
    } && version >= 0`;
  const { recorded, skipped } = parseRecorded(
    globalArgs.appId,
    await context.queryData(predicate),
  );
  if (skipped > 0) {
    logger.warning(
      "Skipped {skipped} stored records that are not builds of app {appId}",
      { skipped, appId: globalArgs.appId },
    );
  }
  return recorded;
}

/** The Steamworks builds behavior. */
export const behavior = {
  type: "@reset/steamworks-builds",
  version: "2026.10.30.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    builds: {
      description:
        "One read of an app's branches, the build each runs, and its recent builds, flagging branches whose build changed",
      schema: BuildsRecordSchema,
      lifetime: "infinite",
      garbageCollection: "730d",
    },
    summary: {
      description:
        "Each branch's build history across the recorded versions, how often it moved, and the newest build",
      schema: SummarySchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    sample: {
      description:
        "Read the app's branches from GetAppBetas and its recent builds from GetAppBuilds, and record them as a new version, flagging branches whose live build changed",
      arguments: SampleArgsSchema,
      execute: async (
        args: SampleArgs & Injected,
        context: MethodContext,
      ): Promise<MethodResult> => {
        const { globalArgs, logger } = context;
        const { appId, apiKey } = globalArgs;
        const fetcher = args._fetch ?? globalThis.fetch;
        const now = args._now ?? (() => new Date());
        const count = args.count ?? DEFAULT_COUNT;
        if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
          throw new Error(
            `count ${count} is not a whole number from 1 to ${MAX_COUNT}`,
          );
        }
        const recorded = await readRecorded("sample", context);
        const previous = recorded[recorded.length - 1]?.record ?? null;
        logger.info(
          "Reading the branches and {count} recent builds of app {appId}",
          { appId, count },
        );
        const branches = await fetchBranches(
          fetcher,
          apiKey,
          appId,
          context.signal,
        );
        const builds = await fetchBuilds(
          fetcher,
          apiKey,
          appId,
          count,
          context.signal,
        );
        const data = compare(
          appId,
          branches,
          builds,
          previous,
          count,
          now().toISOString(),
        );
        const handle = await context.writeResource(
          "builds",
          buildsName(appId),
          { ...data },
        );
        logger.info(
          "App {appId}: {branches} branches, {builds} builds, {changed} branches on a new build since the previous read",
          {
            appId,
            branches: data.branches.length,
            builds: data.builds.length,
            changed: data.changedBranches.length,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    summarise: {
      description:
        "Summarise the recorded versions: each branch's live builds and when each was first seen, how often it moved, and the newest build",
      arguments: SummariseArgsSchema,
      execute: async (
        args: SummariseArgs & Injected,
        context: MethodContext,
      ): Promise<MethodResult> => {
        const { globalArgs, logger } = context;
        const { appId } = globalArgs;
        const now = args._now ?? (() => new Date());
        logger.info("Reading the recorded builds of app {appId}", { appId });
        const recorded = await readRecorded("summarise", context);
        if (recorded.length === 0) {
          throw new Error(
            `No builds of app ${appId} recorded; run the sample method first`,
          );
        }
        const data = summarise(
          appId,
          recorded.map(({ record }) => record),
          args.branch ?? null,
          now().toISOString(),
        );
        const handle = await context.writeResource(
          "summary",
          summaryName(appId),
          { ...data },
        );
        logger.info(
          "Summarised {samples} versions of app {appId}: {branches} branches, {moves} moves",
          {
            samples: data.samples,
            appId,
            branches: data.branches.length,
            moves: data.branches.reduce((sum, item) => sum + item.moves, 0),
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
