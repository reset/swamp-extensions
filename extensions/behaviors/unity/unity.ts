/**
 * Drive the Unity Editor in batch mode with its documented command-line
 * arguments only: no editor bridge, no package inside the project. `version`
 * reads the project's editor version and resolves the editor executable,
 * `compile` opens the project and reads the compiler diagnostics from the log,
 * `test` runs the Unity Test Framework and reads its NUnit result file, and
 * `build` runs a static method the project supplies with `-executeMethod`.
 * Each method records what it found as a swamp resource. The process runner,
 * the file helpers and the host platform are injectable, so the unit tests run
 * without Unity installed.
 *
 * @module
 */

import { z } from "npm:zod@4";

/** How many trailing log lines a record keeps besides the matched ones. */
const EXCERPT_TAIL = 20;

/** Hard cap on the log lines a record keeps. */
const EXCERPT_MAX = 120;

/** How many compiler diagnostics a build run keeps for its error message. */
const BUILD_DIAGNOSTICS = 50;

/** The relative path of the file that names a project's editor version. */
const PROJECT_VERSION_FILE = "ProjectSettings/ProjectVersion.txt";

/**
 * A C# compiler diagnostic as the Editor log prints it:
 * `Assets/Scripts/Foo.cs(12,34): error CS0103: The name 'x' does not exist`.
 */
const DIAGNOSTIC_LINE = /^(.+?)\((\d+),(\d+)\): (error|warning) (CS\d+): (.*)$/;

/**
 * Log lines that mean the editor could not get a license. Unity does not
 * document its log, so these are the shapes of the licensing client's error
 * lines; a line that matches none of them is reported as a plain failure.
 */
const LICENSE_FAILURE_PATTERNS: readonly RegExp[] = [
  /no valid unity editor license/i,
  /unity has not been activated/i,
  /license (is |was )?(invalid|expired|not valid|not found)/i,
  /\[licensing::(client|module)\].*\b(error|failed)\b/i,
  /failed to activate/i,
  /activation failed/i,
];

/** Log lines that summarise a batch run's outcome. */
const SUMMARY_PATTERNS: readonly RegExp[] = [
  /^Scripts have compiler errors/i,
  /^Aborting batchmode due to failure/i,
  /^Compilation failed/i,
  /^Build (succeeded|failed)/i,
];

/** Lines worth keeping from an Editor log. */
const INTERESTING_LINE = new RegExp(
  "error CS|warning CS|Exception|\\bError\\b|\\bFailed\\b|Licens|compiler errors|Aborting|Batchmode|BuildPlayer|Build (succeeded|failed|completed)|Test run|-runTests|executeMethod",
  "i",
);

/** Arguments the methods own; an `extraArgs` entry that repeats one is refused. */
const RESERVED_ARGUMENTS = new Set(
  [
    "-batchmode",
    "-nographics",
    "-quit",
    "-projectPath",
    "-logFile",
    "-executeMethod",
    "-buildTarget",
    "-runTests",
    "-testPlatform",
    "-testResults",
    "-testFilter",
    "-testCategory",
  ].map((argument) => argument.toLowerCase()),
);

/** `true` only when the zod output type and the hand-written interface describe the same shape. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

const GlobalArgsSchema = z.object({
  projectPath: z.string().min(1).meta({
    description:
      "The Unity project directory (holds Assets and ProjectSettings), absolute or relative to the repository",
  }),
  editor: z
    .string()
    .min(1)
    .meta({
      description:
        "Path of the Unity editor executable to run. Leave unset to use Unity Hub's default install location for the project's editor version",
    })
    .optional(),
  timeoutSeconds: z.number().int().positive().default(1800).meta({
    description:
      "Kill the editor and fail when it has not exited after this many seconds",
  }),
  logDir: z.string().min(1).default(".swamp/unity/logs").meta({
    description:
      "Directory the editor logs and test result files are written to, absolute or relative to the repository",
  }),
});

/** Global arguments of a behavior instance, as validated by swamp. */
export interface GlobalArgs {
  /** The Unity project directory, absolute or relative to the repository. */
  projectPath: string;
  /** Path of the editor executable; Unity Hub's default location when absent. */
  editor?: string;
  /** Seconds after which the editor is killed. */
  timeoutSeconds: number;
  /** Directory for editor logs and test result files. */
  logDir: string;
}

const _GlobalArgsMatch: Same<
  z.infer<typeof GlobalArgsSchema>,
  GlobalArgs
> = true;

const CompileArgsSchema = z.object({
  maxDiagnostics: z.number().int().positive().max(1000).default(50).meta({
    description: "How many compiler errors and warnings the record keeps",
  }),
});

/** Arguments of the `compile` method. */
export interface CompileArgs {
  /** How many compiler errors and warnings the record keeps. */
  maxDiagnostics: number;
}

const _CompileArgsMatch: Same<
  z.infer<typeof CompileArgsSchema>,
  CompileArgs
