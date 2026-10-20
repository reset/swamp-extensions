/**
 * Unit tests for the Steam publishing behavior. Every test injects a runner,
 * file helpers and a fetch so nothing here runs steamcmd or reaches Steam.
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
  type Fetcher,
  type Files,
  type MethodContext,
  parseSteamcmdOutput,
  redact,
  redactKeyParameter,
  renderAppBuildVdf,
  type Runner,
  type RunRequest,
  type RunResult,
} from "./steam.ts";

const APP_ID = 480;
const PASSWORD = "hunter2-not-a-real-password";
const WEB_API_KEY = "0123456789ABCDEF0123456789ABCDEF";
const GUARD_CODE = "ABCDE";
const TEMP_DIR = "/tmp/fake-steam-temp";

/** A successful run_app_build transcript, shaped like steamcmd's. */
const SUCCESS_OUTPUT = [
  "Redirecting stderr to '/home/build/Steam/logs/stderr.txt'",
  "Loading Steam API...OK",
  `Logging in user 'builder' [U:1:1000001] to Steam Public...OK`,
  "Waiting for user info...OK",
  "Scanning content",
  "Uploading content...",
  "Building depot 481 ... done",
  "[2026-10-20 10:00:00]: Successfully finished AppID 480 build (BuildID 1234567).",
].join("\n");

const GUARD_MISMATCH_OUTPUT = [
  "Loading Steam API...OK",
  "Logging in user 'builder' [U:1:1000001] to Steam Public...FAILED (Two-factor code mismatch)",
].join("\n");

const GUARD_PROMPT_OUTPUT = [
  "Loading Steam API...OK",
  "Logging in user 'builder' to Steam Public...",
  "Steam Guard code:",
].join("\n");

const INVALID_PASSWORD_OUTPUT = [
  "Loading Steam API...OK",
  "Logging in user 'builder' to Steam Public...FAILED (Invalid Password)",
].join("\n");

interface FakeFiles extends Files {
  written: Map<string, string>;
  removed: string[];
  directories: string[];
}

function fakeFiles(): FakeFiles {
  const files: FakeFiles = {
    written: new Map(),
    removed: [],
    directories: [],
    makeTempDir: () => Promise.resolve(TEMP_DIR),
    mkdir: (path) => {
      files.directories.push(path);
      return Promise.resolve();
    },
    writeTextFile: (path, text) => {
      files.written.set(path, text);
      return Promise.resolve();
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
      output: SUCCESS_OUTPUT,
      timedOut: false,
      ...result,
    });
  };
  return { runner, requests };
}

interface Call {
  url: string;
  method: string;
  body: URLSearchParams | undefined;
}

type Route = (call: Call) => Response;

function fakeFetch(route: Route): { fetcher: Fetcher; calls: Call[] } {
  const calls: Call[] = [];
  const fetcher: Fetcher = (input, init) => {
    const body = typeof init?.body === "string"
      ? new URLSearchParams(init.body)
      : undefined;
    const call: Call = { url: input, method: init?.method ?? "GET", body };
    calls.push(call);
    return Promise.resolve(route(call));
  };
  return { fetcher, calls };
}

