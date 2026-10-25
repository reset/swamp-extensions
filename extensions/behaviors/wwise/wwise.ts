/**
 * Drive an open Wwise Authoring instance through WAAPI, Audiokinetic's Wwise
 * Authoring API, over its WAMP WebSocket endpoint. `info` reads the Wwise and
 * project facts, `query` runs a WAQL query, `events` and `banks` list the
 * project's Events and SoundBanks, `generate` generates SoundBanks and keeps
 * the generation log, and `save` saves the project. Every method writes what
 * it read as a versioned resource, so a workflow can assert on it with CEL.
 *
 * The WAMP caller is in this file: HELLO and WELCOME, CALL with RESULT or
 * ERROR, GOODBYE. The socket is injectable, so the unit tests run against an
 * in-memory router and, where the network is allowed, an in-process server.
 *
 * @module
 */

import { z } from "npm:zod@4";

/** WAAPI's WAMP endpoint on the machine Wwise runs on, port 8080 by default. */
const DEFAULT_HOST = "ws://127.0.0.1:8080/waapi";
/** The WAMP realm Wwise's own clients join. */
const REALM = "realm1";
/** The WebSocket subprotocol for JSON-serialized WAMP. */
const SUBPROTOCOL = "wamp.2.json";
/** Seconds an ordinary call may take before the method fails. */
const DEFAULT_TIMEOUT_SECONDS = 30;
/** Seconds a SoundBank generation may take before the method fails. */
const DEFAULT_GENERATE_DEADLINE_SECONDS = 1800;
/** Longest time the GOODBYE exchange may take before the socket is closed anyway. */
const GOODBYE_TIMEOUT_MS = 5000;
/** How many objects a WAQL query is asked for at most, by default. */
const DEFAULT_QUERY_LIMIT = 1000;
/** How many Events or SoundBanks are listed at most, by default. */
const DEFAULT_LIST_LIMIT = 5000;
/** How many generation log entries a record keeps, by default. */
const DEFAULT_LOG_LIMIT = 500;
/** How many inclusion ids one name-resolving query carries. */
const INCLUSION_CHUNK = 100;

/** WAMP basic-profile message codes this module sends and reads. */
const WAMP = {
  HELLO: 1,
  WELCOME: 2,
  ABORT: 3,
  GOODBYE: 6,
  ERROR: 8,
  CALL: 48,
  RESULT: 50,
} as const;

/** The WAAPI procedures this module calls. */
const URI = {
  getInfo: "ak.wwise.core.getInfo",
  getProjectInfo: "ak.wwise.core.getProjectInfo",
  objectGet: "ak.wwise.core.object.get",
  getInclusions: "ak.wwise.core.soundbank.getInclusions",
  generate: "ak.wwise.core.soundbank.generate",
  save: "ak.wwise.core.project.save",
} as const;

/** Object accessors every listing asks object.get for. */
const EVENT_RETURN = ["id", "name", "path", "notes"];
const BANK_RETURN = ["id", "name", "path", "notes", "soundbankBnkFilePath"];
const INCLUSION_RETURN = ["id", "name", "type", "path"];
const DEFAULT_QUERY_RETURN = ["id", "name", "type", "path"];

/** Severities the SoundBank generation log uses. */
const LOG_SEVERITIES = ["Message", "Warning", "Error", "Fatal Error"] as const;

/** A Wwise object GUID: 36 hex-and-dash characters in braces. */
const GUID_PATTERN = /^\{[0-9A-Fa-f]{8}(-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}\}$/;
/** A resource instance name that is a valid directory name everywhere. */
const INSTANCE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Global arguments every method reads from the behavior definition. */
export interface GlobalArgs {
  /** WAAPI's WAMP endpoint, ws://127.0.0.1:8080/waapi unless Wwise was told otherwise. */
  host: string;
  /** Seconds a connection or an ordinary call may take before the method fails. */
  timeoutSeconds: number;
}

