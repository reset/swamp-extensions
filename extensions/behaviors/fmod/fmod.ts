/**
 * Drive FMOD Studio from swamp through its command line tool. `build` runs
 * `fmodstudiocl -build` for named banks and platforms, `inspect` runs a
 * script through `-script` that lists the project's platforms, banks and
 * events with the scripting API, and `diagnostic` runs `-diagnostic`, the
 * tool's own project validation. Each method records what the tool reported
 * as a swamp resource. The process runner and the file helpers are
 * injectable, so the unit tests run without FMOD Studio.
 *
 * @module
 */

import { z } from "npm:zod@4";

/** Environment variable the macOS launcher sets so the app runs in command-line mode. */
const COMMAND_LINE_ENV = "FMODSTUDIOCMDLINE=1";

/** How many trailing output lines a record keeps besides the matched ones. */
const EXCERPT_TAIL = 20;

/** Hard cap on the lines a record keeps. */
const EXCERPT_MAX = 120;

/** Hard cap on the events the `events` record lists; the record says when it was cut. */
export const EVENT_MAX = 2000;

/** Output lines that only report progress and are left out of the excerpt. */
const PROGRESS_LINE = /^(Build Status|Validation Status): /;

/** The lines that frame the JSON the inspect script prints. */
const INSPECT_BEGIN = "SWAMP_FMOD_INSPECT_BEGIN";
const INSPECT_END = "SWAMP_FMOD_INSPECT_END";

/** Prefix FMOD Studio puts before every line a script logs. */
const SCRIPTING_PREFIX = /^\[Scripting\] /;

/**
 * The script `inspect` runs inside FMOD Studio. It uses only the documented
 * scripting API: `studio.version`, `studio.project.filePath`,
 * `studio.project.workspace` and its relationships, `Entity.findInstances`,
 * `ManagedObject.%property_name%` and `%relationship_name%`, `Bank.getPath`
 * and `Event.getPath`. `Event.findInstances()` without `includeDerivedTypes`
 * leaves snapshots out. The engine is ES5, so no arrow functions or `let`.
 */
export const INSPECT_SCRIPT: string = [
  "(function () {",
  "  function names(objects) {",
  "    var result = [];",
  "    for (var i = 0; i < objects.length; i++) { result.push(objects[i].name); }",
  "    return result.sort();",
  "  }",
  "  function byPath(a, b) { return a.path < b.path ? -1 : a.path > b.path ? 1 : 0; }",
  "  var workspace = studio.project.workspace;",
  "  var platforms = [];",
  "  var platformObjects = workspace.platforms;",
  "  for (var i = 0; i < platformObjects.length; i++) {",
  "    var platform = platformObjects[i];",
  "    platforms.push({",
  "      id: platform.id,",
  "      name: platform.name,",
  "      subDirectory: platform.subDirectory,",
  "      buildMetadataOnly: platform.buildMetadataOnly === true",
  "    });",
  "  }",
  "  var banks = [];",
  "  var bankObjects = studio.project.model.Bank.findInstances();",
  "  for (var j = 0; j < bankObjects.length; j++) {",
  "    var bank = bankObjects[j];",
  "    banks.push({",
  "      id: bank.id,",
  "      name: bank.name,",
  "      path: bank.getPath(),",
  "      isMasterBank: bank.isMasterBank === true,",
  "      events: names(bank.events)",
  "    });",
  "  }",
  "  banks.sort(byPath);",
  "  var events = [];",
  "  var eventObjects = studio.project.model.Event.findInstances();",
  "  for (var k = 0; k < eventObjects.length; k++) {",
  "    var event = eventObjects[k];",
  "    events.push({",
  "      id: event.id,",
  "      name: event.name,",
  "      path: event.getPath(),",
  "      banks: names(event.banks)",
  "    });",
  "  }",
  "  events.sort(byPath);",
  `  var eventMax = ${EVENT_MAX};`,
  "  var report = {",
  "    version: {",
  "      productVersion: studio.version.productVersion,",
  "      majorVersion: studio.version.majorVersion,",
  "      minorVersion: studio.version.minorVersion,",
  "      text: studio.version.toString()",
  "    },",
  "    filePath: studio.project.filePath,",
  "    builtBanksOutputDirectory: workspace.builtBanksOutputDirectory,",
  "    platforms: platforms,",
  "    banks: banks,",
  "    eventCount: events.length,",
  "    events: events.slice(0, eventMax)",
  "  };",
  `  console.log("${INSPECT_BEGIN}");`,
  "  console.log(JSON.stringify(report));",
  `  console.log("${INSPECT_END}");`,
  "})();",
  "",
].join("\n");

