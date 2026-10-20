/**
 * Unit tests for the Unity batch-mode behavior. Every test injects a runner,
 * file helpers, a platform and a home directory, so nothing here needs Unity
 * installed or starts a process.
 *
 * @module
 */

import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20261013.54";
import {
  behavior,
  type Files,
  type HostPlatform,
  hubEditorCandidates,
  type MethodContext,
  parseEditorLog,
  parseNunitResults,
  parseProjectVersion,
  type Runner,
  type RunRequest,
  type RunResult,
} from "./unity.ts";

const REPO = "/work/game";
const PROJECT = `${REPO}/unity`;
const VERSION_FILE = `${PROJECT}/ProjectSettings/ProjectVersion.txt`;
const EDITOR_VERSION = "6000.0.23f1";
const MAC_EDITOR =
  `/Applications/Unity/Hub/Editor/${EDITOR_VERSION}/Unity.app/Contents/MacOS/Unity`;
const LOG_DIR = `${REPO}/.swamp/unity/logs`;

const PROJECT_VERSION_TEXT = [
  `m_EditorVersion: ${EDITOR_VERSION}`,
  `m_EditorVersionWithRevision: ${EDITOR_VERSION} (1c4764c07fb4)`,
  "",
].join("\n");

/** A log shaped like a clean batch-mode open and quit. */
const CLEAN_LOG = [
  "Unity Editor version:    6000.0.23f1 (1c4764c07fb4)",
  "COMMAND LINE ARGUMENTS:",
  "-batchmode",
  "[Licensing::Client] Successfully resolved entitlement details",
  "Refreshing native plugins compatible for Editor in 1.00 ms",
  "Start importing Assets/Scripts/Player.cs",
  "- Starting script compilation",
  "- Finished script compilation in 2.345 seconds",
  "Batchmode quit successfully invoked - shutting down!",
].join("\n");

/** A log with two errors, one of them printed twice, and a warning. */
const ERROR_LOG = [
  "Unity Editor version:    6000.0.23f1 (1c4764c07fb4)",
  "- Starting script compilation",
  "Assets/Scripts/Player.cs(12,34): error CS0103: The name 'speed' does not exist in the current context",
  "Assets/Scripts/Player.cs(20,9): warning CS0219: The variable 'unused' is assigned but its value is never used",
  "Assets/Scripts/Enemy.cs(7,1): error CS1002: ; expected",
  "-----CompilerOutput:-stderr----------",
  "Assets/Scripts/Player.cs(12,34): error CS0103: The name 'speed' does not exist in the current context",
  "-----EndCompilerOutput---------------",
  "Scripts have compiler errors.",
  "Aborting batchmode due to failure:",
  "Scripts have compiler errors.",
].join("\n");

const LICENSE_LOG = [
  "Unity Editor version:    6000.0.23f1 (1c4764c07fb4)",
  "[Licensing::Client] Error: Code 500 while verifying entitlements",
  "No valid Unity Editor license found. Please activate your license.",
].join("\n");

const BUILD_LOG = [
  "Unity Editor version:    6000.0.23f1 (1c4764c07fb4)",
  "Executing static method Builds.Pipeline.BuildWindows",
  "Build completed with a result of 'Succeeded' in 120 seconds (120000 ms)",
  "Batchmode quit successfully invoked - shutting down!",
].join("\n");

const PASSING_XML = `<?xml version="1.0" encoding="utf-8"?>
<test-run id="2" testcasecount="3" result="Passed" total="3" passed="2" failed="0" inconclusive="0" skipped="1" asserts="4" engine-version="3.5.0.0" clr-version="4.0.30319.42000" start-time="2026-10-20 10:00:00" end-time="2026-10-20 10:00:02" duration="2.5">
  <test-suite type="TestSuite" id="1000" name="Game.Tests" fullname="Game.Tests" result="Passed" total="3" passed="2" failed="0" inconclusive="0" skipped="1">
    <test-case id="1001" name="Spawns" fullname="Game.Tests.PlayerTests.Spawns" methodname="Spawns" classname="Game.Tests.PlayerTests" runstate="Runnable" seed="1" result="Passed" start-time="2026-10-20 10:00:00" end-time="2026-10-20 10:00:01" duration="0.5" asserts="2" />
    <test-case id="1002" name="Moves" fullname="Game.Tests.PlayerTests.Moves" methodname="Moves" classname="Game.Tests.PlayerTests" runstate="Runnable" seed="1" result="Passed" duration="0.5" asserts="2" />
    <test-case id="1003" name="Flies" fullname="Game.Tests.PlayerTests.Flies" methodname="Flies" classname="Game.Tests.PlayerTests" runstate="Ignored" result="Skipped" label="Ignored">
      <reason><message><![CDATA[Not yet]]></message></reason>
    </test-case>
  </test-suite>
</test-run>
`;