> = true;

const TestPlatformSchema = z.enum(["EditMode", "PlayMode"]);

/** Where the Unity Test Framework runs the tests (`-testPlatform`). */
export type TestPlatform = "EditMode" | "PlayMode";

const _TestPlatformMatch: Same<
  z.infer<typeof TestPlatformSchema>,
  TestPlatform
> = true;

const TestArgsSchema = z.object({
  platform: TestPlatformSchema.default("EditMode").meta({
    description:
      "EditMode runs Edit Mode tests, PlayMode runs Play Mode tests in the editor (-testPlatform)",
  }),
  testFilter: z
    .string()
    .min(1)
    .meta({
      description:
        "Semicolon-separated test names or a regular expression on full names, passed as -testFilter",
    })
    .optional(),
  testCategory: z
    .string()
    .min(1)
    .meta({
      description:
        "Semicolon-separated categories or a regular expression on category names, passed as -testCategory",
    })
    .optional(),
  maxFailures: z.number().int().positive().max(1000).default(50).meta({
    description: "How many failed tests the record keeps with their messages",
  }),
});

/** Arguments of the `test` method. */
export interface TestArgs {
  /** EditMode or PlayMode. */
  platform: TestPlatform;
  /** Test name filter passed as -testFilter. */
  testFilter?: string;
  /** Category filter passed as -testCategory. */
  testCategory?: string;
  /** How many failed tests the record keeps. */
  maxFailures: number;
}

const _TestArgsMatch: Same<z.infer<typeof TestArgsSchema>, TestArgs> = true;

/** The `-buildTarget` names the Unity manual lists. */
const BuildTargetSchema = z.enum([
  "android",
  "cloudrendering",
  "ios",
  "linux64",
  "osxuniversal",
  "tvos",
  "visionos",
  "windowsstoreapps",
  "webgl",
  "win",
  "win64",
]);

/** A `-buildTarget` name. */
export type BuildTarget =
  | "android"
  | "cloudrendering"
  | "ios"
  | "linux64"
  | "osxuniversal"
  | "tvos"
  | "visionos"
  | "windowsstoreapps"
  | "webgl"
  | "win"
  | "win64";

const _BuildTargetMatch: Same<
  z.infer<typeof BuildTargetSchema>,
  BuildTarget
> = true;

const BuildArgsSchema = z.object({
  method: z
    .string()
    .regex(
      /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/,
      "a method is Class.Method or Namespace.Class.Method",
    )
    .meta({
      description:
        "The static method in an Editor folder of the project that makes the build, passed as -executeMethod",
    }),
  buildTarget: BuildTargetSchema.meta({
    description: "The active build target the editor opens with (-buildTarget)",
  }),
  extraArgs: z.array(z.string().min(1)).default([]).meta({
    description:
      "Further command-line arguments appended as they are, for the method to read with System.Environment.GetCommandLineArgs",
  }),
});

/** Arguments of the `build` method. */
export interface BuildArgs {
  /** The static method passed as -executeMethod. */
  method: string;
  /** The -buildTarget name. */
  buildTarget: BuildTarget;
  /** Further arguments appended as they are. */
  extraArgs: string[];
}

const _BuildArgsMatch: Same<z.infer<typeof BuildArgsSchema>, BuildArgs> = true;

const VersionResourceSchema = z.object({
  projectPath: z.string(),
  editorVersion: z.string(),
  editorVersionWithRevision: z.string().optional(),
  editorPath: z.string(),
  editorSource: z.enum(["argument", "hub"]),
  editorExists: z.boolean(),
  candidates: z.array(z.string()),
  platform: z.string(),
  readAt: z.string(),
});

const DiagnosticSchema = z.object({
  file: z.string(),
  line: z.number().int(),
  column: z.number().int(),
  severity: z.enum(["error", "warning"]),
  code: z.string(),
  message: z.string(),
});

const CompileResourceSchema = z.object({
  projectPath: z.string(),
  editorVersion: z.string(),
  editorPath: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  durationSeconds: z.number(),
  exitCode: z.number().int(),
  errorCount: z.number().int(),
  warningCount: z.number().int(),
  diagnostics: z.array(DiagnosticSchema),
  diagnosticsTruncated: z.boolean(),
  summaryLine: z.string().optional(),
  logFile: z.string(),
  logLines: z.number().int(),
  logExcerpt: z.array(z.string()),
});

const TestFailureSchema = z.object({
  name: z.string(),
  fullName: z.string(),
  message: z.string(),
  stackTrace: z.string().optional(),
});

const TestResourceSchema = z.object({
  projectPath: z.string(),
  editorVersion: z.string(),
  editorPath: z.string(),
  platform: TestPlatformSchema,
  startedAt: z.string(),
  finishedAt: z.string(),
  durationSeconds: z.number(),
  exitCode: z.number().int(),
  resultsFile: z.string(),
  result: z.string(),
  total: z.number().int(),
  passed: z.number().int(),
  failed: z.number().int(),
  inconclusive: z.number().int(),
  skipped: z.number().int(),
  failures: z.array(TestFailureSchema),
  failuresTruncated: z.boolean(),
  logFile: z.string(),
  logLines: z.number().int(),
  logExcerpt: z.array(z.string()),
});

