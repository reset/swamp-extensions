/**
 * Unit tests for the Godot behavior. Every test injects a runner and file
 * helpers, so nothing here runs Godot or needs a project on disk, except the
 * pre-flight check test, which uses a temporary directory.
 *
 * @module
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20261013.54";
import {
  behavior,
  type FileFacts,
  type Files,
  type MethodContext,
  normalizePath,
  parseConfigFile,
  parseExportPresets,
  parseGodotOutput,
  parseProjectGodot,
  parseScriptErrors,
  parseVersionString,
  projectDirectory,
  type Runner,
  type RunRequest,
  type RunResult,
} from "./godot.ts";
import source from "./godot.ts" with { type: "text" };

const REPO = "/work/game";
const PROJECT = `${REPO}/godot`;

const PROJECT_GODOT = [
  "; Engine configuration file.",
  "; It's best edited using the editor UI and not directly,",
  "",
  "config_version=5",
  "",
  "[application]",
  "",
  'config/name="Example Game"',
  'config/version="1.4.2"',
  'run/main_scene="res://scenes/main.tscn"',
  'config/features=PackedStringArray("4.3", "Forward Plus")',
  'config/icon="res://icon.svg"',
  "",
  "[rendering]",
  "",
  'renderer/rendering_method="forward_plus"',
].join("\n");

const EXPORT_PRESETS = [
  "[preset.0]",
  "",
  'name="Linux"',
  'platform="Linux"',
  "runnable=true",
  "advanced_options=false",
  "dedicated_server=false",
  'custom_features=""',
  'export_filter="all_resources"',
  'include_filter=""',
  'exclude_filter=""',
  'export_path="../build/linux/example.x86_64"',
  'encryption_include_filters=""',
  "",
  "[preset.0.options]",
  "",
  'custom_template/debug=""',
  "binary_format/embed_pck=false",
  "",
  "[preset.1]",
  "",
  'name="Windows Desktop"',
  'platform="Windows Desktop"',
  "runnable=false",
  "dedicated_server=false",
  'export_filter="all_resources"',
  'export_path=""',
  "",
  "[preset.1.options]",
  "",
  'application/product_name="Example \\"Game\\""',
  "",
  "[preset.2]",
  "",
  'name="Server"',
  'platform="Linux"',
  "runnable=true",
  "dedicated_server=true",
  'export_filter="all_resources"',
  'export_path="../build/server/example.x86_64"',
].join("\n");

const IMPORT_OUTPUT = [
  "Godot Engine v4.3.stable.official.77dcf97d8 - https://godotengine.org",
  "",
  "Importing: res://icon.svg",
  "Importing: res://assets/player.png",
].join("\n");

const EXPORT_OUTPUT = [
  "Godot Engine v4.3.stable.official.77dcf97d8 - https://godotengine.org",
  "savepack: begin: Packing steps: 102",
  "savepack: step 2: Storing File: res://.godot/global_script_class_cache.cfg",
  "savepack: end",
].join("\n");

const TEMPLATE_MISSING_OUTPUT = [
  "Godot Engine v4.3.stable.official.77dcf97d8 - https://godotengine.org",
  "ERROR: No export template found at the expected path:",
  "/home/build/.local/share/godot/export_templates/4.3.stable/linux_release.x86_64",
  'ERROR: Project export for preset "Linux" failed.',
].join("\n");

const UNKNOWN_PRESET_OUTPUT = [
  "Godot Engine v4.3.stable.official.77dcf97d8 - https://godotengine.org",
  'ERROR: Export preset "Nope" not found.',
].join("\n");

const PARSE_ERROR_OUTPUT = [
  "Godot Engine v4.3.stable.official.77dcf97d8 - https://godotengine.org",
  "SCRIPT ERROR: Parse Error: Expected indented block after function declaration.",
  "          at: GDScript::reload (res://player.gd:12)",
  'SCRIPT ERROR: Parse Error: Identifier "velocty" not declared in the current scope.',
  "          at: GDScript::reload (res://player.gd:30)",
  'ERROR: Failed to load script "res://player.gd" with error "Parse error".',
  "          at: load (modules/gdscript/gdscript.cpp:2900)",
].join("\n");

interface FakeFiles extends Files {
  texts: Map<string, string>;
  facts: Map<string, FileFacts>;
  reads: string[];
  stats: string[];
}

function fakeFiles(
  texts: Record<string, string> = {},
  facts: Record<string, FileFacts> = {},
): FakeFiles {
  const files: FakeFiles = {
    texts: new Map(Object.entries(texts)),
    facts: new Map(Object.entries(facts)),
    reads: [],
    stats: [],
    readTextFile: (path) => {
      files.reads.push(path);
      const text = files.texts.get(path);
      return text === undefined
        ? Promise.reject(new Deno.errors.NotFound(`No such file: ${path}`))
        : Promise.resolve(text);
    },
    stat: (path) => {
      files.stats.push(path);
      const fact = files.facts.get(path);
      return fact === undefined
        ? Promise.reject(new Deno.errors.NotFound(`No such file: ${path}`))
        : Promise.resolve(fact);
    },
  };
  return files;
}

function projectFiles(): FakeFiles {
  return fakeFiles(
    {
      [`${PROJECT}/project.godot`]: PROJECT_GODOT,
      [`${PROJECT}/export_presets.cfg`]: EXPORT_PRESETS,
    },
    {
      [`${REPO}/build/linux/example.x86_64`]: {
        size: 73_400_320,
        isDirectory: false,
      },
      [`${PROJECT}/out/example.pck`]: { size: 1024, isDirectory: false },
      [`/tmp/Example.app`]: { size: 128, isDirectory: true },
    },
  );
}

/** A runner that answers each request in turn; the last answer repeats. */
function fakeRunner(
  ...results: Array<Partial<RunResult> | Error>
): { runner: Runner; requests: RunRequest[] } {
  const requests: RunRequest[] = [];
  const runner: Runner = (request) => {
    requests.push(request);
    const result = results[Math.min(requests.length - 1, results.length - 1)];
    if (result instanceof Error) {
      return Promise.reject(result);
    }
    return Promise.resolve({
      code: 0,
      output: "4.3.stable.official.77dcf97d8\n",
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
): TestContext {
  const created = createModelTestContext({
    methodName,
    repoDir: REPO,
    globalArgs: {
      projectPath: "godot",
      godot: "godot",
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

const { version, import: importMethod, presets, export: exportMethod, check } =
  behavior.methods;

Deno.test("parseVersionString reads stable, patch, pre-release and custom builds", () => {
  assertEquals(parseVersionString("4.3.stable.official.77dcf97d8\n"), {
    version: "4.3.stable.official.77dcf97d8",
    major: 4,
    minor: 3,
    patch: 0,
    status: "stable",
    build: "official",
    hash: "77dcf97d8",
  });
  assertEquals(parseVersionString("4.2.1.stable.mono.official.b09f793f5"), {
    version: "4.2.1.stable.mono.official.b09f793f5",
    major: 4,
    minor: 2,
    patch: 1,
    status: "stable",
    build: "mono.official",
    hash: "b09f793f5",
  });
  assertEquals(parseVersionString("4.4.beta1.custom_build"), {
    version: "4.4.beta1.custom_build",
    major: 4,
    minor: 4,
    patch: 0,
    status: "beta1",
    build: "custom_build",
  });
  assertEquals(
    parseVersionString("Some banner first\n4.3.1.rc2.official.abcdef123\n"),
    {
      version: "4.3.1.rc2.official.abcdef123",
      major: 4,
      minor: 3,
      patch: 1,
      status: "rc2",
      build: "official",
      hash: "abcdef123",
    },
  );
});

Deno.test("parseVersionString rejects output without a version string", () => {
  assertEquals(parseVersionString(""), undefined);
  assertEquals(parseVersionString("godot: command not found"), undefined);
  assertEquals(parseVersionString("4.3"), undefined);
});

Deno.test("parseConfigFile reads sections, skips comments and keeps the first = as the separator", () => {
  const sections = parseConfigFile(
    '; comment\ntop=1\n[a]\nk="x=y"\n\n[b]\n# comment\nflag=true\n',
  );
  assertEquals(sections.get("")?.get("top"), "1");
  assertEquals(sections.get("a")?.get("k"), '"x=y"');
  assertEquals(sections.get("b")?.get("flag"), "true");
});

Deno.test("parseProjectGodot reads the application settings and the feature list", () => {
  assertEquals(parseProjectGodot(PROJECT_GODOT), {
    name: "Example Game",
    version: "1.4.2",
    mainScene: "res://scenes/main.tscn",
    features: ["4.3", "Forward Plus"],
  });
  assertEquals(parseProjectGodot("config_version=5\n"), { features: [] });
});

Deno.test("parseExportPresets reads each [preset.N] section and ignores the options sections", () => {
  const parsed = parseExportPresets(EXPORT_PRESETS);
  assertEquals(parsed.map((preset) => preset.name), [
    "Linux",
    "Windows Desktop",
    "Server",
  ]);
  assertEquals(parsed[0], {
    name: "Linux",
    platform: "Linux",
    exportPath: "../build/linux/example.x86_64",
    runnable: true,
    dedicatedServer: false,
    exportFilter: "all_resources",
  });
  assertEquals(parsed[1]?.exportPath, "");
  assertEquals(parsed[1]?.runnable, false);
  assertEquals(parsed[2]?.dedicatedServer, true);
  assertEquals(parseExportPresets(""), []);
});

Deno.test("parseGodotOutput counts error lines, names the failure causes and bounds the excerpt", () => {
  const template = parseGodotOutput(TEMPLATE_MISSING_OUTPUT);
  assertEquals(template.errorCount, 2);
  assertStringIncludes(template.templateLine ?? "", "No export template found");
  assertEquals(template.presetLine, undefined);

  const preset = parseGodotOutput(UNKNOWN_PRESET_OUTPUT);
  assertStringIncludes(preset.presetLine ?? "", 'preset "Nope" not found');
  assertEquals(preset.templateLine, undefined);

  const noise = Array.from({ length: 500 }, (_, i) => `savepack: step ${i}`);
  const report = parseGodotOutput(
    ["ERROR: first", ...noise, "savepack: end"].join("\n"),
  );
  assertEquals(report.lineCount, 502);
  assertEquals(report.errorLines, ["ERROR: first"]);
  assert(report.excerpt.length <= 120, `${report.excerpt.length} lines kept`);
  assertEquals(report.excerpt[0], "ERROR: first");
  assertEquals(report.excerpt.at(-1), "savepack: end");
});

Deno.test("parseGodotOutput caps the error lines it keeps but counts them all", () => {
  const errors = Array.from({ length: 250 }, (_, i) => `ERROR: e${i}`);
  const report = parseGodotOutput(errors.join("\n"));
  assertEquals(report.errorCount, 250);
  assertEquals(report.errorLines.length, 200);
});

Deno.test("parseScriptErrors pairs each error with the line its at: line names", () => {
  assertEquals(parseScriptErrors(PARSE_ERROR_OUTPUT), [
    {
      message:
        "SCRIPT ERROR: Parse Error: Expected indented block after function declaration.",
      line: 12,
    },
    {
      message:
        'SCRIPT ERROR: Parse Error: Identifier "velocty" not declared in the current scope.',
      line: 30,
    },
    {
      message:
        'ERROR: Failed to load script "res://player.gd" with error "Parse error".',
      line: 2900,
    },
  ]);
  assertEquals(parseScriptErrors("Godot Engine v4.3\n"), []);
});

Deno.test("projectDirectory resolves against the repository and accepts the project file itself", () => {
  assertEquals(projectDirectory(REPO, "godot"), PROJECT);
  assertEquals(projectDirectory(`${REPO}/`, "godot/project.godot"), PROJECT);
  assertEquals(projectDirectory(REPO, "/abs/game"), "/abs/game");
  assertEquals(projectDirectory(REPO, "C:\\games\\x"), "C:\\games\\x");
  assertEquals(
    normalizePath("/work/game/godot/../build/./x"),
    "/work/game/build/x",
  );
  assertEquals(normalizePath("../../up"), "../../up");
  assertEquals(normalizePath("a/.."), ".");
});

Deno.test("version runs godot --version and records the engine and project facts", async () => {
  const files = projectFiles();
  const { runner, requests } = fakeRunner({});
  const { context, getWrittenResources, getLogs } = testContext("version");
  const result = await version.execute(
    { _runner: runner, _files: files },
    context,
  );
  assertEquals(requests.length, 1);
  assertEquals(requests[0]?.command, "godot");
  assertEquals(requests[0]?.args, ["--version"]);
  assertEquals(requests[0]?.timeoutMs, 30_000);
  assertEquals(files.reads, [`${PROJECT}/project.godot`]);
  const written = getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0]?.specName, "version");
  assertEquals(written[0]?.name, "version");
  const data = written[0]?.data ?? {};
  assertEquals(data.version, "4.3.stable.official.77dcf97d8");
  assertEquals(data.major, 4);
  assertEquals(data.minor, 3);
  assertEquals(data.patch, 0);
  assertEquals(data.status, "stable");
  assertEquals(data.build, "official");
  assertEquals(data.hash, "77dcf97d8");
  assertEquals(data.projectPath, PROJECT);
  assertEquals(data.project, {
    name: "Example Game",
    version: "1.4.2",
    mainScene: "res://scenes/main.tscn",
    features: ["4.3", "Forward Plus"],
  });
  assertEquals(result.dataHandles.length, 1);
  assert(getLogs().some((log) => log.level === "info"));
});

Deno.test("version fails when no version string is printed or project.godot is missing, and writes nothing", async () => {
  const { context, getWrittenResources } = testContext("version");
  await assertRejects(
    () =>
      version.execute(
        {
          _runner: fakeRunner({ code: 1, output: "unknown option" }).runner,
          _files: projectFiles(),
        },
        context,
      ),
    Error,
    "printed no version string",
  );
  const error = await assertRejects(
    () =>
      version.execute(
        { _runner: fakeRunner({}).runner, _files: fakeFiles() },
        context,
      ),
    Error,
    `${PROJECT}/project.godot does not exist`,
  );
  assertStringIncludes(error.message, "projectPath");
  assertEquals(getWrittenResources(), []);
});

Deno.test("every method explains a missing Godot binary", async () => {
  const missing = () =>
    fakeRunner(new Deno.errors.NotFound("No such file")).runner;
  const { context, getWrittenResources } = testContext("version", {
    godot: "/opt/godot/Godot_v4.3-stable_linux.x86_64",
  });
  const expected =
    'Godot was not found as "/opt/godot/Godot_v4.3-stable_linux.x86_64"';
  await assertRejects(
    () =>
      version.execute(
        { _runner: missing(), _files: projectFiles() },
        context,
      ),
    Error,
    expected,
  );
  await assertRejects(
    () => importMethod.execute({ _runner: missing() }, context),
    Error,
    expected,
  );
  await assertRejects(
    () =>
      exportMethod.execute(
        {
          preset: "Linux",
          path: "../build/linux/example.x86_64",
          mode: "release",
          _runner: missing(),
          _files: projectFiles(),
        },
        context,
      ),
    Error,
    expected,
  );
  await assertRejects(
    () =>
      check.execute({ scripts: ["player.gd"], _runner: missing() }, context),
    Error,
    expected,
  );
  assertEquals(getWrittenResources(), []);
});

Deno.test("import runs --headless --path --import and records the exit code, duration and error lines", async () => {
  const { runner, requests } = fakeRunner({
    output:
      `${IMPORT_OUTPUT}\nERROR: Failed loading resource: res://missing.png\n`,
  });
  const { context, getWrittenResources } = testContext("import");
  await importMethod.execute({ _runner: runner }, context);
  assertEquals(requests[0]?.args, [
    "--headless",
    "--path",
    PROJECT,
    "--import",
  ]);
  const written = getWrittenResources();
  assertEquals(written[0]?.specName, "import");
  assertEquals(written[0]?.name, "import");
  const data = written[0]?.data ?? {};
  assertEquals(data.projectPath, PROJECT);
  assertEquals(data.exitCode, 0);
  assertEquals(data.errorCount, 1);
  assertEquals(data.errorLines, [
    "ERROR: Failed loading resource: res://missing.png",
  ]);
  assertEquals(data.logLines, 4);
  assert(typeof data.durationSeconds === "number" && data.durationSeconds >= 0);
  assertStringIncludes(
    (data.logExcerpt as string[]).join("\n"),
    "Importing: res://icon.svg",
  );
});

Deno.test("import fails on a non-zero exit code and writes nothing", async () => {
  const { runner } = fakeRunner({
    code: 1,
    output: 'ERROR: Couldn\'t load project data at path "/work/game/godot".',
  });
  const { context, getWrittenResources } = testContext("import");
  const error = await assertRejects(
    () => importMethod.execute({ _runner: runner }, context),
    Error,
    "exited with code 1 after 1 error lines",
  );
  assertStringIncludes(error.message, "Couldn't load project data");
  assertEquals(getWrittenResources(), []);
});

Deno.test("import reports a timeout that names the deadline", async () => {
  const { runner } = fakeRunner({
    code: null,
    output: "Godot Engine v4.3.stable.official.77dcf97d8",
    timedOut: true,
  });
  const { context, getWrittenResources } = testContext("import", {
    timeoutSeconds: 7,
  });
  const error = await assertRejects(
    () => importMethod.execute({ _runner: runner }, context),
    Error,
    "did not finish --import within 7 seconds",
  );
  assertStringIncludes(error.message, "--headless");
  assertEquals(getWrittenResources(), []);
});

Deno.test("presets reads export_presets.cfg and records the presets", async () => {
  const files = projectFiles();
  const { context, getWrittenResources } = testContext("presets");
  await presets.execute({ _files: files }, context);
  assertEquals(files.reads, [`${PROJECT}/export_presets.cfg`]);
  const written = getWrittenResources();
  assertEquals(written[0]?.specName, "presets");
  assertEquals(written[0]?.name, "presets");
  const data = written[0]?.data ?? {};
  assertEquals(data.count, 3);
  assertEquals(data.names, ["Linux", "Windows Desktop", "Server"]);
  assertEquals((data.presets as Preset[])[2], {
    name: "Server",
    platform: "Linux",
    exportPath: "../build/server/example.x86_64",
    runnable: true,
    dedicatedServer: true,
    exportFilter: "all_resources",
  });
});

Deno.test("presets fails when export_presets.cfg is missing and writes nothing", async () => {
  const { context, getWrittenResources } = testContext("presets");
  const error = await assertRejects(
    () => presets.execute({ _files: fakeFiles() }, context),
    Error,
    `${PROJECT}/export_presets.cfg does not exist`,
  );
  assertStringIncludes(error.message, "Project > Export");
  assertEquals(getWrittenResources(), []);
});

Deno.test("export runs --export-release with the preset and path and records the produced file", async () => {
  const files = projectFiles();
  const { runner, requests } = fakeRunner({ output: EXPORT_OUTPUT });
  const { context, getWrittenResources, getLogs } = testContext("export");
  const result = await exportMethod.execute(
    {
      preset: "Linux",
      path: "../build/linux/example.x86_64",
      mode: "release",
      _runner: runner,
      _files: files,
    },
    context,
  );
  assertEquals(requests.length, 1);
  assertEquals(requests[0]?.args, [
    "--headless",
    "--path",
    PROJECT,
    "--export-release",
    "Linux",
    "../build/linux/example.x86_64",
  ]);
  // Godot resolves a relative output path against the project directory, so the stat does too.
  assertEquals(files.stats, [`${REPO}/build/linux/example.x86_64`]);
  const written = getWrittenResources();
  assertEquals(written[0]?.specName, "export");
  assertEquals(written[0]?.name, "export");
  const data = written[0]?.data ?? {};
  assertEquals(data.preset, "Linux");
  assertEquals(data.platform, "Linux");
  assertEquals(data.mode, "release");
  assertEquals(data.outputPath, `${REPO}/build/linux/example.x86_64`);
  assertEquals(data.fileSize, 73_400_320);
  assertEquals(data.isDirectory, false);
  assertEquals(data.exitCode, 0);
  assertEquals(data.errorCount, 0);
  assertEquals(data.logLines, 4);
  assertEquals(result.dataHandles.length, 1);
  assert(
    getLogs().some((log) => log.message.includes("Exported preset {preset}")),
  );
});

Deno.test("export runs --export-debug and --export-pack for the other modes", async () => {
  const files = projectFiles();
  const { runner, requests } = fakeRunner({ output: EXPORT_OUTPUT });
  const { context, getWrittenResources } = testContext("export");
  await exportMethod.execute(
    {
      preset: "Linux",
      path: "/tmp/Example.app",
      mode: "debug",
      _runner: runner,
      _files: files,
    },
    context,
  );
  await exportMethod.execute(
    {
      preset: "Windows Desktop",
      path: "out/example.pck",
      mode: "pack",
      _runner: runner,
      _files: files,
    },
    context,
  );
  assertEquals(requests[0]?.args.slice(3), [
    "--export-debug",
    "Linux",
    "/tmp/Example.app",
  ]);
  assertEquals(requests[1]?.args.slice(3), [
    "--export-pack",
    "Windows Desktop",
    "out/example.pck",
  ]);
  const [debug, pack] = getWrittenResources();
  assertEquals(debug?.data.mode, "debug");
  assertEquals(debug?.data.outputPath, "/tmp/Example.app");
  assertEquals(debug?.data.isDirectory, true);
  assertEquals(pack?.data.mode, "pack");
  assertEquals(pack?.data.outputPath, `${PROJECT}/out/example.pck`);
  assertEquals(pack?.data.fileSize, 1024);
});

Deno.test("export refuses a preset export_presets.cfg does not define, before running Godot", async () => {
  const { runner, requests } = fakeRunner({});
  const { context, getWrittenResources } = testContext("export");
  const error = await assertRejects(
    () =>
      exportMethod.execute(
        {
          preset: "Nope",
          path: "out/x",
          mode: "release",
          _runner: runner,
          _files: projectFiles(),
        },
        context,
      ),
    Error,
    'has no preset named "Nope"',
  );
  assertStringIncludes(error.message, '"Linux", "Windows Desktop", "Server"');
  assertEquals(requests, []);
  await assertRejects(
    () =>
      exportMethod.execute(
        {
          preset: "Linux",
          path: "out/x",
          mode: "release",
          _runner: runner,
          _files: fakeFiles(),
        },
        context,
      ),
    Error,
    "export_presets.cfg does not exist",
  );
  assertEquals(getWrittenResources(), []);
});

Deno.test("export names a missing export template and writes nothing", async () => {
  const { runner } = fakeRunner({ code: 1, output: TEMPLATE_MISSING_OUTPUT });
  const { context, getWrittenResources } = testContext("export");
  const error = await assertRejects(
    () =>
      exportMethod.execute(
        {
          preset: "Linux",
          path: "../build/linux/example.x86_64",
          mode: "release",
          _runner: runner,
          _files: projectFiles(),
        },
        context,
      ),
    Error,
    "the export template for Linux is not installed",
  );
  assertStringIncludes(error.message, "No export template found");
  assertStringIncludes(error.message, "Manage Export Templates");
  assertEquals(getWrittenResources(), []);
});

Deno.test("export names a preset Godot rejects when the presets file could not be parsed", async () => {
  const files = fakeFiles({
    [`${PROJECT}/export_presets.cfg`]:
      "; a presets file in a shape this parser does not know\n",
  });
  const { runner, requests } = fakeRunner({
    code: 1,
    output: UNKNOWN_PRESET_OUTPUT,
  });
  const { context, getWrittenResources } = testContext("export");
  const error = await assertRejects(
    () =>
      exportMethod.execute(
        {
          preset: "Nope",
          path: "out/x",
          mode: "release",
          _runner: runner,
          _files: files,
        },
        context,
      ),
    Error,
    'Godot does not know the preset "Nope"',
  );
  assertStringIncludes(error.message, 'Export preset "Nope" not found');
  assertEquals(requests.length, 1);
  assertEquals(getWrittenResources(), []);
});

Deno.test("export fails on a non-zero exit, a missing output file and a timeout", async () => {
  const { context, getWrittenResources } = testContext("export", {
    timeoutSeconds: 5,
  });
  const run = (result: Partial<RunResult>, path: string) =>
    exportMethod.execute(
      {
        preset: "Linux",
        path,
        mode: "release",
        _runner: fakeRunner(result).runner,
        _files: projectFiles(),
      },
      context,
    );
  const failed = await assertRejects(
    () =>
      run(
        { code: 1, output: "ERROR: Failed to export project\n" },
        "../build/linux/example.x86_64",
      ),
    Error,
    'Godot --export-release "Linux" exited with code 1 after 1 error lines',
  );
  assertStringIncludes(failed.message, "Failed to export project");
  await assertRejects(
    () => run({ output: EXPORT_OUTPUT }, "out/never-written"),
    Error,
    `exited with code 0 but ${PROJECT}/out/never-written does not exist`,
  );
  await assertRejects(
    () =>
      run(
        { code: null, output: EXPORT_OUTPUT, timedOut: true },
        "../build/linux/example.x86_64",
      ),
    Error,
    "did not finish --export-release Linux within 5 seconds",
  );
  assertEquals(getWrittenResources(), []);
});

Deno.test("check runs --check-only -s once per script and records a passing pass", async () => {
  const { runner, requests } = fakeRunner({
    output: "Godot Engine v4.3.stable.official.77dcf97d8\n",
  });
  const { context, getWrittenResources } = testContext("check");
  await check.execute(
    { scripts: ["player.gd", "res://enemies/bat.gd"], _runner: runner },
    context,
  );
  assertEquals(requests.length, 2);
  assertEquals(requests[0]?.args, [
    "--headless",
    "--path",
    PROJECT,
    "--check-only",
    "-s",
    "player.gd",
  ]);
  assertEquals(requests[1]?.args.slice(-1), ["res://enemies/bat.gd"]);
  const written = getWrittenResources();
  assertEquals(written[0]?.specName, "check");
  assertEquals(written[0]?.name, "check");
  const data = written[0]?.data ?? {};
  assertEquals(data.passed, 2);
  assertEquals(data.failed, 0);
  assertEquals(data.scripts, [
    { script: "player.gd", exitCode: 0, passed: true, errors: [] },
    { script: "res://enemies/bat.gd", exitCode: 0, passed: true, errors: [] },
  ]);
});

Deno.test("check records parse errors per script and keeps going after a failure", async () => {
  const { runner } = fakeRunner(
    { code: 1, output: PARSE_ERROR_OUTPUT },
    { code: 0, output: "" },
    { code: 0, output: "SCRIPT ERROR: Parse Error: odd exit code\n" },
  );
  const { context, getWrittenResources, getLogs } = testContext("check");
  await check.execute(
    { scripts: ["player.gd", "ok.gd", "weird.gd"], _runner: runner },
    context,
  );
  const data = getWrittenResources()[0]?.data ?? {};
  assertEquals(data.passed, 1);
  assertEquals(data.failed, 2);
  const scripts = data.scripts as Array<Record<string, unknown>>;
  assertEquals(scripts[0]?.passed, false);
  assertEquals(scripts[0]?.exitCode, 1);
  assertEquals(
    (scripts[0]?.errors as ScriptError[]).map((error) => error.line),
    [12, 30, 2900],
  );
  assertEquals(scripts[1]?.passed, true);
  // An error line with exit code 0 still fails the script: the record trusts the output over the code.
  assertEquals(scripts[2]?.passed, false);
  assertEquals(
    getLogs().filter((log) => log.level === "warning").length,
    2,
  );
});

Deno.test("check fails on a timeout and writes nothing", async () => {
  const { runner } = fakeRunner(
    { code: 0, output: "" },
    { code: null, output: "", timedOut: true },
  );
  const { context, getWrittenResources } = testContext("check", {
    timeoutSeconds: 3,
  });
  await assertRejects(
    () =>
      check.execute(
        { scripts: ["a.gd", "hangs.gd"], _runner: runner },
        context,
      ),
    Error,
    "did not finish --check-only hangs.gd within 3 seconds",
  );
  assertEquals(getWrittenResources(), []);
});

Deno.test("an absolute projectPath and a project.godot path are used as given", async () => {
  const files = fakeFiles({
    "/abs/game/project.godot": PROJECT_GODOT,
  });
  const { runner, requests } = fakeRunner({});
  const { context, getWrittenResources } = testContext("version", {
    projectPath: "/abs/game/project.godot",
  });
  await version.execute({ _runner: runner, _files: files }, context);
  assertEquals(files.reads, ["/abs/game/project.godot"]);
  assertEquals(getWrittenResources()[0]?.data.projectPath, "/abs/game");
  const importContext = testContext("import", { projectPath: "/abs/game" });
  await importMethod.execute({ _runner: runner }, importContext.context);
  assertEquals(requests[1]?.args, [
    "--headless",
    "--path",
    "/abs/game",
    "--import",
  ]);
});

Deno.test("the project-file check passes for a directory with project.godot and names the fix otherwise", async () => {
  const checkContext = {
    globalArgs: { projectPath: "godot", godot: "godot", timeoutSeconds: 1 },
    repoDir: REPO,
  };
  const missing = await behavior.checks["project-file"].execute(
    checkContext,
    fakeFiles(),
  );
  assertEquals(missing.pass, false);
  assertStringIncludes(missing.errors?.[0] ?? "", "does not exist");
  const directory = await behavior.checks["project-file"].execute(
    checkContext,
    fakeFiles({}, {
      [`${PROJECT}/project.godot`]: { size: 0, isDirectory: true },
    }),
  );
  assertEquals(directory.pass, false);
  assertStringIncludes(directory.errors?.[0] ?? "", "is a directory");
  assertEquals(
    await behavior.checks["project-file"].execute(
      checkContext,
      fakeFiles({}, {
        [`${PROJECT}/project.godot`]: { size: 420, isDirectory: false },
      }),
    ),
    { pass: true },
  );
});

Deno.test("every method resource validates against its declared schema", async () => {
  const files = projectFiles();
  const { context, getWrittenResources } = testContext("version");
  await version.execute(
    { _runner: fakeRunner({}).runner, _files: files },
    context,
  );
  await importMethod.execute(
    { _runner: fakeRunner({ output: IMPORT_OUTPUT }).runner },
    context,
  );
  await presets.execute({ _files: files }, context);
  await exportMethod.execute(
    {
      preset: "Linux",
      path: "../build/linux/example.x86_64",
      mode: "release",
      _runner: fakeRunner({ output: EXPORT_OUTPUT }).runner,
      _files: files,
    },
    context,
  );
  await check.execute(
    {
      scripts: ["player.gd", "ok.gd"],
      _runner: fakeRunner({ code: 1, output: PARSE_ERROR_OUTPUT }, { code: 0 })
        .runner,
    },
    context,
  );
  const written = getWrittenResources();
  assertEquals(
    written.map((record) => record.specName),
    ["version", "import", "presets", "export", "check"],
  );
  const names = new Set(written.map((record) => record.name));
  assertEquals(names.size, written.length, "instance names are unique");
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

/** The preset shape, for reading records back in tests. */
type Preset = {
  name: string;
  platform: string;
  exportPath: string;
  runnable: boolean;
  dedicatedServer: boolean;
  exportFilter: string;
};

/** The script error shape, for reading records back in tests. */
type ScriptError = { line?: number; message: string };

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