/** `true` only when the zod output type and the hand-written interface describe the same shape. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

/** A bank or platform name as the command line takes it: the lists are comma-separated, so a comma cannot be in a name. */
const NameSchema = z.string().min(1).regex(
  /^[^,]+$/,
  "a bank or platform name cannot contain a comma",
);

const GlobalArgsSchema = z.object({
  project: z.string().min(1).regex(
    /\.fspro$/i,
    "an FMOD Studio project is a .fspro file",
  ).meta({
    description:
      "Path of the FMOD Studio project (.fspro), absolute or relative to the repository",
  }),
  fmodstudio: z.string().min(1).default("fmodstudiocl").meta({
    description:
      "The command line tool: its command name when it is on PATH, a path to it, or on macOS the path of the FMOD Studio app bundle (see the README)",
  }),
  timeoutSeconds: z.number().int().positive().default(1800).meta({
    description:
      "Kill FMOD Studio and fail when it has not exited after this many seconds",
  }),
});

/** Global arguments of a behavior instance, as validated by swamp. */
export interface GlobalArgs {
  /** Path of the .fspro project, absolute or relative to the repository. */
  project: string;
  /** The command line tool, or on macOS the app bundle. */
  fmodstudio: string;
  /** Seconds after which FMOD Studio is killed. */
  timeoutSeconds: number;
}

const _GlobalArgsMatch: Same<z.infer<typeof GlobalArgsSchema>, GlobalArgs> =
  true;

const BuildArgsSchema = z.object({
  banks: z.array(NameSchema).default([]).meta({
    description:
      "Banks to build, by name as the banks browser shows them. Empty builds every bank",
  }),
  platforms: z.array(NameSchema).default([]).meta({
    description:
      "Platforms to build for, by the names in the project's build preferences. Empty builds every platform",
  }),
  ignoreWarnings: z.boolean().default(false).meta({
    description:
      "Continue the build when FMOD Studio reports warnings (-ignore-warnings)",
  }),
  exportGuids: z.boolean().default(false).meta({
    description:
      "Export event and mixer GUIDs to text files beside the project (-export-guids)",
  }),
  sharedAudioSourceDir: z
    .string()
    .min(1)
    .meta({
      description:
        "Directory that replaces the project's assets folder for this build (-shared-audio-source-dir), absolute or relative to the repository",
    })
    .optional(),
  logDir: z
    .string()
    .min(1)
    .meta({
      description:
        "Directory FMOD Studio writes its own log file to (-log-dir), absolute or relative to the repository",
    })
    .optional(),
});

/** Arguments of the `build` method. */
export interface BuildArgs {
  /** Banks to build; empty means every bank. */
  banks: string[];
  /** Platforms to build for; empty means every platform. */
  platforms: string[];
  /** Continue when FMOD Studio reports warnings. */
  ignoreWarnings: boolean;
  /** Export event and mixer GUIDs to text files. */
  exportGuids: boolean;
  /** Directory that replaces the project's assets folder. */
  sharedAudioSourceDir?: string;
  /** Directory FMOD Studio writes its log file to. */
  logDir?: string;
}

const _BuildArgsMatch: Same<z.infer<typeof BuildArgsSchema>, BuildArgs> = true;

const BankBuildSchema = z.object({
  bank: z.string(),
  platform: z.string(),
});