const FAILING_XML = `<?xml version="1.0" encoding="utf-8"?>
<test-run id="2" testcasecount="3" result="Failed" total="3" passed="1" failed="2" inconclusive="0" skipped="0" asserts="3">
  <test-suite type="TestFixture" id="1000" name="PlayerTests" fullname="Game.Tests.PlayerTests" result="Failed" total="3" passed="1" failed="2">
    <test-case id="1001" name="Spawns" fullname="Game.Tests.PlayerTests.Spawns" result="Passed" duration="0.1" />
    <test-case id="1002" name="Moves(&quot;left&quot;)" fullname="Game.Tests.PlayerTests.Moves(&quot;left&quot;)" result="Failed" duration="0.2">
      <failure>
        <message><![CDATA[  Expected: 1
  But was:  0
]]></message>
        <stack-trace><![CDATA[at Game.Tests.PlayerTests.Moves (System.String direction) [0x0001a] in Assets/Tests/PlayerTests.cs:24]]></stack-trace>
      </failure>
      <output><![CDATA[moved]]></output>
    </test-case>
    <test-case id="1003" name="Jumps" fullname="Game.Tests.PlayerTests.Jumps" result="Failed" label="Error" duration="0.3">
      <failure>
        <message>System.NullReferenceException : Object reference &lt;null&gt;</message>
      </failure>
    </test-case>
  </test-suite>
</test-run>
`;

interface FakeFiles extends Files {
  contents: Map<string, string>;
  present: Set<string>;
  directories: string[];
}

function fakeFiles(
  contents: Record<string, string> = {},
  present: string[] = [],
): FakeFiles {
  const files: FakeFiles = {
    contents: new Map(Object.entries(contents)),
    present: new Set(present),
    directories: [],
    readTextFile: (path) => {
      const text = files.contents.get(path);
      return text === undefined
        ? Promise.reject(new Deno.errors.NotFound(path))
        : Promise.resolve(text);
    },
    exists: (path) =>
      Promise.resolve(files.present.has(path) || files.contents.has(path)),
    mkdir: (path) => {
      files.directories.push(path);
      return Promise.resolve();
    },
  };
  return files;
}

/** Files for a project whose editor is installed at the macOS Hub location. */
function projectFiles(): FakeFiles {
  return fakeFiles({ [VERSION_FILE]: PROJECT_VERSION_TEXT }, [MAC_EDITOR]);
}

interface FakeRun {
  runner: Runner;
  requests: RunRequest[];
}

/**
 * A runner that behaves like the editor: it writes the log the test supplies
 * to the -logFile path and, when given one, the result XML to -testResults.
 */
function fakeRunner(
  files: FakeFiles,
  options: {
    log?: string;
    xml?: string;
    code?: number | null;
    timedOut?: boolean;
    error?: Error;
  } = {},
): FakeRun {
  const requests: RunRequest[] = [];
  const runner: Runner = (request) => {
    requests.push(request);
    if (options.error !== undefined) {
      return Promise.reject(options.error);
    }
    const logFile = request.args[request.args.indexOf("-logFile") + 1];
    if (logFile !== undefined && options.log !== undefined) {
      files.contents.set(logFile, options.log);
    }
    const results = request.args.indexOf("-testResults");
    const resultsFile = results === -1 ? undefined : request.args[results + 1];
    if (resultsFile !== undefined && options.xml !== undefined) {
      files.contents.set(resultsFile, options.xml);
    }
    const result: RunResult = {
      code: options.code === undefined ? 0 : options.code,
      output: "",
      timedOut: options.timedOut ?? false,
    };
    return Promise.resolve(result);
  };
  return { runner, requests };
}

interface TestContext {
  context: MethodContext;
  getWrittenResources: () => Array<{
    specName: string;
    name: string;
    data: Record<string, unknown>;
  }>;
  getLogs: () => Array<{ level: string; message: string; args: unknown[] }>;
}

function testContext(
  methodName: string,
  globalArgs: Record<string, unknown> = {},
): TestContext {
  const created = createModelTestContext({
    methodName,
    repoDir: REPO,
    globalArgs: {
      projectPath: "unity",
      timeoutSeconds: 60,
      logDir: ".swamp/unity/logs",
      ...globalArgs,
    },
  });
  return {
    context: created.context as unknown as MethodContext,
    getWrittenResources: created.getWrittenResources,
    getLogs: created.getLogs,
  };
}

const PLATFORM: { _platform: HostPlatform; _home: string } = {
  _platform: "darwin",
  _home: "/Users/builder",
};

const { version, compile, test, build } = behavior.methods;