/** The logger methods this behavior calls. */
export interface Logger {
  /** Internal detail, such as a frame received. */
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

/** What a session needs from the method context. */
export interface SessionContext {
  /** Parsed global arguments of the behavior definition. */
  globalArgs: GlobalArgs;
  /** Cancels the session when the run is cancelled. */
  signal: AbortSignal;
  /** Structured logger. */
  logger: Logger;
}

/** The parts of Swamp's method context this behavior uses. */
export interface Context extends SessionContext {
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

/** The parts of a WebSocket this module uses. Tests supply an in-memory one. */
export interface Socket {
  /** 0 connecting, 1 open, 2 closing, 3 closed, as WebSocket numbers them. */
  readonly readyState: number;
  /** Sends one text frame. */
  send(data: string): void;
  /** Closes the socket. */
  close(code?: number, reason?: string): void;
  /** Listens for open, message, error and close events. */
  addEventListener(type: string, listener: (event: Event) => void): void;
}

/** Opens a socket to a URL with the given subprotocols. Tests replace it. */
export type SocketFactory = (url: string, protocols: string[]) => Socket;

/** Injectable dependencies, set by tests and otherwise defaulted to Deno's WebSocket. */
export interface Injected {
  /** Replaces `denoSocket`. */
  _socket?: SocketFactory;
}

/** Arguments of the `query` method. */
export interface QueryArgs {
  /** The WAQL query, starting with `$`. */
  waql: string;
  /** Accessors and properties to return for each object. */
  return: string[];
  /** Objects to skip before the first one kept. */
  offset: number;
  /** Objects to keep at most. One more is fetched to detect truncation. */
  limit: number;
  /** Suffix of the instance name, so several queries can coexist. */
  name: string;
  /** Platform whose values are returned; Wwise's current one when unset. */
  platform?: string;
  /** Language whose values are returned; Wwise's current one when unset. */
  language?: string;
}

/** Arguments of the `events` and `banks` methods. */
export interface ListArgs {
  /** Objects to skip before the first one kept. */
  offset: number;
  /** Objects to keep at most. One more is fetched to detect truncation. */
  limit: number;
}

/** Arguments of the `generate` method. */
export interface GenerateArgs {
  /** Names of the user-defined SoundBanks to generate. Empty means all of them. */
  banks: string[];
  /** Platform names or ids to generate for. Empty means every platform. */
  platforms: string[];
  /** Language names or ids to generate. Empty means every language. */
  languages: string[];
  /** Generate no localized SoundBank at all. */
  skipLanguages: boolean;
  /** Rebuild every SoundBank instead of only what changed. */
  rebuildSoundBanks: boolean;
  /** Clear the audio file cache first, so every source is reconverted. */
  clearAudioFileCache: boolean;
  /** Write the SoundBanks and their info files to disk. */
  writeToDisk: boolean;
  /** Rebuild the Init bank of each platform without rebuilding everything. */
  rebuildInitBank: boolean;
  /** Seconds the generation may take before the method fails. */
  deadlineSeconds: number;
  /** Fail the method when the log carries an error. Off, the record says so instead. */
  failOnError: boolean;
  /** Log entries the record keeps at most. */
  logLimit: number;
}

/** Arguments of the `save` method. */
export interface SaveArgs {
  /** Let Wwise check the affected Work Units out of source control first. */
  autoCheckOutToSourceControl: boolean;
}

/** The Wwise facts `info` keeps from ak.wwise.core.getInfo. */
export interface WwiseInfo {
  /** Wwise session id. */
  sessionId?: string;
  /** Version of the Wwise Authoring API. */
  apiVersion?: number;
  /** Wwise display name. */
  displayName?: string;
  /** Branch built. */
  branch?: string;
  /** Version name, year, major, minor, build, nickname and schema. */
  version: WwiseVersion;
  /** release or debug. */
  configuration?: string;
  /** x64, win32, macosx or linux. */
  platform?: string;
  /** Whether Wwise runs as WwiseConsole. */
  isCommandLine?: boolean;
  /** Process id of Wwise. */
  processId?: number;
  /** Process path of Wwise. */
  processPath?: string;
  /** The install, authoring, bin, help and user directories. */
  directories?: Record<string, string>;
}

/** The version object of ak.wwise.core.getInfo. */
export interface WwiseVersion {
  /** Version name, such as v2024.1.2. */
  displayName: string;
  /** Version year. */
  year?: number;
  /** Major number. */
  major?: number;
  /** Minor number. */
  minor?: number;
  /** Build number. */
  build?: number;
  /** Special name given to the version. */
  nickname?: string;
  /** Schema version of the project and Work Units. */
  schema?: number;
}

/** The project facts `info` and `save` keep from ak.wwise.core.getProjectInfo. */
export interface ProjectInfo {
  /** Project name. */
  name: string;
  /** Absolute path of the wproj file. */
  path: string;
  /** Project id. */
  id?: string;
  /** Whether the project or a Work Unit has unsaved changes. */
  isDirty: boolean;
  /** The platform the user interface shows. */
  currentPlatformId?: string;
  /** The language the user interface shows. */
  currentLanguageId?: string;
  /** The platforms defined in the project. */
  platforms: ProjectPlatform[];
  /** The languages defined in the project. */
  languages: ProjectLanguage[];
  /** The root, cache, originals and SoundBank output directories. */
  directories?: Record<string, string>;
}

/** One platform of the project. */
export interface ProjectPlatform {
  /** Platform id. */
  id: string;
  /** Platform name in the project. */
  name: string;
  /** Deployment platform name used on the file system. */
  baseName?: string;
  /** Where the platform's SoundBanks are generated. */
  soundBankPath?: string;
}

/** One language of the project. */
export interface ProjectLanguage {
  /** Language id. */
  id: string;
  /** Language name. */
  name: string;
  /** Short id of the language. */
  shortId?: number;
}

/** One Event as the `events` resource keeps it. */
export interface EventRecord {
  /** The Event's GUID. */
  id: string;
  /** The Event's name. */
  name: string;
  /** The Event's project path. */
  path?: string;
  /** The Event's notes. */
  notes?: string;
}

/** One SoundBank inclusion, with the included object's name when it resolved. */
export interface Inclusion {
  /** GUID of the included object. */
  object: string;
  /** Name of the included object. */
  name?: string;
  /** Type of the included object. */
  type?: string;
  /** Project path of the included object. */
  path?: string;
  /** What is included: events, structures, media. */
  filter: string[];
}

/** One SoundBank as the `banks` resource keeps it. */
export interface BankRecord {
  /** The SoundBank's GUID. */
  id: string;
  /** The SoundBank's name. */
  name: string;
  /** The SoundBank's project path. */
  path?: string;
  /** The SoundBank's notes. */
  notes?: string;
  /** Absolute path of the generated bnk file, when Wwise reports one. */
  bnkFilePath?: string;
  /** The inclusion list. */
  inclusions: Inclusion[];
}

/** One entry of the SoundBank generation log. */
export interface GenerationLogEntry {
  /** Message, Warning, Error or Fatal Error. */
  severity: string;
  /** Unix seconds of the entry. */
  time?: number;
  /** The message id. */
  messageId?: string;
  /** The message. */
  message: string;
  /** The platform the entry was reported for. */
  platform?: { id?: string; name?: string };
  /** The entry's parameters, normally object names. */
  parameters?: string[];
}

/** Counts of generation log entries by severity. */
export interface GenerationCounts {
  /** Entries at severity Message. */
  messages: number;
  /** Entries at severity Warning. */
  warnings: number;
  /** Entries at severity Error. */
  errors: number;
  /** Entries at severity Fatal Error. */
  fatal: number;
}

/**
 * A failed WAAPI session or call. `code` says what failed: `connect` when no
 * session could be opened, `call` when Wwise answered an ERROR (then `uri` is
 * the WAMP error URI), `timeout` when a deadline passed, `protocol` when a
 * frame could not be understood, `closed` when the session ended under a
 * call, and `aborted` when the run was cancelled.
 */
export class WaapiError extends Error {
  /** What failed. */
  readonly code: WaapiErrorCode;
  /** The WAMP error URI of an ERROR answer. */
  readonly uri: string | undefined;

  /** Builds the error. `uri` is set for an ERROR answer only. */
  constructor(message: string, code: WaapiErrorCode, uri?: string) {
    super(message);
    this.name = "WaapiError";
    this.code = code;
    this.uri = uri;
  }
}

/** The kinds of failure a WaapiError reports. */
export type WaapiErrorCode =
  | "connect"
  | "call"
  | "timeout"
  | "protocol"
  | "closed"
  | "aborted";

// ---------------------------------------------------------------------------
// Schemas (private: the exported interfaces above are the public types, and
// `satisfies` keeps each schema in step with its interface)
// ---------------------------------------------------------------------------

const isWebSocketUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "ws:" || url.protocol === "wss:";
  } catch {
    return false;
  }
};

const GlobalArgsSchema = z.object({
  host: z.string()
    .default(DEFAULT_HOST)
    .refine(isWebSocketUrl, { message: "host must be a ws:// or wss:// URL" })
    .describe(
      "WAAPI's WAMP endpoint: ws://127.0.0.1:8080/waapi unless Wwise's User Preferences say otherwise.",
    ),
  timeoutSeconds: z.number()
    .int()
    .min(1)
    .max(3600)
    .default(DEFAULT_TIMEOUT_SECONDS)
    .describe(
      "Seconds a connection or an ordinary call may take before the method fails. generate has its own deadline.",
    ),
}) satisfies z.ZodType<GlobalArgs>;