function json(
  body: unknown,
  status = 200,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const BUILDS_RESPONSE = {
  response: {
    result: 1,
    builds: {
      "1000": {
        BuildID: 1000,
        CreationTime: 1760000000,
        Description: "older",
        AccountIDCreator: 42,
      },
      "1234567": {
        BuildID: 1234567,
        CreationTime: 1760900000,
        Description: "candidate",
        AccountIDCreator: 42,
      },
      "1200": {
        BuildID: "1200",
        CreationTime: "1760500000",
        Description: "live one",
        AccountIDCreator: "42",
      },
    },
  },
};

const BETAS_RESPONSE = {
  response: {
    result: 1,
    betas: {
      public: { BuildID: 1200, Description: "", ReqPassword: 0, ReqLocalCS: 0 },
      beta: {
        BuildID: "1234567",
        Description: "Testers",
        ReqPassword: 1,
        ReqLocalCS: false,
      },
    },
  },
};

function steamRoutes(
  overrides: Partial<Record<"builds" | "betas" | "setLive", Route>> = {},
): Route {
  return (call) => {
    if (call.url.includes("GetAppBuilds")) {
      return overrides.builds?.(call) ?? json(BUILDS_RESPONSE);
    }
    if (call.url.includes("GetAppBetas")) {
      return overrides.betas?.(call) ?? json(BETAS_RESPONSE);
    }
    if (call.url.includes("SetAppBuildLive")) {
      return (
        overrides.setLive?.(call) ??
          json({ response: { result: 1, message: "" } })
      );
    }
    return new Response("unexpected", { status: 500 });
  };
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
    repoDir: "/work/game",
    globalArgs: {
      appId: APP_ID,
      steamcmd: "steamcmd",
      username: "builder",
      password: PASSWORD,
      webApiKey: WEB_API_KEY,
      contentRoot: "build/StandaloneLinux64",
      ...globalArgs,
    },
  });
  return {
    context: created.context as unknown as MethodContext,
    getWrittenResources: created.getWrittenResources,
    getLogs: created.getLogs,
  };
}

function assertNoSecretIn(text: string): void {
  assert(!text.includes(PASSWORD), "the password leaked");
  assert(!text.includes(WEB_API_KEY), "the Web API key leaked");
  assert(!text.includes(GUARD_CODE), "the Steam Guard code leaked");
}

const { upload, builds, setLive, betas } = behavior.methods;

Deno.test("renderAppBuildVdf writes the AppBuild script with escaped values and sorted depots", () => {
  const vdf = renderAppBuildVdf({
    appId: APP_ID,
    description: 'Build "quoted" C:\\path',
    contentRoot: "/work/game/build",
    buildOutput: "/work/game/.swamp/steam/build-output/480",
    depots: {
      "482": {
        localPath: "windows/*",
        depotPath: ".",
        recursive: true,
        exclusions: ["*.pdb"],
      },
      "481": {
        localPath: "*",
        depotPath: ".",
        recursive: false,
        exclusions: [],
      },
    },
    setLive: "beta",
    preview: false,
  });
  assertStringIncludes(vdf, '"AppBuild"\n{\n\t"AppID" "480"');
  assertStringIncludes(vdf, '"Desc" "Build \\"quoted\\" C:\\\\path"');
  assertStringIncludes(vdf, '"SetLive" "beta"');
  assertStringIncludes(vdf, '"Preview" "0"');
  assert(
    vdf.indexOf('"481"') < vdf.indexOf('"482"'),
    "depots are sorted by id",
  );
  assertStringIncludes(vdf, '"LocalPath" "windows/*"');
  assertStringIncludes(vdf, '"Recursive" "0"');
  assertStringIncludes(vdf, '"FileExclusion" "*.pdb"');
  assert(vdf.endsWith("}\n"));
});

Deno.test("renderAppBuildVdf leaves SetLive out when no branch is given", () => {
  const vdf = renderAppBuildVdf({
    appId: APP_ID,
    description: "d",
    contentRoot: "/c",
    buildOutput: "/o",
    depots: {},
    preview: true,
  });
  assert(!vdf.includes("SetLive"));
  assertStringIncludes(vdf, '"Preview" "1"');
});

Deno.test("parseSteamcmdOutput reads the BuildID, the login line and depot lines", () => {
  const report = parseSteamcmdOutput(SUCCESS_OUTPUT);
  assertEquals(report.buildId, 1234567);
  assertEquals(report.loginSucceeded, true);
  assertEquals(report.steamGuardLine, undefined);
  assertEquals(report.loginFailureLine, undefined);
  assertEquals(report.depots, [
    {
      depotId: "481",
      line: "Building depot 481 ... done",
    },
  ]);
  assertStringIncludes(report.excerpt.join("\n"), "(BuildID 1234567)");
});

