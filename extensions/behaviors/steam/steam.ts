/**
 * Publish a game's builds to Steam. `upload` drives steamcmd to build and
 * upload an app build from a generated or supplied app build script, `builds`
 * and `betas` read the app's build history and branches from the Steamworks
 * Web API, and `setLive` puts a build on a branch. Each method records what it
 * did as a swamp resource. The process runner, the file helpers and `fetch`
 * are injectable, so the unit tests run without steamcmd or the network.
 *
 * @module
 */

import { z } from "npm:zod@4";

/** Base URL of the publisher-side Steamworks Web API. */
const PARTNER_API = "https://partner.steam-api.com";

/** Replacement for a secret in anything this module logs, stores or throws. */
const REDACTED = "[redacted]";

/** How many trailing output lines the upload record keeps besides the matched ones. */
const EXCERPT_TAIL = 20;

/** Hard cap on the lines an upload record keeps. */
const EXCERPT_MAX = 120;

/** Output lines steamcmd prints when the login needs a Steam Guard code or was refused one. */
const STEAM_GUARD_PATTERNS: readonly RegExp[] = [
  /two[- ]?factor/i,
  /steam guard/i,
  /auth code/i,
  /account logon denied/i,
  /need two-factor code/i,
];

/** Output lines that mean the login itself failed for a reason other than Steam Guard. */
const LOGIN_FAILURE_PATTERNS: readonly RegExp[] = [
  /logging in user .*(failed|error)/i,
  /invalid password/i,
  /rate limit exceeded/i,
];

/** Lines worth keeping from steamcmd's output. */
const INTERESTING_LINE = new RegExp(
  "BuildID|Logging in|ERROR|FAILED|Steam Guard|two[- ]?factor|depot|Uploading|Scanning|Building|Successfully|Loading Steam API",
  "i",
);

/** `true` only when the zod output type and the hand-written interface describe the same shape. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

const GlobalArgsSchema = z.object({
  appId: z.number().int().positive().describe(
    "Steam application id (the AppID the build belongs to)",
  ),
  steamcmd: z.string().min(1).default("steamcmd").describe(
    "Path to steamcmd, or its command name when it is on PATH",
  ),
  username: z.string().min(1).describe(
    "Steam account used for builds (upload only)",
  ),
  password: z.string()
    .min(1)
    .meta({ sensitive: true })
    .optional().describe(
      "Password of the build account. Omit when steamcmd on this machine already holds a cached login for the account",
    ),
  webApiKey: z.string()
    .min(1)
    .meta({ sensitive: true })
    .optional().describe(
      "Publisher Web API key of the Steamworks group that owns the app, used by builds, betas and setLive",
    ),
  contentRoot: z.string()
    .min(1)
    .optional().describe(
      "Directory holding the depot content a generated app build script uploads from (upload without a supplied vdf)",
    ),
});

/** Global arguments of a behavior instance, as validated by swamp. */
export interface GlobalArgs {
  /** Steam application id. */
  appId: number;
  /** Path to steamcmd, or its command name when it is on PATH. */
  steamcmd: string;
  /** Steam account used for builds. */
  username: string;
  /** Password of the build account, absent when a cached steamcmd login is used. */
  password?: string;
  /** Publisher Web API key, absent when only `upload` is used. */
  webApiKey?: string;
  /** Directory holding the depot content a generated script uploads from. */
  contentRoot?: string;
}

const _GlobalArgsMatch: Same<
  z.infer<typeof GlobalArgsSchema>,
  GlobalArgs
> = true;

const DepotMappingSchema = z.object({
  localPath: z.string().min(1).default("*").describe(
    "File pattern under contentRoot to upload (steamcmd LocalPath)",
  ),
  depotPath: z.string().min(1).default(".").describe(
    "Directory inside the depot to place the files in (steamcmd DepotPath)",
  ),
  recursive: z.boolean().default(true).describe(
    "Whether localPath matches recursively",
  ),
  exclusions: z.array(z.string().min(1)).default([]).describe(
    "File patterns to leave out (steamcmd FileExclusion)",
  ),
});

/** One depot's file mapping in a generated app build script. */
export interface DepotMapping {
  /** File pattern under contentRoot to upload. */
  localPath: string;
  /** Directory inside the depot to place the files in. */
  depotPath: string;
  /** Whether localPath matches recursively. */
  recursive: boolean;
  /** File patterns to leave out. */
  exclusions: string[];
}

const _DepotMappingMatch: Same<
  z.infer<typeof DepotMappingSchema>,
  DepotMapping
> = true;

