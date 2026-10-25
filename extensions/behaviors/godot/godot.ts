/**
 * Drive the Godot 4 editor binary headlessly over its documented command line.
 * `version` reads `godot --version` and the project's `project.godot`,
 * `import` reimports the project's assets with `--import`, `presets` reads
 * the export presets from `export_presets.cfg`, `export` runs
 * `--export-release`, `--export-debug` or `--export-pack` and checks the
 * produced file, and `check` parses GDScript files with `--check-only`. Each
 * method records what it did as a swamp resource. The process runner and the
 * file helpers are injectable, so the unit tests run without Godot.
 *
 * @module
 */

import { z } from "npm:zod@4";

/** How many trailing output lines a record keeps besides the matched ones. */
const EXCERPT_TAIL = 20;

/** Hard cap on the lines a record keeps. */
const EXCERPT_MAX = 120;

/** Hard cap on the error lines a record keeps. */
const ERRORS_MAX = 200;

/** Output lines Godot prints for an error. The exact wording is not part of the documented interface, so the match is loose. */
const ERROR_LINE = /\b(SCRIPT ERROR|ERROR|Parse Error|Compile Error)\b/;

/** Output lines that mean the export template for the preset's platform is not installed. */
const TEMPLATE_PATTERNS: readonly RegExp[] = [
  /export template/i,
  /template.*(not found|missing|could not)/i,
  /(not found|missing|could not).*template/i,
];

/** Output lines that mean Godot does not know the preset it was given. */
const PRESET_PATTERNS: readonly RegExp[] = [
  /preset.*(not found|unknown|invalid|does not exist)/i,
  /(unknown|invalid|no such).*preset/i,
];

/** Lines worth keeping from Godot's output. */
const INTERESTING_LINE =
  /ERROR|WARNING|Error|error|template|preset|export|Export|import|Import|Godot Engine|^\s+at:/;

/** `true` only when the zod output type and the hand-written interface describe the same shape. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

const GlobalArgsSchema = z.object({
  projectPath: z.string().min(1).describe(
    "Directory holding the project's project.godot, absolute or relative to the repository",
  ),
  godot: z.string().min(1).default("godot").describe(
    "Path to the Godot 4 editor binary, or its command name when it is on PATH. Export templates are only found by an editor build",
  ),
  timeoutSeconds: z.number().int().positive().default(1800).describe(
    "Kill Godot and fail when one invocation has not exited after this many seconds",
  ),
});

/** Global arguments of a behavior instance, as validated by swamp. */
export interface GlobalArgs {
  /** Directory holding project.godot, absolute or relative to the repository. */
  projectPath: string;
  /** Path to the Godot editor binary, or its command name when it is on PATH. */
  godot: string;
  /** Seconds after which one Godot invocation is killed. */
  timeoutSeconds: number;
}

const _GlobalArgsMatch: Same<
  z.infer<typeof GlobalArgsSchema>,
  GlobalArgs
> = true;

const ExportArgsSchema = z.object({
  preset: z.string().min(1).describe(
    "Name of an export preset defined in the project's export_presets.cfg",
  ),
  path: z.string().min(1).describe(
    "Output file. A relative path is relative to the project directory, as Godot resolves it, not to the working directory",
  ),
  mode: z.enum(["release", "debug", "pack"]).default("release").describe(
    "release runs --export-release, debug runs --export-debug (debug template), pack runs --export-pack (PCK or ZIP by the path's extension, no executable)",
  ),
});

/** Arguments of the `export` method. */
export interface ExportArgs {
  /** Name of an export preset in export_presets.cfg. */
  preset: string;
  /** Output file, relative to the project directory or absolute. */
  path: string;
  /** Which export flag to run. */
  mode: "release" | "debug" | "pack";
}

const _ExportArgsMatch: Same<
  z.infer<typeof ExportArgsSchema>,
  ExportArgs
> = true;

const CheckArgsSchema = z.object({
  scripts: z.array(z.string().min(1)).min(1).describe(
    "GDScript files to parse, each a resource path relative to the project (player.gd is res://player.gd) or an absolute filesystem path",
  ),
});