Deno.test("parseSteamcmdOutput names Steam Guard trouble and other login failures", () => {
  assertStringIncludes(
    parseSteamcmdOutput(GUARD_MISMATCH_OUTPUT).steamGuardLine ?? "",
    "Two-factor code mismatch",
  );
  assertEquals(
    parseSteamcmdOutput(GUARD_PROMPT_OUTPUT).steamGuardLine,
    "Steam Guard code:",
  );
  const invalid = parseSteamcmdOutput(INVALID_PASSWORD_OUTPUT);
  assertEquals(invalid.steamGuardLine, undefined);
  assertStringIncludes(invalid.loginFailureLine ?? "", "Invalid Password");
  assertEquals(invalid.loginSucceeded, false);
});

Deno.test("parseSteamcmdOutput bounds the excerpt and keeps the lines that matter", () => {
  const noise = Array.from({ length: 500 }, (_, i) => `progress ${i}%`);
  const output = [
    "Logging in user 'b' to Steam Public...OK",
    ...noise,
    "Successfully finished AppID 480 build (BuildID 7).",
  ].join("\n");
  const report = parseSteamcmdOutput(output);
  assert(
    report.excerpt.length <= 120,
    `excerpt has ${report.excerpt.length} lines`,
  );
  assertEquals(report.lineCount, 502);
  assertEquals(report.excerpt[0], "Logging in user 'b' to Steam Public...OK");
  assertEquals(
    report.excerpt.at(-1),
    "Successfully finished AppID 480 build (BuildID 7).",
  );
  // The 20-line tail ends with the BuildID line, so 19 progress lines remain.
  assertEquals(
    report.excerpt.filter((line) => line.startsWith("progress")).length,
    19,
  );
});

Deno.test("redact replaces secrets and key parameters", () => {
  assertEquals(
    redact(`pw=${PASSWORD} code=${GUARD_CODE}`, [
      PASSWORD,
      undefined,
      "",
      GUARD_CODE,
    ]),
    "pw=[redacted] code=[redacted]",
  );
  assertEquals(
    redactKeyParameter(
      `https://partner.steam-api.com/x/?key=${WEB_API_KEY}&appid=480`,
    ),
    "https://partner.steam-api.com/x/?key=[redacted]&appid=480",
  );
});

Deno.test("upload generates the script, runs steamcmd with the password only in argv and records the build", async () => {
  const files = fakeFiles();
  const { runner, requests } = fakeRunner({
    output: `${SUCCESS_OUTPUT}\necho ${PASSWORD}`,
  });
  const { context, getWrittenResources, getLogs } = testContext("upload");
  const result = await upload.execute(
    {
      depots: {
        "481": "*",
        "482": {
          localPath: "windows/*",
          depotPath: ".",
          recursive: true,
          exclusions: [],
        },
      },
      description: "Nightly",
      setLive: "beta",
      preview: false,
      timeoutSeconds: 30,
      _runner: runner,
      _files: files,
    },
    context,
  );

  assertEquals(requests.length, 1);
  const request = requests[0];
  assert(request !== undefined);
  assertEquals(request.command, "steamcmd");
  const vdfPath = `${TEMP_DIR}/app_build_480.vdf`;
  assertEquals(request.args, [
    "+login",
    "builder",
    PASSWORD,
    "+run_app_build",
    vdfPath,
    "+quit",
  ]);
  assertEquals(request.timeoutMs, 30_000);
  assertEquals(files.directories, ["/work/game/.swamp/steam/build-output/480"]);
  const vdf = files.written.get(vdfPath);
  assert(vdf !== undefined, "the script was written");
  assertStringIncludes(
    vdf,
    '"ContentRoot" "/work/game/build/StandaloneLinux64"',
  );
  assertStringIncludes(vdf, '"SetLive" "beta"');
  assertStringIncludes(vdf, '"481"');
  assertStringIncludes(vdf, '"LocalPath" "windows/*"');
  assertEquals(files.removed, [TEMP_DIR]);

  const written = getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0]?.specName, "upload");
  assertEquals(written[0]?.name, "upload");
  const data = written[0]?.data ?? {};
  assertEquals(data.buildId, 1234567);
  assertEquals(data.appId, APP_ID);
  assertEquals(data.exitCode, 0);
  assertEquals(data.description, "Nightly");
  assertEquals(data.branch, "beta");
  assertEquals(data.vdf, vdfPath);
  assertEquals(data.depots, [
    {
      depotId: "481",
      line: "Building depot 481 ... done",
    },
  ]);
  assertEquals(data.logLines, 9);
  const excerpt = (data.logExcerpt as string[]).join("\n");
  assertStringIncludes(excerpt, "echo [redacted]");
  assertNoSecretIn(JSON.stringify(data));
  assertNoSecretIn(JSON.stringify(getLogs()));
  assertEquals(result.dataHandles.length, 1);
});