const UploadArgsSchema = z.object({
  vdf: z.string()
    .min(1)
    .optional().describe(
      "Path of an existing app build script to run as it is. When set, description, depots and setLive are ignored",
    ),
  description: z.string()
    .min(1)
    .max(200)
    .optional().describe(
      "Build description shown in Steamworks (generated script only)",
    ),
  depots: z.record(
    z.string().regex(/^\d+$/, "a depot id is a number"),
    z.union([z.string().min(1), DepotMappingSchema]),
  )
    .optional().describe(
      "Depot id to file mapping for the generated script: a localPath pattern, or an object with localPath, depotPath, recursive and exclusions",
    ),
  setLive: z.string()
    .min(1)
    .optional().describe(
      "Branch the generated script sets live right after the upload. Leave unset to upload only (the default branch cannot be set this way)",
    ),
  buildOutput: z.string()
    .min(1)
    .optional().describe(
      "Directory steamcmd writes its build logs and chunk cache to. Defaults to .swamp/steam/build-output/<appId> under the repository",
    ),
  preview: z.boolean().default(false).describe(
    "Build the depot locally without uploading (steamcmd Preview)",
  ),
  steamGuardCode: z.string()
    .regex(/^[A-Za-z0-9]{5}$/, "a Steam Guard code is five characters")
    .optional().describe(
      "A Steam Guard code for this one login, passed as +set_steam_guard_code. Needed on a machine with no cached login",
    ),
  timeoutSeconds: z.number().int().positive().default(3600).describe(
    "Kill steamcmd and fail when it has not exited after this many seconds",
  ),
});

/** Arguments of the `upload` method. */
export interface UploadArgs {
  /** Path of an existing app build script to run as it is. */
  vdf?: string;
  /** Build description for a generated script. */
  description?: string;
  /** Depot id to file mapping for a generated script. */
  depots?: Record<string, string | DepotMapping>;
  /** Branch a generated script sets live after the upload. */
  setLive?: string;
  /** Directory steamcmd writes logs and its chunk cache to. */
  buildOutput?: string;
  /** Build without uploading. */
  preview: boolean;
  /** A Steam Guard code for this one login. */
  steamGuardCode?: string;
  /** Seconds after which steamcmd is killed. */
  timeoutSeconds: number;
}

const _UploadArgsMatch: Same<
  z.infer<typeof UploadArgsSchema>,
  UploadArgs
> = true;

const BuildsArgsSchema = z.object({
  count: z.number().int().positive().max(1000).default(50).describe(
    "How many of the newest builds to read",
  ),
});

/** Arguments of the `builds` method. */
export interface BuildsArgs {
  /** How many of the newest builds to read. */
  count: number;
}

const _BuildsArgsMatch: Same<
  z.infer<typeof BuildsArgsSchema>,
  BuildsArgs
> = true;

const SetLiveArgsSchema = z.object({
  buildId: z.number().int().positive().describe(
    "The BuildID to set live, as reported by upload or builds",
  ),
  branch: z.string().min(1).default("public").describe(
    "Branch name (betakey). 'public' is the default branch players get",
  ),
  description: z.string()
    .min(1)
    .max(200)
    .optional().describe("Note recorded with the change in Steamworks"),
  approverSteamId: z.string()
    .regex(/^\d{17}$/, "a SteamID64 is 17 digits")
    .optional().describe(
      "SteamID64 of the account that confirms the change in the Steam mobile app when the app requires that for the default branch",
    ),
});

/** Arguments of the `setLive` method. */
export interface SetLiveArgs {
  /** The BuildID to set live. */
  buildId: number;
  /** Branch name. `public` is the default branch. */
  branch: string;
  /** Note recorded with the change. */
  description?: string;
  /** SteamID64 of the account that confirms the change in the Steam mobile app. */
  approverSteamId?: string;
}

const _SetLiveArgsMatch: Same<
  z.infer<typeof SetLiveArgsSchema>,
  SetLiveArgs
> = true;

const DepotLineSchema = z.object({
  depotId: z.string(),
  line: z.string(),
});

const UploadResourceSchema = z.object({
  appId: z.number().int(),
  buildId: z.number().int(),
  description: z.string().optional(),
  branch: z.string().optional(),
  vdf: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  exitCode: z.number().int(),
  depots: z.array(DepotLineSchema),
  logLines: z.number().int(),
  logExcerpt: z.array(z.string()),
});

const BuildRecordSchema = z.object({
  buildId: z.number().int(),
  description: z.string(),
  createdAt: z.string(),
  creatorAccountId: z.number().int(),
  liveOn: z.array(z.string()),
  raw: z.record(z.string(), z.unknown()),
});