/** Arguments of the `check` method. */
export interface CheckArgs {
  /** GDScript files to parse. */
  scripts: string[];
}

const _CheckArgsMatch: Same<
  z.infer<typeof CheckArgsSchema>,
  CheckArgs
> = true;

const ProjectFactsSchema = z.object({
  name: z.string().optional(),
  version: z.string().optional(),
  mainScene: z.string().optional(),
  features: z.array(z.string()),
});

const VersionResourceSchema = z.object({
  godot: z.string(),
  version: z.string(),
  major: z.number().int(),
  minor: z.number().int(),
  patch: z.number().int(),
  status: z.string(),
  build: z.string(),
  hash: z.string().optional(),
  projectPath: z.string(),
  project: ProjectFactsSchema,
  readAt: z.string(),
});

const ImportResourceSchema = z.object({
  projectPath: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  durationSeconds: z.number(),
  exitCode: z.number().int(),
  errorCount: z.number().int(),
  errorLines: z.array(z.string()),
  logLines: z.number().int(),
  logExcerpt: z.array(z.string()),
});

const PresetSchema = z.object({
  name: z.string(),
  platform: z.string(),
  exportPath: z.string(),
  runnable: z.boolean(),
  dedicatedServer: z.boolean(),
  exportFilter: z.string(),
});

/** One export preset as `export_presets.cfg` declares it. */
export interface Preset {
  /** The preset name, what `--export-release` takes. */
  name: string;
  /** The target platform, for example `Linux` or `Windows Desktop`. */
  platform: string;
  /** The export path the preset remembers, empty when none was set. */
  exportPath: string;
  /** Whether the editor marks the preset runnable. */
  runnable: boolean;
  /** Whether the preset exports as a dedicated server. */
  dedicatedServer: boolean;
  /** The resource export filter, for example `all_resources`. */
  exportFilter: string;
}

const _PresetMatch: Same<z.infer<typeof PresetSchema>, Preset> = true;

const PresetsResourceSchema = z.object({
  projectPath: z.string(),
  readAt: z.string(),
  count: z.number().int(),
  names: z.array(z.string()),
  presets: z.array(PresetSchema),
});

const ExportResourceSchema = z.object({
  projectPath: z.string(),
  preset: z.string(),
  platform: z.string().optional(),
  mode: z.enum(["release", "debug", "pack"]),
  outputPath: z.string(),
  fileSize: z.number().int(),
  isDirectory: z.boolean(),
  startedAt: z.string(),
  finishedAt: z.string(),
  durationSeconds: z.number(),
  exitCode: z.number().int(),
  errorCount: z.number().int(),
  errorLines: z.array(z.string()),
  logLines: z.number().int(),
  logExcerpt: z.array(z.string()),
});

const ScriptErrorSchema = z.object({
  line: z.number().int().optional(),
  message: z.string(),
});

const ScriptResultSchema = z.object({
  script: z.string(),
  exitCode: z.number().int(),
  passed: z.boolean(),
  errors: z.array(ScriptErrorSchema),
});