const QueryArgsSchema = z.object({
  waql: z.string()
    .regex(/^\s*\$/, "a WAQL query starts with $")
    .describe(
      "The WAQL query, starting with $. Example: $ from type Sound where volume < 0",
    ),
  return: z.array(z.string().min(1))
    .min(1)
    .default(DEFAULT_QUERY_RETURN)
    .describe(
      "Accessors and properties to return for each object, such as id, name, type, path, notes, or Volume.",
    ),
  offset: z.number()
    .int()
    .min(0)
    .default(0)
    .describe("Objects to skip before the first one kept."),
  limit: z.number()
    .int()
    .min(1)
    .max(100_000)
    .default(DEFAULT_QUERY_LIMIT)
    .describe(
      "Objects to keep at most. The record says truncated when more matched.",
    ),
  name: z.string()
    .regex(INSTANCE_NAME_PATTERN, "lowercase letters, digits and dashes")
    .default("query")
    .describe(
      "Suffix of the instance name, query-<name>, so several queries can coexist.",
    ),
  platform: z.string()
    .min(1)
    .optional()
    .describe(
      "Platform name or id whose values are returned. Wwise's current one when unset.",
    ),
  language: z.string()
    .min(1)
    .optional()
    .describe(
      "Language name or id whose values are returned. Wwise's current one when unset.",
    ),
}) satisfies z.ZodType<QueryArgs>;

const ListArgsSchema = z.object({
  offset: z.number()
    .int()
    .min(0)
    .default(0)
    .describe("Objects to skip before the first one kept."),
  limit: z.number()
    .int()
    .min(1)
    .max(100_000)
    .default(DEFAULT_LIST_LIMIT)
    .describe(
      "Objects to keep at most. The record says truncated when more exist.",
    ),
}) satisfies z.ZodType<ListArgs>;

const GenerateArgsSchema = z.object({
  banks: z.array(z.string().min(1))
    .default([])
    .describe(
      "Names of the user-defined SoundBanks to generate. Empty means all of them.",
    ),
  platforms: z.array(z.string().min(1))
    .default([])
    .describe(
      "Platform names or ids to generate for. Empty means every platform.",
    ),
  languages: z.array(z.string().min(1))
    .default([])
    .describe("Language names or ids to generate. Empty means every language."),
  skipLanguages: z.boolean()
    .default(false)
    .describe("Generate no localized SoundBank at all."),
  rebuildSoundBanks: z.boolean()
    .default(false)
    .describe("Rebuild every SoundBank instead of only what changed."),
  clearAudioFileCache: z.boolean()
    .default(false)
    .describe(
      "Clear the audio file cache first, so every source is reconverted.",
    ),
  writeToDisk: z.boolean()
    .default(true)
    .describe("Write the SoundBanks and their info files to disk."),
  rebuildInitBank: z.boolean()
    .default(false)
    .describe(
      "Rebuild the Init bank of each platform without rebuilding everything.",
    ),
  deadlineSeconds: z.number()
    .int()
    .min(1)
    .max(86_400)
    .default(DEFAULT_GENERATE_DEADLINE_SECONDS)
    .describe("Seconds the generation may take before the method fails."),
  failOnError: z.boolean()
    .default(true)
    .describe(
      "Fail the method when the log carries an Error or Fatal Error. Off, the record carries succeeded=false instead.",
    ),
  logLimit: z.number()
    .int()
    .min(1)
    .max(100_000)
    .default(DEFAULT_LOG_LIMIT)
    .describe("Log entries the record keeps at most."),
}) satisfies z.ZodType<GenerateArgs>;

const SaveArgsSchema = z.object({
  autoCheckOutToSourceControl: z.boolean()
    .default(true)
    .describe(
      "Let Wwise check the affected Work Units out of source control first.",
    ),
}) satisfies z.ZodType<SaveArgs>;

const WwiseVersionSchema = z.object({
  displayName: z.string(),
  year: z.number().int().optional(),
  major: z.number().int().optional(),
  minor: z.number().int().optional(),
  build: z.number().int().optional(),
  nickname: z.string().optional(),
  schema: z.number().int().optional(),
}) satisfies z.ZodType<WwiseVersion>;

const WwiseInfoSchema = z.object({
  sessionId: z.string().optional(),
  apiVersion: z.number().optional(),
  displayName: z.string().optional(),
  branch: z.string().optional(),
  version: WwiseVersionSchema,
  configuration: z.string().optional(),
  platform: z.string().optional(),
  isCommandLine: z.boolean().optional(),
  processId: z.number().int().optional(),
  processPath: z.string().optional(),
  directories: z.record(z.string(), z.string()).optional(),
}) satisfies z.ZodType<WwiseInfo>;

const ProjectPlatformSchema = z.object({
  id: z.string(),
  name: z.string(),
  baseName: z.string().optional(),
  soundBankPath: z.string().optional(),
}) satisfies z.ZodType<ProjectPlatform>;

const ProjectLanguageSchema = z.object({
  id: z.string(),
  name: z.string(),
  shortId: z.number().int().optional(),
}) satisfies z.ZodType<ProjectLanguage>;

const ProjectInfoSchema = z.object({
  name: z.string(),
  path: z.string(),
  id: z.string().optional(),
  isDirty: z.boolean(),
  currentPlatformId: z.string().optional(),
  currentLanguageId: z.string().optional(),
  platforms: z.array(ProjectPlatformSchema),
  languages: z.array(ProjectLanguageSchema),
  directories: z.record(z.string(), z.string()).optional(),
}) satisfies z.ZodType<ProjectInfo>;

const InfoResourceSchema = z.object({
  fetchedAt: z.iso.datetime(),
  host: z.string(),
  wwise: WwiseInfoSchema,
  project: ProjectInfoSchema.nullable(),
});

const QueryResourceSchema = z.object({
  fetchedAt: z.iso.datetime(),
  host: z.string(),
  waql: z.string(),
  return: z.array(z.string()),
  platform: z.string().optional(),
  language: z.string().optional(),
  offset: z.number().int(),
  limit: z.number().int(),
  count: z.number().int(),
  truncated: z.boolean(),
  objects: z.array(z.record(z.string(), z.unknown())),
});

const EventRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string().optional(),
  notes: z.string().optional(),
}) satisfies z.ZodType<EventRecord>;

const EventsResourceSchema = z.object({
  fetchedAt: z.iso.datetime(),
  host: z.string(),
  offset: z.number().int(),
  limit: z.number().int(),
  count: z.number().int(),
  truncated: z.boolean(),
  events: z.array(EventRecordSchema),
});

const InclusionSchema = z.object({
  object: z.string(),
  name: z.string().optional(),
  type: z.string().optional(),
  path: z.string().optional(),
  filter: z.array(z.string()),
}) satisfies z.ZodType<Inclusion>;

const BankRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string().optional(),
  notes: z.string().optional(),
  bnkFilePath: z.string().optional(),
  inclusions: z.array(InclusionSchema),
}) satisfies z.ZodType<BankRecord>;

const BanksResourceSchema = z.object({
  fetchedAt: z.iso.datetime(),
  host: z.string(),
  offset: z.number().int(),
  limit: z.number().int(),
  count: z.number().int(),
  truncated: z.boolean(),
  banks: z.array(BankRecordSchema),
});

const GenerationLogEntrySchema = z.object({
  severity: z.string(),
  time: z.number().int().optional(),
  messageId: z.string().optional(),
  message: z.string(),
  platform: z.object({ id: z.string().optional(), name: z.string().optional() })
    .optional(),
  parameters: z.array(z.string()).optional(),
}) satisfies z.ZodType<GenerationLogEntry>;

