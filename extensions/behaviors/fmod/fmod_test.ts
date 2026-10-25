/**
 * Unit tests for the FMOD Studio behavior. Every test injects a runner and
 * file helpers, so nothing here starts FMOD Studio. The transcripts are
 * shaped like the tool's own output.
 *
 * @module
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20261016.58";
import {
  behavior,
  EVENT_MAX,
  type Files,
  INSPECT_SCRIPT,
  invocation,
  isAppBundle,
  type MethodContext,
  parseStudioOutput,
  resolveFrom,
  type Runner,
  type RunRequest,
  type RunResult,
} from "./fmod.ts";
import source from "./fmod.ts" with { type: "text" };

const PROJECT = "/work/game/audio/Examples.fspro";
const TEMP_DIR = "/tmp/fake-fmod-temp";
const APP_BUNDLE = "/Applications/FMOD Studio.app";

const OPENED = [
  "",
  `Loading project "${PROJECT}"...`,
  "[Scripting] ScriptServer is disabled.",
  "Successfully opened project.",
];

/** A successful -build -platforms Desktop transcript. */
const BUILD_OUTPUT = [
  ...OPENED,
  `Building project "${PROJECT}"...`,
  "Build Status: Gathering file stats...",
  "Build Status: Preparing to build for Desktop...",
  'Build Status: Checking dependencies for "Master"...',
  'Build Status: Loading "Master" objects...',
  'Build Status: Building "Master" for Desktop...',
  'Build Status: Checking dependencies for "SFX"...',
  'Build Status: Loading "SFX" objects...',
  'Build Status: Building "SFX" for Desktop...',
  "Build completed successfully.",
].join("\n");

const BUILD_STDERR = Array.from(
  { length: 3 },
  () =>
    "fsbank_file_disk.cpp(26) : FSBank error (7) : An operating system based file error was encountered.",
).join("\n");

const MISSING_PROJECT_OUTPUT = [
  "",
  `Loading project "${PROJECT}"...`,
  `Project Load Error: The project "${PROJECT}" could not be located. Please make sure the file exists.`,
  `Error: Unable to open "${PROJECT}".`,
].join("\n");

const UNKNOWN_BANK_OUTPUT = [
  ...OPENED,
  `Building project "${PROJECT}"...`,
  'Build Banks Error: Could not locate bank "Nope".',
].join("\n");

const UNKNOWN_PLATFORM_OUTPUT = [
  ...OPENED,
  `Building project "${PROJECT}"...`,
  'Build Banks Error: Unknown platform name "Nope".',
].join("\n");

const SCRIPT_ERROR_OUTPUT = [
  ...OPENED,
  `Running script "${TEMP_DIR}/inspect.js"...`,
  `[Scripting] [script-error] An error occured while loading "${TEMP_DIR}/inspect.js": Error: Unable to open script file., callstack:`,
  "",
  "The following scripting errors occurred.",
].join("\n");

const LAUNCHER_OUTPUT =
  "The files /Applications/FMOD Studio.app/Contents/MacOS/a, /Applications/FMOD Studio.app/Contents/MacOS/tty, /Applications/FMOD Studio.app/Contents/MacOS/a, and /Applications/FMOD Studio.app/Contents/MacOS/tty do not exist.";

const DIAGNOSTIC_OUTPUT = [
  ...OPENED,
  "Validating project...",
  'Validation Status: Checking Audio File ["Ambience/amb_noon_loop.ogg"]...',
  "Validation Status: Checking EventFolder for unattached dangling objects...",
  "Validation Status: Checking EventFolder for cyclical references...",
  "Project validation completed successfully.",
].join("\n");