const CheckResourceSchema = z.object({
  projectPath: z.string(),
  checkedAt: z.string(),
  durationSeconds: z.number(),
  scripts: z.array(ScriptResultSchema),
  passed: z.number().int(),
  failed: z.number().int(),
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
  /** Standard output followed by standard error. */
  output: string;
  /** True when the program was killed for exceeding the timeout. */
  timedOut: boolean;
}

/** Runs a program with closed standard input. Tests replace it, swamp uses `denoRunner`. */
export type Runner = (request: RunRequest) => Promise<RunResult>;

/** What a file looks like on disk. */
export interface FileFacts {
  /** Size in bytes; what the platform reports for a directory. */
  size: number;
  /** True for a directory, such as a macOS `.app` bundle. */
  isDirectory: boolean;
}

/** The file operations the methods need. */
export interface Files {
  /** Reads a text file. Throws `Deno.errors.NotFound` when it does not exist. */
  readTextFile(path: string): Promise<string>;
  /** Describes a file or directory. Throws `Deno.errors.NotFound` when it does not exist. */
  stat(path: string): Promise<FileFacts>;
}

/** Runs a program with `Deno.Command`, standard input closed, killed on timeout or abort. */
export const denoRunner: Runner = async (
  request: RunRequest,
): Promise<RunResult> => {
  // swamp-quality-ignore deno-command: the Godot editor binary is the only way to import, export and parse a project, and its arguments are the validated global arguments, a preset name and paths
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
  readTextFile: (path: string): Promise<string> => Deno.readTextFile(path),
  stat: async (path: string): Promise<FileFacts> => {
    const info = await Deno.stat(path);
    return { size: info.size, isDirectory: info.isDirectory };
  },
};

/** True for an absolute POSIX or Windows path. */
function isAbsolute(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

/** Resolves a path against a base directory unless it is absolute. */
export function resolveFrom(base: string, path: string): string {
  return normalizePath(
    isAbsolute(path) ? path : `${base.replace(/[\\/]+$/, "")}/${path}`,
  );
}

/** Collapses `.` and `..` segments of a slash-separated path. A path with backslashes is returned as written. */
export function normalizePath(path: string): string {
  if (path.includes("\\")) {
    return path;
  }
  const absolute = path.startsWith("/");
  const parts: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      const last = parts[parts.length - 1];
      if (last !== undefined && last !== "..") {
        parts.pop();
      } else if (!absolute) {
        parts.push("..");
      }
      continue;
    }
    parts.push(segment);
  }
  const joined = parts.join("/");
  if (absolute) {
    return `/${joined}`;
  }
  return joined.length === 0 ? "." : joined;
}

/** Resolves the project directory, accepting the project.godot file itself for the directory. */
export function projectDirectory(repoDir: string, projectPath: string): string {
  const resolved = resolveFrom(repoDir, projectPath);
  return resolved.replace(/[\\/]+project\.godot$/, "");
}

/** What `parseVersionString` reads from `godot --version`. */
export interface GodotVersion {
  /** The line as printed, for example `4.3.stable.official.77dcf97d8`. */
  version: string;
  /** Major version. */
  major: number;
  /** Minor version. */
  minor: number;
  /** Patch version, 0 when the string omits it. */
  patch: number;
  /** Status such as `stable`, `beta1` or `rc2`. */
  status: string;
  /** Build name such as `official` or `custom_build`, with any module name before it. */
  build: string;
  /** Trailing commit hash when the string carries one. */
  hash?: string;
}

/**
 * Parses the version string the engine prints: major, minor, patch, status and
 * build joined with dots, as `Engine.get_version_info().string` documents, with
 * an optional trailing commit hash. The patch is omitted when it is zero.
 */
export function parseVersionString(output: string): GodotVersion | undefined {
  const line = output
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .find((candidate) => /^\d+\.\d+/.test(candidate));
  if (line === undefined) {
    return undefined;
  }
  const tokens = line.split(".");
  const major = Number(tokens[0]);
  const minor = Number(tokens[1]);
  let index = 2;
  let patch = 0;
  if (tokens[index] !== undefined && /^\d+$/.test(tokens[index])) {
    patch = Number(tokens[index]);
    index += 1;
  }
  const status = tokens[index];
  if (status === undefined || status.length === 0) {
    return undefined;
  }
  const rest = tokens.slice(index + 1);
  let hash: string | undefined;
  const last = rest[rest.length - 1];
  if (rest.length > 1 && last !== undefined && /^[0-9a-f]{7,40}$/.test(last)) {
    hash = last;
    rest.pop();
  }
  const result: GodotVersion = {
    version: line,
    major,
    minor,
    patch,
    status,
    build: rest.join("."),
  };
  if (hash !== undefined) {
    result.hash = hash;
  }
  return result;
}

/** Reads a ConfigFile-format text (INI-style sections of `key=value` lines) into a map of sections. */
export function parseConfigFile(
  text: string,
): Map<string, Map<string, string>> {
  const sections = new Map<string, Map<string, string>>();
  let current = new Map<string, string>();
  sections.set("", current);
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith(";") || line.startsWith("#")) {
      continue;
    }
    const section = /^\[(.+)\]$/.exec(line);
    if (section?.[1] !== undefined) {
      current = sections.get(section[1]) ?? new Map<string, string>();
      sections.set(section[1], current);
      continue;
    }
    const separator = line.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    current.set(
      line.slice(0, separator).trim(),
      line.slice(separator + 1).trim(),
    );
  }
  return sections;
}