Deno.test("upload passes a Steam Guard code once and never records it", async () => {
  const files = fakeFiles();
  const { runner, requests } = fakeRunner({
    output: `${SUCCESS_OUTPUT}\nnoted ${GUARD_CODE}`,
  });
  const { context, getWrittenResources } = testContext("upload");
  await upload.execute(
    {
      depots: { "481": "*" },
      steamGuardCode: GUARD_CODE,
      preview: false,
      timeoutSeconds: 30,
      _runner: runner,
      _files: files,
    },
    context,
  );
  assertEquals(requests[0]?.args.slice(0, 4), [
    "+set_steam_guard_code",
    GUARD_CODE,
    "+login",
    "builder",
  ]);
  assertNoSecretIn(JSON.stringify(getWrittenResources()));
});

Deno.test("upload relies on the cached login when no password is set", async () => {
  const files = fakeFiles();
  const { runner, requests } = fakeRunner({});
  const { context } = testContext("upload", { password: undefined });
  await upload.execute(
    {
      depots: { "481": "*" },
      preview: false,
      timeoutSeconds: 30,
      _runner: runner,
      _files: files,
    },
    context,
  );
  assertEquals(requests[0]?.args, [
    "+login",
    "builder",
    "+run_app_build",
    `${TEMP_DIR}/app_build_480.vdf`,
    "+quit",
  ]);
});

Deno.test("upload runs a supplied script as it is, resolved against the repository", async () => {
  const files = fakeFiles();
  const { runner, requests } = fakeRunner({});
  const { context, getWrittenResources } = testContext("upload", {
    contentRoot: undefined,
  });
  await upload.execute(
    {
      vdf: "steam/app_build.vdf",
      preview: false,
      timeoutSeconds: 30,
      _runner: runner,
      _files: files,
    },
    context,
  );
  assertEquals(requests[0]?.args[4], "/work/game/steam/app_build.vdf");
  assertEquals(files.written.size, 0);
  assertEquals(files.removed, []);
  const data = getWrittenResources()[0]?.data ?? {};
  assertEquals(data.vdf, "/work/game/steam/app_build.vdf");
  assertEquals(data.description, undefined);
  assertEquals(data.branch, undefined);
});

Deno.test("upload fails with a Steam Guard error when the code is refused, and writes nothing", async () => {
  const files = fakeFiles();
  const { runner } = fakeRunner({ code: 5, output: GUARD_MISMATCH_OUTPUT });
  const { context, getWrittenResources } = testContext("upload");
  const error = await assertRejects(
    () =>
      upload.execute(
        {
          depots: { "481": "*" },
          preview: false,
          timeoutSeconds: 30,
          _runner: runner,
          _files: files,
        },
        context,
      ),
    Error,
    "Steam Guard",
  );
  assertStringIncludes(error.message, "Two-factor code mismatch");
  assertStringIncludes(error.message, "steamGuardCode");
  assertEquals(getWrittenResources(), []);
  assertEquals(files.removed, [TEMP_DIR]);
});

Deno.test("upload fails with a Steam Guard error when steamcmd stops at the code prompt", async () => {
  const files = fakeFiles();
  const { runner } = fakeRunner({
    code: null,
    output: GUARD_PROMPT_OUTPUT,
    timedOut: true,
  });
  const { context } = testContext("upload");
  await assertRejects(
    () =>
      upload.execute(
        {
          depots: { "481": "*" },
          preview: false,
          timeoutSeconds: 30,
          _runner: runner,
          _files: files,
        },
        context,
      ),
    Error,
    "Steam Guard",
  );
});