Deno.test("parseProjectVersion reads both version lines and tolerates CRLF", () => {
  const parsed = parseProjectVersion(
    PROJECT_VERSION_TEXT.replace(/\n/g, "\r\n"),
  );
  assertEquals(parsed, {
    editorVersion: EDITOR_VERSION,
    editorVersionWithRevision: `${EDITOR_VERSION} (1c4764c07fb4)`,
  });
  assertEquals(parseProjectVersion("m_EditorVersion: 2022.3.50f1\n"), {
    editorVersion: "2022.3.50f1",
  });
});

Deno.test("parseProjectVersion rejects a file without m_EditorVersion", () => {
  let message = "";
  try {
    parseProjectVersion("m_EditorVersionWithRevision: 1 (a)\n");
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assertStringIncludes(message, "no m_EditorVersion line");
});

Deno.test("hubEditorCandidates gives the documented Hub location per platform", () => {
  assertEquals(hubEditorCandidates("2022.3.50f1", "darwin", "/Users/b"), [
    "/Applications/Unity/Hub/Editor/2022.3.50f1/Unity.app/Contents/MacOS/Unity",
  ]);
  assertEquals(hubEditorCandidates("2022.3.50f1", "windows", "C:\\Users\\b"), [
    "C:\\Program Files\\Unity\\Hub\\Editor\\2022.3.50f1\\Editor\\Unity.exe",
  ]);
  assertEquals(hubEditorCandidates("2022.3.50f1", "linux", "/home/b/"), [
    "/home/b/Unity/Hub/Editor/2022.3.50f1/Editor/Unity",
    "/home/b/Unity/Hub/Editor/2022.3.50f1/Unity",
    "/opt/Unity/Hub/Editor/2022.3.50f1/Editor/Unity",
  ]);
});

Deno.test("parseEditorLog counts distinct diagnostics, keeps the first N and finds the summary", () => {
  const report = parseEditorLog(ERROR_LOG, 2);
  assertEquals(report.errorCount, 2);
  assertEquals(report.warningCount, 1);
  assertEquals(report.diagnostics.length, 2);
  assertEquals(report.diagnosticsTruncated, true);
  assertEquals(report.diagnostics[0], {
    file: "Assets/Scripts/Player.cs",
    line: 12,
    column: 34,
    severity: "error",
    code: "CS0103",
    message: "The name 'speed' does not exist in the current context",
  });
  assertEquals(report.diagnostics[1]?.severity, "warning");
  assertEquals(report.summaryLine, "Scripts have compiler errors.");
  assertEquals(report.licenseLine, undefined);
  assertEquals(report.lineCount, 11);
  assertStringIncludes(report.excerpt.join("\n"), "error CS1002");
});

Deno.test("parseEditorLog names a licensing failure and not a successful entitlement line", () => {
  assertEquals(
    parseEditorLog(LICENSE_LOG, 10).licenseLine,
    "[Licensing::Client] Error: Code 500 while verifying entitlements",
  );
  const clean = parseEditorLog(CLEAN_LOG, 10);
  assertEquals(clean.licenseLine, undefined);
  assertEquals(clean.errorCount, 0);
  assertEquals(clean.summaryLine, undefined);
});

Deno.test("parseEditorLog bounds the excerpt and keeps the lines that matter", () => {
  const noise = Array.from({ length: 500 }, (_, i) => `importing asset ${i}`);
  const report = parseEditorLog(
    ["Assets/A.cs(1,1): error CS0001: first", ...noise, "last line"].join("\n"),
    10,
  );
  assert(report.excerpt.length <= 120);
  assertEquals(report.excerpt[0], "Assets/A.cs(1,1): error CS0001: first");
  assertEquals(report.excerpt.at(-1), "last line");
  assertEquals(report.lineCount, 502);
});

Deno.test("parseNunitResults reads the totals and ignores passed and skipped cases", () => {
  const report = parseNunitResults(PASSING_XML, 10);
  assertEquals(report, {
    result: "Passed",
    total: 3,
    passed: 2,
    failed: 0,
    inconclusive: 0,
    skipped: 1,
    failures: [],
    failuresTruncated: false,
  });
});

Deno.test("parseNunitResults reads failed cases with decoded names, CDATA messages and stack traces", () => {
  const report = parseNunitResults(FAILING_XML, 10);
  assertEquals(report.result, "Failed");
  assertEquals(report.failed, 2);
  assertEquals(report.failures.length, 2);
  assertEquals(report.failures[0], {
    name: 'Moves("left")',
    fullName: 'Game.Tests.PlayerTests.Moves("left")',
    message: "Expected: 1\n  But was:  0",
    stackTrace:
      "at Game.Tests.PlayerTests.Moves (System.String direction) [0x0001a] in Assets/Tests/PlayerTests.cs:24",
  });
  assertEquals(report.failures[1], {
    name: "Jumps",
    fullName: "Game.Tests.PlayerTests.Jumps",
    message: "System.NullReferenceException : Object reference <null>",
  });
});

Deno.test("parseNunitResults caps the failures it keeps and rejects a file without test-run", () => {
  const report = parseNunitResults(FAILING_XML, 1);
  assertEquals(report.failures.length, 1);
  assertEquals(report.failuresTruncated, true);
  assertEquals(report.failed, 2);
  let message = "";
  try {
    parseNunitResults("<html></html>", 10);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assertStringIncludes(message, "no <test-run> element");
});

Deno.test("version records the project's version and the Hub editor that exists", async () => {
  const files = projectFiles();
  const { context, getWrittenResources, getLogs } = testContext("version");
  const result = await version.execute({ _files: files, ...PLATFORM }, context);
  const written = getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0]?.specName, "version");
  assertEquals(written[0]?.name, "version");
  const data = written[0]?.data ?? {};
  assertEquals(data.projectPath, PROJECT);
  assertEquals(data.editorVersion, EDITOR_VERSION);
  assertEquals(
    data.editorVersionWithRevision,
    `${EDITOR_VERSION} (1c4764c07fb4)`,
  );
  assertEquals(data.editorPath, MAC_EDITOR);
  assertEquals(data.editorSource, "hub");
  assertEquals(data.editorExists, true);
  assertEquals(data.candidates, [MAC_EDITOR]);
  assertEquals(data.platform, "darwin");
  assertMatch(String(data.readAt), /^\d{4}-\d{2}-\d{2}T/);
  assertEquals(result.dataHandles.length, 1);
  assert(getLogs().some((log) => log.message.includes("uses Unity {version}")));
});