const GenerationCountsSchema = z.object({
  messages: z.number().int(),
  warnings: z.number().int(),
  errors: z.number().int(),
  fatal: z.number().int(),
}) satisfies z.ZodType<GenerationCounts>;

const GenerationResourceSchema = z.object({
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  host: z.string(),
  banks: z.array(z.string()),
  platforms: z.array(z.string()),
  languages: z.array(z.string()),
  skipLanguages: z.boolean(),
  rebuildSoundBanks: z.boolean(),
  clearAudioFileCache: z.boolean(),
  writeToDisk: z.boolean(),
  rebuildInitBank: z.boolean(),
  seconds: z.number(),
  succeeded: z.boolean(),
  error: z.string().optional(),
  counts: GenerationCountsSchema,
  logCount: z.number().int(),
  logTruncated: z.boolean(),
  logs: z.array(GenerationLogEntrySchema),
});

const SaveResourceSchema = z.object({
  savedAt: z.iso.datetime(),
  host: z.string(),
  autoCheckOutToSourceControl: z.boolean(),
  project: ProjectInfoSchema.nullable(),
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
  const number = asNumber(value);
  return number === undefined ? undefined : Math.trunc(number);
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/** Drops undefined values so a resource holds only what Wwise answered. */
function compact<T extends Record<string, unknown>>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) out[key] = entry;
  }
  return out as T;
}

/** The string-valued entries of a record, such as a directories object. */
function stringMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

/**
 * The URL without its userinfo, for records, logs and errors. WAAPI has no
 * credentials, but a URL can carry some and they do not belong in a record.
 */
export function redactUrl(host: string): string {
  try {
    const url = new URL(host);
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return host;
  }
}

/** Reduces a getInfo answer to the fields the `info` resource keeps. */
export function normalizeWwiseInfo(raw: unknown): WwiseInfo {
  if (!isRecord(raw) || !isRecord(raw.version)) {
    throw new WaapiError(
      `${URI.getInfo}: the answer carries no version object, so this is not a Wwise Authoring API endpoint`,
      "protocol",
    );
  }
  const version = raw.version;
  return compact({
    sessionId: asString(raw.sessionId),
    apiVersion: asNumber(raw.apiVersion),
    displayName: asString(raw.displayName),
    branch: asString(raw.branch),
    version: compact({
      displayName: asString(version.displayName) ?? "",
      year: asInteger(version.year),
      major: asInteger(version.major),
      minor: asInteger(version.minor),
      build: asInteger(version.build),
      nickname: asString(version.nickname),
      schema: asInteger(version.schema),
    }),
    configuration: asString(raw.configuration),
    platform: asString(raw.platform),
    isCommandLine: asBoolean(raw.isCommandLine),
    processId: asInteger(raw.processId),
    processPath: asString(raw.processPath),
    directories: stringMap(raw.directories),
  });
}

/** Reduces a getProjectInfo answer to the fields the resources keep. */
export function normalizeProjectInfo(raw: unknown): ProjectInfo {
  if (!isRecord(raw)) {
    throw new WaapiError(
      `${URI.getProjectInfo}: the answer is not an object`,
      "protocol",
    );
  }
  const platforms: ProjectPlatform[] = [];
  for (const entry of Array.isArray(raw.platforms) ? raw.platforms : []) {
    if (!isRecord(entry)) continue;
    const id = asString(entry.id);
    const name = asString(entry.name);
    if (id === undefined || name === undefined) continue;
    platforms.push(
      compact({
        id,
        name,
        baseName: asString(entry.baseName),
        soundBankPath: asString(entry.soundBankPath),
      }),
    );
  }
  const languages: ProjectLanguage[] = [];
  for (const entry of Array.isArray(raw.languages) ? raw.languages : []) {
    if (!isRecord(entry)) continue;
    const id = asString(entry.id);
    const name = asString(entry.name);
    if (id === undefined || name === undefined) continue;
    languages.push(compact({ id, name, shortId: asInteger(entry.shortId) }));
  }
  return compact({
    name: asString(raw.name) ?? "",
    path: asString(raw.path) ?? "",
    id: asString(raw.id),
    isDirty: asBoolean(raw.isDirty) ?? false,
    currentPlatformId: asString(raw.currentPlatformId),
    currentLanguageId: asString(raw.currentLanguageId),
    platforms,
    languages,
    directories: stringMap(raw.directories),
  });
}

/** The `return` rows of an object.get answer. */
function rowsOf(result: unknown): Record<string, unknown>[] {
  if (!isRecord(result) || !Array.isArray(result.return)) return [];
  return result.return.filter(isRecord);
}

/** Reduces an object.get row to an Event record, or undefined without id and name. */
export function normalizeEvent(
  row: Record<string, unknown>,
): EventRecord | undefined {
  const id = asString(row.id);
  const name = asString(row.name);
  if (id === undefined || name === undefined) return undefined;
  return compact({
    id,
    name,
    path: asString(row.path),
    notes: asString(row.notes),
  });
}

/** Reduces a getInclusions answer to inclusion records. */
export function normalizeInclusions(result: unknown): Inclusion[] {
  if (!isRecord(result) || !Array.isArray(result.inclusions)) return [];
  const inclusions: Inclusion[] = [];
  for (const entry of result.inclusions) {
    if (!isRecord(entry)) continue;
    const object = asString(entry.object);
    if (object === undefined) continue;
    inclusions.push({ object, filter: asStringArray(entry.filter) });
  }
  return inclusions;
}

/** Reduces one generation log entry, or undefined when it has no message. */
export function normalizeLogEntry(
  raw: unknown,
): GenerationLogEntry | undefined {
  if (!isRecord(raw)) return undefined;
  const message = asString(raw.message);
  if (message === undefined) return undefined;
  const platform = isRecord(raw.platform)
    ? compact({
      id: asString(raw.platform.id),
      name: asString(raw.platform.name),
    })
    : undefined;
  const parameters = Array.isArray(raw.parameters)
    ? asStringArray(raw.parameters)
    : undefined;
  return compact({
    severity: asString(raw.severity) ?? "Message",
    time: asInteger(raw.time),
    messageId: asString(raw.messageId),
    message,
    platform,
    parameters,
  });
}

/** Counts log entries by severity. An unknown severity counts as a message. */
export function countBySeverity(
  logs: readonly GenerationLogEntry[],
): GenerationCounts {
  const counts: GenerationCounts = {
    messages: 0,
    warnings: 0,
    errors: 0,
    fatal: 0,
  };
  for (const entry of logs) {
    switch (entry.severity) {
      case LOG_SEVERITIES[1]:
        counts.warnings++;
        break;
      case LOG_SEVERITIES[2]:
        counts.errors++;
        break;
      case LOG_SEVERITIES[3]:
        counts.fatal++;
        break;
      default:
        counts.messages++;
    }
  }
  return counts;
}

/**
 * Appends `skip` and `take` transforms to a WAQL query so one more object than
 * `limit` is fetched: a full answer then means the query matched more.
 */