const BuildsResourceSchema = z.object({
  appId: z.number().int(),
  fetchedAt: z.string(),
  count: z.number().int(),
  truncated: z.boolean(),
  buildIds: z.array(z.number().int()),
  builds: z.array(BuildRecordSchema),
});

const ReleaseResourceSchema = z.object({
  appId: z.number().int(),
  buildId: z.number().int(),
  branch: z.string(),
  description: z.string().optional(),
  at: z.string(),
  alreadyLive: z.boolean(),
  response: z.object({
    result: z.number().int(),
    message: z.string(),
  })
    .nullable(),
});

const BranchSchema = z.object({
  name: z.string(),
  buildId: z.number().int(),
  description: z.string(),
  requiresPassword: z.boolean(),
  requiresLocalContentServer: z.boolean(),
});

const BetasResourceSchema = z.object({
  appId: z.number().int(),
  fetchedAt: z.string(),
  branches: z.array(BranchSchema),
});

/** A branch of the app as the Web API reports it. */
export interface Branch {
  /** Branch name (betakey); `public` is the default branch. */
  name: string;
  /** The build live on the branch, 0 when none. */
  buildId: number;
  /** The branch description from Steamworks. */
  description: string;
  /** Whether the branch needs a password. */
  requiresPassword: boolean;
  /** Whether the branch is served from a local content server. */
  requiresLocalContentServer: boolean;
}

const _BranchMatch: Same<z.infer<typeof BranchSchema>, Branch> = true;

/** A request to run a program to completion. */
export interface RunRequest {
  /** Path or command name of the program. */
  command: string;
  /** Arguments, passed without shell interpretation. */
  args: string[];
  /** Milliseconds after which the program is killed and `timedOut` is set. */
  timeoutMs: number;
  /** Cancellation from swamp. Aborting kills the program. */
  signal?: AbortSignal;
}

/** What running a program produced. */
export interface RunResult {
  /** Exit code, or null when the program was killed. */
  code: number | null;
  /** Standard output followed by standard error. */
  output: string;
  /** True when the program was killed for exceeding the timeout. */
  timedOut: boolean;
}

/** Runs a program with closed standard input. Tests replace it, swamp uses `denoRunner`. */
export type Runner = (request: RunRequest) => Promise<RunResult>;

/** The file operations `upload` needs for a generated build script. */
export interface Files {
  /** Creates a fresh temporary directory and returns its path. */
  makeTempDir(): Promise<string>;
  /** Creates a directory and its parents. */
  mkdir(path: string): Promise<void>;
  /** Writes a text file, replacing it. */
  writeTextFile(path: string, text: string): Promise<void>;
  /** Removes a file or directory tree. */
  remove(path: string): Promise<void>;
}

/** The subset of `fetch` the Web API methods use. Tests replace it. */
export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

/** Runs a program with `Deno.Command`, standard input closed, killed on timeout or abort. */
export const denoRunner: Runner = async (
  request: RunRequest,
): Promise<RunResult> => {
  // swamp-quality-ignore deno-command: steamcmd is the only way to upload a build, and its arguments are the validated global arguments and a script path
  const child = new Deno.Command(request.command, {
    args: request.args,
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
      output: decoder.decode(result.stdout) + decoder.decode(result.stderr),
      timedOut,
    };
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", kill);
  }
};