Deno.test("upload reports a timeout that names the Steam Guard case", async () => {
  const files = fakeFiles();
  const { runner } = fakeRunner({
    code: null,
    output:
      "Loading Steam API...OK\nLogging in user 'builder' to Steam Public...",
    timedOut: true,
  });
  const { context } = testContext("upload");
  const error = await assertRejects(
    () =>
      upload.execute(
        {
          depots: { "481": "*" },
          preview: false,
          timeoutSeconds: 7,
          _runner: runner,
          _files: files,
        },
        context,
      ),
    Error,
    "did not finish within 7 seconds",
  );
  assertStringIncludes(error.message, "Steam Guard");
});

Deno.test("upload distinguishes a wrong password from a failed build", async () => {
  const files = fakeFiles();
  const { context } = testContext("upload");
  const run = (output: string, code: number) =>
    upload.execute(
      {
        depots: { "481": "*" },
        preview: false,
        timeoutSeconds: 30,
        _runner: fakeRunner({ code, output }).runner,
        _files: files,
      },
      context,
    );
  await assertRejects(
    () => run(INVALID_PASSWORD_OUTPUT, 5),
    Error,
    "login as builder failed",
  );
  const error = await assertRejects(
    () =>
      run(
        "Logging in user 'builder' to Steam Public...OK\nERROR! Failed to commit build",
        1,
      ),
    Error,
    "exited with code 1 and reported no BuildID",
  );
  assertStringIncludes(error.message, "Failed to commit build");
});

Deno.test("upload refuses to run without a script source or content root", async () => {
  const files = fakeFiles();
  const { runner, requests } = fakeRunner({});
  const { context } = testContext("upload");
  await assertRejects(
    () =>
      upload.execute(
        {
          preview: false,
          timeoutSeconds: 30,
          _runner: runner,
          _files: files,
        },
        context,
      ),
    Error,
    "either vdf",
  );
  const noRoot = testContext("upload", { contentRoot: undefined }).context;
  await assertRejects(
    () =>
      upload.execute(
        {
          depots: { "481": "*" },
          preview: false,
          timeoutSeconds: 30,
          _runner: runner,
          _files: files,
        },
        noRoot,
      ),
    Error,
    "contentRoot",
  );
  assertEquals(requests, []);
});

Deno.test("upload explains a missing steamcmd", async () => {
  const files = fakeFiles();
  const { runner } = fakeRunner(new Deno.errors.NotFound("No such file"));
  const { context } = testContext("upload", {
    steamcmd: "/opt/steamcmd/steamcmd.sh",
  });
  await assertRejects(
    () =>
      upload.execute(
        {
          depots: { "481": "*" },
          preview: false,
          timeoutSeconds: 30,
          _runner: runner,
          _files: files,
        },
        context,
      ),
    Error,
    'steamcmd was not found as "/opt/steamcmd/steamcmd.sh"',
  );
  assertEquals(files.removed, [TEMP_DIR]);
});

Deno.test("builds reads GetAppBuilds and GetAppBetas and records the branches each build is live on", async () => {
  const { fetcher, calls } = fakeFetch(steamRoutes());
  const { context, getWrittenResources, getLogs } = testContext("builds");
  await builds.execute({ count: 50, _fetch: fetcher }, context);

  assertEquals(
    calls.map((call) => call.method),
    ["GET", "GET"],
  );
  const buildsUrl = new URL(calls[0]?.url ?? "");
  assertEquals(
    buildsUrl.origin + buildsUrl.pathname,
    "https://partner.steam-api.com/ISteamApps/GetAppBuilds/v1/",
  );
  assertEquals(buildsUrl.searchParams.get("key"), WEB_API_KEY);
  assertEquals(buildsUrl.searchParams.get("appid"), "480");
  assertEquals(buildsUrl.searchParams.get("count"), "50");
  assertStringIncludes(calls[1]?.url ?? "", "/ISteamApps/GetAppBetas/v1/?key=");

  const data = getWrittenResources()[0]?.data ?? {};
  assertEquals(getWrittenResources()[0]?.specName, "builds");
  assertEquals(data.appId, APP_ID);
  assertEquals(data.count, 50);
  assertEquals(data.truncated, false);
  assertEquals(data.buildIds, [1234567, 1200, 1000]);
  const records = data.builds as Array<Record<string, unknown>>;
  assertEquals(records[0]?.liveOn, ["beta"]);
  assertEquals(records[1]?.liveOn, ["public"]);
  assertEquals(records[2]?.liveOn, []);
  assertEquals(records[1]?.creatorAccountId, 42);
  assertEquals(
    records[0]?.createdAt,
    new Date(1760900000 * 1000).toISOString(),
  );
  assertEquals(
    (records[0]?.raw as Record<string, unknown>).Description,
    "candidate",
  );
  assertNoSecretIn(JSON.stringify(data));
  assertNoSecretIn(JSON.stringify(getLogs()));
});