const INSPECT_REPORT = {
  version: {
    productVersion: 2,
    majorVersion: 3,
    minorVersion: 14,
    text: "Version 2.03.14, 64-bit, Qt 6.5.3 under LGPL, Build #164239",
  },
  filePath: PROJECT,
  builtBanksOutputDirectory: "",
  platforms: [
    {
      id: "{c9f35dc9-139f-472b-8888-8ad9fad5168c}",
      name: "Desktop",
      subDirectory: "Desktop",
      buildMetadataOnly: false,
    },
    {
      id: "{8d452eed-4519-4e5e-9f8d-5ab4c83b0c2a}",
      name: "HTML5",
      subDirectory: "HTML5",
      buildMetadataOnly: true,
    },
  ],
  banks: [
    {
      id: "{816d4737-171a-41e7-a9f0-32996ece71cb}",
      name: "Master",
      path: "bank:/Master",
      isMasterBank: true,
      events: [],
    },
    {
      id: "{561cd480-bd2b-4c2e-b919-d775f9c4f409}",
      name: "SFX",
      path: "bank:/SFX",
      isMasterBank: false,
      events: ["Explosion", "Pistol"],
    },
  ],
  eventCount: 3,
  events: [
    {
      id: "{1f687138-e06c-40f5-9bac-57f84bbcedd3}",
      name: "Explosion",
      path: "event:/Weapons/Explosion",
      banks: ["SFX"],
    },
    {
      id: "{03c85dcf-c4eb-4094-83c7-7839b5d058e8}",
      name: "Pistol",
      path: "event:/Weapons/Pistol",
      banks: ["SFX"],
    },
    {
      id: "{903988af-df31-4d76-81d6-cbf5de60c09c}",
      name: "knapsack_open",
      path: "event:/Haptics/knapsack_open",
      banks: [],
    },
  ],
};

function inspectOutput(report: unknown): string {
  return [
    ...OPENED,
    `Running script "${TEMP_DIR}/inspect.js"...`,
    "[Scripting] SWAMP_FMOD_INSPECT_BEGIN",
    `[Scripting] ${JSON.stringify(report)}`,
    "[Scripting] SWAMP_FMOD_INSPECT_END",
  ].join("\n");
}

interface FakeFiles extends Files {
  written: Map<string, string>;
  removed: string[];
  readable: Map<string, string>;
}

function fakeFiles(readable: Record<string, string> = {}): FakeFiles {
  const files: FakeFiles = {
    written: new Map(),
    removed: [],
    readable: new Map(Object.entries(readable)),
    makeTempDir: () => Promise.resolve(TEMP_DIR),
    writeTextFile: (path, text) => {
      files.written.set(path, text);
      return Promise.resolve();
    },
    readTextFile: (path) => {
      const text = files.readable.get(path);
      return text === undefined
        ? Promise.reject(new Deno.errors.NotFound(path))
        : Promise.resolve(text);
    },
    remove: (path) => {
      files.removed.push(path);
      return Promise.resolve();
    },
  };
  return files;
}