const BuildResourceSchema = z.object({
  project: z.string(),
  banks: z.array(z.string()),
  platforms: z.array(z.string()),
  startedAt: z.string(),
  finishedAt: z.string(),
  exitCode: z.number().int().nullable(),
  platformsBuilt: z.array(z.string()),
  bankBuilds: z.array(BankBuildSchema),
  warnings: z.array(z.string()),
  logLines: z.number().int(),
  logExcerpt: z.array(z.string()),
  stderrLines: z.number().int(),
});

const PlatformSchema = z.object({
  id: z.string(),
  name: z.string(),
  subDirectory: z.string(),
  buildMetadataOnly: z.boolean(),
});

const BankSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  isMasterBank: z.boolean(),
  events: z.array(z.string()),
});

const EventSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  banks: z.array(z.string()),
});

const VersionSchema = z.object({
  productVersion: z.number().int(),
  majorVersion: z.number().int(),
  minorVersion: z.number().int(),
  text: z.string(),
});

/** What the inspect script prints, validated before anything is written. */
const InspectOutputSchema = z.object({
  version: VersionSchema,
  filePath: z.string(),
  builtBanksOutputDirectory: z.string(),
  platforms: z.array(PlatformSchema),
  banks: z.array(BankSchema),
  eventCount: z.number().int().nonnegative(),
  events: z.array(EventSchema),
});

/** A platform in the project's build preferences. */
export interface Platform {
  /** The platform's GUID. */
  id: string;
  /** Its name, as `-platforms` takes it. */
  name: string;
  /** The output sub-directory banks are built into. */
  subDirectory: string;
  /** True when the platform builds metadata only, skipping sample data. */
  buildMetadataOnly: boolean;
}

/** A bank with the events assigned to it. */
export interface Bank {
  /** The bank's GUID. */
  id: string;
  /** Its name, as `-banks` takes it. */
  name: string;
  /** Its `bank:/` path. */
  path: string;
  /** True for a master bank. */
  isMasterBank: boolean;
  /** Names of the events assigned to it, sorted. */
  events: string[];
}

/** An event with the banks it is assigned to. */
export interface Event {
  /** The event's GUID. */
  id: string;
  /** Its name. */
  name: string;
  /** Its `event:/` path. */
  path: string;
  /** Names of the banks it is assigned to, sorted; empty when unassigned. */
  banks: string[];
}

/** The FMOD Studio version as `studio.version` reports it. */
export interface Version {
  /** The product version, 2 for FMOD Studio 2.x. */
  productVersion: number;
  /** The major version. */
  majorVersion: number;
  /** The minor (patch) version. */
  minorVersion: number;
  /** The human-readable version line. */
  text: string;
}

/** The inspect script's report, as the `inspect` method validates it. */
export interface InspectOutput {
  /** The FMOD Studio version. */
  version: Version;
  /** The absolute path of the opened project. */
  filePath: string;
  /** The built banks output directory from the build preferences, empty for the default. */
  builtBanksOutputDirectory: string;
  /** The project's platforms. */
  platforms: Platform[];
  /** The project's banks, sorted by path. */
  banks: Bank[];
  /** How many events the project has. */
  eventCount: number;
  /** The first `EVENT_MAX` events, sorted by path. */
  events: Event[];
}

const _InspectOutputMatch: Same<
  z.infer<typeof InspectOutputSchema>,
  InspectOutput
> = true;

const ProjectResourceSchema = z.object({
  project: z.string(),
  inspectedAt: z.string(),
  version: VersionSchema,
  builtBanksOutputDirectory: z.string(),
  platforms: z.array(PlatformSchema),
  platformNames: z.array(z.string()),
});

const BanksResourceSchema = z.object({
  project: z.string(),
  inspectedAt: z.string(),
  names: z.array(z.string()),
  banks: z.array(BankSchema),
});

const EventsResourceSchema = z.object({
  project: z.string(),
  inspectedAt: z.string(),
  count: z.number().int(),
  truncated: z.boolean(),
  paths: z.array(z.string()),
  events: z.array(EventSchema),
});

const DiagnosticResourceSchema = z.object({
  project: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  exitCode: z.number().int().nullable(),
  checks: z.number().int(),
  logLines: z.number().int(),
  logExcerpt: z.array(z.string()),
});

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
  /** Standard output. */
  stdout: string;
  /** Standard error. */
  stderr: string;
  /** True when the program was killed for exceeding the timeout. */
  timedOut: boolean;
}

