/**
 * itch.io from Swamp, in two halves that share one behavior type.
 *
 * The butler half publishes a game's builds with butler, the command line tool
 * itch.io documents for uploads. `push` uploads a directory or zip to a
 * channel, `status` reads the channels of a project and the state of their
 * latest and pending builds (optionally waiting, within a deadline, until a
 * channel's build has finished processing), and `version` records which butler
 * ran.
 *
 * The API half records an account's games through itch.io's server-side API
 * and says what changed since the last recorded version. `games` reads
 * `GET https://api.itch.io/profile/games`, every game the API key's owner can
 * edit, and writes their publish state, price and counts with the differences
 * from the previous version. `credentials` reads
 * `GET https://api.itch.io/credentials/info`, the key's type and scopes.
 *
 * `latest` belongs to both: it reads a channel's latest user version from
 * itch.io's public update check, `GET https://api.itch.io/wharf/latest`, which
 * needs no key. With a `gameId` it records the channel by game id and whether
 * the version moved; without one it reads the `target` project's channel.
 *
 * The API key is a sensitive global argument, supplied from a swamp vault.
 * butler gets it as `BUTLER_API_KEY`, never on its command line; `games` and
 * `credentials` send it only in the `Authorization: Bearer` header, never in a
 * URL. It is redacted from butler's output and never written to a resource or
 * a log. The process runner, `fetch`, the clock and the sleep are injectable,
 * so the unit tests run without butler or the network.
 *
 * @module
 */

import { z } from "npm:zod@4";

/** Base URL of itch.io's server-side API. */
export const API_BASE = "https://api.itch.io";

/** The endpoint listing the key owner's games (scope `profile:games`). */
export const GAMES_URL = `${API_BASE}/profile/games`;

/** The endpoint describing the credentials of the request. */
export const CREDENTIALS_URL = `${API_BASE}/credentials/info`;

/** itch.io's documented update check endpoint, which needs no credentials. */
export const WHARF_LATEST_URL = `${API_BASE}/wharf/latest`;

/** How long one request to itch.io may take before it is abandoned. */
export const REQUEST_TIMEOUT_MS = 15_000;

/** The data name the key owner's games are written under. */
export const GAMES_NAME = "my-games";

/** The data name the credentials description is written under. */
export const CREDENTIALS_NAME = "credentials";

/** Replacement for a secret in anything this module logs, stores or throws. */
const REDACTED = "[redacted]";

/** How many trailing output lines a record keeps besides warnings and errors. */
const EXCERPT_TAIL = 20;

/** Hard cap on the lines a record keeps. */
const EXCERPT_MAX = 120;

/** `true` only when the zod output type and the hand-written interface describe the same shape. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

/** A project as butler names it: `user/game`. */
const PROJECT_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** A channel name: itch.io's kebab-case convention, no colon or slash. */
const CHANNEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

const GlobalArgsSchema = z.object({
  target: z.string()
    .regex(PROJECT_PATTERN, "a target is user/game, as butler push names it")
    .optional()
    .describe(
      "The itch.io project as user/game, the part of a butler target before the channel. push and status need it, and latest without a gameId",
    ),
  butler: z.string().min(1).default("butler").describe(
    "Path to butler, or its command name when it is on PATH",
  ),
  apiKey: z.string().min(1).optional().meta({ sensitive: true }).describe(
    "itch.io API key, supplied with a vault.get expression, never a literal. butler gets it as BUTLER_API_KEY; games and credentials need it and send it only as a Bearer header. butler needs none when it is logged in",
  ),
  identity: z.string().min(1).optional().describe(
    "Credentials file butler reads instead of its default one (butler -i), for a second account",
  ),
});

/** Global arguments of a behavior instance, as validated by swamp. */
export interface GlobalArgs {
  /** The itch.io project as `user/game`; push, status and latest by target need it. */
  target?: string;
  /** Path to butler, or its command name when it is on PATH. */
  butler: string;
  /** itch.io API key. Sensitive: supply it with a vault expression. */
  apiKey?: string;
  /** Credentials file passed as butler -i. */
  identity?: string;
}

const _GlobalArgsMatch: Same<
  z.infer<typeof GlobalArgsSchema>,
  GlobalArgs
> = true;

const PushArgsSchema = z.object({
  directory: z.string().min(1).describe(
    "Build directory or .zip to upload, relative to the repository root or absolute",
  ),
  channel: z.string()
    .regex(CHANNEL_PATTERN, "a channel name has no colon, slash or space")
    .describe(
      "Channel to push to, such as windows-beta or linux-stable; itch.io tags the platform from its name",
    ),
  userVersion: z.string().optional().describe(
    "Your own version number for this build (butler --userversion). Empty records none",
  ),
  userVersionFile: z.string().min(1).optional().describe(
    "File holding the version number, relative to the repository root or absolute (butler --userversion-file)",
  ),
  ifChanged: z.boolean().default(false).describe(
    "Push nothing when the contents equal the channel's latest build (butler --if-changed)",
  ),
  dryRun: z.boolean().default(false).describe(
    "List what would be pushed and upload nothing (butler --dry-run)",
  ),
  hidden: z.boolean().default(false).describe(
    "Mark a new channel's upload hidden. butler refuses it on an existing channel (butler --hidden)",
  ),
  fixPermissions: z.boolean().default(false).describe(
    "Mark Mac and Linux executables executable before pushing (butler --fix-permissions)",
  ),
  ignore: z.array(z.string().min(1)).default([]).describe(
    "Glob patterns of files to leave out, each passed as butler --ignore",
  ),
  timeoutSeconds: z.number().int().positive().default(3600).describe(
    "Kill butler and fail when it has not exited after this many seconds",
  ),
});

/** Arguments of `push`. */
export interface PushArgs {
  /** Build directory or zip to upload. */
  directory: string;
  /** Channel to push to. */
  channel: string;
  /** Version number for this build. */
  userVersion?: string;
  /** File holding the version number. */
  userVersionFile?: string;
  /** Push nothing when unchanged. */
  ifChanged: boolean;
  /** List what would be pushed and upload nothing. */
  dryRun: boolean;
  /** Mark a new channel's upload hidden. */
  hidden: boolean;
  /** Mark executables executable before pushing. */
  fixPermissions: boolean;
  /** Glob patterns of files to leave out. */
  ignore: string[];
  /** Deadline for butler in seconds. */
  timeoutSeconds: number;
}

const _PushArgsMatch: Same<z.infer<typeof PushArgsSchema>, PushArgs> = true;