/** Unquotes a ConfigFile string value; other values are returned as written. */
export function configString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const quoted = /^"(.*)"$/s.exec(value);
  if (quoted?.[1] === undefined) {
    return value;
  }
  return quoted[1].replace(/\\(["\\])/g, "$1");
}

/** Reads a ConfigFile boolean; anything but `true` is false. */
function configBoolean(value: string | undefined): boolean {
  return value === "true";
}

/** Reads the strings of a `PackedStringArray("a", "b")` value. */
export function configStringArray(value: string | undefined): string[] {
  if (value === undefined) {
    return [];
  }
  const inner = /^PackedStringArray\((.*)\)$/s.exec(value)?.[1];
  if (inner === undefined) {
    return [];
  }
  const strings: string[] = [];
  for (const match of inner.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
    strings.push((match[1] ?? "").replace(/\\(["\\])/g, "$1"));
  }
  return strings;
}

/** What `parseProjectGodot` reads from `project.godot`. */
export interface ProjectFacts {
  /** `application/config/name`. */
  name?: string;
  /** `application/config/version`. */
  version?: string;
  /** `application/run/main_scene`. */
  mainScene?: string;
  /** `config/features`, the engine version and renderer the editor wrote the project with; empty when absent. */
  features: string[];
}

const _ProjectFactsMatch: Same<
  z.infer<typeof ProjectFactsSchema>,
  ProjectFacts
> = true;

/** Reads the documented application settings and the editor's feature list from a `project.godot` text. */
export function parseProjectGodot(text: string): ProjectFacts {
  const application = parseConfigFile(text).get("application") ??
    new Map<string, string>();
  const facts: ProjectFacts = {
    features: configStringArray(application.get("config/features")),
  };
  const name = configString(application.get("config/name"));
  if (name !== undefined) {
    facts.name = name;
  }
  const version = configString(application.get("config/version"));
  if (version !== undefined) {
    facts.version = version;
  }
  const mainScene = configString(application.get("run/main_scene"));
  if (mainScene !== undefined) {
    facts.mainScene = mainScene;
  }
  return facts;
}

/** Reads the `[preset.N]` sections of an `export_presets.cfg` text, in file order. */
export function parseExportPresets(text: string): Preset[] {
  const presets: Preset[] = [];
  for (const [section, values] of parseConfigFile(text)) {
    if (!/^preset\.\d+$/.test(section)) {
      continue;
    }
    const name = configString(values.get("name"));
    if (name === undefined || name.length === 0) {
      continue;
    }
    presets.push({
      name,
      platform: configString(values.get("platform")) ?? "",
      exportPath: configString(values.get("export_path")) ?? "",
      runnable: configBoolean(values.get("runnable")),
      dedicatedServer: configBoolean(values.get("dedicated_server")),
      exportFilter: configString(values.get("export_filter")) ?? "",
    });
  }
  return presets;
}

/** What `parseGodotOutput` found in one Godot run's output. */
export interface OutputReport {
  /** Lines that report an error, in order, capped. */
  errorLines: string[];
  /** How many error lines there were before the cap. */
  errorCount: number;
  /** The first line that says an export template is missing. */
  templateLine?: string;
  /** The first line that says the preset is unknown. */
  presetLine?: string;
  /** How many non-empty lines the output had, so a reader knows what the excerpt left out. */
  lineCount: number;
  /** The lines that matter: every matched line plus the tail, in order, capped. */
  excerpt: string[];
}

/** Reads Godot's output for error lines, the named failure causes and a bounded excerpt. */
export function parseGodotOutput(output: string): OutputReport {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  const report: OutputReport = {
    errorLines: [],
    errorCount: 0,
    lineCount: lines.length,
    excerpt: [],
  };
  const keep = new Set<number>();
  lines.forEach((line, index) => {
    if (ERROR_LINE.test(line)) {
      report.errorCount += 1;
      if (report.errorLines.length < ERRORS_MAX) {
        report.errorLines.push(line.trim());
      }
    }
    if (
      report.templateLine === undefined &&
      TEMPLATE_PATTERNS.some((pattern) => pattern.test(line))
    ) {
      report.templateLine = line.trim();
    }
    if (
      report.presetLine === undefined &&
      PRESET_PATTERNS.some((pattern) => pattern.test(line))
    ) {
      report.presetLine = line.trim();
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

/** One parse error of a script, as `check` records it. */
export interface ScriptError {
  /** Line in the script when the output named one. */
  line?: number;
  /** The error line as printed. */
  message: string;
}

const _ScriptErrorMatch: Same<
  z.infer<typeof ScriptErrorSchema>,
  ScriptError
> = true;

/**
 * Reads the parse errors from a `--check-only` run. Each error line is kept;
 * a following `at: ... (res://file.gd:12)` line gives it its line number.
 */
export function parseScriptErrors(output: string): ScriptError[] {
  const errors: ScriptError[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) {
      continue;
    }
    const location = /^at:.*:(\d+)\)?\s*$/.exec(line);
    const last = errors[errors.length - 1];
    if (
      location?.[1] !== undefined && last !== undefined &&
      last.line === undefined
    ) {
      last.line = Number(location[1]);
      continue;
    }
    if (ERROR_LINE.test(line)) {
      errors.push({ message: line });
    }
  }
  return errors;
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
  /** Repository root, which a relative projectPath is resolved against. */
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
  /** Repository root. */
  repoDir: string;
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

/** Seconds between two ISO timestamps, rounded to milliseconds. */
function secondsBetween(startedAt: string, finishedAt: string): number {
  return Math.round(Date.parse(finishedAt) - Date.parse(startedAt)) / 1000;
}

/** Runs Godot once, turning a missing binary into an error that names the fix. */
async function runGodot(
  runner: Runner,
  context: MethodContext,
  args: string[],
): Promise<RunResult> {
  const { globalArgs } = context;
  try {
    return await runner({
      command: globalArgs.godot,
      args,
      timeoutMs: globalArgs.timeoutSeconds * 1000,
      signal: context.signal,
    });
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(
        `Godot was not found as "${globalArgs.godot}": install the Godot 4 editor or set the godot global argument to its path`,
      );
    }
    throw error;
  }
}

/** The error for a run that hit the deadline. */
function timeoutError(
  what: string,
  context: MethodContext,
  excerpt: string[],
): Error {
  return new Error(
    `Godot did not finish ${what} within ${context.globalArgs.timeoutSeconds} seconds and was killed. ` +
      "A run that stops without output usually waits on a display or a dialog: --headless is passed, so check that the binary is a Godot 4 editor build. " +
      `Output:\n${excerpt.join("\n")}`,
  );
}

/** Reads and parses the project's export_presets.cfg, or throws an error that names the file. */
async function readPresets(
  files: Files,
  projectDir: string,
): Promise<Preset[]> {
  const path = `${projectDir}/export_presets.cfg`;
  let text: string;
  try {
    text = await files.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(
        `${path} does not exist: the project has no export presets. Create one in the editor's Project > Export dialog, which writes export_presets.cfg`,
      );
    }
    throw error;
  }
  return parseExportPresets(text);
}

/** The Godot behavior. */
export const behavior = {
  type: "@reset/godot",
  version: "2026.10.24.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    version: {
      description:
        "The engine version godot --version printed, parsed, and the project's name, version, main scene and feature list from project.godot",
      schema: VersionResourceSchema,
      lifetime: "30d",
      garbageCollection: 10,
    },
    import: {
      description:
        "One --import run: exit code, duration, the error lines it printed and a bounded log excerpt",
      schema: ImportResourceSchema,
      lifetime: "30d",
      garbageCollection: 20,
    },
    presets: {
      description:
        "The export presets export_presets.cfg declares: name, platform, export path and flags of each",
      schema: PresetsResourceSchema,
      lifetime: "30d",
      garbageCollection: 10,
    },
    export: {
      description:
        "One export run: the preset, mode and output path, the produced file's size, exit code, duration, error lines and a bounded log excerpt",
      schema: ExportResourceSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
    check: {
      description:
        "One --check-only pass over a list of scripts: each script's exit code and parse errors, and the pass and fail counts",
      schema: CheckResourceSchema,
      lifetime: "30d",
      garbageCollection: 20,
    },
  },
  methods: {
    version: {
      description:
        "Read the engine version with godot --version and the project's application settings from project.godot",
      arguments: z.object({}),
      execute: async (
        args: Injected,
        context: MethodContext,
      ): Promise<MethodResult> => {
        const { globalArgs, logger } = context;
        const runner = args._runner ?? denoRunner;
        const files = args._files ?? denoFiles;
        const projectDir = projectDirectory(
          context.repoDir,
          globalArgs.projectPath,
        );
        logger.info(
          "Reading the version of {godot} and the project at {projectPath}",
          {
            godot: globalArgs.godot,
            projectPath: projectDir,
          },
        );
        const run = await runGodot(runner, context, ["--version"]);
        if (run.timedOut) {
          throw timeoutError(
            "--version",
            context,
            parseGodotOutput(run.output).excerpt,
          );
        }
        const parsed = parseVersionString(run.output);
        if (parsed === undefined) {
          throw new Error(
            `${globalArgs.godot} --version exited with code ${
              String(run.code)
            } and printed no version string. Output:\n${run.output.trim()}`,
          );
        }
        const projectFile = `${projectDir}/project.godot`;
        let projectText: string;
        try {
          projectText = await files.readTextFile(projectFile);
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) {
            throw new Error(
              `${projectFile} does not exist: projectPath must be the directory holding project.godot`,
            );
          }
          throw error;
        }
        const project = parseProjectGodot(projectText);
        logger.info(
          "Godot {version} opens project {name} written with features {features}",
          {
            version: parsed.version,
            name: project.name ?? "(unnamed)",
            features: project.features,
          },
        );
        const data: z.infer<typeof VersionResourceSchema> = {
          godot: globalArgs.godot,
          version: parsed.version,
          major: parsed.major,
          minor: parsed.minor,
          patch: parsed.patch,
          status: parsed.status,
          build: parsed.build,
          projectPath: projectDir,
          project,
          readAt: new Date().toISOString(),
        };
        if (parsed.hash !== undefined) {
          data.hash = parsed.hash;
        }
        const handle = await context.writeResource("version", "version", data);
        return { dataHandles: [handle] };
      },
    },
    import: {
      description:
        "Reimport the project's assets with --headless --import and record the exit code, duration and error lines",
      arguments: z.object({}),
      execute: async (
        args: Injected,
        context: MethodContext,
      ): Promise<MethodResult> => {
        const { globalArgs, logger } = context;
        const runner = args._runner ?? denoRunner;
        const projectDir = projectDirectory(
          context.repoDir,
          globalArgs.projectPath,
        );
        logger.info("Importing the project at {projectPath} with {godot}", {
          projectPath: projectDir,
          godot: globalArgs.godot,
        });
        const startedAt = new Date().toISOString();
        const run = await runGodot(runner, context, [
          "--headless",
          "--path",
          projectDir,
          "--import",
        ]);
        const finishedAt = new Date().toISOString();
        const report = parseGodotOutput(run.output);
        if (run.timedOut) {
          throw timeoutError("--import", context, report.excerpt);
        }
        if (run.code !== 0) {
          throw new Error(
            `Godot --import of ${projectDir} exited with code ${
              String(run.code)
            } after ${report.errorCount} error lines. Output:\n${
              report.excerpt.join("\n")
            }`,
          );
        }
        logger.info(
          "Imported {projectPath} in {seconds} seconds with {errors} error lines",
          {
            projectPath: projectDir,
            seconds: secondsBetween(startedAt, finishedAt),
            errors: report.errorCount,
          },
        );
        const data: z.infer<typeof ImportResourceSchema> = {
          projectPath: projectDir,
          startedAt,
          finishedAt,
          durationSeconds: secondsBetween(startedAt, finishedAt),
          exitCode: run.code,
          errorCount: report.errorCount,
          errorLines: report.errorLines,
          logLines: report.lineCount,
          logExcerpt: report.excerpt,
        };
        const handle = await context.writeResource("import", "import", data);
        return { dataHandles: [handle] };
      },
    },
    presets: {
      description:
        "Read the export presets from the project's export_presets.cfg",
      arguments: z.object({}),
      execute: async (
        args: Injected,
        context: MethodContext,
      ): Promise<MethodResult> => {
        const { globalArgs, logger } = context;
        const files = args._files ?? denoFiles;
        const projectDir = projectDirectory(
          context.repoDir,
          globalArgs.projectPath,
        );
        logger.info("Reading the export presets of {projectPath}", {
          projectPath: projectDir,
        });
        const presets = await readPresets(files, projectDir);
        logger.info("Read {count} export presets: {names}", {
          count: presets.length,
          names: presets.map((preset) => preset.name),
        });
        const data: z.infer<typeof PresetsResourceSchema> = {
          projectPath: projectDir,
          readAt: new Date().toISOString(),
          count: presets.length,
          names: presets.map((preset) => preset.name),
          presets,
        };
        const handle = await context.writeResource("presets", "presets", data);
        return { dataHandles: [handle] };
      },
    },
    export: {
      description:
        "Export the project with --headless --export-release, --export-debug or --export-pack and record the produced file's size",
      arguments: ExportArgsSchema,
      execute: async (
        args: ExportArgs & Injected,
        context: MethodContext,
      ): Promise<MethodResult> => {
        const { globalArgs, logger } = context;
        const runner = args._runner ?? denoRunner;
        const files = args._files ?? denoFiles;
        const projectDir = projectDirectory(
          context.repoDir,
          globalArgs.projectPath,
        );
        const presets = await readPresets(files, projectDir);
        const preset = presets.find((candidate) =>
          candidate.name === args.preset
        );
        if (preset === undefined && presets.length > 0) {
          throw new Error(
            `export_presets.cfg of ${projectDir} has no preset named "${args.preset}". It defines: ${
              presets.map((candidate) => `"${candidate.name}"`).join(", ")
            }`,
          );
        }
        const flag = args.mode === "release"
          ? "--export-release"
          : args.mode === "debug"
          ? "--export-debug"
          : "--export-pack";
        const outputPath = resolveFrom(projectDir, args.path);
        logger.info(
          "Exporting {projectPath} with preset {preset} ({mode}) to {outputPath}",
          {
            projectPath: projectDir,
            preset: args.preset,
            mode: args.mode,
            outputPath,
            platform: preset?.platform,
          },
        );
        const startedAt = new Date().toISOString();
        const run = await runGodot(runner, context, [
          "--headless",
          "--path",
          projectDir,
          flag,
          args.preset,
          args.path,
        ]);
        const finishedAt = new Date().toISOString();
        const report = parseGodotOutput(run.output);
        const excerpt = report.excerpt.join("\n");
        if (run.timedOut) {
          throw timeoutError(`${flag} ${args.preset}`, context, report.excerpt);
        }
        if (report.templateLine !== undefined) {
          throw new Error(
            `Export of preset "${args.preset}" failed: the export template for ${
              preset?.platform ?? "the preset's platform"
            } is not installed for this Godot version ("${report.templateLine}"). ` +
              "Install the templates that match the editor (Editor > Manage Export Templates) on this machine. " +
              `Output:\n${excerpt}`,
          );
        }
        if (report.presetLine !== undefined) {
          throw new Error(
            `Export failed: Godot does not know the preset "${args.preset}" ("${report.presetLine}"). Output:\n${excerpt}`,
          );
        }
        if (run.code !== 0) {
          throw new Error(
            `Godot ${flag} "${args.preset}" exited with code ${
              String(run.code)
            } after ${report.errorCount} error lines. Output:\n${excerpt}`,
          );
        }
        let facts: FileFacts;
        try {
          facts = await files.stat(outputPath);
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) {
            throw new Error(
              `Godot ${flag} "${args.preset}" exited with code 0 but ${outputPath} does not exist. Output:\n${excerpt}`,
            );
          }
          throw error;
        }
        logger.info(
          "Exported preset {preset} to {outputPath} ({bytes} bytes) in {seconds} seconds with {errors} error lines",
          {
            preset: args.preset,
            outputPath,
            bytes: facts.size,
            seconds: secondsBetween(startedAt, finishedAt),
            errors: report.errorCount,
          },
        );
        const data: z.infer<typeof ExportResourceSchema> = {
          projectPath: projectDir,
          preset: args.preset,
          mode: args.mode,
          outputPath,
          fileSize: facts.size,
          isDirectory: facts.isDirectory,
          startedAt,
          finishedAt,
          durationSeconds: secondsBetween(startedAt, finishedAt),
          exitCode: run.code,
          errorCount: report.errorCount,
          errorLines: report.errorLines,
          logLines: report.lineCount,
          logExcerpt: report.excerpt,
        };
        if (preset !== undefined) {
          data.platform = preset.platform;
        }
        const handle = await context.writeResource("export", "export", data);
        return { dataHandles: [handle] };
      },
    },
    check: {
      description:
        "Parse GDScript files one at a time with --headless --check-only -s and record each file's parse errors",
      arguments: CheckArgsSchema,
      execute: async (
        args: CheckArgs & Injected,
        context: MethodContext,
      ): Promise<MethodResult> => {
        const { globalArgs, logger } = context;
        const runner = args._runner ?? denoRunner;
        const projectDir = projectDirectory(
          context.repoDir,
          globalArgs.projectPath,
        );
        logger.info("Checking {count} scripts of {projectPath} with {godot}", {
          count: args.scripts.length,
          projectPath: projectDir,
          godot: globalArgs.godot,
        });
        const startedAt = new Date().toISOString();
        const scripts: z.infer<typeof ScriptResultSchema>[] = [];
        for (const script of args.scripts) {
          const run = await runGodot(runner, context, [
            "--headless",
            "--path",
            projectDir,
            "--check-only",
            "-s",
            script,
          ]);
          if (run.timedOut) {
            throw timeoutError(
              `--check-only ${script}`,
              context,
              parseGodotOutput(run.output).excerpt,
            );
          }
          const errors = parseScriptErrors(run.output);
          const passed = run.code === 0 && errors.length === 0;
          if (!passed) {
            logger.warning("{script} failed to parse with {count} errors", {
              script,
              count: errors.length,
              exitCode: run.code,
            });
          }
          scripts.push({
            script,
            exitCode: run.code ?? -1,
            passed,
            errors,
          });
        }
        const finishedAt = new Date().toISOString();
        const failed = scripts.filter((result) => !result.passed).length;
        logger.info(
          "Checked {count} scripts in {seconds} seconds: {passed} passed, {failed} failed",
          {
            count: scripts.length,
            seconds: secondsBetween(startedAt, finishedAt),
            passed: scripts.length - failed,
            failed,
          },
        );
        const data: z.infer<typeof CheckResourceSchema> = {
          projectPath: projectDir,
          checkedAt: finishedAt,
          durationSeconds: secondsBetween(startedAt, finishedAt),
          scripts,
          passed: scripts.length - failed,
          failed,
        };
        const handle = await context.writeResource("check", "check", data);
        return { dataHandles: [handle] };
      },
    },
  },
  checks: {
    "project-file": {
      description:
        "projectPath names a directory that holds a project.godot file",
      labels: ["live"],
      appliesTo: ["version", "import", "presets", "export", "check"],
      // swamp passes the context alone; tests pass file helpers that need no permissions.
      execute: async (
        context: CheckContext,
        files: Files = denoFiles,
      ): Promise<CheckResult> => {
        const projectFile = `${
          projectDirectory(context.repoDir, context.globalArgs.projectPath)
        }/project.godot`;
        try {
          const facts = await files.stat(projectFile);
          if (facts.isDirectory) {
            return {
              pass: false,
              errors: [`${projectFile} is a directory, not the project file`],
            };
          }
          return { pass: true };
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) {
            return {
              pass: false,
              errors: [
                `${projectFile} does not exist: set projectPath to the directory holding project.godot`,
              ],
            };
          }
          throw error;
        }
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