export function boundWaql(waql: string, offset: number, limit: number): string {
  const trimmed = waql.trim();
  if (!trimmed.startsWith("$")) {
    throw new Error("a WAQL query starts with $");
  }
  const skip = offset > 0 ? ` skip ${offset}` : "";
  return `${trimmed}${skip} take ${limit + 1}`;
}

/** A WAQL source naming objects by GUID: `$ "{..}", "{..}"`. Rejects anything else. */
export function waqlForGuids(guids: readonly string[]): string {
  for (const guid of guids) {
    if (!GUID_PATTERN.test(guid)) {
      throw new WaapiError(
        `${URI.getInclusions}: "${guid}" is not an object GUID`,
        "protocol",
      );
    }
  }
  return `$ ${guids.map((guid) => `"${guid}"`).join(", ")}`;
}

// ---------------------------------------------------------------------------
// WAMP session
// ---------------------------------------------------------------------------

/** Opens a socket with Deno's WebSocket. */
export const denoSocket: SocketFactory = (
  url: string,
  protocols: string[],
): Socket => new WebSocket(url, protocols);

/** What `WaapiSession.connect` needs. */
export interface SessionOptions {
  /** The WAMP endpoint. */
  url: string;
  /** Milliseconds the connection and each call may take unless a call says otherwise. */
  timeoutMs: number;
  /** Cancels the session. */
  signal?: AbortSignal;
  /** Replaces Deno's WebSocket. */
  socket?: SocketFactory;
  /** Receives frame-level detail at debug level. */
  logger?: Logger;
}

interface PendingCall {
  uri: string;
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * One WAMP session with Wwise: HELLO and WELCOME on connect, CALL answered by
 * RESULT or ERROR, GOODBYE on close. Frames are JSON arrays whose first
 * element is the message code. WAAPI takes a call's `options` in the WAMP
 * Options dictionary and its `args` as keyword arguments, and answers with
 * keyword results, which `call` returns.
 */
export class WaapiSession {
  /** The endpoint, without userinfo. */
  readonly url: string;
  /** The session id Wwise assigned in WELCOME. */
  readonly sessionId: number;
  private readonly socket: Socket;
  private readonly timeoutMs: number;
  private readonly signal: AbortSignal | undefined;
  private readonly logger: Logger | undefined;
  private readonly pending = new Map<number, PendingCall>();
  private nextRequestId = 1;
  private closed = false;
  private goodbye: (() => void) | undefined;
  private readonly onAbort = (): void =>
    this.fail(
      new WaapiError("the run was cancelled", "aborted"),
      true,
    );

  private constructor(
    socket: Socket,
    sessionId: number,
    options: SessionOptions,
  ) {
    this.socket = socket;
    this.sessionId = sessionId;
    this.url = redactUrl(options.url);
    this.timeoutMs = options.timeoutMs;
    this.signal = options.signal;
    this.logger = options.logger;
    socket.addEventListener("message", (event) => this.onMessage(event));
    socket.addEventListener("close", (event) => this.onClose(event));
    socket.addEventListener("error", () => this.onClose(undefined));
    this.signal?.addEventListener("abort", this.onAbort, { once: true });
  }

  /**
   * Opens the socket, sends HELLO for the realm as a caller and waits for
   * WELCOME. Fails with a `connect` error when the socket cannot open, Wwise
   * answers ABORT or closes, or the timeout passes.
   */
  static connect(options: SessionOptions): Promise<WaapiSession> {
    const url = redactUrl(options.url);
    const factory = options.socket ?? denoSocket;
    return new Promise<WaapiSession>((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(new WaapiError("the run was cancelled", "aborted"));
        return;
      }
      let settled = false;
      let socket: Socket | undefined;
      const settle = (outcome: WaapiSession | Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        if (outcome instanceof Error) {
          if (socket !== undefined) closeQuietly(socket);
          reject(outcome);
        } else {
          resolve(outcome);
        }
      };
      const abort = (): void =>
        settle(new WaapiError("the run was cancelled", "aborted"));
      // The timer is set before the socket exists and the socket's listeners
      // go on right after it is made: an in-memory socket opens on a
      // microtask, and a runtime can drain microtasks inside the first
      // setTimeout or addEventListener call it serves, which would fire
      // "open" before anything listened for it.
      const timer = setTimeout(
        () =>
          settle(
            new WaapiError(
              `${url}: no WAMP session within ${
                options.timeoutMs / 1000
              } seconds; is Wwise open with the Wwise Authoring API enabled?`,
              "timeout",
            ),
          ),
        options.timeoutMs,
      );
      try {
        socket = factory(options.url, [SUBPROTOCOL]);
      } catch (error) {
        settle(connectError(url, error));
        return;
      }
      socket.addEventListener("open", () => {
        socket.send(
          JSON.stringify([WAMP.HELLO, REALM, { roles: { caller: {} } }]),
        );
      });
      socket.addEventListener("error", (event) => {
        settle(connectError(url, event));
      });
      socket.addEventListener("close", (event) => {
        const close = event as Partial<CloseEvent>;
        settle(
          new WaapiError(
            `${url}: the connection closed before a WAMP session was opened` +
              closeDetail(close.code, close.reason),
            "connect",
          ),
        );
      });
      socket.addEventListener("message", (event) => {
        if (settled) return;
        const frame = parseFrame((event as MessageEvent).data);
        if (frame instanceof Error) {
          settle(frame);
          return;
        }
        const [code] = frame;
        if (code === WAMP.WELCOME) {
          const sessionId = asInteger(frame[1]) ?? 0;
          settle(new WaapiSession(socket, sessionId, options));
        } else if (code === WAMP.ABORT) {
          const details = isRecord(frame[1]) ? frame[1] : {};
          const reason = asString(frame[2]) ?? "no reason";
          const message = asString(details.message);
          settle(
            new WaapiError(
              `${url}: Wwise refused the WAMP session: ${reason}${
                message === undefined ? "" : ` (${message})`
              }`,
              "connect",
            ),
          );
        } else {
          settle(
            new WaapiError(
              `${url}: expected WELCOME, got WAMP message ${String(code)}`,
              "protocol",
            ),
          );
        }
      });
      options.signal?.addEventListener("abort", abort, { once: true });
    });
  }