const StatusArgsSchema = z.object({
  channel: z.string()
    .regex(CHANNEL_PATTERN, "a channel name has no colon, slash or space")
    .optional()
    .describe(
      "Read only this channel. Unset reads every channel of the project",
    ),
  waitSeconds: z.number().int().min(0).max(86400).default(0).describe(
    "Read again until the channel's build is ready or failed, for at most this many seconds. 0 reads once",
  ),
  intervalSeconds: z.number().int().min(5).max(600).default(15).describe(
    "Seconds between reads while waiting",
  ),
  timeoutSeconds: z.number().int().positive().default(120).describe(
    "Kill one butler status call and fail when it has not exited after this many seconds",
  ),
});

/** Arguments of `status`. */
export interface StatusArgs {
  /** Read only this channel. */
  channel?: string;
  /** Wait up to this many seconds for the build to be ready or failed. */
  waitSeconds: number;
  /** Seconds between reads while waiting. */
  intervalSeconds: number;
  /** Deadline for one butler call in seconds. */
  timeoutSeconds: number;
}

const _StatusArgsMatch: Same<
  z.infer<typeof StatusArgsSchema>,
  StatusArgs
> = true;

const LatestArgsSchema = z.object({
  channel: z.string()
    .regex(CHANNEL_PATTERN, "a channel name has no colon, slash or space")
    .describe(
      "Channel whose latest user version to read, as named in butler push, such as windows-beta",
    ),
  gameId: z.number().int().positive().optional().describe(
    "itch.io game id, shown on the game's Edit game page. Set, the channel is recorded by game id with whether it moved; unset, the target's channel is read",
  ),
});

/** Arguments of `latest`. */
export interface LatestArgs {
  /** Channel whose latest user version to read. */
  channel: string;
  /** itch.io game id; absent reads the `target` project's channel. */
  gameId?: number;
}

const _LatestArgsMatch: Same<
  z.infer<typeof LatestArgsSchema>,
  LatestArgs
> = true;

const NoArgsSchema = z.object({});

/** An ISO-8601 time this behavior stamps on a record. */
const IsoTime = z.string().pipe(z.iso.datetime());