/** Runs a program with closed standard input. Tests replace it, swamp uses `denoRunner`. */
export type Runner = (request: RunRequest) => Promise<RunResult>;

/** The file operations the methods need for the inspect script and the macOS output capture. */
export interface Files {
  /** Creates a fresh temporary directory and returns its path. */
  makeTempDir(): Promise<string>;
  /** Writes a text file, replacing it. */
  writeTextFile(path: string, text: string): Promise<void>;
  /** Reads a text file; rejects when it does not exist. */
  readTextFile(path: string): Promise<string>;
  /** Removes a file or directory tree. */
  remove(path: string): Promise<void>;
}

/** Runs a program with `Deno.Command`, standard input closed, killed on timeout or abort. */
export const denoRunner: Runner = async (
  request: RunRequest,
): Promise<RunResult> => {
  // swamp-quality-ignore deno-command: the command line tool is the only documented way to build banks and run a script, and its arguments are the validated global and method arguments
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
      stdout: decoder.decode(result.stdout),
      stderr: decoder.decode(result.stderr),
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
    Deno.makeTempDir({ prefix: "swamp-fmod-" }),
  writeTextFile: (path: string, text: string): Promise<void> =>
    Deno.writeTextFile(path, text),
  readTextFile: (path: string): Promise<string> => Deno.readTextFile(path),
  remove: (path: string): Promise<void> =>
    Deno.remove(path, { recursive: true }),
};