const BuildResourceSchema = z.object({
  projectPath: z.string(),
  editorVersion: z.string(),
  editorPath: z.string(),
  method: z.string(),
  buildTarget: BuildTargetSchema,
  extraArgs: z.array(z.string()),
  startedAt: z.string(),
  finishedAt: z.string(),
  durationSeconds: z.number(),
  exitCode: z.number().int(),
  summaryLine: z.string().optional(),
  logFile: z.string(),
  logLines: z.number().int(),
  logExcerpt: z.array(z.string()),
});

/** A request to run a program to completion. */
export interface RunRequest {
  /** Path of the program. */
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

/** The file operations the methods need. */
export interface Files {
  /** Reads a text file; rejects with `Deno.errors.NotFound` when it is missing. */
  readTextFile(path: string): Promise<string>;
  /** True when a file or directory exists at the path. */
  exists(path: string): Promise<boolean>;
  /** Creates a directory and its parents. */
  mkdir(path: string): Promise<void>;
}

/** The operating systems Unity Hub installs editors on. */
export type HostPlatform = "darwin" | "linux" | "windows";

/** Runs a program with `Deno.Command`, standard input closed, killed on timeout or abort. */
export const denoRunner: Runner = async (
  request: RunRequest,
): Promise<RunResult> => {
  // swamp-quality-ignore deno-command: the editor executable is the only way to drive Unity in batch mode, and its arguments are the validated global and method arguments plus paths this module chose
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
  exists: async (path: string): Promise<boolean> => {
    try {
      await Deno.stat(path);
      return true;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return false;
      }
      throw error;
    }
  },
  mkdir: (path: string): Promise<void> => Deno.mkdir(path, { recursive: true }),
};

/** The platform swamp is running on, in Unity Hub's terms. */
export function hostPlatform(): HostPlatform {
  switch (Deno.build.os) {
    case "darwin":
      return "darwin";
    case "windows":
      return "windows";
    default:
      return "linux";
  }
}

/** The current user's home directory, or an empty string when the environment does not say. */
export function homeDirectory(): string {
  try {
    return Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "";
  } catch {
    return "";
  }
}

/** What `ProjectSettings/ProjectVersion.txt` says. */
export interface ProjectVersion {
  /** The editor version, such as `6000.0.23f1` (`m_EditorVersion`). */
  editorVersion: string;
  /** The version with its changeset, such as `6000.0.23f1 (1c4764c07fb4)` (`m_EditorVersionWithRevision`). */
  editorVersionWithRevision?: string;
}

/** Reads the editor version from the text of `ProjectSettings/ProjectVersion.txt`. */
export function parseProjectVersion(text: string): ProjectVersion {
  let editorVersion: string | undefined;
  let editorVersionWithRevision: string | undefined;
  for (const rawLine of text.split(/\r?\n/)) {
    const match =
      /^\s*(m_EditorVersion|m_EditorVersionWithRevision)\s*:\s*(.+?)\s*$/
        .exec(rawLine);
    if (match?.[1] === "m_EditorVersion") {
      editorVersion = match[2];
    } else if (match?.[1] === "m_EditorVersionWithRevision") {
      editorVersionWithRevision = match[2];
    }
  }
  if (editorVersion === undefined || editorVersion.length === 0) {
    throw new Error(
      `${PROJECT_VERSION_FILE} has no m_EditorVersion line; it is not a Unity project's version file`,
    );
  }
  const version: ProjectVersion = { editorVersion };
  if (editorVersionWithRevision !== undefined) {
    version.editorVersionWithRevision = editorVersionWithRevision;
  }
  return version;
}

/**
 * Where Unity Hub installs an editor version by default, in the order to try.
 * macOS and Windows have one documented location. On Linux the Hub's default
 * editor folder is `~/Unity/Hub/Editor`; the executable has been documented
 * both with and without an `Editor` directory under the version, and the
 * manual's own example uses `/opt/Unity/Hub/Editor`, so all three are tried.
 */
export function hubEditorCandidates(
  version: string,
  platform: HostPlatform,
  home: string,
): string[] {
  switch (platform) {
    case "darwin":
      return [
        `/Applications/Unity/Hub/Editor/${version}/Unity.app/Contents/MacOS/Unity`,
      ];
    case "windows":
      return [
        `C:\\Program Files\\Unity\\Hub\\Editor\\${version}\\Editor\\Unity.exe`,
      ];
    default: {
      const base = home.replace(/[\\/]+$/, "");
      return [
        `${base}/Unity/Hub/Editor/${version}/Editor/Unity`,
        `${base}/Unity/Hub/Editor/${version}/Unity`,
        `/opt/Unity/Hub/Editor/${version}/Editor/Unity`,
      ];
    }
  }
}