/** File operations backed by the Deno runtime. */
export const denoFiles: Files = {
  makeTempDir: (): Promise<string> =>
    Deno.makeTempDir({ prefix: "swamp-steam-" }),
  mkdir: (path: string): Promise<void> => Deno.mkdir(path, { recursive: true }),
  writeTextFile: (path: string, text: string): Promise<void> =>
    Deno.writeTextFile(path, text),
  remove: (path: string): Promise<void> =>
    Deno.remove(path, { recursive: true }),
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

/** Replaces the value of a `key` query parameter in a URL or message with a marker. */
export function redactKeyParameter(text: string): string {
  return text.replace(/([?&]key=)[^&\s]*/g, `$1${REDACTED}`);
}

/** Escapes a value for a double-quoted VDF string. */
function vdfString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** What `renderAppBuildVdf` needs to write an app build script. */
export interface AppBuildScript {
  /** The AppID. */
  appId: number;
  /** Build description shown in Steamworks. */
  description: string;
  /** Directory the depot file patterns are relative to. */
  contentRoot: string;
  /** Directory steamcmd writes logs and its chunk cache to. */
  buildOutput: string;
  /** Depot id to mapping. */
  depots: Record<string, DepotMapping>;
  /** Branch to set live after the upload, if any. */
  setLive?: string;
  /** Whether to build without uploading. */
  preview: boolean;
}

/** Renders a steamcmd app build script (the `AppBuild` VDF) from its parts. */
export function renderAppBuildVdf(script: AppBuildScript): string {
  const lines: string[] = [
    '"AppBuild"',
    "{",
    `\t"AppID" ${vdfString(String(script.appId))}`,
    `\t"Desc" ${vdfString(script.description)}`,
    `\t"ContentRoot" ${vdfString(script.contentRoot)}`,
    `\t"BuildOutput" ${vdfString(script.buildOutput)}`,
    `\t"Preview" ${vdfString(script.preview ? "1" : "0")}`,
  ];
  if (script.setLive !== undefined) {
    lines.push(`\t"SetLive" ${vdfString(script.setLive)}`);
  }
  lines.push('\t"Depots"', "\t{");
  for (const depotId of Object.keys(script.depots).sort()) {
    const mapping = script.depots[depotId];
    if (mapping === undefined) {
      continue;
    }
    lines.push(
      `\t\t${vdfString(depotId)}`,
      "\t\t{",
      '\t\t\t"FileMapping"',
      "\t\t\t{",
      `\t\t\t\t"LocalPath" ${vdfString(mapping.localPath)}`,
      `\t\t\t\t"DepotPath" ${vdfString(mapping.depotPath)}`,
      `\t\t\t\t"Recursive" ${vdfString(mapping.recursive ? "1" : "0")}`,
      "\t\t\t}",
    );
    for (const exclusion of mapping.exclusions) {
      lines.push(`\t\t\t"FileExclusion" ${vdfString(exclusion)}`);
    }
    lines.push("\t\t}");
  }
  lines.push("\t}", "}", "");
  return lines.join("\n");
}

/** What `parseSteamcmdOutput` found in a steamcmd run's output. */
export interface SteamcmdReport {
  /** The BuildID from the "Successfully finished AppID ... build (BuildID n)" line. */
  buildId?: number;
  /** True when a "Logging in user ... OK" line was printed. */
  loginSucceeded: boolean;
  /** The first line that names a Steam Guard code, prompt or rejection. */
  steamGuardLine?: string;
  /** The first line that reports a login failure for another reason. */
  loginFailureLine?: string;
  /** Lines that name a depot, with the depot id. */
  depots: Array<{ depotId: string; line: string }>;
  /** How many non-empty lines the output had, so a reader knows what the excerpt left out. */
  lineCount: number;
  /** The lines that matter: every matched line plus the tail, in order, capped. */
  excerpt: string[];
}

/** Reads steamcmd's output for the build id, the login outcome, depot lines and a bounded excerpt. */
export function parseSteamcmdOutput(output: string): SteamcmdReport {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  const report: SteamcmdReport = {
    loginSucceeded: false,
    depots: [],
    lineCount: lines.length,
    excerpt: [],
  };
  const keep = new Set<number>();
  lines.forEach((line, index) => {
    const buildId = /\(BuildID (\d+)\)/.exec(line);
    if (buildId?.[1] !== undefined) {
      report.buildId = Number(buildId[1]);
    }
    if (/logging in user .*\bOK\b/i.test(line)) {
      report.loginSucceeded = true;
    }
    if (
      report.steamGuardLine === undefined &&
      STEAM_GUARD_PATTERNS.some((pattern) => pattern.test(line))
    ) {
      report.steamGuardLine = line;
    } else if (
      report.loginFailureLine === undefined &&
      LOGIN_FAILURE_PATTERNS.some((pattern) => pattern.test(line))
    ) {
      report.loginFailureLine = line;
    }
    const depot = /\bdepot\D{0,20}(\d{3,})/i.exec(line);
    if (depot?.[1] !== undefined) {
      report.depots.push({ depotId: depot[1], line });
    }
    if (INTERESTING_LINE.test(line) || index >= lines.length - EXCERPT_TAIL) {
      keep.add(index);
    }
  });
  const kept = [...keep].sort((a, b) => a - b);
  const start = Math.max(0, kept.length - EXCERPT_MAX);
  report.excerpt = kept.slice(start).map((index) => lines[index] ?? "");
  return report;
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
  /** Repository root, used for the default build output directory. */
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
}

/** The context fields the pre-flight checks read. */
export interface CheckContext {
  /** Validated global arguments of the behavior instance. */
  globalArgs: GlobalArgs;
}

/** A pre-flight check's verdict. */
export interface CheckResult {
  /** True when the check passed. */
  pass: boolean;
  /** Reasons when it did not. */
  errors?: string[];
}

/** Injectable dependencies, set by tests and otherwise defaulted to the Deno runtime. */
export interface Injected {
  /** Replaces `denoRunner`. */
  _runner?: Runner;
  /** Replaces `denoFiles`. */
  _files?: Files;
  /** Replaces the global `fetch`. */
  _fetch?: Fetcher;
}

/** True for an absolute POSIX or Windows path. */
function isAbsolute(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

/** Resolves a path against the repository root unless it is absolute. */
function resolveFrom(repoDir: string, path: string): string {
  return isAbsolute(path) ? path : `${repoDir.replace(/[\\/]+$/, "")}/${path}`;
}

/** Fills in the defaults of a depot mapping given as a bare pattern or a partial object. */
function normaliseDepots(
  depots: Record<string, string | DepotMapping>,
): Record<string, DepotMapping> {
  const result: Record<string, DepotMapping> = {};
  for (const [depotId, mapping] of Object.entries(depots)) {
    result[depotId] = typeof mapping === "string"
      ? DepotMappingSchema.parse({ localPath: mapping })
      : mapping;
  }
  return result;
}

/** A Steamworks Web API `response` object. */
type ApiResponse = Record<string, unknown>;

/** Calls a Steamworks Web API method and returns its `response` object, or throws a redacted, specific error. */
async function callWebApi(
  fetcher: Fetcher,
  method: "GET" | "POST",
  path: string,
  key: string,
  params: Record<string, string>,
): Promise<ApiResponse> {
  const url = new URL(`${PARTNER_API}/${path}`);
  let init: RequestInit;
  if (method === "GET") {
    url.searchParams.set("key", key);
    for (const [name, value] of Object.entries(params)) {
      url.searchParams.set(name, value);
    }
    init = { method };
  } else {
    const body = new URLSearchParams({ key, ...params });
    init = {
      method,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    };
  }
  let response: Response;
  try {
    response = await fetcher(url.toString(), init);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${path}: request failed: ${redactKeyParameter(redact(detail, [key]))}`,
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(
      `${path}: Steamworks rejected the Web API key (HTTP ${response.status}). ` +
        "webApiKey must be a publisher Web API key of the Steamworks group that owns the app, not a user key",
    );
  }
  if (response.status === 429) {
    const retryAfter = response.headers.get("retry-after");
    throw new Error(
      `${path}: Steamworks rate limited the request (HTTP 429)` +
        (retryAfter ? `, retry after ${retryAfter} seconds` : ""),
    );
  }
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `${path}: HTTP ${response.status}: ${
        redactKeyParameter(
          redact(text.slice(0, 300), [key]),
        )
      }`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `${path}: Steamworks returned a body that is not JSON: ${
        redact(
          text.slice(0, 120),
          [key],
        )
      }`,
    );
  }
  const wrapper = parsed as { response?: ApiResponse } | null;
  if (
    wrapper === null ||
    typeof wrapper !== "object" ||
    typeof wrapper.response !== "object" ||
    wrapper.response === null
  ) {
    throw new Error(`${path}: Steamworks returned no response object`);
  }
  const result = wrapper.response.result;
  if (result !== undefined && Number(result) !== 1) {
    const message = typeof wrapper.response.message === "string"
      ? wrapper.response.message
      : "";
    throw new Error(
      `${path}: Steamworks reported result ${String(result)}${
        message ? `: ${message}` : ""
      }`,
    );
  }
  return wrapper.response;
}

/** Reads a number the Web API may send as a number or a numeric string. */
function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

/** Reads a flag the Web API may send as a boolean, a number or a string. */
function asBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

/** Turns the Web API's `betas` map into branch records, sorted by name. */
function parseBetas(response: ApiResponse): Branch[] {
  const betas = response.betas;
  if (
    betas === undefined ||
    betas === null ||
    typeof betas !== "object" ||
    Array.isArray(betas)
  ) {
    return [];
  }
  const branches: Branch[] = [];
  for (
    const [name, entry] of Object.entries(
      betas as Record<string, unknown>,
    )
  ) {
    if (entry === null || typeof entry !== "object") {
      continue;
    }
    const record = entry as Record<string, unknown>;
    branches.push({
      name,
      buildId: asNumber(record.BuildID) ?? 0,
      description: typeof record.Description === "string"
        ? record.Description
        : "",
      requiresPassword: asBoolean(record.ReqPassword),
      requiresLocalContentServer: asBoolean(record.ReqLocalCS),
    });
  }
  return branches.sort((a, b) => a.name.localeCompare(b.name));
}

/** Reads the app's branches from GetAppBetas. */
async function fetchBetas(
  fetcher: Fetcher,
  key: string,
  appId: number,
): Promise<Branch[]> {
  const response = await callWebApi(
    fetcher,
    "GET",
    "ISteamApps/GetAppBetas/v1/",
    key,
    {
      appid: String(appId),
    },
  );
  return parseBetas(response);
}

/** The Web API key, or a clear error naming the method that needs it. */
function requireWebApiKey(globalArgs: GlobalArgs, method: string): string {
  if (globalArgs.webApiKey === undefined) {
    throw new Error(
      `${method} needs the webApiKey global argument (a publisher Web API key); it is not set`,
    );
  }
  return globalArgs.webApiKey;
}

/** The Steam publishing behavior. */
export const behavior = {
  type: "@reset/steam",
  version: "2026.10.24.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    upload: {
      description:
        "One steamcmd upload: the BuildID it produced, the depot lines and a bounded log excerpt",
      schema: UploadResourceSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
    builds: {
      description:
        "The app's newest builds from GetAppBuilds, with the branches each is live on",
      schema: BuildsResourceSchema,
      lifetime: "30d",
      garbageCollection: 10,
    },
    release: {
      description:
        "One SetAppBuildLive change: which build went live on which branch, and Steam's answer",
      schema: ReleaseResourceSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
    betas: {
      description:
        "The app's branches from GetAppBetas and the build live on each",
      schema: BetasResourceSchema,
      lifetime: "30d",
      garbageCollection: 10,
    },
  },
  methods: {
    upload: {
      description:
        "Build and upload an app build with steamcmd from a generated or supplied app build script, and record the BuildID",
      arguments: UploadArgsSchema,
      execute: async (
        args: UploadArgs & Injected,
        context: MethodContext,
      ): Promise<MethodResult> => {
        const { globalArgs, logger } = context;
        const runner = args._runner ?? denoRunner;
        const files = args._files ?? denoFiles;
        const secrets = [globalArgs.password, args.steamGuardCode];
        let vdfPath: string;
        let tempDir: string | undefined;
        if (args.vdf !== undefined) {
          vdfPath = resolveFrom(context.repoDir, args.vdf);
        } else {
          if (
            args.depots === undefined ||
            Object.keys(args.depots).length === 0
          ) {
            throw new Error(
              "upload needs either vdf (an existing app build script) or depots (to generate one)",
            );
          }
          if (globalArgs.contentRoot === undefined) {
            throw new Error(
              "upload with depots needs the contentRoot global argument: the directory the depot patterns are relative to",
            );
          }
          const buildOutput = resolveFrom(
            context.repoDir,
            args.buildOutput ?? `.swamp/steam/build-output/${globalArgs.appId}`,
          );
          await files.mkdir(buildOutput);
          tempDir = await files.makeTempDir();
          vdfPath = `${tempDir}/app_build_${globalArgs.appId}.vdf`;
          const script: AppBuildScript = {
            appId: globalArgs.appId,
            description: args.description ??
              `swamp upload ${new Date().toISOString()}`,
            contentRoot: resolveFrom(context.repoDir, globalArgs.contentRoot),
            buildOutput,
            depots: normaliseDepots(args.depots),
            preview: args.preview,
          };
          if (args.setLive !== undefined) {
            script.setLive = args.setLive;
          }
          await files.writeTextFile(vdfPath, renderAppBuildVdf(script));
        }
        const commandArgs: string[] = [];
        if (args.steamGuardCode !== undefined) {
          commandArgs.push("+set_steam_guard_code", args.steamGuardCode);
        }
        commandArgs.push("+login", globalArgs.username);
        if (globalArgs.password !== undefined) {
          commandArgs.push(globalArgs.password);
        }
        commandArgs.push("+run_app_build", vdfPath, "+quit");
        logger.info(
          "Uploading app {appId} with {steamcmd} from {vdf} as {username}",
          {
            appId: globalArgs.appId,
            steamcmd: globalArgs.steamcmd,
            vdf: vdfPath,
            username: globalArgs.username,
            cachedLogin: globalArgs.password === undefined,
            steamGuardCode: args.steamGuardCode !== undefined,
          },
        );
        const startedAt = new Date().toISOString();
        let run: RunResult;
        try {
          run = await runner({
            command: globalArgs.steamcmd,
            args: commandArgs,
            timeoutMs: args.timeoutSeconds * 1000,
            signal: context.signal,
          });
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) {
            throw new Error(
              `steamcmd was not found as "${globalArgs.steamcmd}": install it or set the steamcmd global argument to its path`,
            );
          }
          throw error;
        } finally {
          if (tempDir !== undefined) {
            await files.remove(tempDir);
          }
        }
        const finishedAt = new Date().toISOString();
        const report = parseSteamcmdOutput(redact(run.output, secrets));
        const excerpt = report.excerpt.join("\n");
        if (report.steamGuardLine !== undefined) {
          throw new Error(
            `Steam Guard: steamcmd could not log in as ${globalArgs.username} ("${report.steamGuardLine}"). ` +
              "This machine has no cached login for the account, or the code was rejected. " +
              "Log in once interactively with steamcmd and supply the code, or pass steamGuardCode for this run. " +
              `Output:\n${excerpt}`,
          );
        }
        if (run.timedOut) {
          throw new Error(
            `steamcmd did not finish within ${args.timeoutSeconds} seconds and was killed. ` +
              "If the output stops after the login line, steamcmd was waiting for a Steam Guard code or a password " +
              "on closed standard input: see the README section on Steam Guard. " +
              `Output:\n${excerpt}`,
          );
        }
        if (report.loginFailureLine !== undefined) {
          throw new Error(
            `steamcmd login as ${globalArgs.username} failed ("${report.loginFailureLine}"). Output:\n${excerpt}`,
          );
        }
        if (run.code !== 0 || report.buildId === undefined) {
          throw new Error(
            `steamcmd exited with code ${String(run.code)} and reported ${
              report.buildId === undefined
                ? "no BuildID"
                : `BuildID ${report.buildId}`
            }. Output:\n${excerpt}`,
          );
        }
        logger.info(
          "Uploaded app {appId} as BuildID {buildId} in {seconds} seconds",
          {
            appId: globalArgs.appId,
            buildId: report.buildId,
            seconds: Math.round(
              (Date.parse(finishedAt) - Date.parse(startedAt)) / 1000,
            ),
          },
        );
        const data: z.infer<typeof UploadResourceSchema> = {
          appId: globalArgs.appId,
          buildId: report.buildId,
          vdf: vdfPath,
          startedAt,
          finishedAt,
          exitCode: run.code,
          depots: report.depots,
          logLines: report.lineCount,
          logExcerpt: report.excerpt,
        };
        if (args.vdf === undefined) {
          data.description = args.description ?? `swamp upload ${startedAt}`;
          if (args.setLive !== undefined) {
            data.branch = args.setLive;
          }
        }
        const handle = await context.writeResource("upload", "upload", data);
        return { dataHandles: [handle] };
      },
    },
    builds: {
      description:
        "Read the app's newest builds from the Steamworks Web API, with the branch each is live on",
      arguments: BuildsArgsSchema,
      execute: async (
        args: BuildsArgs & Injected,
        context: MethodContext,
      ): Promise<MethodResult> => {
        const { globalArgs, logger } = context;
        const fetcher = args._fetch ?? globalThis.fetch;
        const key = requireWebApiKey(globalArgs, "builds");
        logger.info("Reading the newest {count} builds of app {appId}", {
          count: args.count,
          appId: globalArgs.appId,
        });
        const response = await callWebApi(
          fetcher,
          "GET",
          "ISteamApps/GetAppBuilds/v1/",
          key,
          {
            appid: String(globalArgs.appId),
            count: String(args.count),
          },
        );
        const branches = await fetchBetas(fetcher, key, globalArgs.appId);
        const rawBuilds = response.builds;
        const builds: z.infer<typeof BuildRecordSchema>[] = [];
        if (
          rawBuilds !== undefined &&
          rawBuilds !== null &&
          typeof rawBuilds === "object"
        ) {
          const entries = Array.isArray(rawBuilds)
            ? (rawBuilds as unknown[])
            : Object.values(rawBuilds as Record<string, unknown>);
          for (const entry of entries) {
            if (entry === null || typeof entry !== "object") {
              continue;
            }
            const raw = entry as Record<string, unknown>;
            const buildId = asNumber(raw.BuildID);
            if (buildId === undefined) {
              logger.warning(
                "Skipping a build without a BuildID in GetAppBuilds",
              );
              continue;
            }
            const created = asNumber(raw.CreationTime);
            builds.push({
              buildId,
              description: typeof raw.Description === "string"
                ? raw.Description
                : "",
              createdAt: created === undefined
                ? ""
                : new Date(created * 1000).toISOString(),
              creatorAccountId: asNumber(raw.AccountIDCreator) ?? 0,
              liveOn: branches
                .filter((branch) => branch.buildId === buildId)
                .map((branch) => branch.name),
              raw,
            });
          }
        }
        builds.sort((a, b) => b.buildId - a.buildId);
        logger.info(
          "Read {builds} builds of app {appId}, {live} of them live on a branch",
          {
            builds: builds.length,
            appId: globalArgs.appId,
            live: builds.filter((build) => build.liveOn.length > 0).length,
          },
        );
        const data: z.infer<typeof BuildsResourceSchema> = {
          appId: globalArgs.appId,
          fetchedAt: new Date().toISOString(),
          count: args.count,
          truncated: builds.length >= args.count,
          buildIds: builds.map((build) => build.buildId),
          builds,
        };
        const handle = await context.writeResource("builds", "builds", data);
        return { dataHandles: [handle] };
      },
    },
    setLive: {
      description:
        "Set a build live on a branch through SetAppBuildLive, unless it already is",
      arguments: SetLiveArgsSchema,
      execute: async (
        args: SetLiveArgs & Injected,
        context: MethodContext,
      ): Promise<MethodResult> => {
        const { globalArgs, logger } = context;
        const fetcher = args._fetch ?? globalThis.fetch;
        const key = requireWebApiKey(globalArgs, "setLive");
        logger.info(
          "Setting BuildID {buildId} live on branch {branch} of app {appId}",
          {
            buildId: args.buildId,
            branch: args.branch,
            appId: globalArgs.appId,
          },
        );
        const branches = await fetchBetas(fetcher, key, globalArgs.appId);
        const current = branches.find((branch) => branch.name === args.branch);
        const data: z.infer<typeof ReleaseResourceSchema> = {
          appId: globalArgs.appId,
          buildId: args.buildId,
          branch: args.branch,
          at: new Date().toISOString(),
          alreadyLive: false,
          response: null,
        };
        if (args.description !== undefined) {
          data.description = args.description;
        }
        if (current !== undefined && current.buildId === args.buildId) {
          logger.info(
            "BuildID {buildId} is already live on branch {branch} of app {appId}; not asking again",
            {
              buildId: args.buildId,
              branch: args.branch,
              appId: globalArgs.appId,
            },
          );
          data.alreadyLive = true;
          const handle = await context.writeResource(
            "release",
            "release",
            data,
          );
          return { dataHandles: [handle] };
        }
        const params: Record<string, string> = {
          appid: String(globalArgs.appId),
          buildid: String(args.buildId),
          betakey: args.branch,
        };
        if (args.description !== undefined) {
          params.description = args.description;
        }
        if (args.approverSteamId !== undefined) {
          params.steamid = args.approverSteamId;
        }
        const response = await callWebApi(
          fetcher,
          "POST",
          "ISteamApps/SetAppBuildLive/v2/",
          key,
          params,
        );
        data.at = new Date().toISOString();
        data.response = {
          result: asNumber(response.result) ?? 1,
          message: typeof response.message === "string" ? response.message : "",
        };
        logger.info(
          "BuildID {buildId} is live on branch {branch} of app {appId}",
          {
            buildId: args.buildId,
            branch: args.branch,
            appId: globalArgs.appId,
            previous: current?.buildId,
          },
        );
        const handle = await context.writeResource("release", "release", data);
        return { dataHandles: [handle] };
      },
    },
    betas: {
      description:
        "Read the app's branches and the build live on each from GetAppBetas",
      arguments: z.object({}),
      execute: async (
        args: Injected,
        context: MethodContext,
      ): Promise<MethodResult> => {
        const { globalArgs, logger } = context;
        const fetcher = args._fetch ?? globalThis.fetch;
        const key = requireWebApiKey(globalArgs, "betas");
        logger.info("Reading the branches of app {appId}", {
          appId: globalArgs.appId,
        });
        const branches = await fetchBetas(fetcher, key, globalArgs.appId);
        logger.info("Read {branches} branches of app {appId}", {
          branches: branches.length,
          appId: globalArgs.appId,
        });
        const data: z.infer<typeof BetasResourceSchema> = {
          appId: globalArgs.appId,
          fetchedAt: new Date().toISOString(),
          branches,
        };
        const handle = await context.writeResource("betas", "betas", data);
        return { dataHandles: [handle] };
      },
    },
  },
  checks: {
    "web-api-key-set": {
      description:
        "The webApiKey global argument is set for methods that call the Steamworks Web API",
      labels: ["policy"],
      appliesTo: ["builds", "betas", "setLive"],
      execute: (context: CheckContext): Promise<CheckResult> => {
        if (context.globalArgs.webApiKey === undefined) {
          return Promise.resolve({
            pass: false,
            errors: [
              "webApiKey is not set: add a publisher Web API key from the vault to the behavior instance",
            ],
          });
        }
        return Promise.resolve({ pass: true });
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
