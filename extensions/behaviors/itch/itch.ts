/**
 * Publish a game's builds to itch.io with butler, the command line tool
 * itch.io documents for uploads. `push` uploads a directory or zip to a
 * channel, `status` reads the channels of a project and the state of their
 * latest and pending builds (optionally waiting, within a deadline, until a
 * channel's build has finished processing), `latest` reads a channel's latest
 * user version from itch.io's public update check endpoint, and `version`
 * records which butler ran. Each method writes what it saw as a swamp
 * resource. The process runner, `fetch`, the clock and the sleep are
 * injectable, so the unit tests run without butler or the network.
 *
 * @module
 */

import { z } from "npm:zod@4";

/** itch.io's documented update check endpoint, which needs no credentials. */
const WHARF_LATEST = "https://api.itch.io/wharf/latest";

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
  target: z
    .string()
    .regex(PROJECT_PATTERN, "a target is user/game, as butler push names it")
    .meta({
      description:
        "The itch.io project as user/game, the part of a butler target before the channel",
    }),
  butler: z.string().min(1).default("butler").meta({
    description: "Path to butler, or its command name when it is on PATH",
  }),
  apiKey: z
    .string()
    .min(1)
    .meta({ sensitive: true })
    .describe(
      "itch.io API key, passed to butler as BUTLER_API_KEY. Omit when butler on this machine is logged in",
    )
    .optional(),
  identity: z
    .string()
    .min(1)
    .meta({
      description:
        "Credentials file butler reads instead of its default one (butler -i), for a second account",
    })
    .optional(),
});

/** Global arguments of a behavior instance, as validated by swamp. */
export interface GlobalArgs {
  /** The itch.io project as `user/game`. */
  target: string;
  /** Path to butler, or its command name when it is on PATH. */
  butler: string;
  /** itch.io API key passed as BUTLER_API_KEY, absent when butler is logged in. */
  apiKey?: string;
  /** Credentials file passed as butler -i. */
  identity?: string;
}

const _GlobalArgsMatch: Same<
  z.infer<typeof GlobalArgsSchema>,
  GlobalArgs
> = true;

const PushArgsSchema = z.object({
  directory: z.string().min(1).meta({
    description:
      "Build directory or .zip to upload, relative to the repository root or absolute",
  }),
  channel: z
    .string()
    .regex(CHANNEL_PATTERN, "a channel name has no colon, slash or space")
    .meta({
      description:
        "Channel to push to, such as windows-beta or linux-stable; itch.io tags the platform from its name",
    }),
  userVersion: z
    .string()
    .meta({
      description:
        "Your own version number for this build (butler --userversion). Empty records none",
    })
    .optional(),
  userVersionFile: z
    .string()
    .min(1)
    .meta({
      description:
        "File holding the version number, relative to the repository root or absolute (butler --userversion-file)",
    })
    .optional(),
  ifChanged: z.boolean().default(false).meta({
    description:
      "Push nothing when the contents equal the channel's latest build (butler --if-changed)",
  }),
  dryRun: z.boolean().default(false).meta({
    description:
      "List what would be pushed and upload nothing (butler --dry-run)",
  }),
  hidden: z.boolean().default(false).meta({
    description:
      "Mark a new channel's upload hidden. butler refuses it on an existing channel (butler --hidden)",
  }),
  fixPermissions: z.boolean().default(false).meta({
    description:
      "Mark Mac and Linux executables executable before pushing (butler --fix-permissions)",
  }),
  ignore: z.array(z.string().min(1)).default([]).meta({
    description:
      "Glob patterns of files to leave out, each passed as butler --ignore",
  }),
  timeoutSeconds: z.number().int().positive().default(3600).meta({
    description:
      "Kill butler and fail when it has not exited after this many seconds",
  }),
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
  channel: z
    .string()
    .regex(CHANNEL_PATTERN, "a channel name has no colon, slash or space")
    .meta({
      description:
        "Read only this channel. Unset reads every channel of the project",
    })
    .optional(),
  waitSeconds: z.number().int().min(0).max(86400).default(0).meta({
    description:
      "Read again until the channel's build is ready or failed, for at most this many seconds. 0 reads once",
  }),
  intervalSeconds: z.number().int().min(5).max(600).default(15).meta({
    description: "Seconds between reads while waiting",
  }),
  timeoutSeconds: z.number().int().positive().default(120).meta({
    description:
      "Kill one butler status call and fail when it has not exited after this many seconds",
  }),
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
  channel: z
    .string()
    .regex(CHANNEL_PATTERN, "a channel name has no colon, slash or space")
    .meta({ description: "Channel whose latest user version to read" }),
});