/** The editor executable chosen for a project. */
export interface ResolvedEditor {
  /** The project's editor version. */
  version: ProjectVersion;
  /** The executable path that was chosen. */
  path: string;
  /** Whether `path` came from the `editor` global argument or Unity Hub's default location. */
  source: "argument" | "hub";
  /** Whether `path` exists. */
  exists: boolean;
  /** Every path that was considered, in order. */
  candidates: string[];
}

/** A C# compiler diagnostic read from the Editor log. */
export interface Diagnostic {
  /** Source file as the compiler printed it, usually relative to the project. */
  file: string;
  /** 1-based line. */
  line: number;
  /** 1-based column. */
  column: number;
  /** `error` or `warning`. */
  severity: "error" | "warning";
  /** The compiler code, such as `CS0103`. */
  code: string;
  /** The message after the code. */
  message: string;
}

/** What `parseEditorLog` found in an Editor log. */
export interface LogReport {
  /** Distinct diagnostics in log order, capped at the given maximum. */
  diagnostics: Diagnostic[];
  /** Whether more distinct diagnostics existed than were kept. */
  diagnosticsTruncated: boolean;
  /** Distinct compiler errors, kept or not. */
  errorCount: number;
  /** Distinct compiler warnings, kept or not. */
  warningCount: number;
  /** The first line that reports a licensing failure. */
  licenseLine?: string;
  /** The first line that summarises the run's outcome. */
  summaryLine?: string;
  /** How many non-empty lines the log had, so a reader knows what the excerpt left out. */
  lineCount: number;
  /** The lines that matter: every matched line plus the tail, in order, capped. */
  excerpt: string[];
}