function fakeRunner(result: Partial<RunResult> | Error): {
  runner: Runner;
  requests: RunRequest[];
} {
  const requests: RunRequest[] = [];
  const runner: Runner = (request) => {
    requests.push(request);
    if (result instanceof Error) {
      return Promise.reject(result);
    }
    return Promise.resolve({
      code: 0,
      stdout: BUILD_OUTPUT,
      stderr: "",
      timedOut: false,
      ...result,
    });
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
  signal?: AbortSignal,
): TestContext {
  const created = createModelTestContext({
    methodName,
    repoDir: "/work/game",
    ...(signal === undefined ? {} : { signal }),
    globalArgs: {
      project: "audio/Examples.fspro",
      fmodstudio: "fmodstudiocl",
      timeoutSeconds: 30,
      ...globalArgs,
    },
  });
  return {
    context: created.context as unknown as MethodContext,
    getWrittenResources: created.getWrittenResources,
    getLogs: created.getLogs,
  };
}

const { build, inspect, diagnostic } = behavior.methods;

const NO_BUILD_ARGS = {
  banks: [],
  platforms: [],
  ignoreWarnings: false,
  exportGuids: false,
};

Deno.test("resolveFrom keeps absolute POSIX and Windows paths and joins relative ones", () => {
  assertEquals(
    resolveFrom("/work/game/", "audio/x.fspro"),
    "/work/game/audio/x.fspro",
  );
  assertEquals(resolveFrom("/work/game", "/abs/x.fspro"), "/abs/x.fspro");
  assertEquals(
    resolveFrom("/work/game", "C:\\audio\\x.fspro"),
    "C:\\audio\\x.fspro",
  );
});

Deno.test("isAppBundle recognises a macOS bundle path with or without a trailing slash", () => {
  assert(isAppBundle(APP_BUNDLE));
  assert(isAppBundle(`${APP_BUNDLE}/`));
  assert(!isAppBundle("fmodstudiocl"));
  assert(!isAppBundle("/opt/fmodstudio/fmodstudiocl"));
});

Deno.test("invocation runs an executable as it is", () => {
  const run = invocation(
    "/opt/fmodstudio/fmodstudiocl",
    "/work/game",
    TEMP_DIR,
    [
      "-build",
      PROJECT,
    ],
  );
  assertEquals(run, {
    command: "/opt/fmodstudio/fmodstudiocl",
    args: ["-build", PROJECT],
  });
});

Deno.test("invocation starts an app bundle through open with captured output and a working directory", () => {
  const run = invocation(APP_BUNDLE, "/work/game", TEMP_DIR, [
    "-build",
    PROJECT,
  ]);
  assertEquals(run.command, "open");
  assertEquals(run.args, [
    "-W",
    "-a",
    APP_BUNDLE,
    "--stdout",
    `${TEMP_DIR}/stdout.txt`,
    "--stderr",
    `${TEMP_DIR}/stderr.txt`,
    "--env",
    "FMODSTUDIOCMDLINE=1",
    "--args",
    "-working-dir",
    "/work/game",
    "-build",
    PROJECT,
  ]);
  assertEquals(run.captures, {
    stdout: `${TEMP_DIR}/stdout.txt`,
    stderr: `${TEMP_DIR}/stderr.txt`,
  });
});

Deno.test("parseStudioOutput reads a successful build", () => {
  const report = parseStudioOutput(BUILD_OUTPUT, BUILD_STDERR);
  assert(report.projectOpened);
  assert(report.buildCompleted);
  assert(!report.validationCompleted);
  assertEquals(report.loadError, undefined);
  assertEquals(report.buildError, undefined);
  assertEquals(report.platformsPrepared, ["Desktop"]);
  assertEquals(report.bankBuilds, [
    { bank: "Master", platform: "Desktop" },
    { bank: "SFX", platform: "Desktop" },
  ]);
  assertEquals(report.warnings, []);
  assertEquals(report.lineCount, 13);
  assertEquals(report.stderrLineCount, 3);
  // Progress lines survive only inside the tail; the first kept line is not one.
  assert(!(report.excerpt[0] ?? "").startsWith("Build Status"));
  assertStringIncludes(
    report.excerpt.join("\n"),
    "Build completed successfully.",
  );
  assertStringIncludes(report.excerpt.join("\n"), "FSBank error (7)");
});

Deno.test("parseStudioOutput names the failures the tool prints", () => {
  assertStringIncludes(
    parseStudioOutput(MISSING_PROJECT_OUTPUT, "").loadError ?? "",
    "Project Load Error",
  );
  assertEquals(
    parseStudioOutput(UNKNOWN_BANK_OUTPUT, "").buildError,
    'Build Banks Error: Could not locate bank "Nope".',
  );
  assertEquals(
    parseStudioOutput(UNKNOWN_PLATFORM_OUTPUT, "").buildError,
    'Build Banks Error: Unknown platform name "Nope".',
  );
  assertStringIncludes(
    parseStudioOutput(SCRIPT_ERROR_OUTPUT, "").scriptError ?? "",
    "[script-error]",
  );
  assert(parseStudioOutput("", LAUNCHER_OUTPUT).launcherNeedsTerminal);
  assert(!parseStudioOutput(BUILD_OUTPUT, "").launcherNeedsTerminal);
});

Deno.test("parseStudioOutput collects warnings and counts validation checks", () => {
  const output = [
    ...OPENED,
    'Warning: Bank "SFX" has no events.',
    "Build Status: Building warning-free bank for Desktop...",
    "Build completed successfully.",
  ].join("\n");
  assertEquals(parseStudioOutput(output, "").warnings, [
    'Warning: Bank "SFX" has no events.',
  ]);
  const diagnostic = parseStudioOutput(DIAGNOSTIC_OUTPUT, "");
  assert(diagnostic.validationCompleted);
  assertEquals(diagnostic.validationChecks, 3);
});

Deno.test("parseStudioOutput extracts the inspect JSON and strips the scripting prefix", () => {
  const report = parseStudioOutput(inspectOutput(INSPECT_REPORT), "");
  assertEquals(JSON.parse(report.inspectJson ?? "null"), INSPECT_REPORT);
  const unterminated = inspectOutput(INSPECT_REPORT).replace(
    "[Scripting] SWAMP_FMOD_INSPECT_END",
    "",
  );
  assertEquals(parseStudioOutput(unterminated, "").inspectJson, undefined);
});

Deno.test("parseStudioOutput bounds the excerpt and keeps the tail", () => {
  const progress = Array.from(
    { length: 500 },
    (_, i) => `Build Status: Building "Bank ${i}" for Desktop...`,
  );
  const output = [...OPENED, ...progress, "Build completed successfully."].join(
    "\n",
  );
  const report = parseStudioOutput(output, "");
  assertEquals(report.bankBuilds.length, 500);
  assert(
    report.excerpt.length <= 120,
    `excerpt has ${report.excerpt.length} lines`,
  );
  assertEquals(report.excerpt[0], `Loading project "${PROJECT}"...`);
  assertEquals(report.excerpt.at(-1), "Build completed successfully.");
  // The 20-line tail ends with the completion line, so 19 progress lines remain.
  assertEquals(
    report.excerpt.filter((line) => line.startsWith("Build Status")).length,
    19,
  );
});

Deno.test("the inspect script is ES5 and prints the markers the parser looks for", () => {
  assertStringIncludes(
    INSPECT_SCRIPT,
    'console.log("SWAMP_FMOD_INSPECT_BEGIN")',
  );
  assertStringIncludes(INSPECT_SCRIPT, 'console.log("SWAMP_FMOD_INSPECT_END")');
  assertStringIncludes(
    INSPECT_SCRIPT,
    "studio.project.model.Bank.findInstances()",
  );
  assertStringIncludes(
    INSPECT_SCRIPT,
    "studio.project.model.Event.findInstances()",
  );
  assertStringIncludes(INSPECT_SCRIPT, `var eventMax = ${EVENT_MAX};`);
  assert(
    !/=>|\blet\b|\bconst\b|`/.test(INSPECT_SCRIPT),
    "the script uses ES5 only",
  );
});

Deno.test("build arguments refuse a bank or platform name with a comma", () => {
  const schema = build.arguments;
  assert(schema.safeParse({ banks: ["Master Bank", "SFX"] }).success);
  assert(!schema.safeParse({ banks: ["Master, SFX"] }).success);
  assert(!schema.safeParse({ platforms: ["Desktop,HTML5"] }).success);
  assert(!schema.safeParse({ banks: [""] }).success);
});

Deno.test("global arguments default the tool and the deadline and need a .fspro project", () => {
  const parsed = behavior.globalArguments.parse({
    project: "audio/Examples.fspro",
  });
  assertEquals(parsed.fmodstudio, "fmodstudiocl");
  assertEquals(parsed.timeoutSeconds, 1800);
  assert(
    !behavior.globalArguments.safeParse({ project: "audio/Examples" }).success,
  );
});

Deno.test("build runs fmodstudiocl -build with the banks and platforms and records the build", async () => {
  const files = fakeFiles();
  const { runner, requests } = fakeRunner({ stderr: BUILD_STDERR });
  const { context, getWrittenResources, getLogs } = testContext("build");
  const result = await build.execute(
    {
      ...NO_BUILD_ARGS,
      banks: ["Master", "SFX"],
      platforms: ["Desktop"],
      _runner: runner,
      _files: files,
    },
    context,
  );
  assertEquals(requests.length, 1);
  const request = requests[0];
  assert(request !== undefined);
  assertEquals(request.command, "fmodstudiocl");
  assertEquals(request.args, [
    "-build",
    "-banks",
    "Master,SFX",
    "-platforms",
    "Desktop",
    PROJECT,
  ]);
  assertEquals(request.timeoutMs, 30_000);
  assertEquals(files.removed, [TEMP_DIR]);
  assertEquals(files.written.size, 0);

  const written = getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0]?.specName, "build");
  assertEquals(written[0]?.name, "build");
  const data = written[0]?.data ?? {};
  assertEquals(data.project, PROJECT);
  assertEquals(data.banks, ["Master", "SFX"]);
  assertEquals(data.platforms, ["Desktop"]);
  assertEquals(data.exitCode, 0);
  assertEquals(data.platformsBuilt, ["Desktop"]);
  assertEquals(data.bankBuilds, [
    { bank: "Master", platform: "Desktop" },
    { bank: "SFX", platform: "Desktop" },
  ]);
  assertEquals(data.warnings, []);
  assertEquals(data.logLines, 13);
  assertEquals(data.stderrLines, 3);
  assert(
    typeof data.startedAt === "string" && typeof data.finishedAt === "string",
  );
  assertEquals(result.dataHandles.length, 1);
  assert(
    getLogs().some((log) =>
      log.message.includes("Built {bankBuilds} bank builds")
    ),
  );
});

Deno.test("build passes the optional flags and resolves directories against the repository", async () => {
  const files = fakeFiles();
  const { runner, requests } = fakeRunner({});
  const { context } = testContext("build", { project: "/abs/Game.fspro" });
  await build.execute(
    {
      ...NO_BUILD_ARGS,
      ignoreWarnings: true,
      exportGuids: true,
      sharedAudioSourceDir: "audio/assets",
      logDir: "/var/log/fmod",
      _runner: runner,
      _files: files,
    },
    context,
  );
  assertEquals(requests[0]?.args, [
    "-build",
    "-ignore-warnings",
    "-export-guids",
    "-shared-audio-source-dir",
    "/work/game/audio/assets",
    "-log-dir",
    "/var/log/fmod",
    "/abs/Game.fspro",
  ]);
});

Deno.test("build through an app bundle reads the captured output and cleans up", async () => {
  const files = fakeFiles({
    [`${TEMP_DIR}/stdout.txt`]: BUILD_OUTPUT,
    [`${TEMP_DIR}/stderr.txt`]: BUILD_STDERR,
  });
  // open's own output is empty; the app's goes to the capture files.
  const { runner, requests } = fakeRunner({ stdout: "", stderr: "" });
  const { context, getWrittenResources } = testContext("build", {
    fmodstudio: APP_BUNDLE,
  });
  await build.execute({
    ...NO_BUILD_ARGS,
    platforms: ["Desktop"],
    _runner: runner,
    _files: files,
  }, context);
  assertEquals(requests[0]?.command, "open");
  assertEquals(requests[0]?.args.slice(0, 3), ["-W", "-a", APP_BUNDLE]);
  const argsIndex = requests[0]?.args.indexOf("--args") ?? -1;
  assert(argsIndex > 0, "open gets --args");
  assertEquals(requests[0]?.args.slice(argsIndex), [
    "--args",
    "-working-dir",
    "/work/game",
    "-build",
    "-platforms",
    "Desktop",
    PROJECT,
  ]);
  const data = getWrittenResources()[0]?.data ?? {};
  assertEquals(data.bankBuilds, [
    { bank: "Master", platform: "Desktop" },
    { bank: "SFX", platform: "Desktop" },
  ]);
  assertEquals(data.stderrLines, 3);
  assertEquals(files.removed, [TEMP_DIR]);
});

Deno.test("build through an app bundle fails when open wrote no output", async () => {
  const files = fakeFiles();
  const { runner } = fakeRunner({ stdout: "", stderr: "" });
  const { context, getWrittenResources } = testContext("build", {
    fmodstudio: APP_BUNDLE,
  });
  await assertRejects(
    () =>
      build.execute(
        { ...NO_BUILD_ARGS, _runner: runner, _files: files },
        context,
      ),
    Error,
    "did not report the build complete",
  );
  assertEquals(getWrittenResources(), []);
});

Deno.test("build fails on an unknown bank or platform and writes nothing", async () => {
  const files = fakeFiles();
  const { context, getWrittenResources } = testContext("build");
  const run = (stdout: string) =>
    build.execute(
      {
        ...NO_BUILD_ARGS,
        banks: ["Nope"],
        _runner: fakeRunner({ stdout }).runner,
        _files: files,
      },
      context,
    );
  const bank = await assertRejects(
    () => run(UNKNOWN_BANK_OUTPUT),
    Error,
    "refused the build",
  );
  assertStringIncludes(bank.message, 'Could not locate bank "Nope"');
  const platform = await assertRejects(
    () => run(UNKNOWN_PLATFORM_OUTPUT),
    Error,
    "refused the build",
  );
  assertStringIncludes(platform.message, 'Unknown platform name "Nope"');
  assertEquals(getWrittenResources(), []);
});

Deno.test("build fails when the project could not be opened", async () => {
  const files = fakeFiles();
  const { runner } = fakeRunner({ code: 1, stdout: MISSING_PROJECT_OUTPUT });
  const { context, getWrittenResources } = testContext("build");
  const error = await assertRejects(
    () =>
      build.execute(
        { ...NO_BUILD_ARGS, _runner: runner, _files: files },
        context,
      ),
    Error,
    `could not open ${PROJECT}`,
  );
  assertStringIncludes(error.message, "Project Load Error");
  assertEquals(getWrittenResources(), []);
});

Deno.test("build fails on a non-zero exit even when the completion line was printed", async () => {
  const files = fakeFiles();
  const { runner } = fakeRunner({ code: 3 });
  const { context, getWrittenResources } = testContext("build");
  await assertRejects(
    () =>
      build.execute(
        { ...NO_BUILD_ARGS, _runner: runner, _files: files },
        context,
      ),
    Error,
    "exited with code 3 and reported the build complete",
  );
  assertEquals(getWrittenResources(), []);
});

Deno.test("build fails when the completion line is missing even on exit 0", async () => {
  const files = fakeFiles();
  const { runner } = fakeRunner({
    stdout: [
      ...OPENED,
      `Building project "${PROJECT}"...`,
      "Build Status: Gathering file stats...",
    ].join("\n"),
  });
  const { context } = testContext("build");
  const error = await assertRejects(
    () =>
      build.execute(
        { ...NO_BUILD_ARGS, _runner: runner, _files: files },
        context,
      ),
    Error,
    "exited with code 0 and did not report the build complete",
  );
  assertStringIncludes(error.message, "Successfully opened project.");
});

Deno.test("build reports a timeout with the deadline and removes the temporary directory", async () => {
  const files = fakeFiles();
  const { runner } = fakeRunner({
    code: null,
    stdout: OPENED.join("\n"),
    timedOut: true,
  });
  const { context, getWrittenResources } = testContext("build", {
    timeoutSeconds: 7,
  });
  const error = await assertRejects(
    () =>
      build.execute(
        { ...NO_BUILD_ARGS, _runner: runner, _files: files },
        context,
      ),
    Error,
    "did not finish build within 7 seconds",
  );
  assertStringIncludes(error.message, "may still be running");
  assertEquals(files.removed, [TEMP_DIR]);
  assertEquals(getWrittenResources(), []);
});

Deno.test("build explains a missing executable", async () => {
  const files = fakeFiles();
  const { runner } = fakeRunner(new Deno.errors.NotFound("No such file"));
  const { context } = testContext("build", {
    fmodstudio: "/opt/fmodstudio/fmodstudiocl",
  });
  await assertRejects(
    () =>
      build.execute(
        { ...NO_BUILD_ARGS, _runner: runner, _files: files },
        context,
      ),
    Error,
    'FMOD Studio was not found as "/opt/fmodstudio/fmodstudiocl"',
  );
  assertEquals(files.removed, [TEMP_DIR]);
});

Deno.test("build explains the macOS launcher failing without a terminal", async () => {
  const files = fakeFiles();
  const { runner } = fakeRunner({
    code: 1,
    stdout: "",
    stderr: LAUNCHER_OUTPUT,
  });
  const { context } = testContext("build", {
    fmodstudio: "/Applications/FMOD Studio.app/Contents/MacOS/fmodstudiocl",
  });
  const error = await assertRejects(
    () =>
      build.execute(
        { ...NO_BUILD_ARGS, _runner: runner, _files: files },
        context,
      ),
    Error,
    "needs a terminal",
  );
  assertStringIncludes(error.message, '"/Applications/FMOD Studio.app"');
});

Deno.test("build passes swamp's cancellation signal to the runner", async () => {
  const files = fakeFiles();
  const { runner, requests } = fakeRunner({});
  const controller = new AbortController();
  const { context } = testContext("build", {}, controller.signal);
  await build.execute(
    { ...NO_BUILD_ARGS, _runner: runner, _files: files },
    context,
  );
  assertEquals(requests[0]?.signal, controller.signal);
});

Deno.test("inspect writes the script, runs it with -script and records the project, banks and events", async () => {
  const files = fakeFiles();
  const { runner, requests } = fakeRunner({
    stdout: inspectOutput(INSPECT_REPORT),
  });
  const { context, getWrittenResources, getLogs } = testContext("inspect");
  const result = await inspect.execute(
    { _runner: runner, _files: files },
    context,
  );
  assertEquals(requests[0]?.args, [
    "-script",
    `${TEMP_DIR}/inspect.js`,
    PROJECT,
  ]);
  assertEquals(files.written.get(`${TEMP_DIR}/inspect.js`), INSPECT_SCRIPT);
  assertEquals(files.removed, [TEMP_DIR]);

  const written = getWrittenResources();
  assertEquals(written.map((record) => [record.specName, record.name]), [
    ["project", "project"],
    ["banks", "banks"],
    ["events", "events"],
  ]);
  const project = written[0]?.data ?? {};
  assertEquals(project.project, PROJECT);
  assertEquals(project.version, INSPECT_REPORT.version);
  assertEquals(project.platformNames, ["Desktop", "HTML5"]);
  assertEquals(project.builtBanksOutputDirectory, "");
  const banks = written[1]?.data ?? {};
  assertEquals(banks.names, ["Master", "SFX"]);
  assertEquals(banks.banks, INSPECT_REPORT.banks);
  const events = written[2]?.data ?? {};
  assertEquals(events.count, 3);
  assertEquals(events.truncated, false);
  assertEquals(events.paths, [
    "event:/Weapons/Explosion",
    "event:/Weapons/Pistol",
    "event:/Haptics/knapsack_open",
  ]);
  assertEquals(result.dataHandles.length, 3);
  assert(
    getLogs().some((log) =>
      log.message.includes("lists {platforms} platforms")
    ),
  );
});

Deno.test("inspect marks the events truncated when the script cut the list", async () => {
  const files = fakeFiles();
  const report = { ...INSPECT_REPORT, eventCount: EVENT_MAX + 5 };
  const { runner } = fakeRunner({ stdout: inspectOutput(report) });
  const { context, getWrittenResources } = testContext("inspect");
  await inspect.execute({ _runner: runner, _files: files }, context);
  const events = getWrittenResources()[2]?.data ?? {};
  assertEquals(events.truncated, true);
  assertEquals(events.count, EVENT_MAX + 5);
});

Deno.test("inspect fails on a script error and writes nothing", async () => {
  const files = fakeFiles();
  const { runner } = fakeRunner({ stdout: SCRIPT_ERROR_OUTPUT });
  const { context, getWrittenResources } = testContext("inspect");
  const error = await assertRejects(
    () => inspect.execute({ _runner: runner, _files: files }, context),
    Error,
    "script error",
  );
  assertStringIncludes(error.message, "[script-error]");
  assertEquals(getWrittenResources(), []);
  assertEquals(files.removed, [TEMP_DIR]);
});

Deno.test("inspect fails when the report is missing, not JSON or the wrong shape", async () => {
  const files = fakeFiles();
  const { context, getWrittenResources } = testContext("inspect");
  const run = (stdout: string) =>
    inspect.execute(
      { _runner: fakeRunner({ stdout }).runner, _files: files },
      context,
    );
  await assertRejects(
    () => run(OPENED.join("\n")),
    Error,
    "did not print the inspect report",
  );
  await assertRejects(
    () =>
      run(
        [
          ...OPENED,
          "[Scripting] SWAMP_FMOD_INSPECT_BEGIN",
          "[Scripting] {not json",
          "[Scripting] SWAMP_FMOD_INSPECT_END",
        ]
          .join("\n"),
      ),
    Error,
    "is not JSON",
  );
  await assertRejects(
    () => run(inspectOutput({ ...INSPECT_REPORT, banks: [{ name: 1 }] })),
    Error,
    "expected shape",
  );
  assertEquals(getWrittenResources(), []);
});

Deno.test("diagnostic records a completed validation with its check count", async () => {
  const files = fakeFiles();
  const { runner, requests } = fakeRunner({ stdout: DIAGNOSTIC_OUTPUT });
  const { context, getWrittenResources } = testContext("diagnostic");
  await diagnostic.execute({ _runner: runner, _files: files }, context);
  assertEquals(requests[0]?.args, ["-diagnostic", PROJECT]);
  const written = getWrittenResources();
  assertEquals(written[0]?.specName, "diagnostic");
  const data = written[0]?.data ?? {};
  assertEquals(data.project, PROJECT);
  assertEquals(data.checks, 3);
  assertEquals(data.exitCode, 0);
  assertEquals(data.logLines, 8);
  assert((data.logExcerpt as string[]).length <= 120);
  assertStringIncludes(
    (data.logExcerpt as string[]).join("\n"),
    "Project validation completed successfully.",
  );
});

Deno.test("diagnostic fails when validation did not complete", async () => {
  const files = fakeFiles();
  const { runner } = fakeRunner({
    code: 1,
    stdout: [
      ...OPENED,
      "Validating project...",
      "Validation Status: Checking Event for cyclical references...",
    ].join("\n"),
  });
  const { context, getWrittenResources } = testContext("diagnostic");
  await assertRejects(
    () => diagnostic.execute({ _runner: runner, _files: files }, context),
    Error,
    "exited with code 1 and did not report the validation complete",
  );
  assertEquals(getWrittenResources(), []);
});

Deno.test("the project-is-fspro check names a project that is not a .fspro file", async () => {
  const check = behavior.checks["project-is-fspro"];
  assertEquals(check.appliesTo, ["build", "inspect", "diagnostic"]);
  const ok = await check.execute({
    globalArgs: {
      project: "audio/Examples.fspro",
      fmodstudio: "fmodstudiocl",
      timeoutSeconds: 1,
    },
  });
  assertEquals(ok, { pass: true });
  const bad = await check.execute({
    globalArgs: {
      project: "audio/Examples",
      fmodstudio: "fmodstudiocl",
      timeoutSeconds: 1,
    },
  });
  assertEquals(bad.pass, false);
  assertStringIncludes(bad.errors?.[0] ?? "", "does not end in .fspro");
});

Deno.test("every record validates against its declared schema", async () => {
  const files = fakeFiles();
  const { context, getWrittenResources } = testContext("build");
  await build.execute({
    ...NO_BUILD_ARGS,
    _runner: fakeRunner({}).runner,
    _files: files,
  }, context);
  await inspect.execute({
    _runner: fakeRunner({ stdout: inspectOutput(INSPECT_REPORT) }).runner,
    _files: files,
  }, context);
  await diagnostic.execute({
    _runner: fakeRunner({ stdout: DIAGNOSTIC_OUTPUT }).runner,
    _files: files,
  }, context);
  const written = getWrittenResources();
  assertEquals(
    written.map((record) => record.specName),
    ["build", "project", "banks", "events", "diagnostic"],
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

Deno.test("every argument's description is written where the registry reads it", () => {
  // swamp's registry reads arguments from the source text, not the running
  // behavior: the fields written inside the schema's own `z.object({ ... })`,
  // each starting `name: z.<type>(` on one line, with its description in
  // `.describe("...")` as a string literal. The registry reads a single-quoted
  // literal too; this test matches only the double-quoted one, so a
  // description holds no double quote. A spread, a shared schema constant, a
  // field split after `z` or written `z.iso.datetime()` is left out of the
  // registry's argument list; `.meta({ description })`, a constant or a
  // template literal leaves its description empty.
  const objects = objectLiterals(source);
  const schemas: { shape: Record<string, { description?: string }> }[] = [
    behavior.globalArguments,
    ...Object.values(behavior.methods).map((method) => method.arguments),
  ];
  const unread: string[] = [];
  for (const schema of schemas) {
    const names = Object.keys(schema.shape);
    if (names.length === 0) {
      continue;
    }
    const written = objects.find((fields) =>
      fields.length === names.length &&
      fields.every((field, i) => field.startsWith(`${names[i]}:`))
    );
    for (const [i, name] of names.entries()) {
      const text = written?.[i] ?? "";
      const description = schema.shape[name].description;
      const read = description !== undefined &&
        new RegExp(`^${name}:[ \\t]*z\\.\\w+\\(`).test(text) &&
        new RegExp(`\\.describe\\(\\s*${escape(JSON.stringify(description))}`)
          .test(text);
      if (!read) {
        unread.push(name);
      }
    }
  }
  assertEquals(unread, []);
});

/** `text` with every regular-expression metacharacter escaped. */
function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The top-level fields of every `z.object({ ... })` literal in `text`, as written. */
function objectLiterals(text: string): string[][] {
  const objects: string[][] = [];
  const opener = /z\.object\(\{/g;
  for (const match of text.matchAll(opener)) {
    const fields: string[] = [];
    let depth = 0;
    let quote = "";
    let start = match.index + match[0].length;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (quote) {
        if (c === "\\") {
          i++;
        } else if (c === quote) {
          quote = "";
        }
      } else if (c === '"' || c === "'" || c === "`") {
        quote = c;
      } else if ("([{".includes(c)) {
        depth++;
      } else if (depth > 0 && ")]}".includes(c)) {
        depth--;
      } else if (depth === 0 && (c === "," || c === "}")) {
        const field = text.slice(start, i).trim();
        if (field) {
          fields.push(field);
        }
        start = i + 1;
        if (c === "}") {
          break;
        }
      }
    }
    objects.push(fields);
  }
  return objects;
}