Deno.test("version prefers the editor global argument and records when it is missing", async () => {
  const files = projectFiles();
  const { context, getWrittenResources } = testContext("version", {
    editor: "/opt/unity/Editor/Unity",
  });
  await version.execute({ _files: files, ...PLATFORM }, context);
  const data = getWrittenResources()[0]?.data ?? {};
  assertEquals(data.editorPath, "/opt/unity/Editor/Unity");
  assertEquals(data.editorSource, "argument");
  assertEquals(data.editorExists, false);
  assertEquals(data.candidates, ["/opt/unity/Editor/Unity"]);
});

Deno.test("version tries every Linux candidate and records the one that exists", async () => {
  const linuxEditor = `/home/builder/Unity/Hub/Editor/${EDITOR_VERSION}/Unity`;
  const files = fakeFiles({ [VERSION_FILE]: PROJECT_VERSION_TEXT }, [
    linuxEditor,
  ]);
  const { context, getWrittenResources } = testContext("version");
  await version.execute(
    { _files: files, _platform: "linux", _home: "/home/builder" },
    context,
  );
  const data = getWrittenResources()[0]?.data ?? {};
  assertEquals(data.editorPath, linuxEditor);
  assertEquals(data.editorExists, true);
  assertEquals((data.candidates as string[]).length, 3);
});

Deno.test("version fails when projectPath is not a Unity project, and writes nothing", async () => {
  const files = fakeFiles();
  const { context, getWrittenResources } = testContext("version");
  await assertRejects(
    () => version.execute({ _files: files, ...PLATFORM }, context),
    Error,
    "is not a Unity project directory",
  );
  assertEquals(getWrittenResources(), []);
});

Deno.test("compile runs the editor with the documented arguments and records a clean log", async () => {
  const files = projectFiles();
  const { runner, requests } = fakeRunner(files, { log: CLEAN_LOG });
  const { context, getWrittenResources, getLogs } = testContext("compile");
  const result = await compile.execute(
    { maxDiagnostics: 50, _runner: runner, _files: files, ...PLATFORM },
    context,
  );
  assertEquals(requests.length, 1);
  const request = requests[0];
  assert(request !== undefined);
  assertEquals(request.command, MAC_EDITOR);
  assertEquals(request.args.slice(0, 6), [
    "-batchmode",
    "-nographics",
    "-quit",
    "-projectPath",
    PROJECT,
    "-logFile",
  ]);
  assertMatch(
    request.args[6] ?? "",
    new RegExp(`^${LOG_DIR}/compile-.*\\.log$`),
  );
  assertEquals(request.timeoutMs, 60_000);
  assertEquals(files.directories, [LOG_DIR]);
  const written = getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0]?.specName, "compile");
  assertEquals(written[0]?.name, "compile");
  const data = written[0]?.data ?? {};
  assertEquals(data.projectPath, PROJECT);
  assertEquals(data.editorVersion, EDITOR_VERSION);
  assertEquals(data.editorPath, MAC_EDITOR);
  assertEquals(data.exitCode, 0);
  assertEquals(data.errorCount, 0);
  assertEquals(data.warningCount, 0);
  assertEquals(data.diagnostics, []);
  assertEquals(data.diagnosticsTruncated, false);
  assertEquals(data.summaryLine, undefined);
  assertEquals(data.logFile, request.args[6]);
  assertEquals(data.logLines, 9);
  assert(typeof data.durationSeconds === "number");
  assertStringIncludes(
    (data.logExcerpt as string[]).join("\n"),
    "Batchmode quit successfully invoked",
  );
  assertEquals(result.dataHandles.length, 1);
  assert(
    getLogs().some((log) => log.message.startsWith("Compiled {projectPath}")),
  );
});