const BuildSchema = z.object({
  id: z.number().int(),
  state: z.string(),
  version: z.number().int().optional(),
  userVersion: z.string().optional(),
  parentBuildId: z.number().int().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

/** One build of a channel as butler status reports it. */
export interface Build {
  /** Build id. */
  id: number;
  /** started, queued, processing, completed or failed. */
  state: string;
  /** itch.io's own incrementing version of the channel. */
  version?: number;
  /** The version number given at push, if any. */
  userVersion?: string;
  /** The build this one was patched from. */
  parentBuildId?: number;
  /** When itch.io created the build, as butler printed it. */
  createdAt?: string;
  /** When itch.io last changed the build, as butler printed it. */
  updatedAt?: string;
}

const _BuildMatch: Same<z.infer<typeof BuildSchema>, Build> = true;

const ChannelSchema = z.object({
  name: z.string(),
  tags: z.array(z.string()),
  uploadId: z.number().int().optional(),
  head: BuildSchema.optional(),
  pending: BuildSchema.optional(),
  ready: z.boolean(),
  failed: z.boolean(),
});

/** One channel of a project and the state of its builds. */
export interface Channel {
  /** Channel name. */
  name: string;
  /** Platform tags itch.io gave the channel. */
  tags: string[];
  /** The upload the channel feeds. */
  uploadId?: number;
  /** The channel's latest processed build. */
  head?: Build;
  /** A build still being processed. */
  pending?: Build;
  /** The head build completed and nothing is pending. */
  ready: boolean;
  /** The head or the pending build failed. */
  failed: boolean;
}

const _ChannelMatch: Same<z.infer<typeof ChannelSchema>, Channel> = true;

const PushResourceSchema = z.object({
  target: z.string(),
  channel: z.string(),
  directory: z.string(),
  buildId: z.number().int(),
  dryRun: z.boolean(),
  skipped: z.boolean(),
  reason: z.string(),
  userVersion: z.string().optional(),
  startedAt: IsoTime,
  finishedAt: IsoTime,
  exitCode: z.number().int(),
  logLines: z.number().int(),
  logExcerpt: z.array(z.string()),
});

const StatusResourceSchema = z.object({
  target: z.string(),
  channel: z.string().optional(),
  fetchedAt: IsoTime,
  reads: z.number().int(),
  waitedSeconds: z.number().int(),
  timedOut: z.boolean(),
  found: z.boolean(),
  ready: z.boolean(),
  failed: z.boolean(),
  channelNames: z.array(z.string()),
  channels: z.array(ChannelSchema),
});

const LatestResourceSchema = z.object({
  target: z.string(),
  channel: z.string(),
  fetchedAt: IsoTime,
  latest: z.string().optional(),
});

const VersionResourceSchema = z.object({
  version: z.string(),
  commit: z.string().optional(),
  builtAt: z.string().optional(),
  versionString: z.string(),
});

const EarningSchema = z.object({
  currency: z.string(),
  amount: z.number(),
});

/** A game's earnings in one currency, in the currency's smallest unit. */
export interface Earning {
  /** ISO currency code, e.g. USD. */
  currency: string;
  /** Amount in the smallest unit of the currency, e.g. cents. */
  amount: number;
}

const _EarningMatch: Same<z.infer<typeof EarningSchema>, Earning> = true;

const GameSchema = z.object({
  id: z.number().int().positive(),
  title: z.string(),
  published: z.boolean().nullable(),
  publishedAt: z.string().nullable(),
  minPrice: z.number().nullable(),
  viewsCount: z.number().nullable(),
  downloadsCount: z.number().nullable(),
  purchasesCount: z.number().nullable(),
  earnings: z.array(EarningSchema),
});

/**
 * One game as recorded: its id, title, publish state and the totals itch.io
 * reports to its owner. A field the API left out is null. The page address,
 * which names the owner's account, and fields nothing compares are not kept.
 */
export interface Game {
  /** itch.io game id. */
  id: number;
  /** Game title. */
  title: string;
  /** Whether the page is published. */
  published: boolean | null;
  /** Time the page was published, as itch.io sent it. */
  publishedAt: string | null;
  /** Minimum price in cents. */
  minPrice: number | null;
  /** Page views. */
  viewsCount: number | null;
  /** Downloads. */
  downloadsCount: number | null;
  /** Purchases. */
  purchasesCount: number | null;
  /** Earnings per currency, sorted by currency. */
  earnings: Earning[];
}

const _GameMatch: Same<z.infer<typeof GameSchema>, Game> = true;

const FieldValueSchema = z.union([z.string(), z.number(), z.boolean()])
  .nullable();

/** A recorded field value. */
export type FieldValue = string | number | boolean | null;

const FieldChangeSchema = z.object({
  field: z.string(),
  from: FieldValueSchema,
  to: FieldValueSchema,
  delta: z.number().nullable(),
});

/** One field of one game that differs from the previous version. */
export interface FieldChange {
  /** Field name, or `earnings.<currency>` for an earnings amount. */
  field: string;
  /** The previous value. */
  from: FieldValue;
  /** The current value. */
  to: FieldValue;
  /** `to - from` when both are numbers, otherwise null. */
  delta: number | null;
}

const _FieldChangeMatch: Same<z.infer<typeof FieldChangeSchema>, FieldChange> =
  true;

const GameRefSchema = z.object({
  id: z.number().int().positive(),
  title: z.string(),
});

/** A game named by id and title. */
export interface GameRef {
  /** itch.io game id. */
  id: number;
  /** Game title. */
  title: string;
}

const _GameRefMatch: Same<z.infer<typeof GameRefSchema>, GameRef> = true;

const GameChangeSchema = z.object({
  id: z.number().int().positive(),
  title: z.string(),
  fields: z.array(FieldChangeSchema),
});

/** The fields of one game that changed. */
export interface GameChange extends GameRef {
  /** Each changed field, in a fixed order. */
  fields: FieldChange[];
}

const _GameChangeMatch: Same<z.infer<typeof GameChangeSchema>, GameChange> =
  true;

const ChangesSchema = z.object({
  since: IsoTime,
  added: z.array(GameRefSchema),
  removed: z.array(GameRefSchema),
  changed: z.array(GameChangeSchema),
});

/** What differs from the previous recorded version. */
export interface Changes {
  /** When the previous version was read. */
  since: string;
  /** Games present now and not before. */
  added: GameRef[];
  /** Games present before and not now. */
  removed: GameRef[];
  /** Games present in both whose fields differ. */
  changed: GameChange[];
}

const _ChangesMatch: Same<z.infer<typeof ChangesSchema>, Changes> = true;

const GamesRecordSchema = z.object({
  fetchedAt: IsoTime,
  games: z.array(GameSchema),
  changes: ChangesSchema.nullable(),
});

/** One version of the `games` resource. */
export interface GamesRecord {
  /** ISO-8601 time the games were read. */
  fetchedAt: string;
  /** Every game, sorted by id. */
  games: Game[];
  /** Differences from the previous version, or null for the first one. */
  changes: Changes | null;
}

const _GamesRecordMatch: Same<z.infer<typeof GamesRecordSchema>, GamesRecord> =
  true;

const PreviousLatestSchema = z.object({
  latest: z.string().nullable(),
  checkedAt: IsoTime,
});

/** A channel's previously recorded user version. */
export interface PreviousLatest {
  /** The user version, or null when the build had none. */
  latest: string | null;
  /** When it was read. */
  checkedAt: string;
}

const _PreviousLatestMatch: Same<
  z.infer<typeof PreviousLatestSchema>,
  PreviousLatest
> = true;

const ChannelRecordSchema = z.object({
  gameId: z.number().int().positive(),
  channel: z.string(),
  latest: z.string().nullable(),
  checkedAt: IsoTime,
  previous: PreviousLatestSchema.nullable(),
  changed: z.boolean(),
});

/** One version of a channel's `channel` resource. */
export interface ChannelRecord {
  /** itch.io game id. */
  gameId: number;
  /** butler channel name. */
  channel: string;
  /** Latest user version, or null when the latest build has none. */
  latest: string | null;
  /** ISO-8601 time it was read. */
  checkedAt: string;
  /** The previous recorded version, or null for the first. */
  previous: PreviousLatest | null;
  /** Whether `latest` differs from the previous version's; false for the first. */
  changed: boolean;
}

const _ChannelRecordMatch: Same<
  z.infer<typeof ChannelRecordSchema>,
  ChannelRecord
> = true;

const CredentialsRecordSchema = z.object({
  type: z.string(),
  scopes: z.array(z.string()).nullable(),
  expiresAt: z.string().nullable(),
  checkedAt: IsoTime,
});

/** What itch.io says about the key, never the key itself. */
export interface CredentialsRecord {
  /** `key` for an API key, `jwt` for a JWT token. */
  type: string;
  /** Scopes the key is limited to, or null for an unscoped key. */
  scopes: string[] | null;
  /** Expiry of a JWT token, or null. */
  expiresAt: string | null;
  /** ISO-8601 time it was read. */
  checkedAt: string;
}

const _CredentialsRecordMatch: Same<
  z.infer<typeof CredentialsRecordSchema>,
  CredentialsRecord
> = true;

/**
 * The fields of one game in `/profile/games` this behavior reads; the rest,
 * such as the page address, cover and the owner's user object, are dropped
 * when the answer is parsed.
 */
const ApiGameSchema = z.object({
  id: z.number().int().positive(),
  title: z.string(),
  published: z.boolean().nullish(),
  published_at: z.string().nullish(),
  min_price: z.number().nullish(),
  views_count: z.number().nullish(),
  downloads_count: z.number().nullish(),
  purchases_count: z.number().nullish(),
  earnings: z.array(
    z.object({ currency: z.string(), amount: z.number() }),
  ).nullish(),
});

const ApiGamesSchema = z.object({ games: z.array(ApiGameSchema) });

const ApiCredentialsSchema = z.object({
  type: z.string(),
  scopes: z.array(z.string()).nullish(),
  expires_at: z.string().nullish(),
});

const ApiLatestSchema = z.object({
  latest: z.union([z.string(), z.number()]).nullish(),
});

/** What the injected runner is asked to run. */
export interface RunRequest {
  /** Program to run. */
  command: string;
  /** Its arguments. */
  args: string[];
  /** Variables added to the inherited environment. */
  env: Record<string, string>;
  /** Kill the program after this many milliseconds. */
  timeoutMs: number;
  /** Cancellation from swamp. */
  signal?: AbortSignal;
}

/** What running a program produced. */
export interface RunResult {
  /** Exit code, or null when the program was killed. */
  code: number | null;
  /** Standard output, the JSON lines butler -j prints. */
  stdout: string;
  /** Standard error. */
  stderr: string;
  /** True when the program was killed for exceeding the timeout. */
  timedOut: boolean;
}

/** Runs a program with closed standard input. Tests replace it, swamp uses `denoRunner`. */
export type Runner = (request: RunRequest) => Promise<RunResult>;

/** The subset of `fetch` the methods use. Tests replace it. */
export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

/** Runs a program with `Deno.Command`, standard input closed, killed on timeout or abort. */
export const denoRunner: Runner = async (
  request: RunRequest,
): Promise<RunResult> => {
  // swamp-quality-ignore deno-command: butler is the upload tool itch.io documents, and its arguments are the validated global and method arguments
  const child = new Deno.Command(request.command, {
    args: request.args,
    env: request.env,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let timedOut = false;
  const kill = (): void => {
    try {
      child.kill("SIGKILL");
    } catch {
      // The process has already exited.
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, request.timeoutMs);
  request.signal?.addEventListener("abort", kill, { once: true });
  try {
    const result = await child.output();
    const decoder = new TextDecoder();
    return {
      code: result.code,
      stdout: decoder.decode(result.stdout),
      stderr: decoder.decode(result.stderr),
      timedOut,
    };
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", kill);
  }
};

/** Replaces every given secret in `text` with a marker. Empty and undefined secrets are skipped. */
export function redact(
  text: string,
  secrets: ReadonlyArray<string | undefined>,
): string {
  let result = text;
  for (const secret of secrets) {
    if (secret) {
      result = result.split(secret).join(REDACTED);
    }
  }
  return result;
}

/** What one butler -j run printed, sorted by message type. */
export interface ButlerOutput {
  /** The `value` of the last `result` message, if any. */
  result?: Record<string, unknown>;
  /** First line of each `error` message; butler appends a Go stack trace. */
  errors: string[];
  /** Human-readable lines: log messages and any non-JSON output, in order. */
  lines: string[];
  /** Indexes into `lines` of warnings and errors, kept in every excerpt. */
  important: number[];
}

/**
 * Parses butler's JSON-lines output (the `-j` flag): `log` messages with a
 * level, `error` messages, `result` with the command's value, and progress
 * or object messages, which are dropped. Lines that are not JSON, such as the
 * "bailing out" line butler writes to standard error, are kept as text.
 */
export function parseButlerOutput(stdout: string, stderr = ""): ButlerOutput {
  const out: ButlerOutput = { errors: [], lines: [], important: [] };
  const all = `${stdout}\n${stderr}`.split(/\r?\n/);
  for (const raw of all) {
    const line = raw.trim();
    if (line === "") {
      continue;
    }
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      message = undefined;
    }
    if (
      typeof message !== "object" || message === null ||
      Array.isArray(message)
    ) {
      // Standard error repeats an error's stack trace as plain lines; keep only the summary.
      if (!/^\s|^github\.com\/|^runtime\.|^main\./.test(raw)) {
        if (/^bailing out:/.test(line)) {
          out.important.push(out.lines.length);
        }
        out.lines.push(line);
      }
      continue;
    }
    const record = message as Record<string, unknown>;
    const type = record.type;
    if (type === "result") {
      const value = record.value;
      if (
        typeof value === "object" && value !== null && !Array.isArray(value)
      ) {
        out.result = value as Record<string, unknown>;
      }
    } else if (type === "error") {
      const text = String(record.message ?? "").split("\n")[0] ?? "";
      out.errors.push(text);
      out.important.push(out.lines.length);
      out.lines.push(`error: ${text}`);
    } else if (type === "log") {
      const level = String(record.level ?? "info");
      const text = String(record.message ?? "");
      if (level === "warning" || level === "error") {
        out.important.push(out.lines.length);
      }
      if (level !== "debug") {
        out.lines.push(level === "info" ? text : `${level}: ${text}`);
      }
    }
  }
  return out;
}

/** Warnings, errors and the last lines of the output, bounded. */
export function excerpt(output: ButlerOutput): string[] {
  const keep = new Set<number>(output.important);
  const tailStart = Math.max(0, output.lines.length - EXCERPT_TAIL);
  for (let index = tailStart; index < output.lines.length; index++) {
    keep.add(index);
  }
  const kept = [...keep].sort((a, b) => a - b);
  const start = Math.max(0, kept.length - EXCERPT_MAX);
  return kept.slice(start).map((index) => output.lines[index] ?? "");
}

/** Reads a number field butler printed, or undefined. */
function numberField(
  value: Record<string, unknown>,
  key: string,
): number | undefined {
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field)
    ? field
    : undefined;
}

/** Reads a string field butler printed, or undefined. */
function stringField(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

/** Converts one build object of butler status's JSON result. */
function toBuild(raw: unknown): Build | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const value = raw as Record<string, unknown>;
  const id = numberField(value, "id");
  if (id === undefined) {
    return undefined;
  }
  const build: Build = { id, state: stringField(value, "state") ?? "unknown" };
  const version = numberField(value, "version");
  if (version !== undefined) build.version = version;
  const userVersion = stringField(value, "userVersion");
  if (userVersion) build.userVersion = userVersion;
  const parent = numberField(value, "parentBuildId");
  if (parent !== undefined && parent > 0) build.parentBuildId = parent;
  const createdAt = stringField(value, "createdAt");
  if (createdAt) build.createdAt = createdAt;
  const updatedAt = stringField(value, "updatedAt");
  if (updatedAt) build.updatedAt = updatedAt;
  return build;
}

/** Converts butler status's JSON result into channels, with `ready` and `failed` worked out. */
export function parseStatusResult(value: Record<string, unknown>): Channel[] {
  const list = Array.isArray(value.channels) ? value.channels : [];
  const channels: Channel[] = [];
  for (const raw of list) {
    if (typeof raw !== "object" || raw === null) {
      continue;
    }
    const entry = raw as Record<string, unknown>;
    const name = stringField(entry, "name");
    if (name === undefined) {
      continue;
    }
    const tags = Array.isArray(entry.tags)
      ? entry.tags.filter((tag): tag is string => typeof tag === "string")
      : [];
    const head = toBuild(entry.head);
    const pending = toBuild(entry.pending);
    const channel: Channel = {
      name,
      tags,
      ready: head?.state === "completed" && pending === undefined,
      failed: head?.state === "failed" || pending?.state === "failed",
    };
    const uploadId = numberField(entry, "uploadId");
    if (uploadId !== undefined) channel.uploadId = uploadId;
    if (head !== undefined) channel.head = head;
    if (pending !== undefined) channel.pending = pending;
    channels.push(channel);
  }
  return channels;
}

/** The logger fields this module uses, as swamp's LogTape logger provides them. */
export interface Logger {
  /** Internal state and intermediate values. */
  debug(message: string, properties?: Record<string, unknown>): void;
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

/** The context fields the methods read. */
export interface MethodContext {
  /** Validated global arguments of the behavior instance. */
  globalArgs: GlobalArgs;
  /** Repository root, which relative paths resolve against. */
  repoDir: string;
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
  /** Reads the latest version of one of this instance's records, or null. */
  readResource?: (
    instanceName: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;
}

/** Injectable dependencies, set by tests and otherwise defaulted to the Deno runtime. */
export interface Injected {
  /** Replaces `denoRunner`. */
  _runner?: Runner;
  /** Replaces the global `fetch`. */
  _fetch?: Fetcher;
  /** Replaces the wait between status reads. */
  _sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Replaces `Date.now`. */
  _now?: () => number;
}

/** True for an absolute POSIX or Windows path. */
function isAbsolute(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

/** Resolves a path against the repository root unless it is absolute. */
function resolveFrom(repoDir: string, path: string): string {
  return isAbsolute(path) ? path : `${repoDir.replace(/[\\/]+$/, "")}/${path}`;
}

/** Waits `ms` milliseconds, or rejects when the signal aborts. */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** The `target` global argument, or an error naming the method that needs it. */
function requireTarget(globalArgs: GlobalArgs, method: string): string {
  if (globalArgs.target === undefined) {
    throw new Error(
      `${method} needs the target global argument, the itch.io project as user/game`,
    );
  }
  return globalArgs.target;
}

/** The `apiKey` global argument, or an error naming the method that needs it. */
function requireKey(globalArgs: GlobalArgs, method: string): string {
  if (globalArgs.apiKey === undefined) {
    throw new Error(
      `${method} needs the apiKey global argument: an itch.io API key, supplied with a vault.get expression`,
    );
  }
  return globalArgs.apiKey;
}

/** The global flags and environment every butler call shares. */
function butlerInvocation(
  globalArgs: GlobalArgs,
): { prefix: string[]; env: Record<string, string> } {
  const prefix = ["-j"];
  if (globalArgs.identity !== undefined) {
    prefix.push("-i", globalArgs.identity);
  }
  const env: Record<string, string> = {};
  if (globalArgs.apiKey !== undefined) {
    env.BUTLER_API_KEY = globalArgs.apiKey;
  }
  return { prefix, env };
}

/** Runs butler once, turning a missing binary into a clear error. */
async function runButler(
  runner: Runner,
  globalArgs: GlobalArgs,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<RunResult> {
  const { prefix, env } = butlerInvocation(globalArgs);
  try {
    return await runner({
      command: globalArgs.butler,
      args: [...prefix, ...args],
      env,
      timeoutMs,
      signal,
    });
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(
        `butler was not found as "${globalArgs.butler}": install it (https://itch.io/docs/butler/installing.html) or set the butler global argument to its path`,
      );
    }
    throw error;
  }
}

/** Throws a specific, redacted error for a butler run that failed. */
function failure(
  what: string,
  run: RunResult,
  output: ButlerOutput,
  timeoutSeconds: number,
): Error {
  const lines = excerpt(output).join("\n");
  if (run.timedOut) {
    return new Error(
      `butler ${what} did not finish within ${timeoutSeconds} seconds and was killed. Output:\n${lines}`,
    );
  }
  if (output.errors.some((error) => /no credentials/i.test(error))) {
    return new Error(
      "butler has no credentials on this machine: set the apiKey global argument from a vault (it becomes BUTLER_API_KEY), or run butler login once",
    );
  }
  if (output.errors.some((error) => /invalid key/i.test(error))) {
    return new Error(
      `itch.io refused the API key for butler ${what} (invalid key): replace the key in the vault. Output:\n${lines}`,
    );
  }
  return new Error(
    `butler ${what} exited with code ${String(run.code)}${
      output.errors.length > 0 ? `: ${output.errors.join("; ")}` : ""
    }. Output:\n${lines}`,
  );
}

/** Reads the project's channels once with butler status. */
async function readStatus(
  runner: Runner,
  globalArgs: GlobalArgs,
  target: string,
  channel: string | undefined,
  timeoutSeconds: number,
  signal?: AbortSignal,
): Promise<Channel[]> {
  const run = await runButler(
    runner,
    globalArgs,
    ["status", channel === undefined ? target : `${target}:${channel}`],
    timeoutSeconds * 1000,
    signal,
  );
  const output = parseButlerOutput(
    redact(run.stdout, [globalArgs.apiKey]),
    redact(run.stderr, [globalArgs.apiKey]),
  );
  if (run.timedOut || run.code !== 0 || output.result === undefined) {
    throw failure("status", run, output, timeoutSeconds);
  }
  return parseStatusResult(output.result);
}

/** What a status code means when itch.io's answer carries no message of its own. */
const STATUS_HINTS: Record<number, string> = {
  401: "the API key is missing, invalid or revoked",
  403: "the API key lacks the scope this endpoint needs",
  404: "not found",
};

/**
 * Sends one GET request and returns the parsed JSON body. The key, when
 * given, goes only in the `Authorization` header, and a redirect is then
 * refused rather than followed with it. Throws a specific error for
 * a network failure, a rate limit, a server error, an `errors` array, another
 * failing status, or a body that is not JSON. No message contains the key.
 */
export async function getJson(
  fetcher: Fetcher,
  url: string,
  where: string,
  apiKey: string | null,
  signal?: AbortSignal,
): Promise<unknown> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const headers: Record<string, string> = { accept: "application/json" };
  if (apiKey !== null) {
    headers.authorization = `Bearer ${apiKey}`;
  }
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "GET",
      headers,
      // A redirect would carry the key header to whatever host it names.
      redirect: apiKey === null ? "follow" : "error",
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
      `${where}: itch.io rate limited the request (HTTP 429)` +
        (retryAfter ? `, retry after ${retryAfter} seconds` : ", retry later"),
    );
  }
  const text = await response.text();
  if (response.status >= 500) {
    throw new Error(
      `${where}: itch.io is unavailable (HTTP ${response.status}), a transient failure, retry later: ${
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
  const errors = body !== null && typeof body === "object"
    ? (body as Record<string, unknown>).errors
    : undefined;
  if (Array.isArray(errors) && errors.length > 0) {
    const hint = STATUS_HINTS[response.status];
    throw new Error(
      `${where}: itch.io refused the request (HTTP ${response.status}): ${
        errors.map(String).join("; ")
      }` + (hint ? ` (${hint})` : ""),
    );
  }
  if (!response.ok) {
    const hint = STATUS_HINTS[response.status] ?? "unexpected status";
    throw new Error(
      `${where}: HTTP ${response.status}, ${hint}: ${text.slice(0, 200)}`,
    );
  }
  return body;
}

/** Converts one documented API game to the recorded shape. */
function toGame(api: z.infer<typeof ApiGameSchema>): Game {
  const earnings = (api.earnings ?? [])
    .map((earning) => ({ currency: earning.currency, amount: earning.amount }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
  return {
    id: api.id,
    title: api.title,
    published: api.published ?? null,
    publishedAt: api.published_at ?? null,
    minPrice: api.min_price ?? null,
    viewsCount: api.views_count ?? null,
    downloadsCount: api.downloads_count ?? null,
    purchasesCount: api.purchases_count ?? null,
    earnings,
  };
}

/** Reads the key owner's games from `/profile/games`, sorted by id. */
export async function fetchGames(
  fetcher: Fetcher,
  apiKey: string,
  signal?: AbortSignal,
): Promise<Game[]> {
  const where = "GET /profile/games";
  const body = await getJson(fetcher, GAMES_URL, where, apiKey, signal);
  const parsed = ApiGamesSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(
      `${where}: the answer is not the documented shape: ${
        parsed.error.issues.map((issue) =>
          `${issue.path.join(".")}: ${issue.message}`
        ).join("; ").slice(0, 300)
      }`,
    );
  }
  return parsed.data.games.map(toGame).sort((a, b) => a.id - b.id);
}

/** Reads `/wharf/latest` for one query, without a key. */
async function readLatest(
  fetcher: Fetcher,
  query: Record<string, string>,
  where: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const url = new URL(WHARF_LATEST_URL);
  for (const [name, value] of Object.entries(query)) {
    url.searchParams.set(name, value);
  }
  const body = await getJson(fetcher, url.toString(), where, null, signal);
  const parsed = ApiLatestSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(`${where}: the answer is not the documented shape`);
  }
  const latest = parsed.data.latest;
  return latest === null || latest === undefined ? null : String(latest);
}

/** Reads a channel's latest user version by game id from `/wharf/latest`, without a key. */
export function fetchLatest(
  fetcher: Fetcher,
  gameId: number,
  channel: string,
  signal?: AbortSignal,
): Promise<string | null> {
  return readLatest(
    fetcher,
    { game_id: String(gameId), channel_name: channel },
    `GET /wharf/latest for game ${gameId} channel ${channel}`,
    signal,
  );
}

/** Reads a channel's latest user version by `user/game` target from `/wharf/latest`, without a key. */
export function fetchTargetLatest(
  fetcher: Fetcher,
  target: string,
  channel: string,
  signal?: AbortSignal,
): Promise<string | null> {
  return readLatest(
    fetcher,
    { target, channel_name: channel },
    `GET /wharf/latest for ${target}:${channel} (a private game answers "invalid game")`,
    signal,
  );
}

/** The key's description from `/credentials/info`, without a reading time. */
export type KeyInfo = Omit<CredentialsRecord, "checkedAt">;

/** Reads the key's type and scopes from `/credentials/info`. */
export async function fetchCredentials(
  fetcher: Fetcher,
  apiKey: string,
  signal?: AbortSignal,
): Promise<KeyInfo> {
  const where = "GET /credentials/info";
  const body = await getJson(fetcher, CREDENTIALS_URL, where, apiKey, signal);
  const parsed = ApiCredentialsSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(`${where}: the answer is not the documented shape`);
  }
  return {
    type: parsed.data.type,
    scopes: parsed.data.scopes ?? null,
    expiresAt: parsed.data.expires_at ?? null,
  };
}

/** The scalar game fields compared between versions, in reporting order. */
const COMPARED_FIELDS = [
  "title",
  "published",
  "publishedAt",
  "minPrice",
  "viewsCount",
  "downloadsCount",
  "purchasesCount",
] as const;

/** One field change, with a delta when both sides are numbers. */
function fieldChange(
  field: string,
  from: FieldValue,
  to: FieldValue,
): FieldChange {
  const delta = typeof from === "number" && typeof to === "number"
    ? to - from
    : null;
  return { field, from, to, delta };
}

/** The fields of one game that differ between two versions. */
export function diffGame(before: Game, after: Game): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const field of COMPARED_FIELDS) {
    if (before[field] !== after[field]) {
      changes.push(fieldChange(field, before[field], after[field]));
    }
  }
  const earned = (game: Game) =>
    new Map(game.earnings.map((earning) => [earning.currency, earning.amount]));
  const was = earned(before);
  const now = earned(after);
  const currencies = [...new Set([...was.keys(), ...now.keys()])].sort();
  for (const currency of currencies) {
    const from = was.get(currency) ?? null;
    const to = now.get(currency) ?? null;
    if (from !== to) {
      changes.push(fieldChange(`earnings.${currency}`, from, to));
    }
  }
  return changes;
}

/** What differs between the previous recorded games and the current ones. */
export function diffGames(
  previous: GamesRecord,
  current: readonly Game[],
): Changes {
  const before = new Map(previous.games.map((game) => [game.id, game]));
  const after = new Map(current.map((game) => [game.id, game]));
  const ref = (game: Game): GameRef => ({ id: game.id, title: game.title });
  const added: GameRef[] = [];
  const changed: GameChange[] = [];
  for (const game of current) {
    const old = before.get(game.id);
    if (old === undefined) {
      added.push(ref(game));
      continue;
    }
    const fields = diffGame(old, game);
    if (fields.length > 0) {
      changed.push({ ...ref(game), fields });
    }
  }
  const removed = previous.games
    .filter((game) => !after.has(game.id))
    .map(ref)
    .sort((a, b) => a.id - b.id);
  return { since: previous.fetchedAt, added, removed, changed };
}

/** The data name a channel's latest user version is written under. */
export function channelName(gameId: number, channel: string): string {
  return `game-${gameId}-${channel}`;
}

/**
 * Reads this instance's previous record, or null when there is none or it no
 * longer parses. Fields a record holds that the schema no longer declares,
 * such as a game's page address in versions before 2026.10.31.1, are dropped.
 */
async function readPrevious<T>(
  context: MethodContext,
  name: string,
  schema: z.ZodType<T>,
): Promise<T | null> {
  if (context.readResource === undefined) {
    throw new Error(
      "this method needs swamp's readResource to compare with the previous version; upgrade swamp",
    );
  }
  const stored = await context.readResource(name);
  if (stored === null) {
    return null;
  }
  const parsed = schema.safeParse(stored);
  if (!parsed.success) {
    context.logger.warning(
      "The previous {name} record is not in the current shape; recording without a comparison",
      { name },
    );
    return null;
  }
  return parsed.data;
}

/**
 * The upgrade to 2026.10.31.1. Both lines that held this name keep their
 * global arguments as written: a butler instance (2026.10.21.1: target, butler,
 * apiKey, identity) and an API instance (2026.10.22.x: apiKey alone) are each
 * a valid set of 2026.10.31.1's arguments. Pure: the same arguments give the
 * same result.
 */
export function upgradeArguments(
  old: Record<string, unknown>,
): Record<string, unknown> {
  return { ...old };
}

/** The itch.io behavior: butler publishing and the server-side API's records. */
export const behavior = {
  // String literals, not constants: the registry catalog reads them from the
  // source.
  type: "@reset/itch",
  version: "2026.10.31.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    push: {
      description:
        "One butler push: the build id itch.io gave it, whether it was a dry run or skipped as unchanged, and a bounded log excerpt",
      schema: PushResourceSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
    status: {
      description:
        "The project's channels from butler status, the state of each one's latest and pending build, and whether the read channel is ready",
      schema: StatusResourceSchema,
      lifetime: "30d",
      garbageCollection: 20,
    },
    latest: {
      description:
        "A target channel's latest user version from itch.io's public update check endpoint",
      schema: LatestResourceSchema,
      lifetime: "30d",
      garbageCollection: 20,
    },
    version: {
      description: "The butler version this machine runs",
      schema: VersionResourceSchema,
      lifetime: "30d",
      garbageCollection: 5,
    },
    games: {
      description:
        "Every game the API key's owner can edit, its publish state, price and counts, with what changed since the previous version",
      schema: GamesRecordSchema,
      lifetime: "infinite",
      garbageCollection: "365d",
    },
    channel: {
      description:
        "One game's channel's latest user version by game id, and whether it moved since the previous version",
      schema: ChannelRecordSchema,
      lifetime: "infinite",
      garbageCollection: "365d",
    },
    credentials: {
      description: "The API key's type and scopes, never the key itself",
      schema: CredentialsRecordSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    push: {
      description:
        "Upload a build directory or zip to a channel of the project with butler push, and record the build id",
      arguments: PushArgsSchema,
      execute: async (
        args: PushArgs & Injected,
        context: MethodContext,
      ): Promise<MethodResult> => {
        const { globalArgs, logger } = context;
        const project = requireTarget(globalArgs, "push");
        const runner = args._runner ?? denoRunner;
        const directory = resolveFrom(context.repoDir, args.directory);
        const flags: string[] = [];
        const userVersion = args.userVersion === ""
          ? undefined
          : args.userVersion;
        if (userVersion !== undefined) {
          flags.push("--userversion", userVersion);
        }
        if (args.userVersionFile !== undefined) {
          flags.push(
            "--userversion-file",
            resolveFrom(context.repoDir, args.userVersionFile),
          );
        }
        if (args.ifChanged) flags.push("--if-changed");
        if (args.dryRun) flags.push("--dry-run");
        if (args.hidden) flags.push("--hidden");
        if (args.fixPermissions) flags.push("--fix-permissions");
        for (const pattern of args.ignore) {
          flags.push("--ignore", pattern);
        }
        const target = `${project}:${args.channel}`;
        logger.info("Pushing {directory} to {target}", {
          directory,
          target,
          dryRun: args.dryRun,
          ifChanged: args.ifChanged,
          userVersion,
          apiKey: globalArgs.apiKey !== undefined,
        });
        const startedAt = new Date().toISOString();
        const run = await runButler(
          runner,
          globalArgs,
          ["push", ...flags, directory, target],
          args.timeoutSeconds * 1000,
          context.signal,
        );
        const finishedAt = new Date().toISOString();
        const output = parseButlerOutput(
          redact(run.stdout, [globalArgs.apiKey]),
          redact(run.stderr, [globalArgs.apiKey]),
        );
        if (run.timedOut || run.code !== 0 || output.result === undefined) {
          throw failure("push", run, output, args.timeoutSeconds);
        }
        const buildId = numberField(output.result, "buildId") ?? 0;
        const dryRun = output.result.dryRun === true;
        const skipped = output.result.skipped === true;
        if (!dryRun && !skipped && buildId <= 0) {
          throw new Error(
            `butler push reported success but no build id. Output:\n${
              excerpt(output).join("\n")
            }`,
          );
        }
        logger.info(
          "Pushed to {target}: build {buildId}{note}",
          {
            target,
            buildId,
            note: dryRun
              ? " (dry run)"
              : skipped
              ? " (unchanged, skipped)"
              : "",
          },
        );
        const lines = excerpt(output);
        const data: z.infer<typeof PushResourceSchema> = {
          target: project,
          channel: stringField(output.result, "channel") ?? args.channel,
          directory,
          buildId,
          dryRun,
          skipped,
          reason: stringField(output.result, "reason") ?? "",
          startedAt,
          finishedAt,
          exitCode: run.code ?? -1,
          logLines: output.lines.length,
          logExcerpt: lines,
        };
        if (userVersion !== undefined) {
          data.userVersion = userVersion;
        }
        const handle = await context.writeResource("push", "push", data);
        return { dataHandles: [handle] };
      },
    },
    status: {
      description:
        "Read the project's channels and their builds with butler status, waiting within a deadline for a channel's build to finish processing",
      arguments: StatusArgsSchema,
      execute: async (
        args: StatusArgs & Injected,
        context: MethodContext,
      ): Promise<MethodResult> => {
        const { globalArgs, logger } = context;
        const target = requireTarget(globalArgs, "status");
        const runner = args._runner ?? denoRunner;
        const sleep = args._sleep ?? defaultSleep;
        const now = args._now ?? Date.now;
        const startedAt = now();
        const deadline = startedAt + args.waitSeconds * 1000;
        let reads = 0;
        let channels: Channel[];
        let timedOut = false;
        logger.info("Reading the channels of {target}{named}", {
          target,
          named: args.channel === undefined ? "" : `:${args.channel}`,
          waitSeconds: args.waitSeconds,
        });
        let failedReads = 0;
        channels = [];
        for (;;) {
          try {
            channels = await readStatus(
              runner,
              globalArgs,
              target,
              args.channel,
              args.timeoutSeconds,
              context.signal,
            );
            reads++;
          } catch (error) {
            // The first read surfaces credentials and target errors at once. While
            // waiting, a failed read is retried until the deadline, then thrown.
            if (
              reads === 0 || context.signal?.aborted ||
              now() + args.intervalSeconds * 1000 > deadline
            ) {
              throw error;
            }
            failedReads++;
            logger.warning(
              "butler status failed while waiting ({failedReads} so far), retrying: {error}",
              {
                failedReads,
                error: error instanceof Error ? error.message : String(error),
              },
            );
            await sleep(args.intervalSeconds * 1000, context.signal);
            continue;
          }
          const settled = channels.length > 0 &&
            channels.every((channel) => channel.ready || channel.failed);
          if (args.waitSeconds === 0 || settled) {
            break;
          }
          if (now() + args.intervalSeconds * 1000 > deadline) {
            timedOut = true;
            break;
          }
          logger.debug("{target} not settled after {reads} reads", {
            target,
            reads,
          });
          await sleep(args.intervalSeconds * 1000, context.signal);
        }
        const found = channels.length > 0;
        const data: z.infer<typeof StatusResourceSchema> = {
          target,
          fetchedAt: new Date(now()).toISOString(),
          reads,
          waitedSeconds: Math.round((now() - startedAt) / 1000),
          timedOut,
          found,
          ready: found && channels.every((channel) => channel.ready),
          failed: channels.some((channel) => channel.failed),
          channelNames: channels.map((channel) => channel.name),
          channels,
        };
        if (args.channel !== undefined) {
          data.channel = args.channel;
        }
        if (!found) {
          logger.warning(
            "{target} has no channel{named}",
            {
              target,
              named: args.channel === undefined ? "" : ` named ${args.channel}`,
            },
          );
        } else {
          logger.info(
            "{target}: {count} channels, ready {ready}, failed {failed}",
            {
              target,
              count: channels.length,
              ready: data.ready,
              failed: data.failed,
            },
          );
        }
        const handle = await context.writeResource("status", "status", data);
        return { dataHandles: [handle] };
      },
    },
    latest: {
      description:
        "Read a channel's latest user version from itch.io's public update check, without the key. With gameId, writes channel and whether it moved; without, writes latest for the target",
      arguments: LatestArgsSchema,
      execute: async (
        args: LatestArgs & Injected,
        context: MethodContext,
      ): Promise<MethodResult> => {
        const { globalArgs, logger } = context;
        const fetcher = args._fetch ?? globalThis.fetch;
        const now = args._now ?? Date.now;
        if (args.gameId === undefined) {
          const target = requireTarget(globalArgs, "latest without a gameId");
          logger.info(
            "Reading the latest user version of {target}:{channel}",
            { target, channel: args.channel },
          );
          const latest = await fetchTargetLatest(
            fetcher,
            target,
            args.channel,
            context.signal,
          );
          const data: z.infer<typeof LatestResourceSchema> = {
            target,
            channel: args.channel,
            fetchedAt: new Date(now()).toISOString(),
          };
          if (latest !== null) {
            data.latest = latest;
          }
          logger.info("{target}:{channel} latest user version {latest}", {
            target,
            channel: args.channel,
            latest: latest ?? "(none)",
          });
          const handle = await context.writeResource("latest", "latest", data);
          return { dataHandles: [handle] };
        }
        const gameId = args.gameId;
        const name = channelName(gameId, args.channel);
        const previous = await readPrevious(context, name, ChannelRecordSchema);
        logger.info(
          "Reading the latest version of game {gameId} channel {channel}",
          { gameId, channel: args.channel },
        );
        const latest = await fetchLatest(
          fetcher,
          gameId,
          args.channel,
          context.signal,
        );
        const data: ChannelRecord = {
          gameId,
          channel: args.channel,
          latest,
          checkedAt: new Date(now()).toISOString(),
          previous: previous === null
            ? null
            : { latest: previous.latest, checkedAt: previous.checkedAt },
          changed: previous !== null && previous.latest !== latest,
        };
        const handle = await context.writeResource("channel", name, {
          ...data,
        });
        logger.info(
          "Game {gameId} channel {channel} is at {latest}" +
            (data.changed ? ", new since {since}" : ""),
          {
            gameId,
            channel: args.channel,
            latest: latest ?? "no user version",
            since: data.previous?.checkedAt ?? "",
          },
        );
        return { dataHandles: [handle] };
      },
    },
    version: {
      description: "Record which butler this machine runs (butler version)",
      arguments: NoArgsSchema,
      execute: async (
        args: Injected,
        context: MethodContext,
      ): Promise<MethodResult> => {
        const { globalArgs, logger } = context;
        const runner = args._runner ?? denoRunner;
        logger.info("Reading the version of {butler}", {
          butler: globalArgs.butler,
        });
        const run = await runButler(
          runner,
          globalArgs,
          ["version"],
          60_000,
          context.signal,
        );
        const output = parseButlerOutput(
          redact(run.stdout, [globalArgs.apiKey]),
          redact(run.stderr, [globalArgs.apiKey]),
        );
        const version = output.result === undefined
          ? undefined
          : stringField(output.result, "version");
        if (run.code !== 0 || output.result === undefined || !version) {
          throw failure("version", run, output, 60);
        }
        const data: z.infer<typeof VersionResourceSchema> = {
          version,
          versionString: stringField(output.result, "versionString") ??
            version,
        };
        const commit = stringField(output.result, "commit");
        if (commit) data.commit = commit;
        const builtAt = stringField(output.result, "builtAt");
        if (builtAt) data.builtAt = builtAt;
        logger.info("butler {version}", { version });
        const handle = await context.writeResource("version", "version", data);
        return { dataHandles: [handle] };
      },
    },
    games: {
      description:
        "Read the key owner's games from /profile/games and record them with the changes since the previous version",
      arguments: NoArgsSchema,
      execute: async (
        args: Injected,
        context: MethodContext,
      ): Promise<MethodResult> => {
        const { globalArgs, logger } = context;
        const apiKey = requireKey(globalArgs, "games");
        const fetcher = args._fetch ?? globalThis.fetch;
        const now = args._now ?? Date.now;
        const previous = await readPrevious(
          context,
          GAMES_NAME,
          GamesRecordSchema,
        );
        logger.info("Reading the games of the API key's owner");
        const games = await fetchGames(fetcher, apiKey, context.signal);
        const data: GamesRecord = {
          fetchedAt: new Date(now()).toISOString(),
          games,
          changes: previous === null ? null : diffGames(previous, games),
        };
        const handle = await context.writeResource(
          "games",
          GAMES_NAME,
          { ...data },
        );
        if (data.changes === null) {
          logger.info("Recorded {games} games, the first version", {
            games: games.length,
          });
        } else {
          logger.info(
            "Recorded {games} games: {added} added, {removed} removed, {changed} changed since {since}",
            {
              games: games.length,
              added: data.changes.added.length,
              removed: data.changes.removed.length,
              changed: data.changes.changed.length,
              since: data.changes.since,
            },
          );
        }
        return { dataHandles: [handle] };
      },
    },
    credentials: {
      description:
        "Read the API key's type and scopes from /credentials/info and record them, never the key",
      arguments: NoArgsSchema,
      execute: async (
        args: Injected,
        context: MethodContext,
      ): Promise<MethodResult> => {
        const { globalArgs, logger } = context;
        const apiKey = requireKey(globalArgs, "credentials");
        const fetcher = args._fetch ?? globalThis.fetch;
        const now = args._now ?? Date.now;
        logger.info("Reading the API key's type and scopes");
        const info = await fetchCredentials(fetcher, apiKey, context.signal);
        const data: CredentialsRecord = {
          ...info,
          checkedAt: new Date(now()).toISOString(),
        };
        const handle = await context.writeResource(
          "credentials",
          CREDENTIALS_NAME,
          { ...data },
        );
        logger.info("The API key is a {type} with {scopes}", {
          type: data.type,
          scopes: data.scopes === null ? "every scope" : data.scopes.join(", "),
        });
        return { dataHandles: [handle] };
      },
    },
  },
  upgrades: [
    {
      toVersion: "2026.10.31.1",
      description:
        "Joins the two lines of this extension: instances made on 2026.10.21.1 (butler: push, status, latest, version) and on 2026.10.22.x (API: games, latest by game id, credentials) keep their global arguments as written, and every method is available to both",
      upgradeAttributes: (old: Record<string, unknown>): Record<
        string,
        unknown
      > => upgradeArguments(old),
    },
  ],
};