/** Reads an Editor log for compiler diagnostics, licensing failures, a summary line and a bounded excerpt. */
export function parseEditorLog(
  text: string,
  maxDiagnostics: number,
): LogReport {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  const report: LogReport = {
    diagnostics: [],
    diagnosticsTruncated: false,
    errorCount: 0,
    warningCount: 0,
    lineCount: lines.length,
    excerpt: [],
  };
  const seen = new Set<string>();
  const keep = new Set<number>();
  lines.forEach((line, index) => {
    const diagnostic = DIAGNOSTIC_LINE.exec(line);
    if (diagnostic !== null && !seen.has(line)) {
      seen.add(line);
      const severity = diagnostic[4] === "error" ? "error" : "warning";
      if (severity === "error") {
        report.errorCount += 1;
      } else {
        report.warningCount += 1;
      }
      if (report.diagnostics.length < maxDiagnostics) {
        report.diagnostics.push({
          file: diagnostic[1] ?? "",
          line: Number(diagnostic[2]),
          column: Number(diagnostic[3]),
          severity,
          code: diagnostic[5] ?? "",
          message: diagnostic[6] ?? "",
        });
      } else {
        report.diagnosticsTruncated = true;
      }
    }
    if (
      report.licenseLine === undefined &&
      LICENSE_FAILURE_PATTERNS.some((pattern) => pattern.test(line))
    ) {
      report.licenseLine = line;
    }
    if (
      report.summaryLine === undefined &&
      SUMMARY_PATTERNS.some((pattern) => pattern.test(line))
    ) {
      report.summaryLine = line;
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

/** One failed test from an NUnit result file. */
export interface TestFailure {
  /** The test's display name (`name`). */
  name: string;
  /** The test's full name (`fullname`). */
  fullName: string;
  /** The failure message, empty when the file has none. */
  message: string;
  /** The stack trace, when the file has one. */
  stackTrace?: string;
}

/** What `parseNunitResults` read from a test result file. */
export interface TestReport {
  /** The run's overall `result`, such as `Passed` or `Failed`. */
  result: string;
  /** The `total` attribute of the test run. */
  total: number;
  /** The `passed` attribute. */
  passed: number;
  /** The `failed` attribute. */
  failed: number;
  /** The `inconclusive` attribute. */
  inconclusive: number;
  /** The `skipped` attribute. */
  skipped: number;
  /** Failed test cases in file order, capped at the given maximum. */
  failures: TestFailure[];
  /** Whether more failed test cases existed than were kept. */
  failuresTruncated: boolean;
}

/** Decodes the XML character references an attribute or text node may hold. */
function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(
      /&#(\d+);/g,
      (_, code: string) => String.fromCodePoint(Number(code)),
    )
    .replace(/&amp;/g, "&");
}

/** Reads the attributes of one XML start tag. */
function parseAttributes(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of tag.matchAll(/([A-Za-z_][\w.-]*)\s*=\s*"([^"]*)"/g)) {
    attributes[match[1] ?? ""] = decodeXml(match[2] ?? "");
  }
  return attributes;
}

/** Reads the text of the first `<element>` in `xml`, unwrapping a CDATA section. */
function elementText(xml: string, element: string): string | undefined {
  const match = new RegExp(`<${element}>([\\s\\S]*?)</${element}>`).exec(xml);
  if (match?.[1] === undefined) {
    return undefined;
  }
  const body = match[1].trim();
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(body);
  return cdata?.[1] !== undefined ? cdata[1].trim() : decodeXml(body);
}

/** Reads a count attribute that is absent or not a number as 0. */
function countAttribute(
  attributes: Record<string, string>,
  name: string,
): number {
  const value = attributes[name];
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : 0;
}

/** Reads a Unity Test Framework result file, which follows NUnit's result XML format. */
export function parseNunitResults(
  xml: string,
  maxFailures: number,
): TestReport {
  const root = /<test-run\b([^>]*)>/.exec(xml);
  if (root === null) {
    throw new Error(
      "the test result file has no <test-run> element; it is not an NUnit result file",
    );
  }
  const attributes = parseAttributes(root[1] ?? "");
  const report: TestReport = {
    result: attributes.result ?? "",
    total: countAttribute(attributes, "total"),
    passed: countAttribute(attributes, "passed"),
    failed: countAttribute(attributes, "failed"),
    inconclusive: countAttribute(attributes, "inconclusive"),
    skipped: countAttribute(attributes, "skipped"),
    failures: [],
    failuresTruncated: false,
  };
  const testCase = /<test-case\b([^>]*?)(\/?)>/g;
  let match: RegExpExecArray | null;
  while ((match = testCase.exec(xml)) !== null) {
    const caseAttributes = parseAttributes(match[1] ?? "");
    let body = "";
    if (match[2] !== "/") {
      const end = xml.indexOf("</test-case>", testCase.lastIndex);
      body = end === -1
        ? xml.slice(testCase.lastIndex)
        : xml.slice(testCase.lastIndex, end);
      testCase.lastIndex = end === -1 ? xml.length : end;
    }
    if (caseAttributes.result !== "Failed") {
      continue;
    }
    if (report.failures.length >= maxFailures) {
      report.failuresTruncated = true;
      continue;
    }
    const failureBlock = /<failure>([\s\S]*?)<\/failure>/.exec(body)?.[1] ??
      "";
    const failure: TestFailure = {
      name: caseAttributes.name ?? "",
      fullName: caseAttributes.fullname ?? caseAttributes.name ?? "",
      message: elementText(failureBlock, "message") ?? "",
    };
    const stackTrace = elementText(failureBlock, "stack-trace");
    if (stackTrace !== undefined) {
      failure.stackTrace = stackTrace;
    }
    report.failures.push(failure);
  }
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
  /** Repository root, which relative project and log paths resolve against. */
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
  /** Replaces `denoFiles`. */
  _files?: Files;
  /** Replaces `hostPlatform()`. */
  _platform?: HostPlatform;
  /** Replaces `homeDirectory()`. */
  _home?: string;
}

/** True for an absolute POSIX or Windows path. */
function isAbsolute(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

/** Resolves a path against the repository root unless it is absolute. */
function resolveFrom(repoDir: string, path: string): string {
  return isAbsolute(path) ? path : `${repoDir.replace(/[\\/]+$/, "")}/${path}`;
}

/** A timestamp safe in a file name: the ISO instant with its separators replaced. */
function fileStamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

/** Seconds between two ISO timestamps, rounded to milliseconds. */
function secondsBetween(startedAt: string, finishedAt: string): number {
  return Math.round(Date.parse(finishedAt) - Date.parse(startedAt)) / 1000;
}

/** Reads the project's version file, naming the project when it is not one. */
async function readProjectVersion(
  files: Files,
  projectPath: string,
): Promise<ProjectVersion> {
  const versionFile = `${projectPath}/${PROJECT_VERSION_FILE}`;
  let text: string;
  try {
    text = await files.readTextFile(versionFile);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(
        `${versionFile} does not exist: projectPath "${projectPath}" is not a Unity project directory`,
      );
    }
    throw error;
  }
  return parseProjectVersion(text);
}

/** Reads the project's version and chooses the editor executable, without requiring it to exist. */
async function resolveEditor(
  globalArgs: GlobalArgs,
  projectPath: string,
  files: Files,
  platform: HostPlatform,
  home: string,
): Promise<ResolvedEditor> {
  const version = await readProjectVersion(files, projectPath);
  const candidates = globalArgs.editor !== undefined
    ? [globalArgs.editor]
    : hubEditorCandidates(version.editorVersion, platform, home);
  let path = candidates[0] ?? "";
  let exists = false;
  for (const candidate of candidates) {
    if (await files.exists(candidate)) {
      path = candidate;
      exists = true;
      break;
    }
  }
  return {
    version,
    path,
    source: globalArgs.editor !== undefined ? "argument" : "hub",
    exists,
    candidates,
  };
}

/** The editor executable, or a clear error naming every path that was tried. */
async function requireEditor(
  globalArgs: GlobalArgs,
  projectPath: string,
  files: Files,
  platform: HostPlatform,
  home: string,
): Promise<ResolvedEditor> {
  const editor = await resolveEditor(
    globalArgs,
    projectPath,
    files,
    platform,
    home,
  );
  if (!editor.exists) {
    const tried = editor.candidates.join(", ");
    throw new Error(
      editor.source === "argument"
        ? `the editor global argument "${editor.path}" does not exist`
        : `Unity ${editor.version.editorVersion} (the project's version) was not found at Unity Hub's default location: tried ${tried}. ` +
          "Install that version with Unity Hub, or set the editor global argument to the executable",
    );
  }
  return editor;
}

/** What one batch-mode run of the editor produced. */
interface EditorRun {
  /** The log file the editor wrote. */
  logFile: string;
  /** When the editor was started. */
  startedAt: string;
  /** When it exited or was killed. */
  finishedAt: string;
  /** The editor's exit code. */
  code: number;
  /** The parsed log. */
  report: LogReport;
}

/** Runs the editor once in batch mode with the given arguments and reads its log. */
async function runEditor(
  context: MethodContext,
  runner: Runner,
  files: Files,
  editor: ResolvedEditor,
  method: string,
  args: string[],
  maxDiagnostics: number,
): Promise<EditorRun> {
  const { globalArgs, logger } = context;
  const logDir = resolveFrom(context.repoDir, globalArgs.logDir);
  await files.mkdir(logDir);
  const startedAt = new Date().toISOString();
  const logFile = `${logDir}/${method}-${fileStamp(new Date(startedAt))}.log`;
  const commandArgs = [
    "-batchmode",
    "-nographics",
    ...args,
    "-logFile",
    logFile,
  ];
  logger.debug("Running {editor} with {args}", {
    editor: editor.path,
    args: commandArgs,
  });
  let run: RunResult;
  try {
    run = await runner({
      command: editor.path,
      args: commandArgs,
      timeoutMs: globalArgs.timeoutSeconds * 1000,
      signal: context.signal,
    });
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(
        `the editor "${editor.path}" could not be started: it is not an executable file`,
      );
    }
    throw error;
  }
  const finishedAt = new Date().toISOString();
  let logText = "";
  try {
    logText = await files.readTextFile(logFile);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
    logger.warning(
      "The editor wrote no log file at {logFile}; reading its console output instead",
      { logFile },
    );
  }
  const report = parseEditorLog(
    logText.length > 0 ? logText : run.output,
    maxDiagnostics,
  );
  const excerpt = report.excerpt.join("\n");
  if (report.licenseLine !== undefined) {
    throw new Error(
      `Unity could not get a license ("${report.licenseLine}"). ` +
        "Activate the editor on this machine first; this behavior does not activate licenses. " +
        `Log ${logFile}:\n${excerpt}`,
    );
  }
  if (run.timedOut) {
    throw new Error(
      `Unity did not exit within ${globalArgs.timeoutSeconds} seconds and was killed. ` +
        "Another editor instance may hold the project open, or a dialog or a hung task is waiting. " +
        `Log ${logFile}:\n${excerpt}`,
    );
  }
  if (run.code === null) {
    throw new Error(
      `Unity was killed before it exited (the run was cancelled). Log ${logFile}:\n${excerpt}`,
    );
  }
  return { logFile, startedAt, finishedAt, code: run.code, report };
}