  /**
   * Calls one WAAPI procedure and returns its keyword results. `args` travel
   * as the call's keyword arguments and `options` as its WAMP options. Fails
   * with a `call` error carrying the WAMP error URI when Wwise answers ERROR,
   * a `timeout` error after `timeoutMs` (the session's by default), and a
   * `closed` error when the session ends first.
   */
  call(
    uri: string,
    args: Record<string, unknown> = {},
    options: Record<string, unknown> = {},
    timeoutMs: number = this.timeoutMs,
  ): Promise<Record<string, unknown>> {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      if (this.closed) {
        reject(
          new WaapiError(`${uri}: the WAMP session is closed`, "closed"),
        );
        return;
      }
      const requestId = this.nextRequestId++;
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        this.fail(
          new WaapiError(
            `${uri}: Wwise did not answer within ${timeoutMs / 1000} seconds`,
            "timeout",
          ),
          true,
        );
        reject(
          new WaapiError(
            `${uri}: Wwise did not answer within ${timeoutMs / 1000} seconds`,
            "timeout",
          ),
        );
      }, timeoutMs);
      this.pending.set(requestId, { uri, resolve, reject, timer });
      this.logger?.debug("CALL {requestId} {uri}", { requestId, uri });
      try {
        this.socket.send(
          JSON.stringify([WAMP.CALL, requestId, options, uri, [], args]),
        );
      } catch (error) {
        this.pending.delete(requestId);
        clearTimeout(timer);
        reject(
          new WaapiError(
            `${uri}: could not send the call: ${messageOf(error)}`,
            "closed",
          ),
        );
      }
    });
  }

  /**
   * Sends GOODBYE, waits briefly for Wwise's GOODBYE or the close, then closes
   * the socket. Never throws, and a second call is a no-op.
   */
  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    this.signal?.removeEventListener("abort", this.onAbort);
    this.fail(
      new WaapiError("the WAMP session was closed", "closed"),
      false,
    );
    return new Promise<void>((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        this.goodbye = undefined;
        closeQuietly(this.socket);
        resolve();
      };
      const timer = setTimeout(finish, GOODBYE_TIMEOUT_MS);
      this.goodbye = finish;
      try {
        this.socket.send(
          JSON.stringify([WAMP.GOODBYE, {}, "wamp.close.close_realm"]),
        );
      } catch {
        finish();
      }
    });
  }

  /** Rejects every pending call and, when asked, closes the socket. */
  private fail(error: Error, closeSocket: boolean): void {
    for (const [requestId, call] of this.pending) {
      this.pending.delete(requestId);
      clearTimeout(call.timer);
      call.reject(error);
    }
    if (closeSocket) {
      this.closed = true;
      this.signal?.removeEventListener("abort", this.onAbort);
      closeQuietly(this.socket);
    }
  }

  /** Rejects every pending call when the socket closes, and ends a GOODBYE wait. */
  private onClose(event: Event | undefined): void {
    const close = event as Partial<CloseEvent> | undefined;
    this.closed = true;
    this.signal?.removeEventListener("abort", this.onAbort);
    this.fail(
      new WaapiError(
        `${this.url}: the connection closed under a call` +
          closeDetail(close?.code, close?.reason),
        "closed",
      ),
      false,
    );
    this.goodbye?.();
  }

  /** Dispatches one frame from Wwise by its message code. */
  private onMessage(event: Event): void {
    const frame = parseFrame((event as MessageEvent).data);
    if (frame instanceof Error) {
      this.logger?.warning("Malformed WAMP frame: {error}", {
        error: frame.message,
      });
      this.fail(frame, true);
      return;
    }
    const [code] = frame;
    switch (code) {
      case WAMP.RESULT:
        this.onResult(frame);
        return;
      case WAMP.ERROR:
        this.onError(frame);
        return;
      case WAMP.GOODBYE: {
        const reason = asString(frame[2]) ?? "no reason";
        if (this.goodbye !== undefined) {
          this.goodbye();
          return;
        }
        if (this.closed) return;
        this.closed = true;
        this.logger?.debug("Wwise sent GOODBYE: {reason}", { reason });
        try {
          this.socket.send(
            JSON.stringify([WAMP.GOODBYE, {}, "wamp.close.goodbye_and_out"]),
          );
        } catch {
          // The socket is already closing.
        }
        this.fail(
          new WaapiError(
            `${this.url}: Wwise closed the WAMP session: ${reason}`,
            "closed",
          ),
          true,
        );
        return;
      }
      case WAMP.ABORT:
        this.fail(
          new WaapiError(
            `${this.url}: Wwise aborted the WAMP session: ${
              asString(frame[2]) ?? "no reason"
            }`,
            "closed",
          ),
          true,
        );
        return;
      default:
        this.logger?.debug("Ignoring WAMP message {code}", { code });
    }
  }

  /** Resolves the pending call a RESULT answers with its keyword results. */
  private onResult(frame: unknown[]): void {
    const requestId = asInteger(frame[1]);
    const call = requestId === undefined
      ? undefined
      : this.pending.get(requestId);
    if (call === undefined) {
      this.logger?.debug("RESULT for no pending call: {requestId}", {
        requestId,
      });
      return;
    }
    this.pending.delete(requestId as number);
    clearTimeout(call.timer);
    const kwargs = frame[4];
    if (frame.length > 4 && !isRecord(kwargs)) {
      call.reject(
        new WaapiError(
          `${call.uri}: RESULT carries no keyword results`,
          "protocol",
        ),
      );
      return;
    }
    call.resolve(isRecord(kwargs) ? kwargs : {});
  }

  /** Rejects the pending call an ERROR answers with its URI and message. */
  private onError(frame: unknown[]): void {
    const requestType = asInteger(frame[1]);
    const requestId = asInteger(frame[2]);
    if (requestType !== WAMP.CALL || requestId === undefined) {
      this.logger?.debug("ERROR for message type {type}", {
        type: requestType,
      });
      return;
    }
    const call = this.pending.get(requestId);
    if (call === undefined) return;
    this.pending.delete(requestId);
    clearTimeout(call.timer);
    const uri = asString(frame[4]) ?? "wamp.error.unknown";
    const args = Array.isArray(frame[5]) ? frame[5] : [];
    const kwargs = isRecord(frame[6]) ? frame[6] : {};
    const details = isRecord(frame[3]) ? frame[3] : {};
    const message = asString(kwargs.message) ?? asString(args[0]) ??
      asString(details.message) ?? uri;
    call.reject(
      new WaapiError(`${call.uri}: ${message} (${uri})`, "call", uri),
    );
  }
}

/** Parses one text frame into a WAMP message, or returns the protocol error. */
function parseFrame(data: unknown): unknown[] | WaapiError {
  if (typeof data !== "string") {
    return new WaapiError("WAMP frame is not text", "protocol");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return new WaapiError("WAMP frame is not JSON", "protocol");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return new WaapiError("WAMP frame is not a non-empty array", "protocol");
  }
  if (asInteger(parsed[0]) === undefined) {
    return new WaapiError("WAMP frame has no message code", "protocol");
  }
  return parsed;
}

function connectError(url: string, cause: unknown): WaapiError {
  const detail = cause instanceof Error
    ? cause.message
    : isRecord(cause) && typeof cause.message === "string"
    ? cause.message
    : "";
  return new WaapiError(
    `${url}: could not connect${
      detail === "" ? "" : ` (${detail})`
    }; is Wwise open with the Wwise Authoring API enabled, and does its User Preferences allow this address?`,
    "connect",
  );
}

function closeDetail(
  code: number | undefined,
  reason: string | undefined,
): string {
  const parts: string[] = [];
  if (code !== undefined) parts.push(`code ${code}`);
  if (reason !== undefined && reason !== "") parts.push(reason);
  return parts.length === 0 ? "" : ` (${parts.join(", ")})`;
}