Deno.test("compile records compiler errors with the exit code instead of failing", async () => {
  const files = projectFiles();
  const { runner } = fakeRunner(files, { log: ERROR_LOG, code: 1 });
  const { context, getWrittenResources } = testContext("compile");
  await compile.execute(
    { maxDiagnostics: 1, _runner: runner, _files: files, ...PLATFORM },
    context,
  );
  const data = getWrittenResources()[0]?.data ?? {};
  assertEquals(data.exitCode, 1);
  assertEquals(data.errorCount, 2);
  assertEquals(data.warningCount, 1);
  assertEquals((data.diagnostics as unknown[]).length, 1);
  assertEquals(data.diagnosticsTruncated, true);
  assertEquals(data.summaryLine, "Scripts have compiler errors.");
});

Deno.test("compile fails on a non-zero exit without diagnostics, and writes nothing", async () => {
  const files = projectFiles();
  const { runner } = fakeRunner(files, {
    log:
      "Unity Editor version: 6000.0.23f1\nFatal Error! It looks like another Unity instance is running with this project open.",
    code: 1,
  });
  const { context, getWrittenResources } = testContext("compile");
  await assertRejects(
    () =>
      compile.execute(
        { maxDiagnostics: 50, _runner: runner, _files: files, ...PLATFORM },
        context,
      ),
    Error,
    "the log has no compiler errors",
  );
  assertEquals(getWrittenResources(), []);
});

Deno.test("compile fails with a licensing error that quotes the log line", async () => {
  const files = projectFiles();
  const { runner } = fakeRunner(files, { log: LICENSE_LOG, code: 1 });
  const { context, getWrittenResources } = testContext("compile");
  const error = await assertRejects(
    () =>
      compile.execute(
        { maxDiagnostics: 50, _runner: runner, _files: files, ...PLATFORM },
        context,
      ),
    Error,
    "could not get a license",
  );
  assertStringIncludes(error.message, "[Licensing::Client] Error");
  assertEquals(getWrittenResources(), []);
});

Deno.test("compile reports a timeout and the log file it was writing", async () => {
  const files = projectFiles();
  const { runner } = fakeRunner(files, {
    log: CLEAN_LOG,
    code: null,
    timedOut: true,
  });
  const { context, getWrittenResources } = testContext("compile");
  const error = await assertRejects(
    () =>
      compile.execute(
        { maxDiagnostics: 50, _runner: runner, _files: files, ...PLATFORM },
        context,
      ),
    Error,
    "did not exit within 60 seconds",
  );
  assertStringIncludes(error.message, `${LOG_DIR}/compile-`);
  assertEquals(getWrittenResources(), []);
});

Deno.test("compile fails when the project's editor version is not installed, naming the paths tried", async () => {
  const files = fakeFiles({ [VERSION_FILE]: PROJECT_VERSION_TEXT });
  const { runner, requests } = fakeRunner(files, { log: CLEAN_LOG });
  const { context } = testContext("compile");
  const error = await assertRejects(
    () =>
      compile.execute(
        {
          maxDiagnostics: 50,
          _runner: runner,
          _files: files,
          _platform: "windows",
          _home: "C:\\Users\\builder",
        },
        context,
      ),
    Error,
    `Unity ${EDITOR_VERSION} (the project's version) was not found`,
  );
  assertStringIncludes(
    error.message,
    `C:\\Program Files\\Unity\\Hub\\Editor\\${EDITOR_VERSION}\\Editor\\Unity.exe`,
  );
  assertEquals(requests, []);
});