/** The Unity batch-mode behavior. */
export const behavior = {
  type: "@reset/unity",
  version: "2026.10.20.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    version: {
      description:
        "The project's editor version and the editor executable chosen for it, with whether it exists",
      schema: VersionResourceSchema,
      lifetime: "30d",
      garbageCollection: 10,
    },
    compile: {
      description:
        "One batch-mode open of the project: compiler error and warning counts, the first diagnostics, the exit code and a bounded log excerpt",
      schema: CompileResourceSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
    test: {
      description:
        "One Unity Test Framework run: the totals from its NUnit result file, the failed tests with messages, the exit code and a bounded log excerpt",
      schema: TestResourceSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
    build: {
      description:
        "One -executeMethod build run: the method, target, exit code, duration and a bounded log excerpt",
      schema: BuildResourceSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
  },
  methods: {
    version: {
      description:
        "Read ProjectSettings/ProjectVersion.txt and resolve the editor executable for that version, recording whether it exists",
      arguments: z.object({}),
      execute: async (
        args: Injected,
        context: MethodContext,
      ): Promise<MethodResult> => {
        const { globalArgs, logger } = context;
        const files = args._files ?? denoFiles;
        const platform = args._platform ?? hostPlatform();
        const home = args._home ?? homeDirectory();
        const projectPath = resolveFrom(
          context.repoDir,
          globalArgs.projectPath,
        );
        logger.info("Reading the editor version of {projectPath}", {
          projectPath,
        });
        const editor = await resolveEditor(
          globalArgs,
          projectPath,
          files,
          platform,
          home,
        );
        logger.info(
          "Project {projectPath} uses Unity {version}; editor {editorPath} ({source}) {exists}",
          {
            projectPath,
            version: editor.version.editorVersion,
            editorPath: editor.path,
            source: editor.source,
            exists: editor.exists ? "exists" : "does not exist",
          },
        );
        const data: z.infer<typeof VersionResourceSchema> = {
          projectPath,
          editorVersion: editor.version.editorVersion,
          editorPath: editor.path,
          editorSource: editor.source,
          editorExists: editor.exists,
          candidates: editor.candidates,
          platform,
          readAt: new Date().toISOString(),
        };
        if (editor.version.editorVersionWithRevision !== undefined) {
          data.editorVersionWithRevision =
            editor.version.editorVersionWithRevision;
        }
        const handle = await context.writeResource("version", "version", data);
        return { dataHandles: [handle] };
      },
    },
    compile: {
      description:
        "Open the project in batch mode and quit, recording the compiler errors and warnings from the editor log",
      arguments: CompileArgsSchema,
      execute: async (
        args: CompileArgs & Injected,
        context: MethodContext,
      ): Promise<MethodResult> => {
        const { globalArgs, logger } = context;
        const runner = args._runner ?? denoRunner;
        const files = args._files ?? denoFiles;
        const platform = args._platform ?? hostPlatform();
        const home = args._home ?? homeDirectory();
        const projectPath = resolveFrom(
          context.repoDir,
          globalArgs.projectPath,
        );
        const editor = await requireEditor(
          globalArgs,
          projectPath,
          files,
          platform,
          home,
        );
        logger.info(
          "Compiling {projectPath} with Unity {version} at {editorPath}",
          {
            projectPath,
            version: editor.version.editorVersion,
            editorPath: editor.path,
          },
        );
        const { logFile, startedAt, finishedAt, code, report } =
          await runEditor(
            context,
            runner,
            files,
            editor,
            "compile",
            ["-quit", "-projectPath", projectPath],
            args.maxDiagnostics,
          );
        if (code !== 0 && report.errorCount === 0) {
          throw new Error(
            `Unity exited with code ${code} and the log has no compiler errors, so the project could not be opened. ` +
              `Log ${logFile}:\n${report.excerpt.join("\n")}`,
          );
        }
        logger.info(
          "Compiled {projectPath}: {errors} errors, {warnings} warnings, exit code {exitCode} in {seconds} seconds",
          {
            projectPath,
            errors: report.errorCount,
            warnings: report.warningCount,
            exitCode: code,
            seconds: secondsBetween(startedAt, finishedAt),
          },
        );
        const data: z.infer<typeof CompileResourceSchema> = {
          projectPath,
          editorVersion: editor.version.editorVersion,
          editorPath: editor.path,
          startedAt,
          finishedAt,
          durationSeconds: secondsBetween(startedAt, finishedAt),
          exitCode: code,
          errorCount: report.errorCount,
          warningCount: report.warningCount,
          diagnostics: report.diagnostics,
          diagnosticsTruncated: report.diagnosticsTruncated,
          logFile,
          logLines: report.lineCount,
          logExcerpt: report.excerpt,
        };
        if (report.summaryLine !== undefined) {
          data.summaryLine = report.summaryLine;
        }
        const handle = await context.writeResource("compile", "compile", data);
        return { dataHandles: [handle] };
      },
    },
    test: {
      description:
        "Run the project's tests with the Unity Test Framework and record the totals and failures from its NUnit result file",
      arguments: TestArgsSchema,
      execute: async (
        args: TestArgs & Injected,
        context: MethodContext,
      ): Promise<MethodResult> => {
        const { globalArgs, logger } = context;
        const runner = args._runner ?? denoRunner;
        const files = args._files ?? denoFiles;
        const platform = args._platform ?? hostPlatform();
        const home = args._home ?? homeDirectory();
        const projectPath = resolveFrom(
          context.repoDir,
          globalArgs.projectPath,
        );
        const editor = await requireEditor(
          globalArgs,
          projectPath,
          files,
          platform,
          home,
        );
        const logDir = resolveFrom(context.repoDir, globalArgs.logDir);
        const resultsFile = `${logDir}/test-${args.platform}-${
          fileStamp(new Date())
        }.xml`;
        logger.info(
          "Running {platform} tests of {projectPath} with Unity {version}",
          {
            platform: args.platform,
            projectPath,
            version: editor.version.editorVersion,
            testFilter: args.testFilter,
            testCategory: args.testCategory,
          },
        );
        // -quit is not supported while tests run; the editor exits when the run ends.
        const editorArgs = [
          "-projectPath",
          projectPath,
          "-runTests",
          "-testPlatform",
          args.platform,
          "-testResults",
          resultsFile,
        ];
        if (args.testFilter !== undefined) {
          editorArgs.push("-testFilter", args.testFilter);
        }
        if (args.testCategory !== undefined) {
          editorArgs.push("-testCategory", args.testCategory);
        }
        const { logFile, startedAt, finishedAt, code, report } =
          await runEditor(
            context,
            runner,
            files,
            editor,
            "test",
            editorArgs,
            args.maxFailures,
          );
        let xml: string;
        try {
          xml = await files.readTextFile(resultsFile);
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) {
            throw error;
          }
          throw new Error(
            `Unity exited with code ${code} and wrote no result file at ${resultsFile}` +
              (report.errorCount > 0
                ? `; the project has ${report.errorCount} compiler errors, so the tests could not run`
                : "") +
              `. Log ${logFile}:\n${report.excerpt.join("\n")}`,
          );
        }
        const results = parseNunitResults(xml, args.maxFailures);
        logger.info(
          "Tests of {projectPath} {result}: {passed} passed, {failed} failed, {skipped} skipped of {total} in {seconds} seconds",
          {
            projectPath,
            result: results.result,
            passed: results.passed,
            failed: results.failed,
            skipped: results.skipped,
            total: results.total,
            seconds: secondsBetween(startedAt, finishedAt),
          },
        );
        const data: z.infer<typeof TestResourceSchema> = {
          projectPath,
          editorVersion: editor.version.editorVersion,
          editorPath: editor.path,
          platform: args.platform,
          startedAt,
          finishedAt,
          durationSeconds: secondsBetween(startedAt, finishedAt),
          exitCode: code,
          resultsFile,
          result: results.result,
          total: results.total,
          passed: results.passed,
          failed: results.failed,
          inconclusive: results.inconclusive,
          skipped: results.skipped,
          failures: results.failures,
          failuresTruncated: results.failuresTruncated,
          logFile,
          logLines: report.lineCount,
          logExcerpt: report.excerpt,
        };
        const handle = await context.writeResource("test", "test", data);
        return { dataHandles: [handle] };
      },
    },
    build: {
      description:
        "Run a static build method the project supplies with -executeMethod for a build target, and record the outcome",
      arguments: BuildArgsSchema,
      execute: async (
        args: BuildArgs & Injected,
        context: MethodContext,
      ): Promise<MethodResult> => {
        const { globalArgs, logger } = context;
        const runner = args._runner ?? denoRunner;
        const files = args._files ?? denoFiles;
        const platform = args._platform ?? hostPlatform();
        const home = args._home ?? homeDirectory();
        const reserved = args.extraArgs.filter((argument) =>
          RESERVED_ARGUMENTS.has(argument.toLowerCase())
        );
        if (reserved.length > 0) {
          throw new Error(
            `extraArgs may not repeat the arguments build sets itself: ${
              reserved.join(", ")
            }`,
          );
        }
        const projectPath = resolveFrom(
          context.repoDir,
          globalArgs.projectPath,
        );
        const editor = await requireEditor(
          globalArgs,
          projectPath,
          files,
          platform,
          home,
        );
        logger.info(
          "Building {projectPath} for {buildTarget} with {method} in Unity {version}",
          {
            projectPath,
            buildTarget: args.buildTarget,
            method: args.method,
            version: editor.version.editorVersion,
            extraArgs: args.extraArgs,
          },
        );
        const { logFile, startedAt, finishedAt, code, report } =
          await runEditor(
            context,
            runner,
            files,
            editor,
            "build",
            [
              "-quit",
              "-projectPath",
              projectPath,
              "-buildTarget",
              args.buildTarget,
              "-executeMethod",
              args.method,
              ...args.extraArgs,
            ],
            BUILD_DIAGNOSTICS,
          );
        if (code !== 0) {
          throw new Error(
            `Unity exited with code ${code} running ${args.method}` +
              (report.errorCount > 0
                ? ` with ${report.errorCount} compiler errors`
                : "") +
              (report.summaryLine !== undefined
                ? ` ("${report.summaryLine}")`
                : "") +
              `. Log ${logFile}:\n${report.excerpt.join("\n")}`,
          );
        }
        logger.info(
          "Built {projectPath} for {buildTarget} with {method} in {seconds} seconds",
          {
            projectPath,
            buildTarget: args.buildTarget,
            method: args.method,
            seconds: secondsBetween(startedAt, finishedAt),
          },
        );
        const data: z.infer<typeof BuildResourceSchema> = {
          projectPath,
          editorVersion: editor.version.editorVersion,
          editorPath: editor.path,
          method: args.method,
          buildTarget: args.buildTarget,
          extraArgs: args.extraArgs,
          startedAt,
          finishedAt,
          durationSeconds: secondsBetween(startedAt, finishedAt),
          exitCode: code,
          logFile,
          logLines: report.lineCount,
          logExcerpt: report.excerpt,
        };
        if (report.summaryLine !== undefined) {
          data.summaryLine = report.summaryLine;
        }
        const handle = await context.writeResource("build", "build", data);
        return { dataHandles: [handle] };
      },
    },
  },
};