/** True for an absolute POSIX or Windows path. */
function isAbsolute(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

/** Resolves a path against the repository root unless it is absolute. */
export function resolveFrom(repoDir: string, path: string): string {
  return isAbsolute(path) ? path : `${repoDir.replace(/[\\/]+$/, "")}/${path}`;
}

/** True when `fmodstudio` names a macOS app bundle rather than an executable. */
export function isAppBundle(fmodstudio: string): boolean {
  return /\.app$/i.test(fmodstudio.replace(/[\\/]+$/, ""));
}

/** How to start FMOD Studio for one run. */
export interface Invocation {
  /** The program to run: the tool itself, or `open` for a macOS app bundle. */
  command: string;
  /** Its arguments. */
  args: string[];
  /** Where `open` writes the app's output, read after the run. Absent when the tool runs directly. */
  captures?: { stdout: string; stderr: string };
}

/**
 * Builds the invocation for a run. A command name or executable path is run as
 * it is with the tool's own arguments. A macOS app bundle is started through
 * `open -W` with its output sent to files, the command-line environment
 * variable set and `-working-dir` added, which is what the `fmodstudiocl`
 * launcher inside the bundle does; that launcher itself needs a terminal and
 * fails from a process without one.
 */
export function invocation(
  fmodstudio: string,
  workingDir: string,
  captureDir: string,
  toolArgs: string[],
): Invocation {
  if (!isAppBundle(fmodstudio)) {
    return { command: fmodstudio, args: toolArgs };
  }
  const captures = {
    stdout: `${captureDir}/stdout.txt`,
    stderr: `${captureDir}/stderr.txt`,
  };
  return {
    command: "open",
    args: [
      "-W",
      "-a",
      fmodstudio,
      "--stdout",
      captures.stdout,
      "--stderr",
      captures.stderr,
      "--env",
      COMMAND_LINE_ENV,
      "--args",
      "-working-dir",
      workingDir,
      ...toolArgs,
    ],
    captures,
  };
}

/** What `parseStudioOutput` found in a run's output. */
export interface StudioReport {
  /** True when "Successfully opened project." was printed. */
  projectOpened: boolean;
  /** The first line that reports the project could not be loaded. */
  loadError?: string;
  /** The first "Build Banks Error" line. */
  buildError?: string;
  /** The first line that reports a script error. */
  scriptError?: string;
  /** True when the macOS launcher failed for want of a terminal. */
  launcherNeedsTerminal: boolean;
  /** True when "Build completed successfully." was printed. */
  buildCompleted: boolean;
  /** True when "Project validation completed successfully." was printed. */
  validationCompleted: boolean;
  /** Platforms a "Preparing to build for" line named, in order. */
  platformsPrepared: string[];
  /** Each "Building <bank> for <platform>" line. */
  bankBuilds: Array<{ bank: string; platform: string }>;
  /** Lines that mention a warning. */
  warnings: string[];
  /** How many "Validation Status" lines the diagnostic printed. */
  validationChecks: number;
  /** The text between the inspect markers, if both were printed. */
  inspectJson?: string;
  /** How many non-empty lines standard output had. */
  lineCount: number;
  /** How many non-empty lines standard error had. */
  stderrLineCount: number;
  /** The lines that matter: every non-progress line and the tail of both streams, capped. */
  excerpt: string[];
}

/** Splits output into trimmed, non-empty lines. */
function splitLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

/** Keeps the interesting lines plus the tail, in order, capped at `EXCERPT_MAX`. */
function excerptOf(
  lines: string[],
  interesting: (line: string) => boolean,
): string[] {
  const keep: number[] = [];
  lines.forEach((line, index) => {
    if (interesting(line) || index >= lines.length - EXCERPT_TAIL) {
      keep.push(index);
    }
  });
  return keep.slice(Math.max(0, keep.length - EXCERPT_MAX)).map((index) =>
    lines[index] ?? ""
  );
}

/** Reads FMOD Studio's output for the outcome markers, the build lines and a bounded excerpt. */
export function parseStudioOutput(
  stdout: string,
  stderr: string,
): StudioReport {
  const lines = splitLines(stdout);
  const errorLines = splitLines(stderr);
  const report: StudioReport = {
    projectOpened: false,
    launcherNeedsTerminal: false,
    buildCompleted: false,
    validationCompleted: false,
    platformsPrepared: [],
    bankBuilds: [],
    warnings: [],
    validationChecks: 0,
    lineCount: lines.length,
    stderrLineCount: errorLines.length,
    excerpt: [],
  };
  let inspectStart: number | undefined;
  for (const [index, raw] of lines.entries()) {
    const line = raw.replace(SCRIPTING_PREFIX, "");
    if (line === "Successfully opened project.") {
      report.projectOpened = true;
    } else if (line === "Build completed successfully.") {
      report.buildCompleted = true;
    } else if (line === "Project validation completed successfully.") {
      report.validationCompleted = true;
    } else if (line === INSPECT_BEGIN) {
      inspectStart = index + 1;
    } else if (line === INSPECT_END && inspectStart !== undefined) {
      report.inspectJson = lines
        .slice(inspectStart, index)
        .map((entry) => entry.replace(SCRIPTING_PREFIX, ""))
        .join("\n");
    }
    if (
      report.loadError === undefined &&
      /^(Project Load Error:|Error: Unable to open )/.test(line)
    ) {
      report.loadError = line;
    }
    if (report.buildError === undefined && /^Build Banks Error:/.test(line)) {
      report.buildError = line;
    }
    if (
      report.scriptError === undefined &&
      /^(\[script-error\]|The following scripting errors occurred)/.test(line)
    ) {
      report.scriptError = line;
    }
    const prepared = /^Build Status: Preparing to build for (.+)\.\.\.$/.exec(
      line,
    );
    if (prepared?.[1] !== undefined) {
      report.platformsPrepared.push(prepared[1]);
    }
    const building = /^Build Status: Building "(.+)" for (.+)\.\.\.$/.exec(
      line,
    );
    if (building?.[1] !== undefined && building[2] !== undefined) {
      report.bankBuilds.push({ bank: building[1], platform: building[2] });
    }
    if (/^Validation Status: /.test(line)) {
      report.validationChecks += 1;
    }
    if (/warning/i.test(line) && !PROGRESS_LINE.test(line)) {
      report.warnings.push(line);
    }
  }
  const combined = [...lines, ...errorLines];
  if (
    combined.some((line) => /do not exist/.test(line) && /\btty\b/.test(line))
  ) {
    report.launcherNeedsTerminal = true;
  }
  report.excerpt = excerptOf(
    combined,
    (line) => !PROGRESS_LINE.test(line) && !SCRIPTING_PREFIX.test(line),
  );
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
}

/** What one FMOD Studio run produced, after the shared failure checks. */
interface StudioRun {
  /** When the tool was started. */
  startedAt: string;
  /** When it exited. */
  finishedAt: string;
  /** The raw result. */
  result: RunResult;
  /** The parsed output. */
  report: StudioReport;
  /** The excerpt joined for error messages. */
  excerpt: string;
}

/**
 * Runs FMOD Studio once with the tool arguments, the project path last as the
 * tool requires, and throws for the failures every mode shares: a missing
 * executable, the terminal-less launcher, a timeout and a project that did
 * not open. `prepare` runs after the temporary directory exists and before
 * the tool starts, so a mode can write a file there.
 */
async function runStudio(
  mode: string,
  toolArgs: string[],
  context: MethodContext,
  runner: Runner,
  files: Files,
  prepare: (tempDir: string) => Promise<string[]> = () => Promise.resolve([]),
): Promise<StudioRun> {
  const { globalArgs, logger } = context;
  const project = resolveFrom(context.repoDir, globalArgs.project);
  const tempDir = await files.makeTempDir();
  let result: RunResult;
  const startedAt = new Date().toISOString();
  try {
    const extra = await prepare(tempDir);
    const run = invocation(globalArgs.fmodstudio, context.repoDir, tempDir, [
      ...toolArgs,
      ...extra,
      project,
    ]);
    logger.info("Running FMOD Studio {mode} on {project} with {command}", {
      mode,
      project,
      command: run.command,
      args: run.args,
      timeoutSeconds: globalArgs.timeoutSeconds,
    });
    try {
      result = await runner({
        command: run.command,
        args: run.args,
        timeoutMs: globalArgs.timeoutSeconds * 1000,
        signal: context.signal,
      });
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        throw new Error(
          `FMOD Studio was not found as "${globalArgs.fmodstudio}": install it or set the fmodstudio global argument to the tool's path (on macOS, to the app bundle)`,
        );
      }
      throw error;
    }
    if (run.captures !== undefined) {
      const read = (path: string): Promise<string> =>
        files.readTextFile(path).catch(() => "");
      result = {
        ...result,
        stdout: await read(run.captures.stdout),
        stderr: await read(run.captures.stderr),
      };
    }
  } finally {
    await files.remove(tempDir);
  }
  const finishedAt = new Date().toISOString();
  const report = parseStudioOutput(result.stdout, result.stderr);
  const excerpt = report.excerpt.join("\n");
  if (report.launcherNeedsTerminal) {
    throw new Error(
      `"${globalArgs.fmodstudio}" is the macOS launcher, which needs a terminal and cannot run from swamp. ` +
        'Set the fmodstudio global argument to the app bundle, such as "/Applications/FMOD Studio.app", ' +
        `and the behavior starts it with open. Output:\n${excerpt}`,
    );
  }
  if (result.timedOut) {
    throw new Error(
      `FMOD Studio did not finish ${mode} within ${globalArgs.timeoutSeconds} seconds and was killed. ` +
        "When it was started through open, the app itself may still be running: quit it before the next run. " +
        `Output:\n${excerpt}`,
    );
  }
  if (report.loadError !== undefined) {
    throw new Error(
      `FMOD Studio could not open ${project} ("${report.loadError}"). Output:\n${excerpt}`,
    );
  }
  return { startedAt, finishedAt, result, report, excerpt };
}