Deno.test("builds marks the list truncated when Steam returned as many as were asked for", async () => {
  const { fetcher } = fakeFetch(steamRoutes());
  const { context, getWrittenResources } = testContext("builds");
  await builds.execute({ count: 3, _fetch: fetcher }, context);
  assertEquals(getWrittenResources()[0]?.data.truncated, true);
});

Deno.test("builds maps a rejected key to a clear error that does not contain the key", async () => {
  const { fetcher } = fakeFetch(
    () => new Response("Forbidden", { status: 403 }),
  );
  const { context, getWrittenResources } = testContext("builds");
  const error = await assertRejects(
    () => builds.execute({ count: 10, _fetch: fetcher }, context),
    Error,
    "rejected the Web API key (HTTP 403)",
  );
  assertNoSecretIn(error.message);
  assertEquals(getWrittenResources(), []);
});

Deno.test("builds surfaces a non-success result and its message", async () => {
  const { fetcher } = fakeFetch(() =>
    json({ response: { result: 2, message: "No such app" } })
  );
  const { context } = testContext("builds");
  await assertRejects(
    () => builds.execute({ count: 10, _fetch: fetcher }, context),
    Error,
    "result 2: No such app",
  );
});

Deno.test("Web API methods need the key and say so", async () => {
  const { fetcher, calls } = fakeFetch(steamRoutes());
  const { context } = testContext("builds", { webApiKey: undefined });
  await assertRejects(
    () => builds.execute({ count: 10, _fetch: fetcher }, context),
    Error,
    "builds needs the webApiKey",
  );
  await assertRejects(
    () => betas.execute({ _fetch: fetcher }, context),
    Error,
    "betas needs the webApiKey",
  );
  assertEquals(calls, []);
});

Deno.test("Web API errors keep the key out of the message", async () => {
  const { fetcher } = fakeFetch(
    (call) => new Response(`bad request to ${call.url}`, { status: 400 }),
  );
  const { context } = testContext("betas");
  const error = await assertRejects(
    () => betas.execute({ _fetch: fetcher }, context),
    Error,
    "HTTP 400",
  );
  assertNoSecretIn(error.message);
  assertStringIncludes(error.message, "key=[redacted]");
  const failing = fakeFetch(() => {
    throw new Error(`connect failed for ?key=${WEB_API_KEY}`);
  });
  const network = await assertRejects(
    () => betas.execute({ _fetch: failing.fetcher }, context),
    Error,
    "request failed",
  );
  assertNoSecretIn(network.message);
});