Deno.test("compile explains an editor argument that does not exist or cannot start", async () => {
  const files = fakeFiles({ [VERSION_FILE]: PROJECT_VERSION_TEXT });
  const { runner } = fakeRunner(files, { log: CLEAN_LOG });
  const { context } = testContext("compile", { editor: "/nowhere/Unity" });
  await assertRejects(
    () =>
      compile.execute(
        { maxDiagnostics: 50, _runner: runner, _files: files, ...PLATFORM },
        context,
      ),
    Error,
    'the editor global argument "/nowhere/Unity" does not exist',
  );
  const present = fakeFiles({ [VERSION_FILE]: PROJECT_VERSION_TEXT }, [
    "/nowhere/Unity",
  ]);
  const failing = fakeRunner(present, {
    error: new Deno.errors.NotFound("spawn"),
  });
  await assertRejects(
    () =>
      compile.execute(
        {
          maxDiagnostics: 50,
          _runner: failing.runner,
          _files: present,
          ...PLATFORM,
        },
        context,
      ),
    Error,
    "could not be started",
  );
});

Deno.test("compile reads the console output when the editor wrote no log file", async () => {
  const files = projectFiles();
  const requests: RunRequest[] = [];
  const runner: Runner = (request) => {
    requests.push(request);
    return Promise.resolve({ code: 0, output: CLEAN_LOG, timedOut: false });
  };
  const { context, getWrittenResources, getLogs } = testContext("compile");
  await compile.execute(
    { maxDiagnostics: 50, _runner: runner, _files: files, ...PLATFORM },
    context,
  );
  assertEquals(getWrittenResources()[0]?.data.logLines, 9);
  assert(
    getLogs().some((log) =>
      log.level === "warning" && log.message.includes("wrote no log file")
    ),
  );
});

Deno.test("compile resolves an absolute projectPath and logDir as they are", async () => {
  const files = fakeFiles(
    { "/srv/game/ProjectSettings/ProjectVersion.txt": PROJECT_VERSION_TEXT },
    [MAC_EDITOR],
  );
  const { runner, requests } = fakeRunner(files, { log: CLEAN_LOG });
  const { context, getWrittenResources } = testContext("compile", {
    projectPath: "/srv/game",
    logDir: "/var/log/unity",
  });
  await compile.execute(
    { maxDiagnostics: 50, _runner: runner, _files: files, ...PLATFORM },
    context,
  );
  assertEquals(requests[0]?.args[4], "/srv/game");
  assertEquals(files.directories, ["/var/log/unity"]);
  assertMatch(
    String(getWrittenResources()[0]?.data.logFile),
    /^\/var\/log\/unity\/compile-/,
  );
});

Deno.test("test runs the Test Framework without -quit and records a passing run", async () => {
  const files = projectFiles();
  const { runner, requests } = fakeRunner(files, {
    log: CLEAN_LOG,
    xml: PASSING_XML,
  });
  const { context, getWrittenResources, getLogs } = testContext("test");
  const result = await test.execute(
    {
      platform: "EditMode",
      maxFailures: 50,
      _runner: runner,
      _files: files,
      ...PLATFORM,
    },
    context,
  );
  const request = requests[0];
  assert(request !== undefined);
  assertEquals(request.command, MAC_EDITOR);
  assert(!request.args.includes("-quit"), "-quit is not passed with -runTests");
  assertEquals(request.args.slice(0, 7), [
    "-batchmode",
    "-nographics",
    "-projectPath",
    PROJECT,
    "-runTests",
    "-testPlatform",
    "EditMode",
  ]);
  assertEquals(request.args[7], "-testResults");
  assertMatch(
    request.args[8] ?? "",
    new RegExp(`^${LOG_DIR}/test-EditMode-.*\\.xml$`),
  );
  assertEquals(request.args[9], "-logFile");
  const written = getWrittenResources();
  assertEquals(written[0]?.specName, "test");
  assertEquals(written[0]?.name, "test");
  const data = written[0]?.data ?? {};
  assertEquals(data.platform, "EditMode");
  assertEquals(data.resultsFile, request.args[8]);
  assertEquals(data.result, "Passed");
  assertEquals(data.total, 3);
  assertEquals(data.passed, 2);
  assertEquals(data.failed, 0);
  assertEquals(data.inconclusive, 0);
  assertEquals(data.skipped, 1);
  assertEquals(data.failures, []);
  assertEquals(data.failuresTruncated, false);
  assertEquals(data.exitCode, 0);
  assertEquals(data.editorVersion, EDITOR_VERSION);
  assertEquals(result.dataHandles.length, 1);
  assert(getLogs().some((log) => log.message.includes("{passed} passed")));
});

