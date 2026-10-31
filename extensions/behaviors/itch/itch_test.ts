/**
 * Unit tests for the itch.io publishing behavior. Every test injects a
 * runner, a fetch, a clock and a sleep, so nothing here runs butler or
 * reaches itch.io. The fixtures are shaped like butler v15.32.0's `-j`
 * output.
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
  excerpt,
  type Fetcher,
  type MethodContext,
  parseButlerOutput,
  parseStatusResult,
  redact,
  type Runner,
  type RunRequest,
  type RunResult,
} from "./itch.ts";

const API_KEY = "itch-key-not-a-real-one-0123456789";
const TARGET = "studio/game";

function json(message: Record<string, unknown>): string {
  return JSON.stringify({ time: 1792604281, ...message });
}

function log(message: string, level = "info"): string {
  return json({ type: "log", level, message });
}

function result(value: Record<string, unknown>): string {
  return json({ type: "result", value });
}

const PUSH_OK = [
  log(
    "• For channel `windows-beta`: last build is 41, downloading its signature",
  ),
  json({ type: "buildCreated", buildId: 42, channel: "windows-beta" }),
  json({ type: "progress", progress: 0.5 }),
  log("✓ Uploaded patch", "info"),
  result({
    buildId: 42,
    channel: "windows-beta",
    dryRun: false,
    skipped: false,
    reason: "",
  }),
].join("\n");

const NO_CREDENTIALS = [
  log(
    "Please set BUTLER_API_KEY to your API key, see https://itch.io/docs/butler/login.html for more info.",
  ),
  json({
    type: "error",
    message: "No credentials and stdin is not a terminal - terminating.",
  }),
].join("\n");

const INVALID_KEY = json({
  type: "error",
  message:
    "itch.io API error (403): /wharf/channels: invalid key\ngithub.com/itchio/go-itchio.(*Client).GetResponse\n\t/go/http_helpers.go:131",
});

function statusResult(
  channels: Record<string, unknown>[],
): string {
  return result({ target: TARGET, channels });
}

function channel(
  name: string,
  head?: Record<string, unknown>,
  pending?: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name,
    tags: ["windows"],
    uploadId: 900,
  };
  if (head) out.head = head;
  if (pending) out.pending = pending;
  return out;
}

function build(id: number, state: string): Record<string, unknown> {
  return {
    id,
    state,
    version: id - 30,
    userVersion: "1.2.0",
    parentBuildId: id - 1,
    createdAt: "2026-10-21T10:00:00Z",
    updatedAt: "2026-10-21T10:01:00Z",
  };
}

interface FakeRunner {
  runner: Runner;
  requests: RunRequest[];
}

function fakeRunner(
  results: RunResult[] | ((r: RunRequest) => RunResult),
): FakeRunner {
  const requests: RunRequest[] = [];
  let index = 0;
  const runner: Runner = (request) => {
    requests.push(request);
    if (typeof results === "function") {
      return Promise.resolve(results(request));
    }
    const next = results[Math.min(index, results.length - 1)];
    index++;
    if (next === undefined) {
      throw new Error("no fake result");
    }
    return Promise.resolve(next);
  };
  return { runner, requests };
}

function ok(stdout: string): RunResult {
  return { code: 0, stdout, stderr: "", timedOut: false };
}

function failed(stdout: string, stderr = "bailing out: something"): RunResult {
  return { code: 1, stdout, stderr, timedOut: false };
}

function context(
  methodName: string,
  globalArgs: Record<string, unknown> = {},
) {
  const created = createModelTestContext({
    methodName,
    repoDir: "/work/game",
    globalArgs: {
      target: TARGET,
      butler: "butler",
      apiKey: API_KEY,
      ...globalArgs,
    },
  });
  return {
    context: {
      ...created.context,
      globalArgs: created.context.globalArgs,
    } as unknown as MethodContext,
    getWrittenResources: created.getWrittenResources,
    getLogs: created.getLogs,
  };
}

function written(
  getWrittenResources: () => Array<{ specName: string; data: unknown }>,
  spec: string,
): Record<string, unknown> {
  const found = getWrittenResources().filter((r) => r.specName === spec);
  assertEquals(found.length, 1, `one ${spec} record`);
  return found[0]?.data as Record<string, unknown>;
}

const PUSH_DEFAULTS = {
  ifChanged: false,
  dryRun: false,
  hidden: false,
  fixPermissions: false,
  ignore: [] as string[],
  timeoutSeconds: 3600,
};

const STATUS_DEFAULTS = {
  waitSeconds: 0,
  intervalSeconds: 15,
  timeoutSeconds: 120,
};

Deno.test("push passes the target, flags and key, and records the build id", async () => {
  const fake = fakeRunner([ok(PUSH_OK)]);
  const { context: ctx, getWrittenResources } = context("push");
  await behavior.methods.push.execute({
    ...PUSH_DEFAULTS,
    directory: "build/windows",
    channel: "windows-beta",
    userVersion: "1.2.0",
    ifChanged: true,
    fixPermissions: true,
    ignore: ["*.pdb", "*.dSYM"],
    _runner: fake.runner,
  }, ctx);
  const request = fake.requests[0];
  assert(request !== undefined);
  assertEquals(request.command, "butler");
  assertEquals(request.args, [
    "-j",
    "push",
    "--userversion",
    "1.2.0",
    "--if-changed",
    "--fix-permissions",
    "--ignore",
    "*.pdb",
    "--ignore",
    "*.dSYM",
    "/work/game/build/windows",
    "studio/game:windows-beta",
  ]);
  assertEquals(request.env, { BUTLER_API_KEY: API_KEY });
  assert(
    !request.args.join(" ").includes(API_KEY),
    "key not on the command line",
  );
  assertEquals(request.timeoutMs, 3_600_000);
  const data = written(getWrittenResources, "push");
  assertEquals(data.buildId, 42);
  assertEquals(data.channel, "windows-beta");
  assertEquals(data.dryRun, false);
  assertEquals(data.skipped, false);
  assertEquals(data.userVersion, "1.2.0");
  assertEquals(data.directory, "/work/game/build/windows");
  assertEquals(data.exitCode, 0);
});

Deno.test("push with an identity file and no key sets -i and no environment", async () => {
  const fake = fakeRunner([ok(PUSH_OK)]);
  const { context: ctx } = context("push", {
    apiKey: undefined,
    identity: "/home/ci/.config/itch/second_creds",
  });
  await behavior.methods.push.execute({
    ...PUSH_DEFAULTS,
    directory: "/abs/build",
    channel: "windows-beta",
    userVersionFile: "build/version.txt",
    hidden: true,
    _runner: fake.runner,
  }, ctx);
  const request = fake.requests[0];
  assert(request !== undefined);
  assertEquals(request.args.slice(0, 3), [
    "-j",
    "-i",
    "/home/ci/.config/itch/second_creds",
  ]);
  assert(request.args.includes("--hidden"));
  assertEquals(
    request.args[request.args.indexOf("--userversion-file") + 1],
    "/work/game/build/version.txt",
  );
  assertEquals(request.args.at(-2), "/abs/build");
  assertEquals(request.env, {});
});

Deno.test("push treats an empty userVersion as none", async () => {
  const fake = fakeRunner([ok(PUSH_OK)]);
  const { context: ctx, getWrittenResources } = context("push");
  await behavior.methods.push.execute({
    ...PUSH_DEFAULTS,
    directory: "build",
    channel: "windows-beta",
    userVersion: "",
    _runner: fake.runner,
  }, ctx);
  assert(!fake.requests[0]?.args.includes("--userversion"));
  assertEquals(written(getWrittenResources, "push").userVersion, undefined);
});

Deno.test("a dry run records build 0 and the file listing", async () => {
  const stdout = [
    log("• Dry run, listing files we would push..."),
    log("-rw-r--r--        3 B a.txt"),
    log("✓ Would push 3 B (1 files, 0 dirs, 0 symlinks)"),
    result({
      buildId: 0,
      channel: "test",
      dryRun: true,
      reason: "dry-run",
      skipped: false,
    }),
  ].join("\n");
  const fake = fakeRunner([ok(stdout)]);
  const { context: ctx, getWrittenResources } = context("push");
  await behavior.methods.push.execute({
    ...PUSH_DEFAULTS,
    directory: "build",
    channel: "test",
    dryRun: true,
    _runner: fake.runner,
  }, ctx);
  assert(fake.requests[0]?.args.includes("--dry-run"));
  const data = written(getWrittenResources, "push");
  assertEquals(data.buildId, 0);
  assertEquals(data.dryRun, true);
  assertEquals(data.reason, "dry-run");
  assertEquals(data.logExcerpt, [
    "• Dry run, listing files we would push...",
    "-rw-r--r--        3 B a.txt",
    "✓ Would push 3 B (1 files, 0 dirs, 0 symlinks)",
  ]);
});

Deno.test("an unchanged push with --if-changed is recorded as skipped", async () => {
  const stdout = result({
    buildId: 0,
    channel: "windows-beta",
    dryRun: false,
    skipped: true,
    reason: "if-changed",
  });
  const { context: ctx, getWrittenResources } = context("push");
  await behavior.methods.push.execute({
    ...PUSH_DEFAULTS,
    directory: "build",
    channel: "windows-beta",
    ifChanged: true,
    _runner: fakeRunner([ok(stdout)]).runner,
  }, ctx);
  const data = written(getWrittenResources, "push");
  assertEquals(data.skipped, true);
  assertEquals(data.reason, "if-changed");
});

Deno.test("push that exits zero without a build id fails", async () => {
  const stdout = result({
    channel: "windows-beta",
    dryRun: false,
    skipped: false,
  });
  const { context: ctx, getWrittenResources } = context("push");
  await assertRejects(
    () =>
      behavior.methods.push.execute({
        ...PUSH_DEFAULTS,
        directory: "build",
        channel: "windows-beta",
        _runner: fakeRunner([ok(stdout)]).runner,
      }, ctx),
    Error,
    "no build id",
  );
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("push without credentials names the fix", async () => {
  const { context: ctx } = context("push", { apiKey: undefined });
  await assertRejects(
    () =>
      behavior.methods.push.execute({
        ...PUSH_DEFAULTS,
        directory: "build",
        channel: "windows-beta",
        _runner: fakeRunner([
          failed(
            NO_CREDENTIALS,
            "bailing out: No credentials and stdin is not a terminal - terminating.",
          ),
        ]).runner,
      }, ctx),
    Error,
    "set the apiKey global argument",
  );
});

Deno.test("an error that echoes the key is redacted, and the stack trace dropped", async () => {
  const stdout = json({
    type: "error",
    message:
      `upload failed for key ${API_KEY}\ngithub.com/itchio/butler/cmd/push.Do\n\t/push.go:1`,
  });
  const stderr =
    `bailing out: upload failed for key ${API_KEY}\ngithub.com/itchio/butler/cmd/push.Do\n\t/push.go:1`;
  const { context: ctx } = context("push");
  const error = await assertRejects(
    () =>
      behavior.methods.push.execute({
        ...PUSH_DEFAULTS,
        directory: "build",
        channel: "windows-beta",
        _runner: fakeRunner([failed(stdout, stderr)]).runner,
      }, ctx),
    Error,
  );
  assert(!error.message.includes(API_KEY), "the key leaked");
  assertStringIncludes(error.message, "[redacted]");
  assert(!error.message.includes("push.go"), "stack trace kept");
  assertStringIncludes(error.message, "exited with code 1");
});

Deno.test("push that hits the deadline says it was killed", async () => {
  const { context: ctx } = context("push");
  await assertRejects(
    () =>
      behavior.methods.push.execute({
        ...PUSH_DEFAULTS,
        directory: "build",
        channel: "windows-beta",
        timeoutSeconds: 5,
        _runner: fakeRunner([{
          code: null,
          stdout: log("• Uploading"),
          stderr: "",
          timedOut: true,
        }]).runner,
      }, ctx),
    Error,
    "did not finish within 5 seconds",
  );
});

Deno.test("a missing butler binary names the install page", async () => {
  const { context: ctx } = context("version", { butler: "/opt/none/butler" });
  await assertRejects(
    () =>
      behavior.methods.version.execute({
        _runner: () => Promise.reject(new Deno.errors.NotFound("nope")),
      }, ctx),
    Error,
    'butler was not found as "/opt/none/butler"',
  );
});

Deno.test("status reads every channel once and marks ready and failed", async () => {
  const stdout = statusResult([
    channel("linux-stable", build(40, "completed")),
    channel("windows-beta", build(41, "completed"), build(42, "processing")),
    channel("mac-beta", build(43, "failed")),
    channel("android"),
  ]);
  const fake = fakeRunner([ok(stdout)]);
  const { context: ctx, getWrittenResources } = context("status");
  await behavior.methods.status.execute({
    ...STATUS_DEFAULTS,
    _runner: fake.runner,
  }, ctx);
  assertEquals(fake.requests.length, 1);
  assertEquals(fake.requests[0]?.args, ["-j", "status", "studio/game"]);
  const data = written(getWrittenResources, "status");
  assertEquals(data.channelNames, [
    "linux-stable",
    "windows-beta",
    "mac-beta",
    "android",
  ]);
  const channels = data.channels as Array<Record<string, unknown>>;
  assertEquals(channels.map((c) => c.ready), [true, false, false, false]);
  assertEquals(channels.map((c) => c.failed), [false, false, true, false]);
  assertEquals(data.ready, false);
  assertEquals(data.failed, true);
  assertEquals(data.found, true);
  assertEquals(data.reads, 1);
  assertEquals(data.timedOut, false);
  assertEquals(data.channel, undefined);
});

Deno.test("status waits until the channel's pending build completes", async () => {
  const reads = [
    statusResult([
      channel("windows-beta", build(41, "completed"), build(42, "queued")),
    ]),
    statusResult([
      channel("windows-beta", build(41, "completed"), build(42, "processing")),
    ]),
    statusResult([channel("windows-beta", build(42, "completed"))]),
  ].map(ok);
  const fake = fakeRunner(reads);
  let clock = 1_000_000;
  const sleeps: number[] = [];
  const { context: ctx, getWrittenResources } = context("status");
  await behavior.methods.status.execute({
    ...STATUS_DEFAULTS,
    channel: "windows-beta",
    waitSeconds: 600,
    intervalSeconds: 10,
    _runner: fake.runner,
    _now: () => clock,
    _sleep: (ms) => {
      sleeps.push(ms);
      clock += ms;
      return Promise.resolve();
    },
  }, ctx);
  assertEquals(fake.requests[0]?.args, [
    "-j",
    "status",
    "studio/game:windows-beta",
  ]);
  assertEquals(sleeps, [10_000, 10_000]);
  const data = written(getWrittenResources, "status");
  assertEquals(data.reads, 3);
  assertEquals(data.ready, true);
  assertEquals(data.timedOut, false);
  assertEquals(data.waitedSeconds, 20);
  assertEquals(data.channel, "windows-beta");
  const head = (data.channels as Array<Record<string, unknown>>)[0]
    ?.head as Record<string, unknown>;
  assertEquals(head.id, 42);
  assertEquals(head.parentBuildId, 41);
});

Deno.test("status stops waiting at once when the build failed", async () => {
  const fake = fakeRunner([
    ok(statusResult([
      channel("windows-beta", build(41, "completed"), build(42, "failed")),
    ])),
  ]);
  const { context: ctx, getWrittenResources } = context("status");
  await behavior.methods.status.execute({
    ...STATUS_DEFAULTS,
    channel: "windows-beta",
    waitSeconds: 600,
    _runner: fake.runner,
    _sleep: () => Promise.reject(new Error("should not sleep")),
  }, ctx);
  const data = written(getWrittenResources, "status");
  assertEquals(data.failed, true);
  assertEquals(data.ready, false);
  assertEquals(data.reads, 1);
});

Deno.test("status records a timeout instead of waiting past the deadline", async () => {
  const fake = fakeRunner([
    ok(statusResult([
      channel("windows-beta", build(41, "completed"), build(42, "processing")),
    ])),
  ]);
  let clock = 0;
  const { context: ctx, getWrittenResources } = context("status");
  await behavior.methods.status.execute({
    ...STATUS_DEFAULTS,
    channel: "windows-beta",
    waitSeconds: 30,
    intervalSeconds: 10,
    _runner: fake.runner,
    _now: () => clock,
    _sleep: (ms) => {
      clock += ms;
      return Promise.resolve();
    },
  }, ctx);
  const data = written(getWrittenResources, "status");
  assertEquals(data.timedOut, true);
  assertEquals(data.ready, false);
  // Reads at 0, 10, 20 and 30 seconds; a fifth would start past the deadline.
  assertEquals(data.reads, 4);
  assertEquals(data.waitedSeconds, 30);
});

Deno.test("status of a channel that does not exist is recorded as not found", async () => {
  const { context: ctx, getWrittenResources, getLogs } = context("status");
  await behavior.methods.status.execute({
    ...STATUS_DEFAULTS,
    channel: "nope",
    _runner: fakeRunner([ok(statusResult([]))]).runner,
  }, ctx);
  const data = written(getWrittenResources, "status");
  assertEquals(data.found, false);
  assertEquals(data.ready, false);
  assert(getLogs().some((entry) => entry.level === "warning"));
});

Deno.test("status with a rejected key says so", async () => {
  const { context: ctx } = context("status");
  await assertRejects(
    () =>
      behavior.methods.status.execute({
        ...STATUS_DEFAULTS,
        _runner: fakeRunner([failed(INVALID_KEY)]).runner,
      }, ctx),
    Error,
    "refused the API key",
  );
});

Deno.test("status aborts while waiting when swamp cancels", async () => {
  const controller = new AbortController();
  const { context: ctx, getWrittenResources } = context("status");
  ctx.signal = controller.signal;
  await assertRejects(
    () =>
      behavior.methods.status.execute({
        ...STATUS_DEFAULTS,
        channel: "windows-beta",
        waitSeconds: 600,
        intervalSeconds: 5,
        _runner: fakeRunner([
          ok(statusResult([
            channel("windows-beta", undefined, build(42, "started")),
          ])),
        ]).runner,
        _sleep: (_ms, signal) => {
          controller.abort();
          return signal?.aborted
            ? Promise.reject(new Error("aborted"))
            : Promise.resolve();
        },
      }, ctx),
    Error,
    "aborted",
  );
  assertEquals(getWrittenResources().length, 0);
});

function fakeFetch(status: number, body: string): {
  fetcher: Fetcher;
  urls: string[];
} {
  const urls: string[] = [];
  const fetcher: Fetcher = (input) => {
    urls.push(input);
    return Promise.resolve(new Response(body, { status }));
  };
  return { fetcher, urls };
}

Deno.test("latest reads the public update check without credentials", async () => {
  const fake = fakeFetch(200, JSON.stringify({ latest: "106" }));
  const { context: ctx, getWrittenResources } = context("latest");
  await behavior.methods.latest.execute({
    channel: "win32-beta",
    _fetch: fake.fetcher,
  }, ctx);
  assertEquals(fake.urls, [
    "https://api.itch.io/wharf/latest?target=studio%2Fgame&channel_name=win32-beta",
  ]);
  assert(!fake.urls[0]?.includes(API_KEY));
  const data = written(getWrittenResources, "latest");
  assertEquals(data.latest, "106");
  assertEquals(data.channel, "win32-beta");
});

Deno.test("latest with no user version records none", async () => {
  const { context: ctx, getWrittenResources } = context("latest");
  await behavior.methods.latest.execute({
    channel: "win32-beta",
    _fetch: fakeFetch(200, "{}").fetcher,
  }, ctx);
  assertEquals(written(getWrittenResources, "latest").latest, undefined);
});

Deno.test("latest on a private game or unknown channel fails with itch.io's reason", async () => {
  const { context: ctx } = context("latest");
  await assertRejects(
    () =>
      behavior.methods.latest.execute({
        channel: "osx",
        _fetch: fakeFetch(404, JSON.stringify({ errors: ["invalid channel"] }))
          .fetcher,
      }, ctx),
    Error,
    "(HTTP 404): invalid channel",
  );
});

Deno.test("version records butler's version fields", async () => {
  const stdout = result({
    version: "v15.32.0",
    builtAt: "2026-10-05T21:11:54-07:00",
    commit: "336f95416289de8fd17589000d48de5526c1a8f2",
    versionString: "v15.32.0, built on Oct  5 2026",
  });
  const fake = fakeRunner([ok(stdout)]);
  const { context: ctx, getWrittenResources } = context("version");
  await behavior.methods.version.execute({ _runner: fake.runner }, ctx);
  assertEquals(fake.requests[0]?.args, ["-j", "version"]);
  const data = written(getWrittenResources, "version");
  assertEquals(data.version, "v15.32.0");
  assertEquals(data.commit, "336f95416289de8fd17589000d48de5526c1a8f2");
});

Deno.test("parseButlerOutput sorts messages and keeps non-JSON summary lines", () => {
  const out = parseButlerOutput(
    [
      log("debug detail", "debug"),
      log("careful", "warning"),
      json({ type: "progress", progress: 0.1 }),
      "not json at all",
      INVALID_KEY,
      result({ ok: true }),
    ].join("\n"),
    "bailing out: invalid key\ngithub.com/itchio/x.Do\n\t/x.go:1\nruntime.main",
  );
  assertEquals(out.result, { ok: true });
  assertEquals(out.errors, [
    "itch.io API error (403): /wharf/channels: invalid key",
  ]);
  assertEquals(out.lines, [
    "warning: careful",
    "not json at all",
    "error: itch.io API error (403): /wharf/channels: invalid key",
    "bailing out: invalid key",
  ]);
  assertEquals(out.important, [0, 2, 3]);
});

Deno.test("excerpt keeps every warning and the tail, within the cap", () => {
  const lines = Array.from({ length: 300 }, (_, i) => log(`line ${i}`));
  lines.splice(5, 0, log("early warning", "warning"));
  const out = parseButlerOutput(lines.join("\n"));
  const kept = excerpt(out);
  assertEquals(kept[0], "warning: early warning");
  assertEquals(kept.at(-1), "line 299");
  assertEquals(kept.length, 21);
});

Deno.test("parseStatusResult ignores malformed entries", () => {
  const channels = parseStatusResult({
    channels: [
      null,
      { tags: [] },
      { name: "ok", tags: ["linux", 3], head: { id: "x" } },
    ],
  });
  assertEquals(channels.length, 1);
  assertEquals(channels[0]?.tags, ["linux"]);
  assertEquals(channels[0]?.head, undefined);
  assertEquals(channels[0]?.ready, false);
});

Deno.test("redact skips empty secrets and replaces every occurrence", () => {
  assertEquals(
    redact("a k b k", ["k", "", undefined]),
    "a [redacted] b [redacted]",
  );
});

Deno.test("the global arguments reject a target with a channel and mark the key sensitive", () => {
  const schema = behavior.globalArguments;
  assert(!schema.safeParse({ target: "studio/game:windows" }).success);
  assert(!schema.safeParse({ target: "game" }).success);
  const parsed = schema.parse({ target: "studio/game" });
  assertEquals(parsed.butler, "butler");
  const meta = schema.shape.apiKey.meta();
  assertEquals(meta?.sensitive, true);
});

Deno.test("the push arguments reject a channel with a colon or slash", () => {
  const schema = behavior.methods.push.arguments;
  assert(!schema.safeParse({ directory: "b", channel: "a:b" }).success);
  assert(!schema.safeParse({ directory: "b", channel: "a/b" }).success);
  assert(
    schema.safeParse({ directory: "b", channel: "win-linux-mac-stable" })
      .success,
  );
});

Deno.test("status retries a failed read while waiting, and throws it at the deadline", async () => {
  const processing = ok(statusResult([
    channel("windows-beta", build(41, "completed"), build(42, "processing")),
  ]));
  const ready = ok(
    statusResult([channel("windows-beta", build(42, "completed"))]),
  );
  const flaky = failed(
    json({ type: "error", message: "network is unreachable" }),
  );
  let clock = 0;
  const sleep = (ms: number) => {
    clock += ms;
    return Promise.resolve();
  };
  const first = context("status");
  await behavior.methods.status.execute({
    ...STATUS_DEFAULTS,
    channel: "windows-beta",
    waitSeconds: 600,
    intervalSeconds: 10,
    _runner: fakeRunner([processing, flaky, ready]).runner,
    _now: () => clock,
    _sleep: sleep,
  }, first.context);
  const data = written(first.getWrittenResources, "status");
  assertEquals(data.ready, true);
  assertEquals(data.reads, 2);
  assert(first.getLogs().some((entry) => entry.level === "warning"));

  clock = 0;
  const second = context("status");
  await assertRejects(
    () =>
      behavior.methods.status.execute({
        ...STATUS_DEFAULTS,
        channel: "windows-beta",
        waitSeconds: 20,
        intervalSeconds: 10,
        _runner: fakeRunner([processing, flaky]).runner,
        _now: () => clock,
        _sleep: sleep,
      }, second.context),
    Error,
    "network is unreachable",
  );
  assertEquals(second.getWrittenResources().length, 0);
});

Deno.test("status throws a failed first read at once, even when waiting", async () => {
  const { context: ctx } = context("status");
  await assertRejects(
    () =>
      behavior.methods.status.execute({
        ...STATUS_DEFAULTS,
        waitSeconds: 600,
        _runner: fakeRunner([failed(INVALID_KEY)]).runner,
        _sleep: () => Promise.reject(new Error("should not sleep")),
      }, ctx),
    Error,
    "refused the API key",
  );
});

Deno.test("latest names a rate limit or outage as transient", async () => {
  const { context: ctx } = context("latest");
  await assertRejects(
    () =>
      behavior.methods.latest.execute({
        channel: "win32-beta",
        _fetch: fakeFetch(503, "Service Unavailable").fetcher,
      }, ctx),
    Error,
    "retry later",
  );
});