Deno.test("setLive posts the form with the key in the body and records Steam's answer", async () => {
  const { fetcher, calls } = fakeFetch(steamRoutes());
  const { context, getWrittenResources, getLogs } = testContext("setLive");
  await setLive.execute(
    {
      buildId: 1234567,
      branch: "public",
      description: "Release 1.2.0",
      approverSteamId: "76561197960287930",
      _fetch: fetcher,
    },
    context,
  );

  assertEquals(calls.length, 2);
  const post = calls[1];
  assert(post !== undefined);
  assertEquals(post.method, "POST");
  assertEquals(
    post.url,
    "https://partner.steam-api.com/ISteamApps/SetAppBuildLive/v2/",
  );
  assertEquals(post.body?.get("key"), WEB_API_KEY);
  assertEquals(post.body?.get("appid"), "480");
  assertEquals(post.body?.get("buildid"), "1234567");
  assertEquals(post.body?.get("betakey"), "public");
  assertEquals(post.body?.get("description"), "Release 1.2.0");
  assertEquals(post.body?.get("steamid"), "76561197960287930");

  const written = getWrittenResources();
  assertEquals(written[0]?.specName, "release");
  const data = written[0]?.data ?? {};
  assertEquals(data.buildId, 1234567);
  assertEquals(data.branch, "public");
  assertEquals(data.alreadyLive, false);
  assertEquals(data.response, { result: 1, message: "" });
  assertEquals(data.description, "Release 1.2.0");
  assertNoSecretIn(JSON.stringify(data));
  assertNoSecretIn(JSON.stringify(getLogs()));
});

Deno.test("setLive does not ask again when the build is already live on the branch", async () => {
  const { fetcher, calls } = fakeFetch(steamRoutes());
  const { context, getWrittenResources } = testContext("setLive");
  await setLive.execute(
    { buildId: 1234567, branch: "beta", _fetch: fetcher },
    context,
  );
  assertEquals(
    calls.map((call) => call.method),
    ["GET"],
  );
  const data = getWrittenResources()[0]?.data ?? {};
  assertEquals(data.alreadyLive, true);
  assertEquals(data.response, null);
  assertEquals(data.description, undefined);
});

Deno.test("setLive reports a rate limit with the retry hint and writes nothing", async () => {
  const { fetcher } = fakeFetch(
    steamRoutes({
      setLive: () =>
        new Response("", { status: 429, headers: { "retry-after": "30" } }),
    }),
  );
  const { context, getWrittenResources } = testContext("setLive");
  await assertRejects(
    () =>
      setLive.execute(
        { buildId: 1234567, branch: "public", _fetch: fetcher },
        context,
      ),
    Error,
    "rate limited the request (HTTP 429), retry after 30 seconds",
  );
  assertEquals(getWrittenResources(), []);
});

Deno.test("setLive fails when Steam answers with a non-success result", async () => {
  const { fetcher } = fakeFetch(
    steamRoutes({
      setLive: () =>
        json({ response: { result: 8, message: "Build not found" } }),
    }),
  );
  const { context } = testContext("setLive");
  await assertRejects(
    () =>
      setLive.execute(
        { buildId: 99, branch: "public", _fetch: fetcher },
        context,
      ),
    Error,
    "result 8: Build not found",
  );
});

Deno.test("betas records the branches sorted by name with coerced flags", async () => {
  const { fetcher } = fakeFetch(steamRoutes());
  const { context, getWrittenResources } = testContext("betas");
  await betas.execute({ _fetch: fetcher }, context);
  const data = getWrittenResources()[0]?.data ?? {};
  assertEquals(getWrittenResources()[0]?.specName, "betas");
  assertEquals(data.appId, APP_ID);
  assertEquals(data.branches, [
    {
      name: "beta",
      buildId: 1234567,
      description: "Testers",
      requiresPassword: true,
      requiresLocalContentServer: false,
    },
    {
      name: "public",
      buildId: 1200,
      description: "",
      requiresPassword: false,
      requiresLocalContentServer: false,
    },
  ]);
});

Deno.test("every method resource validates against its declared schema", async () => {
  const files = fakeFiles();
  const { runner } = fakeRunner({});
  const { fetcher } = fakeFetch(steamRoutes());
  const { context, getWrittenResources } = testContext("upload");
  await upload.execute(
    {
      depots: { "481": "*" },
      preview: false,
      timeoutSeconds: 30,
      _runner: runner,
      _files: files,
    },
    context,
  );
  await builds.execute({ count: 50, _fetch: fetcher }, context);
  await setLive.execute(
    { buildId: 1000, branch: "public", _fetch: fetcher },
    context,
  );
  await betas.execute({ _fetch: fetcher }, context);
  const written = getWrittenResources();
  assertEquals(
    written.map((record) => record.specName),
    ["upload", "builds", "release", "betas"],
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