Deno.test("test passes PlayMode and the filters through and records failures with messages", async () => {
  const files = projectFiles();
  const { runner, requests } = fakeRunner(files, {
    log: CLEAN_LOG,
    xml: FAILING_XML,
    code: 2,
  });
  const { context, getWrittenResources } = testContext("test");
  await test.execute(
    {
      platform: "PlayMode",
      testFilter: "Game.Tests.PlayerTests",
      testCategory: "Fast;!Slow",
      maxFailures: 1,
      _runner: runner,
      _files: files,
      ...PLATFORM,
    },
    context,
  );
  const args = requests[0]?.args ?? [];
  assertEquals(args[6], "PlayMode");
  assertEquals(args.slice(9, 13), [
    "-testFilter",
    "Game.Tests.PlayerTests",
    "-testCategory",
    "Fast;!Slow",
  ]);
  const data = getWrittenResources()[0]?.data ?? {};
  assertEquals(data.platform, "PlayMode");
  assertEquals(data.result, "Failed");
  assertEquals(data.failed, 2);
  assertEquals(data.exitCode, 2);
  assertEquals((data.failures as unknown[]).length, 1);
  assertEquals(data.failuresTruncated, true);
  assertEquals(
    (data.failures as Array<{ fullName: string }>)[0]?.fullName,
    'Game.Tests.PlayerTests.Moves("left")',
  );
});

Deno.test("test fails when no result file was written, naming compiler errors when the log has them", async () => {
  const files = projectFiles();
  const { runner } = fakeRunner(files, { log: ERROR_LOG, code: 1 });
  const { context, getWrittenResources } = testContext("test");
  const error = await assertRejects(
    () =>
      test.execute(
        {
          platform: "EditMode",
          maxFailures: 50,
          _runner: runner,
          _files: files,
          ...PLATFORM,
        },
        context,
      ),
    Error,
    "wrote no result file",
  );
  assertStringIncludes(error.message, "2 compiler errors");
  assertEquals(getWrittenResources(), []);
});

Deno.test("test fails on a licensing error and on a timeout, and writes nothing", async () => {
  const files = projectFiles();
  const { context, getWrittenResources } = testContext("test");
  const licensed = fakeRunner(files, { log: LICENSE_LOG, code: 1 });
  await assertRejects(
    () =>
      test.execute(
        {
          platform: "EditMode",
          maxFailures: 50,
          _runner: licensed.runner,
          _files: files,
          ...PLATFORM,
        },
        context,
      ),
    Error,
    "could not get a license",
  );
  const slow = fakeRunner(files, {
    log: CLEAN_LOG,
    code: null,
    timedOut: true,
  });
  await assertRejects(
    () =>
      test.execute(
        {
          platform: "EditMode",
          maxFailures: 50,
          _runner: slow.runner,
          _files: files,
          ...PLATFORM,
        },
        context,
      ),
    Error,
    "was killed",
  );
  assertEquals(getWrittenResources(), []);
});

Deno.test("build runs the method for the target with extra arguments and records the outcome", async () => {
  const files = projectFiles();
  const { runner, requests } = fakeRunner(files, { log: BUILD_LOG });
  const { context, getWrittenResources, getLogs } = testContext("build");
  const result = await build.execute(
    {
      method: "Builds.Pipeline.BuildWindows",
      buildTarget: "win64",
      extraArgs: ["-outputPath", "Builds/win64", "-development"],
      _runner: runner,
      _files: files,
      ...PLATFORM,
    },
    context,
  );
  const request = requests[0];
  assert(request !== undefined);
  assertEquals(request.args.slice(0, 12), [
    "-batchmode",
    "-nographics",
    "-quit",
    "-projectPath",
    PROJECT,
    "-buildTarget",
    "win64",
    "-executeMethod",
    "Builds.Pipeline.BuildWindows",
    "-outputPath",
    "Builds/win64",
    "-development",
  ]);
  assertEquals(request.args[12], "-logFile");
  assertMatch(
    request.args[13] ?? "",
    new RegExp(`^${LOG_DIR}/build-.*\\.log$`),
  );
  const written = getWrittenResources();
  assertEquals(written[0]?.specName, "build");
  assertEquals(written[0]?.name, "build");
  const data = written[0]?.data ?? {};
  assertEquals(data.method, "Builds.Pipeline.BuildWindows");
  assertEquals(data.buildTarget, "win64");
  assertEquals(data.extraArgs, ["-outputPath", "Builds/win64", "-development"]);
  assertEquals(data.exitCode, 0);
  assertEquals(data.editorVersion, EDITOR_VERSION);
  assertEquals(data.logFile, request.args[13]);
  assertEquals(data.logLines, 4);
  assertEquals(data.summaryLine, undefined);
  assertStringIncludes(
    (data.logExcerpt as string[]).join("\n"),
    "Build completed with a result of 'Succeeded'",
  );
  assertEquals(result.dataHandles.length, 1);
  assert(
    getLogs().some((log) => log.message.startsWith("Built {projectPath}")),
  );
});