/** The FMOD Studio behavior. */
export const behavior = {
  type: "@reset/fmod",
  version: "2026.10.20.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    build: {
      description:
        "One bank build: which banks were built for which platforms, the exit code, warnings and a bounded log excerpt",
      schema: BuildResourceSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
    project: {
      description:
        "The FMOD Studio version and the project's platforms and built-banks output directory, from the scripting API",
      schema: ProjectResourceSchema,
      lifetime: "30d",
      garbageCollection: 10,
    },
    banks: {
      description: "The project's banks with the events assigned to each",
      schema: BanksResourceSchema,
      lifetime: "30d",
      garbageCollection: 10,
    },
    events: {
      description:
        "The project's events with the banks each is assigned to, capped and marked truncated when cut",
      schema: EventsResourceSchema,
      lifetime: "30d",
      garbageCollection: 10,
    },
    diagnostic: {
      description:
        "One project validation run: how many checks ran and a bounded log excerpt",
      schema: DiagnosticResourceSchema,
      lifetime: "30d",
      garbageCollection: 20,
    },
  },
  methods: {
    build: {
      description:
        "Build banks for platforms with fmodstudiocl -build and record what was built",
      arguments: BuildArgsSchema,
      execute: async (
        args: BuildArgs & Injected,
        context: MethodContext,
      ): Promise<MethodResult> => {
        const { globalArgs, logger } = context;
        const runner = args._runner ?? denoRunner;
        const files = args._files ?? denoFiles;
        const toolArgs: string[] = ["-build"];
        if (args.banks.length > 0) {
          toolArgs.push("-banks", args.banks.join(","));
        }
        if (args.platforms.length > 0) {
          toolArgs.push("-platforms", args.platforms.join(","));
        }
        if (args.ignoreWarnings) {
          toolArgs.push("-ignore-warnings");
        }
        if (args.exportGuids) {
          toolArgs.push("-export-guids");
        }
        if (args.sharedAudioSourceDir !== undefined) {
          toolArgs.push(
            "-shared-audio-source-dir",
            resolveFrom(context.repoDir, args.sharedAudioSourceDir),
          );
        }
        if (args.logDir !== undefined) {
          toolArgs.push("-log-dir", resolveFrom(context.repoDir, args.logDir));
        }
        const run = await runStudio("build", toolArgs, context, runner, files);
        const { report, result, excerpt } = run;
        if (report.buildError !== undefined) {
          throw new Error(
            `FMOD Studio refused the build ("${report.buildError}"). Output:\n${excerpt}`,
          );
        }
        if (result.code !== 0 || !report.buildCompleted) {
          throw new Error(
            `FMOD Studio exited with code ${String(result.code)} and ${
              report.buildCompleted
                ? "reported the build complete"
                : "did not report the build complete"
            }. Output:\n${excerpt}`,
          );
        }
        logger.info(
          "Built {bankBuilds} bank builds for {platforms} in {seconds} seconds",
          {
            bankBuilds: report.bankBuilds.length,
            platforms: report.platformsPrepared,
            warnings: report.warnings.length,
            seconds: Math.round(
              (Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000,
            ),
          },
        );
        const data: z.infer<typeof BuildResourceSchema> = {
          project: resolveFrom(context.repoDir, globalArgs.project),
          banks: args.banks,
          platforms: args.platforms,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          exitCode: result.code,
          platformsBuilt: report.platformsPrepared,
          bankBuilds: report.bankBuilds,
          warnings: report.warnings,
          logLines: report.lineCount,
          logExcerpt: report.excerpt,
          stderrLines: report.stderrLineCount,
        };
        const handle = await context.writeResource("build", "build", data);
        return { dataHandles: [handle] };
      },
    },
    inspect: {
      description:
        "List the project's platforms, banks and events through a script run with fmodstudiocl -script, and record the FMOD Studio version",
      arguments: z.object({}),
      execute: async (
        args: Injected,
        context: MethodContext,
      ): Promise<MethodResult> => {
        const { globalArgs, logger } = context;
        const runner = args._runner ?? denoRunner;
        const files = args._files ?? denoFiles;
        const run = await runStudio(
          "inspect",
          [],
          context,
          runner,
          files,
          async (tempDir) => {
            const script = `${tempDir}/inspect.js`;
            await files.writeTextFile(script, INSPECT_SCRIPT);
            return ["-script", script];
          },
        );
        const { report, result, excerpt } = run;
        if (report.scriptError !== undefined) {
          throw new Error(
            `FMOD Studio reported a script error ("${report.scriptError}"). Output:\n${excerpt}`,
          );
        }
        if (result.code !== 0 || report.inspectJson === undefined) {
          throw new Error(
            `FMOD Studio exited with code ${String(result.code)} and ${
              report.inspectJson === undefined
                ? "did not print the inspect report"
                : "printed the inspect report"
            }. Output:\n${excerpt}`,
          );
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(report.inspectJson);
        } catch {
          throw new Error(
            `The inspect report FMOD Studio printed is not JSON: ${
              report.inspectJson.slice(0, 200)
            }`,
          );
        }
        const checked = InspectOutputSchema.safeParse(parsed);
        if (!checked.success) {
          throw new Error(
            `The inspect report does not have the expected shape: ${
              JSON.stringify(checked.error.issues.slice(0, 5))
            }`,
          );
        }
        const output = checked.data;
        const inspectedAt = run.finishedAt;
        const project = resolveFrom(context.repoDir, globalArgs.project);
        logger.info(
          "FMOD Studio {version} lists {platforms} platforms, {banks} banks and {events} events in {project}",
          {
            version: output.version.text,
            platforms: output.platforms.length,
            banks: output.banks.length,
            events: output.eventCount,
            project,
          },
        );
        const projectData: z.infer<typeof ProjectResourceSchema> = {
          project,
          inspectedAt,
          version: output.version,
          builtBanksOutputDirectory: output.builtBanksOutputDirectory,
          platforms: output.platforms,
          platformNames: output.platforms.map((platform) => platform.name),
        };
        const banksData: z.infer<typeof BanksResourceSchema> = {
          project,
          inspectedAt,
          names: output.banks.map((bank) => bank.name),
          banks: output.banks,
        };
        const eventsData: z.infer<typeof EventsResourceSchema> = {
          project,
          inspectedAt,
          count: output.eventCount,
          truncated: output.events.length < output.eventCount,
          paths: output.events.map((event) => event.path),
          events: output.events,
        };
        const handles = [
          await context.writeResource("project", "project", projectData),
          await context.writeResource("banks", "banks", banksData),
          await context.writeResource("events", "events", eventsData),
        ];
        return { dataHandles: handles };
      },
    },
    diagnostic: {
      description:
        "Validate the project with fmodstudiocl -diagnostic and record the outcome",
      arguments: z.object({}),
      execute: async (
        args: Injected,
        context: MethodContext,
      ): Promise<MethodResult> => {
        const { globalArgs, logger } = context;
        const runner = args._runner ?? denoRunner;
        const files = args._files ?? denoFiles;
        const run = await runStudio(
          "diagnostic",
          ["-diagnostic"],
          context,
          runner,
          files,
        );
        const { report, result, excerpt } = run;
        if (result.code !== 0 || !report.validationCompleted) {
          throw new Error(
            `FMOD Studio exited with code ${String(result.code)} and ${
              report.validationCompleted
                ? "reported the validation complete"
                : "did not report the validation complete"
            }. Output:\n${excerpt}`,
          );
        }
        logger.info("Project validation ran {checks} checks and completed", {
          checks: report.validationChecks,
        });
        const data: z.infer<typeof DiagnosticResourceSchema> = {
          project: resolveFrom(context.repoDir, globalArgs.project),
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          exitCode: result.code,
          checks: report.validationChecks,
          logLines: report.lineCount,
          logExcerpt: report.excerpt,
        };
        const handle = await context.writeResource(
          "diagnostic",
          "diagnostic",
          data,
        );
        return { dataHandles: [handle] };
      },
    },
  },
  checks: {
    "project-is-fspro": {
      description:
        "The project global argument names a .fspro file, which the command line tool takes last",
      labels: ["policy"],
      appliesTo: ["build", "inspect", "diagnostic"],
      execute: (context: CheckContext): Promise<CheckResult> => {
        if (!/\.fspro$/i.test(context.globalArgs.project)) {
          return Promise.resolve({
            pass: false,
            errors: [
              `project "${context.globalArgs.project}" does not end in .fspro: point it at the FMOD Studio project file`,
            ],
          });
        }
        return Promise.resolve({ pass: true });
      },
    },
  },
};