/** Arguments of `latest`. */
export interface LatestArgs {
  /** Channel whose latest user version to read. */
  channel: string;
}

const _LatestArgsMatch: Same<
  z.infer<typeof LatestArgsSchema>,
  LatestArgs
> = true;

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
  /** When itch.io created the build. */
  createdAt?: string;
  /** When itch.io last changed the build. */
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
  startedAt: z.string(),
  finishedAt: z.string(),
  exitCode: z.number().int(),
  logLines: z.number().int(),
  logExcerpt: z.array(z.string()),
});

const StatusResourceSchema = z.object({
  target: z.string(),
  channel: z.string().optional(),
  fetchedAt: z.string(),
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
  fetchedAt: z.string(),
  latest: z.string().optional(),
});

const VersionResourceSchema = z.object({
  version: z.string(),
  commit: z.string().optional(),
  builtAt: z.string().optional(),
  versionString: z.string(),
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

/** The subset of `fetch` the `latest` method uses. Tests replace it. */
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
  channel: string | undefined,
  timeoutSeconds: number,
  signal?: AbortSignal,
): Promise<Channel[]> {
  const target = channel === undefined
    ? globalArgs.target
    : `${globalArgs.target}:${channel}`;
  const run = await runButler(
    runner,
    globalArgs,
    ["status", target],
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

/** The itch.io publishing behavior. */
export const behavior = {
  type: "@reset/itch",
  version: "2026.10.21.1",
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
        "A channel's latest user version from itch.io's public update check endpoint",
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
        const target = `${globalArgs.target}:${args.channel}`;
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
          target: globalArgs.target,
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
        const runner = args._runner ?? denoRunner;
        const sleep = args._sleep ?? defaultSleep;
        const now = args._now ?? Date.now;
        const startedAt = now();
        const deadline = startedAt + args.waitSeconds * 1000;
        let reads = 0;
        let channels: Channel[];
        let timedOut = false;
        logger.info("Reading the channels of {target}{named}", {
          target: globalArgs.target,
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
            target: globalArgs.target,
            reads,
          });
          await sleep(args.intervalSeconds * 1000, context.signal);
        }
        const found = channels.length > 0;
        const data: z.infer<typeof StatusResourceSchema> = {
          target: globalArgs.target,
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
              target: globalArgs.target,
              named: args.channel === undefined ? "" : ` named ${args.channel}`,
            },
          );
        } else {
          logger.info(
            "{target}: {count} channels, ready {ready}, failed {failed}",
            {
              target: globalArgs.target,
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
        "Read a channel's latest user version from itch.io's public update check endpoint, which needs no credentials",
      arguments: LatestArgsSchema,
      execute: async (
        args: LatestArgs & Injected,
        context: MethodContext,
      ): Promise<MethodResult> => {
        const { globalArgs, logger } = context;
        const fetcher = args._fetch ?? globalThis.fetch;
        const url = `${WHARF_LATEST}?target=${
          encodeURIComponent(globalArgs.target)
        }&channel_name=${encodeURIComponent(args.channel)}`;
        logger.info("Reading the latest user version of {target}:{channel}", {
          target: globalArgs.target,
          channel: args.channel,
        });
        const response = await fetcher(url, { signal: context.signal });
        const text = await response.text();
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          body = undefined;
        }
        const value = typeof body === "object" && body !== null
          ? body as Record<string, unknown>
          : {};
        const errors = Array.isArray(value.errors)
          ? value.errors.map(String)
          : [];
        if (!response.ok || errors.length > 0) {
          throw new Error(
            `itch.io update check for ${globalArgs.target}:${args.channel} failed with HTTP ${response.status}${
              errors.length > 0 ? `: ${errors.join("; ")}` : ""
            }. ${
              response.status === 429 || response.status >= 500
                ? "itch.io is limiting or unavailable: retry later"
                : 'A private game answers "invalid game"'
            }`,
          );
        }
        const data: z.infer<typeof LatestResourceSchema> = {
          target: globalArgs.target,
          channel: args.channel,
          fetchedAt: new Date().toISOString(),
        };
        const latest = value.latest;
        if (typeof latest === "string" || typeof latest === "number") {
          data.latest = String(latest);
        }
        logger.info("{target}:{channel} latest user version {latest}", {
          target: globalArgs.target,
          channel: args.channel,
          latest: data.latest ?? "(none)",
        });
        const handle = await context.writeResource("latest", "latest", data);
        return { dataHandles: [handle] };
      },
    },
    version: {
      description: "Record which butler this machine runs (butler version)",
      arguments: z.object({}),
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
        const output = parseButlerOutput(run.stdout, run.stderr);
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
  },
};