Deno.test("build fails on a non-zero exit with the summary line and compiler errors, and writes nothing", async () => {
  const files = projectFiles();
  const { runner } = fakeRunner(files, { log: ERROR_LOG, code: 1 });
  const { context, getWrittenResources } = testContext("build");
  const error = await assertRejects(
    () =>
      build.execute(
        {
          method: "Builds.Pipeline.BuildWindows",
          buildTarget: "win64",
          extraArgs: [],
          _runner: runner,
          _files: files,
          ...PLATFORM,
        },
        context,
      ),
    Error,
    "exited with code 1 running Builds.Pipeline.BuildWindows with 2 compiler errors",
  );
  assertStringIncludes(error.message, '("Scripts have compiler errors.")');
  assertEquals(getWrittenResources(), []);
});

Deno.test("build refuses extra arguments that repeat the ones it sets, before running anything", async () => {
  const files = projectFiles();
  const { runner, requests } = fakeRunner(files, { log: BUILD_LOG });
  const { context, getWrittenResources } = testContext("build");
  await assertRejects(
    () =>
      build.execute(
        {
          method: "Builds.Pipeline.BuildWindows",
          buildTarget: "win64",
          extraArgs: ["-quit", "-LogFile", "x.log"],
          _runner: runner,
          _files: files,
          ...PLATFORM,
        },
        context,
      ),
    Error,
    "may not repeat the arguments build sets itself: -quit, -LogFile",
  );
  assertEquals(requests, []);
  assertEquals(getWrittenResources(), []);
});

Deno.test("build fails on a licensing error even when the exit code is zero", async () => {
  const files = projectFiles();
  const { runner } = fakeRunner(files, { log: LICENSE_LOG, code: 0 });
  const { context, getWrittenResources } = testContext("build");
  await assertRejects(
    () =>
      build.execute(
        {
          method: "Builds.Pipeline.BuildWindows",
          buildTarget: "linux64",
          extraArgs: [],
          _runner: runner,
          _files: files,
          ...PLATFORM,
        },
        context,
      ),
    Error,
    "could not get a license",
  );
  assertEquals(getWrittenResources(), []);
});

Deno.test("method argument schemas apply their defaults and reject bad values", () => {
  const compileArgs = behavior.methods.compile.arguments.parse({});
  assertEquals(compileArgs, { maxDiagnostics: 50 });
  const testArgs = behavior.methods.test.arguments.parse({});
  assertEquals(testArgs, { platform: "EditMode", maxFailures: 50 });
  assert(
    !behavior.methods.test.arguments.safeParse({ platform: "Android" }).success,
  );
  const buildArgs = behavior.methods.build.arguments.parse({
    method: "Builds.Pipeline.BuildWindows",
    buildTarget: "win64",
  });
  assertEquals(buildArgs.extraArgs, []);
  assert(
    !behavior.methods.build.arguments.safeParse({
      method: "NoDot",
      buildTarget: "win64",
    }).success,
  );
  assert(
    !behavior.methods.build.arguments.safeParse({
      method: "A.B",
      buildTarget: "ps5",
    }).success,
  );
  const globals = behavior.globalArguments.parse({ projectPath: "unity" });
  assertEquals(globals.timeoutSeconds, 1800);
  assertEquals(globals.logDir, ".swamp/unity/logs");
});

Deno.test("every method resource validates against its declared schema", async () => {
  const files = projectFiles();
  const { context, getWrittenResources } = testContext("version");
  await version.execute({ _files: files, ...PLATFORM }, context);
  const compiled = fakeRunner(files, { log: ERROR_LOG, code: 1 });
  await compile.execute(
    {
      maxDiagnostics: 50,
      _runner: compiled.runner,
      _files: files,
      ...PLATFORM,
    },
    context,
  );
  const tested = fakeRunner(files, { log: CLEAN_LOG, xml: FAILING_XML });
  await test.execute(
    {
      platform: "EditMode",
      maxFailures: 50,
      _runner: tested.runner,
      _files: files,
      ...PLATFORM,
    },
    context,
  );
  const built = fakeRunner(files, { log: BUILD_LOG });
  await build.execute(
    {
      method: "Builds.Pipeline.BuildWindows",
      buildTarget: "win64",
      extraArgs: [],
      _runner: built.runner,
      _files: files,
      ...PLATFORM,
    },
    context,
  );
  const written = getWrittenResources();
  assertEquals(
    written.map((record) => record.specName),
    ["version", "compile", "test", "build"],
  );
  for (const record of written) {
    const spec =
      behavior.resources[record.specName as keyof typeof behavior.resources];
    const parsed = spec.schema.safeParse(record.data);
    assert(
      parsed.success,
      `${record.specName}: ${JSON.stringify(parsed.error?.issues)}`,
    );
  }
});