function closeQuietly(socket: Socket): void {
  try {
    if (socket.readyState < 2) socket.close(1000, "done");
  } catch {
    // Already closed.
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Opens a session for the behavior's global arguments, runs `fn`, and always closes it. */
export async function withSession<T>(
  context: SessionContext,
  socket: SocketFactory | undefined,
  fn: (session: WaapiSession) => Promise<T>,
): Promise<T> {
  const session = await WaapiSession.connect({
    url: context.globalArgs.host,
    timeoutMs: context.globalArgs.timeoutSeconds * 1000,
    signal: context.signal,
    socket,
    logger: context.logger,
  });
  try {
    return await fn(session);
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// Shared steps
// ---------------------------------------------------------------------------

/** Reads the project facts, or null with a warning when no project answers. */
async function readProject(
  session: WaapiSession,
  logger: Logger,
): Promise<ProjectInfo | null> {
  try {
    return normalizeProjectInfo(await session.call(URI.getProjectInfo));
  } catch (error) {
    if (error instanceof WaapiError && error.code === "call") {
      logger.warning("No project facts: {error}", { error: error.message });
      return null;
    }
    throw error;
  }
}

/** Runs a bounded object.get and says whether more objects matched. */
async function queryObjects(
  session: WaapiSession,
  waql: string,
  options: Record<string, unknown>,
  offset: number,
  limit: number,
): Promise<{ rows: Record<string, unknown>[]; truncated: boolean }> {
  const result = await session.call(
    URI.objectGet,
    { waql: boundWaql(waql, offset, limit) },
    options,
  );
  const rows = rowsOf(result);
  const truncated = rows.length > limit;
  return { rows: truncated ? rows.slice(0, limit) : rows, truncated };
}

/** Looks up name, type and path for inclusion GUIDs, in chunks of 100. */
async function resolveInclusions(
  session: WaapiSession,
  inclusions: Inclusion[],
): Promise<Inclusion[]> {
  const byId = new Map<string, Record<string, unknown>>();
  const guids = [...new Set(inclusions.map((entry) => entry.object))];
  for (let start = 0; start < guids.length; start += INCLUSION_CHUNK) {
    const chunk = guids.slice(start, start + INCLUSION_CHUNK);
    const result = await session.call(
      URI.objectGet,
      { waql: waqlForGuids(chunk) },
      { return: INCLUSION_RETURN },
    );
    for (const row of rowsOf(result)) {
      const id = asString(row.id);
      if (id !== undefined) byId.set(id, row);
    }
  }
  return inclusions.map((entry) => {
    const row = byId.get(entry.object);
    return row === undefined ? entry : compact({
      ...entry,
      name: asString(row.name),
      type: asString(row.type),
      path: asString(row.path),
    });
  });
}

// ---------------------------------------------------------------------------
// Behavior
// ---------------------------------------------------------------------------

/**
 * The behavior definition Swamp registers. Global arguments are `host` and
 * `timeoutSeconds`; see the README for each method, the resource it writes
 * and the instance name it writes it under.
 */
export const behavior = {
  // String literals, not constants: the registry catalog reads them from the
  // source.
  type: "@reset/wwise",
  version: "2026.10.24.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    info: {
      description: "Wwise version, platform and process facts, and the open " +
        "project's name, path, platforms, languages and dirty state",
      schema: InfoResourceSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    query: {
      description: "The objects a WAQL query matched, with the accessors " +
        "asked for, bounded by limit",
      schema: QueryResourceSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    events: {
      description: "The project's Events: id, name, path and notes",
      schema: EventsResourceSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    banks: {
      description: "The project's SoundBanks with their inclusion lists",
      schema: BanksResourceSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    generation: {
      description: "One SoundBank generation: what was asked, whether it " +
        "succeeded, counts by severity and the bounded log",
      schema: GenerationResourceSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
    save: {
      description: "One project save and the project's dirty state after it",
      schema: SaveResourceSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    info: {
      description: "Read Wwise's version, platform and process facts and the " +
        "open project's facts. Writes info.",
      arguments: z.object({}),
      execute: async (
        args: Injected,
        context: Context,
      ): Promise<MethodResult> => {
        const { logger } = context;
        const host = redactUrl(context.globalArgs.host);
        logger.info("Reading Wwise and project facts from {host}", { host });
        const { wwise, project } = await withSession(
          context,
          args._socket,
          async (session) => ({
            wwise: normalizeWwiseInfo(await session.call(URI.getInfo)),
            project: await readProject(session, logger),
          }),
        );
        const handle = await context.writeResource("info", "info", {
          fetchedAt: new Date().toISOString(),
          host,
          wwise,
          project,
        });
        logger.info("{wwise} {version} on {platform}, project {project}", {
          wwise: wwise.displayName ?? "Wwise",
          version: wwise.version.displayName,
          platform: wwise.platform ?? "unknown platform",
          project: project?.name ?? "(none open)",
        });
        return { dataHandles: [handle] };
      },
    },
    query: {
      description: "Run a WAQL query through object.get with a chosen " +
        "return list, bounded by offset and limit. Writes query-<name>.",
      arguments: QueryArgsSchema,
      execute: async (
        args: QueryArgs & Injected,
        context: Context,
      ): Promise<MethodResult> => {
        const { logger } = context;
        const host = redactUrl(context.globalArgs.host);
        const waql = args.waql.trim();
        boundWaql(waql, args.offset, args.limit);
        logger.info(
          "Querying {host}: {waql} (offset {offset}, limit {limit})",
          {
            host,
            waql,
            offset: args.offset,
            limit: args.limit,
          },
        );
        const options = compact({
          return: args.return,
          platform: args.platform,
          language: args.language,
        });
        const { rows, truncated } = await withSession(
          context,
          args._socket,
          (session) =>
            queryObjects(session, waql, options, args.offset, args.limit),
        );
        const handle = await context.writeResource(
          "query",
          `query-${args.name}`,
          {
            fetchedAt: new Date().toISOString(),
            host,
            waql,
            return: args.return,
            ...compact({ platform: args.platform, language: args.language }),
            offset: args.offset,
            limit: args.limit,
            count: rows.length,
            truncated,
            objects: rows,
          },
        );
        logger.info("Query matched {count} objects (truncated={truncated})", {
          count: rows.length,
          truncated,
        });
        return { dataHandles: [handle] };
      },
    },
    events: {
      description: "List the project's Events with id, name, path and " +
        "notes, bounded by offset and limit. Writes events.",
      arguments: ListArgsSchema,
      execute: async (
        args: ListArgs & Injected,
        context: Context,
      ): Promise<MethodResult> => {
        const { logger } = context;
        const host = redactUrl(context.globalArgs.host);
        logger.info(
          "Listing Events from {host} (offset {offset}, limit {limit})",
          {
            host,
            offset: args.offset,
            limit: args.limit,
          },
        );
        const { rows, truncated } = await withSession(
          context,
          args._socket,
          (session) =>
            queryObjects(
              session,
              "$ from type Event",
              { return: EVENT_RETURN },
              args.offset,
              args.limit,
            ),
        );
        const events: EventRecord[] = [];
        for (const row of rows) {
          const event = normalizeEvent(row);
          if (event === undefined) {
            logger.warning("Skipping an Event answer without id and name");
            continue;
          }
          events.push(event);
        }
        const handle = await context.writeResource("events", "events", {
          fetchedAt: new Date().toISOString(),
          host,
          offset: args.offset,
          limit: args.limit,
          count: events.length,
          truncated,
          events,
        });
        logger.info("Listed {count} Events (truncated={truncated})", {
          count: events.length,
          truncated,
        });
        return { dataHandles: [handle] };
      },
    },
    banks: {
      description: "List the project's SoundBanks with their inclusion " +
        "lists, bounded by offset and limit. Writes banks.",
      arguments: ListArgsSchema,
      execute: async (
        args: ListArgs & Injected,
        context: Context,
      ): Promise<MethodResult> => {
        const { logger } = context;
        const host = redactUrl(context.globalArgs.host);
        logger.info(
          "Listing SoundBanks from {host} (offset {offset}, limit {limit})",
          { host, offset: args.offset, limit: args.limit },
        );
        const { banks, truncated } = await withSession(
          context,
          args._socket,
          async (session) => {
            const { rows, truncated } = await queryObjects(
              session,
              "$ from type SoundBank",
              { return: BANK_RETURN },
              args.offset,
              args.limit,
            );
            const banks: BankRecord[] = [];
            for (const row of rows) {
              const base = normalizeEvent(row);
              if (base === undefined) {
                logger.warning(
                  "Skipping a SoundBank answer without id and name",
                );
                continue;
              }
              const bare = normalizeInclusions(
                await session.call(URI.getInclusions, { soundbank: base.id }),
              );
              const inclusions = bare.length === 0
                ? bare
                : await resolveInclusions(session, bare);
              logger.debug("SoundBank {name}: {count} inclusions", {
                name: base.name,
                count: inclusions.length,
              });
              banks.push(
                compact({
                  ...base,
                  bnkFilePath: asString(row.soundbankBnkFilePath),
                  inclusions,
                }),
              );
            }
            return { banks, truncated };
          },
        );
        const handle = await context.writeResource("banks", "banks", {
          fetchedAt: new Date().toISOString(),
          host,
          offset: args.offset,
          limit: args.limit,
          count: banks.length,
          truncated,
          banks,
        });
        logger.info("Listed {count} SoundBanks (truncated={truncated})", {
          count: banks.length,
          truncated,
        });
        return { dataHandles: [handle] };
      },
    },
    generate: {
      description: "Generate SoundBanks for the named banks and platforms " +
        "within a deadline, and keep the generation log. Writes generation.",
      arguments: GenerateArgsSchema,
      execute: async (
        args: GenerateArgs & Injected,
        context: Context,
      ): Promise<MethodResult> => {
        const { logger } = context;
        const host = redactUrl(context.globalArgs.host);
        logger.info(
          "Generating {banks} for {platforms} on {host}, deadline {deadline} seconds",
          {
            banks: args.banks.length === 0
              ? "every user-defined SoundBank"
              : args.banks,
            platforms: args.platforms.length === 0
              ? "every platform"
              : args.platforms,
            host,
            deadline: args.deadlineSeconds,
          },
        );
        const startedAt = new Date().toISOString();
        const result = await withSession(
          context,
          args._socket,
          (session) =>
            session.call(
              URI.generate,
              compact({
                soundbanks: args.banks.map((name) => ({ name })),
                platforms: args.platforms.length === 0
                  ? undefined
                  : args.platforms,
                languages: args.languages.length === 0
                  ? undefined
                  : args.languages,
                skipLanguages: args.skipLanguages,
                rebuildSoundBanks: args.rebuildSoundBanks,
                clearAudioFileCache: args.clearAudioFileCache,
                writeToDisk: args.writeToDisk,
                rebuildInitBank: args.rebuildInitBank,
              }),
              {},
              args.deadlineSeconds * 1000,
            ),
        );
        const finishedAt = new Date().toISOString();
        const rawLogs = Array.isArray(result.logs) ? result.logs : [];
        const logs: GenerationLogEntry[] = [];
        for (const raw of rawLogs) {
          const entry = normalizeLogEntry(raw);
          if (entry !== undefined) logs.push(entry);
        }
        const counts = countBySeverity(logs);
        const firstError = asString(result.error) ??
          logs.find((entry) =>
            entry.severity === LOG_SEVERITIES[2] ||
            entry.severity === LOG_SEVERITIES[3]
          )?.message;
        const succeeded = firstError === undefined;
        const seconds = (Date.parse(finishedAt) - Date.parse(startedAt)) /
          1000;
        if (!succeeded && args.failOnError) {
          throw new Error(
            `SoundBank generation failed with ${counts.errors} errors and ${counts.fatal} fatal errors ` +
              `(${counts.warnings} warnings) after ${seconds} seconds: ${firstError}`,
          );
        }
        const kept = logs.slice(0, args.logLimit);
        const handle = await context.writeResource(
          "generation",
          "generation",
          {
            startedAt,
            finishedAt,
            host,
            banks: args.banks,
            platforms: args.platforms,
            languages: args.languages,
            skipLanguages: args.skipLanguages,
            rebuildSoundBanks: args.rebuildSoundBanks,
            clearAudioFileCache: args.clearAudioFileCache,
            writeToDisk: args.writeToDisk,
            rebuildInitBank: args.rebuildInitBank,
            seconds,
            succeeded,
            ...compact({ error: firstError }),
            counts,
            logCount: logs.length,
            logTruncated: kept.length < logs.length,
            logs: kept,
          },
        );
        logger.info(
          "Generation {outcome} in {seconds} seconds: {errors} errors, {warnings} warnings, {messages} messages",
          {
            outcome: succeeded ? "succeeded" : "failed",
            seconds,
            errors: counts.errors + counts.fatal,
            warnings: counts.warnings,
            messages: counts.messages,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    save: {
      description: "Save the project, then read whether it is still dirty. " +
        "Writes save.",
      arguments: SaveArgsSchema,
      execute: async (
        args: SaveArgs & Injected,
        context: Context,
      ): Promise<MethodResult> => {
        const { logger } = context;
        const host = redactUrl(context.globalArgs.host);
        logger.info("Saving the project on {host}", { host });
        const project = await withSession(
          context,
          args._socket,
          async (session) => {
            await session.call(URI.save, {
              autoCheckOutToSourceControl: args.autoCheckOutToSourceControl,
            });
            return await readProject(session, logger);
          },
        );
        const handle = await context.writeResource("save", "save", {
          savedAt: new Date().toISOString(),
          host,
          autoCheckOutToSourceControl: args.autoCheckOutToSourceControl,
          project,
        });
        logger.info("Saved {project} (dirty={dirty})", {
          project: project?.name ?? "the project",
          dirty: project?.isDirty ?? "unknown",
        });
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
  ],
};
