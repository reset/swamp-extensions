/**
 * Unit tests for the buildq behavior. Every request goes to an in-process
 * fake coordinator on 127.0.0.1 that answers with the shapes buildq's README
 * documents (its tested examples, copied here), so nothing touches a real
 * coordinator. The server tests need --allow-net=127.0.0.1 and are skipped
 * without it; the parsing tests run anywhere.
 *
 * @module
 */

import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.19";
import {
  createModelTestContext,
  type ModelTestContextResult,
} from "jsr:@swamp-club/swamp-testing@0.20261016.58";
import {
  behavior,
  BuildqError,
  buildsPath,
  type Context,
  type GlobalArgs,
  normalizeAgent,
  normalizeBuild,
  normalizeJob,
  secondsBetween,
  summarize,
  tailOf,
} from "./buildq.ts";

const TOKEN = "forge-token-for-tests";
const ACCESS_ID = "access-id-for-tests";
const ACCESS_SECRET = "access-secret-for-tests";

const NET = Deno.permissions.querySync({ name: "net", host: "127.0.0.1" })
  .state === "granted";

// ---------------------------------------------------------------------------
// Fixtures: the README's examples, as the coordinator serves them
// ---------------------------------------------------------------------------

/** A build whose check could not run (`GET .../builds/12`). */
const BUILD_FAILED = {
  number: 12,
  branch: "main",
  ref: "refs/heads/main",
  commit: "3aba76eacb37c319232db0266bd41ee1dbb80126",
  subject: "Skip wip- branches",
  state: "failed",
  blocked: false,
  created: "2026-09-24T15:00:00+00:00",
  started: "2026-09-24T15:00:02+00:00",
  finished: "2026-09-24T15:04:00+00:00",
  requested_by: null,
  rebuilt_from: null,
  jobs: [
    {
      id: "12.1",
      name: "make ci",
      state: "failed",
      exit_status: null,
      signal_reason: "setup_failed",
      started: "2026-09-24T15:00:02+00:00",
      finished: "2026-09-24T15:04:00+00:00",
      agent: "linux-build-0",
      platform: "linux",
      optional: false,
      summary: "checkout failed: git checkout exited 128",
      type: "script",
      runnable_at: "2026-09-24T15:00:00+00:00",
      phases: [
        {
          name: "fetch",
          started_at: "2026-09-24T15:00:02+00:00",
          finished_at: "2026-09-24T15:00:10+00:00",
        },
        {
          name: "checkout",
          started_at: "2026-09-24T15:00:10+00:00",
          finished_at: "2026-09-24T15:03:59+00:00",
        },
      ],
    },
  ],
  source: "webhook",
};

/** Its rebuild, which passed on another agent (`GET .../builds/13`). */
const BUILD_PASSED = {
  number: 13,
  branch: "main",
  ref: "refs/heads/main",
  commit: "3aba76eacb37c319232db0266bd41ee1dbb80126",
  subject: "Skip wip- branches",
  state: "passed",
  blocked: false,
  created: "2026-09-24T15:10:00+00:00",
  started: "2026-09-24T15:10:03+00:00",
  finished: "2026-09-24T15:16:00+00:00",
  requested_by: "someone",
  rebuilt_from: 12,
  jobs: [
    {
      id: "13.1",
      name: "make ci",
      state: "passed",
      exit_status: 0,
      signal_reason: null,
      started: "2026-09-24T15:10:03+00:00",
      finished: "2026-09-24T15:16:00+00:00",
      agent: "linux-build-1",
      platform: "linux",
      optional: false,
      summary: "make ci passed",
      type: "script",
      runnable_at: "2026-09-24T15:10:00+00:00",
      phases: [
        {
          name: "fetch",
          started_at: "2026-09-24T15:10:03+00:00",
          finished_at: "2026-09-24T15:10:09+00:00",
        },
        {
          name: "checkout",
          started_at: "2026-09-24T15:10:09+00:00",
          finished_at: "2026-09-24T15:10:41+00:00",
        },
        {
          name: "command",
          started_at: "2026-09-24T15:10:41+00:00",
          finished_at: "2026-09-24T15:15:48+00:00",
        },
        {
          name: "artifacts",
          started_at: "2026-09-24T15:15:48+00:00",
          finished_at: "2026-09-24T15:15:55+00:00",
        },
        {
          name: "upload",
          started_at: "2026-09-24T15:15:55+00:00",
          finished_at: "2026-09-24T15:15:59+00:00",
        },
      ],
      lease: "7c0c1f0e4b3a4d0f9e6b2a1c5d8f3e2b",
    },
  ],
  source: "api",
  creator: "someone",
};

/** A build created for a preflight (`POST .../builds`), still scheduled. */
const BUILD_SCHEDULED = {
  number: 14,
  branch: "buildq/preflight/0192e4c6-7b1a-7cc0-8f00-0123456789ab",
  ref: "refs/heads/buildq/preflight/0192e4c6-7b1a-7cc0-8f00-0123456789ab",
  commit: "9c1185a5c5e9fc54612808977ee8f548b2258d31",
  subject: "Preflight 0192e4c6-7b1a-7cc0-8f00-0123456789ab",
  state: "scheduled",
  blocked: false,
  created: "2026-09-24T15:20:00+00:00",
  started: null,
  finished: null,
  requested_by: "someone",
  rebuilt_from: null,
  jobs: [
    {
      id: "14.1",
      name: "make ci",
      state: "scheduled",
      exit_status: null,
      signal_reason: null,
      started: null,
      finished: null,
      agent: null,
      platform: "linux",
      optional: false,
      type: "script",
      runnable_at: "2026-09-24T15:20:00+00:00",
    },
  ],
  source: "api",
  creator: "someone",
  env: {
    PREFLIGHT: "true",
    PREFLIGHT_SOURCE_COMMIT: "3aba76eacb37c319232db0266bd41ee1dbb80126",
    PREFLIGHT_SOURCE_BRANCH: "main",
  },
};

/** A build waiting at a block, after the README's description of one. */
const BUILD_BLOCKED = {
  number: 15,
  branch: "main",
  ref: "refs/heads/main",
  commit: "9c1185a5c5e9fc54612808977ee8f548b2258d31",
  subject: "Ship 1.4.2",
  state: "blocked",
  blocked: true,
  created: "2026-09-24T16:00:00+00:00",
  started: "2026-09-24T16:00:02+00:00",
  finished: null,
  requested_by: null,
  rebuilt_from: null,
  jobs: [
    {
      id: "15.1",
      name: "build",
      state: "passed",
      exit_status: 0,
      signal_reason: null,
      started: "2026-09-24T16:00:02+00:00",
      finished: "2026-09-24T16:04:00+00:00",
      agent: "linux-build-1",
      platform: "linux",
      optional: false,
      summary: "build passed",
      type: "script",
      runnable_at: "2026-09-24T16:00:00+00:00",
    },
    {
      id: "15.2",
      name: "Publish?",
      state: "scheduled",
      exit_status: null,
      signal_reason: null,
      started: null,
      finished: null,
      agent: null,
      platform: null,
      optional: false,
      type: "manual",
      key: "publish",
      prompt: "Publish this build to the beta branch?",
      fields: [
        { key: "notes", text: "Patch notes", required: false, default: "" },
        { key: "branch", text: "Steam branch", default: "beta" },
      ],
    },
  ],
  source: "webhook",
};

/** The annotations a build's check left when it failed. */
const ANNOTATIONS = {
  annotations: [
    {
      context: "tests",
      style: "error",
      body: "2 tests failed:\n- test_boot\n- test_rollback",
    },
    {
      context: "coverage",
      style: "info",
      body: "Line coverage 81%",
    },
  ],
};

const ARTIFACTS = {
  artifacts: [
    {
      path: "game-linux.tar.zst",
      url: "/artifacts/example/game/13/game-linux.tar.zst",
    },
    { path: "report.html", url: "/artifacts/example/game/13/report.html" },
  ],
};

const QUEUE = {
  running: [
    {
      owner: "example",
      repo: "game",
      build: 16,
      job: "16.1",
      label: "make ci",
      branch: "main",
      commit: "9c1185a5c5e9fc54612808977ee8f548b2258d31",
      subject: "Ship 1.4.2",
      platform: "linux",
      agent: "linux-build-1",
      started: "2026-09-24T16:10:00+00:00",
      last_seen: "2026-09-24T16:12:00+00:00",
      lease: "7c0c1f0e4b3a4d0f9e6b2a1c5d8f3e2b",
      last_output: "2026-09-24T16:11:30+00:00",
    },
  ],
  waiting: [
    {
      position: 1,
      owner: "example",
      repo: "game",
      build: 17,
      job: "17.1",
      label: "make ci",
      branch: "topic",
      commit: "3aba76eacb37c319232db0266bd41ee1dbb80126",
      subject: "Try the new importer",
      platform: "macos",
      queued: "2026-09-24T16:11:00+00:00",
      held_back: "no macos agent online",
    },
    {
      position: 2,
      owner: "example",
      repo: "server",
      build: 3,
      job: "3.1",
      label: "make ci",
      branch: "main",
      commit: "1111111111111111111111111111111111111111",
      subject: "Bump deps",
      platform: "linux",
      queued: "2026-09-24T16:11:30+00:00",
      held_back: null,
    },
  ],
};

const AGENTS = {
  agents: [
    {
      name: "linux-build-1",
      connection_state: "connected",
      meta_data: ["os=linux", "queue=default"],
      last_seen: "2026-09-24T16:12:00+00:00",
      busy: true,
      job: {
        owner: "example",
        repo: "game",
        build: 16,
        job: "16.1",
        label: "make ci",
        started: "2026-09-24T16:10:00+00:00",
        lease: "7c0c1f0e4b3a4d0f9e6b2a1c5d8f3e2b",
        last_seen: "2026-09-24T16:12:00+00:00",
        last_output: "2026-09-24T16:11:30+00:00",
      },
      host: "build-host-1",
      owner: "buildq-build",
      unit: "buildq-agent.service",
    },
    {
      name: "publisher-1",
      connection_state: "disconnected",
      meta_data: { os: "linux", queue: "publisher" },
      last_seen: "2026-09-24T15:00:00+00:00",
      busy: false,
      job: null,
    },
  ],
};

// ---------------------------------------------------------------------------
// The fake coordinator
// ---------------------------------------------------------------------------

/** One request the fake coordinator answered. */
interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  body: string;
}

/** Answers a request by method and path, or returns undefined for a 404. */
type Routes = (
  call: Call,
) => Response | undefined | Promise<Response | undefined>;

interface Fake {
  host: string;
  calls: Call[];
  shutdown: () => Promise<void>;
}

function serve(routes: Routes): Fake {
  const calls: Call[] = [];
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      const url = new URL(request.url);
      const call: Call = {
        method: request.method,
        path: url.pathname,
        query: url.searchParams,
        headers: request.headers,
        body: await request.text(),
      };
      calls.push(call);
      return (await routes(call)) ??
        Response.json({ message: "not found" }, { status: 404 });
    },
  );
  return {
    host: `http://127.0.0.1:${server.addr.port}`,
    calls,
    shutdown: () => server.shutdown(),
  };
}

/** The README's routes under one repository, answered from the fixtures. */
function repoRoutes(call: Call): Response | undefined {
  const base = "/api/repos/example/game/builds";
  const { method, path } = call;
  if (method === "GET" && path === base) {
    const branch = call.query.get("branch");
    const all = [BUILD_BLOCKED, BUILD_SCHEDULED, BUILD_PASSED, BUILD_FAILED];
    const builds = all
      .filter((b) => branch === null || b.branch === branch)
      .filter((b) => {
        const prefix = call.query.get("commit");
        return prefix === null || b.commit.startsWith(prefix);
      })
      .slice(0, Number(call.query.get("limit") ?? 50));
    return Response.json({ builds });
  }
  if (method === "GET" && path === `${base}/12`) {
    return Response.json(BUILD_FAILED);
  }
  if (method === "GET" && path === `${base}/13`) {
    return Response.json(BUILD_PASSED);
  }
  if (method === "GET" && path === `${base}/15`) {
    return Response.json(BUILD_BLOCKED);
  }
  if (method === "GET" && path === `${base}/13/artifacts`) {
    return Response.json(ARTIFACTS);
  }
  if (method === "GET" && path === `${base}/12/annotations`) {
    return Response.json(ANNOTATIONS);
  }
  if (method === "GET" && path === `${base}/12/jobs/12.1/log`) {
    const lines = Array.from(
      { length: 2000 },
      (_, i) => `line ${String(i + 1).padStart(4, "0")} of the log`,
    );
    return new Response(lines.join("\n") + "\n", {
      headers: { "Content-Type": "text/plain" },
    });
  }
  if (method === "GET" && path === "/api/queue") return Response.json(QUEUE);
  if (method === "GET" && path === "/api/agents") return Response.json(AGENTS);
  if (method === "GET" && path === "/api/v2/organizations/acme/builds") {
    return Response.json({
      builds: [
        {
          ...BUILD_PASSED,
          owner: "example",
          repo: "game",
          organization: "acme",
          pipeline: "game",
        },
      ],
    });
  }
  return undefined;
}

/** Refuses a write without the forge token, as the coordinator does. */
function authorized(call: Call): Response | undefined {
  if (call.headers.get("authorization") !== `token ${TOKEN}`) {
    return Response.json({ message: "token required" }, { status: 401 });
  }
  return undefined;
}

function testContext(overrides: Partial<GlobalArgs> = {}): {
  context: Context;
  getWrittenResources: ModelTestContextResult["getWrittenResources"];
  getWrittenFiles: ModelTestContextResult["getWrittenFiles"];
  getLogs: ModelTestContextResult["getLogs"];
} {
  const globalArgs: GlobalArgs = {
    host: "http://127.0.0.1:1",
    owner: "example",
    repo: "game",
    ...overrides,
  };
  const result = createModelTestContext({ globalArgs: { ...globalArgs } });
  const context: Context = { ...result.context, globalArgs };
  return {
    context,
    getWrittenResources: result.getWrittenResources,
    getWrittenFiles: result.getWrittenFiles,
    getLogs: result.getLogs,
  };
}

/** Runs a test against a fake coordinator, shutting it down afterwards. */
function withFake(
  routes: Routes,
  fn: (fake: Fake) => Promise<void>,
): () => Promise<void> {
  return async () => {
    const fake = serve(routes);
    try {
      await fn(fake);
    } finally {
      await fake.shutdown();
    }
  };
}

// ---------------------------------------------------------------------------
// Schemas and parsing: no network
// ---------------------------------------------------------------------------

Deno.test("global arguments need a host and pair owner with repo and the Access fields", () => {
  const schema = behavior.globalArguments;
  assert(
    schema.safeParse({ host: "https://ci.example.net", owner: "o", repo: "r" })
      .success,
  );
  assert(schema.safeParse({ host: "https://ci.example.net" }).success);
  assert(
    schema.safeParse({ host: "https://ci.example.net", organization: "acme" })
      .success,
    "an organization alone serves org-builds",
  );
  assertFalse(
    schema.safeParse({ owner: "o", repo: "r" }).success,
    "host is required",
  );
  assertFalse(schema.safeParse({ host: "not a url" }).success);
  assertFalse(
    schema.safeParse({ host: "https://ci.example.net", owner: "o" }).success,
  );
  assertFalse(
    schema.safeParse({ host: "https://ci.example.net", pipeline: "p" }).success,
  );
  assertFalse(
    schema.safeParse({ host: "https://ci.example.net", accessClientId: "id" })
      .success,
  );
  assertFalse(
    schema.safeParse({ host: "https://ci.example.net", token: "" }).success,
  );
});

Deno.test("method arguments default the limits and bound the log tail", () => {
  assertEquals(behavior.methods.builds.arguments.parse({}).limit, 50);
  assertFalse(
    behavior.methods.builds.arguments.safeParse({ limit: 501 }).success,
  );
  assertEquals(
    behavior.methods.log.arguments.parse({ number: 12 }).tailKiB,
    64,
  );
  assertFalse(
    behavior.methods.log.arguments.safeParse({ number: 12, tailKiB: 0 })
      .success,
  );
  assertFalse(
    behavior.methods.build.arguments.safeParse({ number: 0 }).success,
  );
  assertFalse(
    behavior.methods.unblock.arguments.safeParse({ number: 15, job: "15.2" })
      .success,
    "fields are required",
  );
});

Deno.test("buildsPath prefers the pipeline route and refuses no repository", () => {
  assertEquals(
    buildsPath({ host: "h", owner: "example", repo: "game" }),
    "/api/repos/example/game/builds",
  );
  assertEquals(
    buildsPath({
      host: "h",
      owner: "o",
      repo: "r",
      organization: "acme",
      pipeline: "game",
    }),
    "/api/v2/organizations/acme/pipelines/game/builds",
  );
  assertEquals(
    buildsPath({ host: "h", owner: "a b", repo: "c/d" }),
    "/api/repos/a%20b/c%2Fd/builds",
  );
  let message = "";
  try {
    buildsPath({ host: "h" });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assertStringIncludes(message, "owner and repo");
});

Deno.test("normalizeBuild keeps ids, states, times and durations and drops people", () => {
  const build = normalizeBuild(BUILD_PASSED);
  assertEquals(build.number, 13);
  assertEquals(build.state, "passed");
  assertEquals(build.rebuiltFrom, 12);
  assertEquals(build.source, "api");
  assertEquals(build.durationSeconds, 357);
  assertEquals(build.jobs.length, 1);
  const job = build.jobs[0];
  assertEquals(job.exitStatus, 0);
  assertEquals(job.waitSeconds, 3);
  assertEquals(job.durationSeconds, 357);
  assertEquals(job.phases?.map((p) => [p.name, p.seconds]), [
    ["fetch", 6],
    ["checkout", 32],
    ["command", 307],
    ["artifacts", 7],
    ["upload", 4],
  ]);
  const serialized = JSON.stringify(build);
  assertFalse(
    serialized.includes("someone"),
    "creator and requested_by are dropped",
  );
  assertEquals(job.lease, "7c0c1f0e4b3a4d0f9e6b2a1c5d8f3e2b");
  assertFalse("signalReason" in job, "nulls are dropped");

  const scheduled = normalizeBuild(BUILD_SCHEDULED);
  assertFalse("started" in scheduled);
  assertFalse("durationSeconds" in scheduled);
  assertFalse("env" in scheduled, "a create call's env is dropped");
  assertFalse("phases" in scheduled.jobs[0], "a job no agent started has none");
});

Deno.test("normalizeJob keeps a block's key, prompt and field keys, never who answered", () => {
  const waiting = normalizeJob(BUILD_BLOCKED.jobs[1]);
  assertEquals(waiting.type, "manual");
  assertEquals(waiting.key, "publish");
  assertEquals(waiting.fieldKeys, ["notes", "branch"]);
  assertEquals(waiting.unblocked, false);
  assertFalse("agent" in waiting);

  const answered = normalizeJob({
    ...BUILD_BLOCKED.jobs[1],
    state: "passed",
    unblocked_by: "someone@example.com",
    unblocked_at: "2026-09-24T16:30:00+00:00",
  });
  assertEquals(answered.unblocked, true);
  assertEquals(answered.unblockedAt, "2026-09-24T16:30:00+00:00");
  assertFalse(JSON.stringify(answered).includes("example.com"));

  const long = normalizeJob({
    id: "1.1",
    summary: "x".repeat(400),
    prompt: "y".repeat(400),
  });
  assertEquals(long.summary?.length, 300);
  assertEquals(long.prompt?.length, 300);
  assertEquals(long.type, "script");
});

Deno.test("summarize counts job states, names the first failure and times phases", () => {
  const failed = summarize(normalizeBuild(BUILD_FAILED));
  assertEquals(failed.passed, false);
  assertEquals(failed.finished, true);
  assertEquals(failed.failedJobs, 1);
  assertEquals(failed.jobStates.failed, 1);
  assertEquals(failed.jobStates.passed, 0);
  assertEquals(
    failed.reason,
    "12.1 make ci failed: checkout failed: git checkout exited 128",
  );
  assertEquals(failed.jobs[0].signalReason, "setup_failed");
  assertEquals(failed.jobs[0].phaseSeconds, { fetch: 8, checkout: 229 });
  assertEquals(failed.durationSeconds, 238);

  const passed = summarize(normalizeBuild(BUILD_PASSED));
  assertEquals(passed.passed, true);
  assertFalse("reason" in passed);
  assertEquals(passed.failedJobs, 0);

  const blocked = summarize(normalizeBuild(BUILD_BLOCKED));
  assertEquals(blocked.blocked, true);
  assertEquals(blocked.finished, false);
  assertEquals(blocked.reason, "15.2 Publish? scheduled");
  assertEquals(blocked.jobStates, {
    scheduled: 1,
    assigned: 0,
    running: 0,
    canceling: 0,
    passed: 1,
    failed: 0,
    canceled: 0,
    skipped: 0,
    broken: 0,
  });

  const optional = summarize(
    normalizeBuild({
      ...BUILD_PASSED,
      jobs: [{
        ...BUILD_PASSED.jobs[0],
        id: "13.2",
        state: "failed",
        optional: true,
      }],
    }),
  );
  assertEquals(optional.failedJobs, 0, "an optional job fails nothing");
  assertFalse("reason" in optional);
});

Deno.test("tailOf keeps the last KiB cut to whole lines and reports the sizes", () => {
  const short = tailOf("one\ntwo\n", 1);
  assertEquals(short, {
    tail: "one\ntwo\n",
    bytes: 8,
    keptBytes: 8,
    cut: false,
  });

  const lines = Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n");
  const cut = tailOf(lines, 1);
  assertEquals(cut.cut, true);
  assertEquals(cut.bytes, new TextEncoder().encode(lines).length);
  assert(cut.keptBytes <= 1024);
  assert(cut.tail.startsWith("line "), "the first kept line is whole");
  assert(cut.tail.endsWith("line 299"));

  const unicode = tailOf("é".repeat(600), 1);
  assertEquals(unicode.cut, true);
  assertFalse(
    unicode.tail.includes("�"),
    "a cut never splits a character badly",
  );
});

Deno.test("normalizeAgent reads tags as a list or a map and secondsBetween tolerates gaps", () => {
  const listed = normalizeAgent(AGENTS.agents[0]);
  assertEquals(listed.metaData, ["os=linux", "queue=default"]);
  assertEquals(listed.busy, true);
  assertEquals(listed.job?.build, 16);
  assertEquals(listed.unit, "buildq-agent.service");
  const mapped = normalizeAgent(AGENTS.agents[1]);
  assertEquals(mapped.metaData, ["os=linux", "queue=publisher"]);
  assertEquals(mapped.busy, false);
  assertFalse("job" in mapped);

  assertEquals(
    secondsBetween("2026-01-01T00:00:00Z", "2026-01-01T00:00:01.5Z"),
    1.5,
  );
  assertEquals(secondsBetween(undefined, "2026-01-01T00:00:00Z"), undefined);
  assertEquals(secondsBetween("nonsense", "2026-01-01T00:00:00Z"), undefined);
});

// ---------------------------------------------------------------------------
// Against the fake coordinator (needs --allow-net=127.0.0.1)
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "builds lists newest first with the filters, no token, and writes builds and newest",
  ignore: !NET,
  fn: withFake(repoRoutes, async (fake) => {
    const { context, getWrittenResources } = testContext({ host: fake.host });
    const result = await behavior.methods.builds.execute(
      { limit: 2, branch: "main" },
      context,
    );
    assertEquals(fake.calls.length, 1);
    const call = fake.calls[0];
    assertEquals(call.method, "GET");
    assertEquals(call.path, "/api/repos/example/game/builds");
    assertEquals(call.query.get("branch"), "main");
    assertEquals(call.query.get("limit"), "2");
    assertFalse(call.query.has("commit"), "undefined filters are left out");
    assertEquals(
      call.headers.get("authorization"),
      null,
      "reads send no token",
    );
    assertEquals(call.headers.get("accept"), "application/json");

    const written = getWrittenResources();
    assertEquals(
      written.map((w) => [w.specName, w.name]),
      [
        ["builds", "builds"],
        ["summary", "newest"],
      ],
    );
    assertEquals(result.dataHandles.length, 2);
    const builds = written[0].data;
    assertEquals(builds.count, 2);
    assertEquals(builds.truncated, true, "a full page: more may exist");
    assertEquals(builds.filters, { branch: "main" });
    assertEquals(builds.owner, "example");
    assertEquals(builds.repo, "game");
    assertEquals(builds.host, fake.host);
    const rows = builds.builds as Record<string, unknown>[];
    assertEquals(rows.map((b) => b.number), [15, 13]);
    const newest = written[1].data;
    assertEquals(newest.number, 15);
    assertEquals(newest.state, "blocked");
    assertEquals(newest.passed, false);
    assertEquals(newest.reason, "15.2 Publish? scheduled");
  }),
});

Deno.test({
  name: "builds with no match writes an empty list and no newest",
  ignore: !NET,
  fn: withFake(repoRoutes, async (fake) => {
    const { context, getWrittenResources } = testContext({ host: fake.host });
    await behavior.methods.builds.execute(
      { limit: 50, branch: "nowhere", commit: "ffff" },
      context,
    );
    const written = getWrittenResources();
    assertEquals(written.length, 1);
    assertEquals(written[0].data.count, 0);
    assertEquals(written[0].data.truncated, false);
    assertEquals(written[0].data.filters, {
      branch: "nowhere",
      commit: "ffff",
    });
  }),
});

Deno.test({
  name:
    "build reads one build, sends the Access headers, and writes build and summary",
  ignore: !NET,
  fn: withFake(
    (call) => {
      if (call.headers.get("cf-access-client-id") !== ACCESS_ID) {
        return new Response("", {
          status: 302,
          headers: { Location: "https://login.example.net/" },
        });
      }
      if (call.headers.get("cf-access-client-secret") !== ACCESS_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      return repoRoutes(call);
    },
    async (fake) => {
      const { context, getWrittenResources, getLogs } = testContext({
        host: fake.host,
        accessClientId: ACCESS_ID,
        accessClientSecret: ACCESS_SECRET,
      });
      await behavior.methods.build.execute({ number: 12 }, context);
      assertEquals(fake.calls[0].path, "/api/repos/example/game/builds/12");
      const written = getWrittenResources();
      assertEquals(
        written.map((w) => [w.specName, w.name]),
        [
          ["build", "build-12"],
          ["summary", "summary-12"],
        ],
      );
      assertEquals(written[0].data.state, "failed");
      assertEquals(written[0].data.subject, "Skip wip- branches");
      assertEquals(written[1].data.failedJobs, 1);
      const jobs = written[1].data.jobs as Record<string, unknown>[];
      assertEquals(jobs[0].phaseSeconds, { fetch: 8, checkout: 229 });
      for (const log of getLogs()) {
        assertFalse(
          JSON.stringify([log.message, log.args]).includes(ACCESS_SECRET),
        );
      }
    },
  ),
});

Deno.test({
  name:
    "a redirect to a login page is reported, not read, and nothing is written",
  ignore: !NET,
  fn: withFake(
    () =>
      new Response("", {
        status: 302,
        headers: { Location: "https://login.example.net/" },
      }),
    async (fake) => {
      const { context, getWrittenResources } = testContext({ host: fake.host });
      const error = await assertRejects(
        () => behavior.methods.build.execute({ number: 12 }, context),
        BuildqError,
      );
      assertEquals(error.status, 302);
      assertStringIncludes(
        error.message,
        "redirected to https://login.example.net/",
      );
      assertStringIncludes(error.message, "accessClientId");
      assertEquals(getWrittenResources().length, 0);
    },
  ),
});

Deno.test({
  name:
    "errors carry the status, the message and a hint, and leave nothing written",
  ignore: !NET,
  fn: withFake(
    (call) => {
      if (call.path.endsWith("/builds/404")) {
        return Response.json({ message: "no build 404" }, { status: 404 });
      }
      if (call.path.endsWith("/builds/500")) {
        return new Response("boom", { status: 500 });
      }
      if (call.path.endsWith("/builds/200")) {
        return new Response("<html>login</html>", { status: 200 });
      }
      return undefined;
    },
    async (fake) => {
      const run = (number: number) => {
        const { context, getWrittenResources } = testContext({
          host: fake.host,
        });
        return assertRejects(
          () => behavior.methods.build.execute({ number }, context),
          BuildqError,
        ).then((error) => {
          assertEquals(getWrittenResources().length, 0);
          return error;
        });
      };
      const missing = await run(404);
      assertEquals(missing.status, 404);
      assertStringIncludes(
        missing.message,
        "GET /api/repos/example/game/builds/404: 404 no build 404",
      );
      assertStringIncludes(missing.message, "no such build");
      const broken = await run(500);
      assertEquals(broken.status, 500);
      assertStringIncludes(broken.message, "500 boom");
      const html = await run(200);
      assertStringIncludes(html.message, "not JSON");
    },
  ),
});

Deno.test({
  name:
    "host joins a trailing slash and a path prefix, and the pipeline route is used when set",
  ignore: !NET,
  fn: withFake(
    (call) =>
      call.path === "/ci/api/v2/organizations/acme/pipelines/game/builds/13"
        ? Response.json(BUILD_PASSED)
        : undefined,
    async (fake) => {
      const { context, getWrittenResources } = testContext({
        host: `${fake.host}/ci/`,
        organization: "acme",
        pipeline: "game",
      });
      await behavior.methods.build.execute({ number: 13 }, context);
      assertEquals(
        fake.calls[0].path,
        "/ci/api/v2/organizations/acme/pipelines/game/builds/13",
      );
      assertEquals(getWrittenResources()[0].data.host, `${fake.host}/ci/`);
    },
  ),
});

Deno.test({
  name: "log keeps the last KiB of a job's log as a text file",
  ignore: !NET,
  fn: withFake(repoRoutes, async (fake) => {
    const { context, getWrittenFiles, getWrittenResources } = testContext({
      host: fake.host,
    });
    const result = await behavior.methods.log.execute(
      { number: 12, tailKiB: 1 },
      context,
    );
    assertEquals(
      fake.calls[0].path,
      "/api/repos/example/game/builds/12/jobs/12.1/log",
    );
    assertEquals(fake.calls[0].headers.get("accept"), "text/plain");
    const files = getWrittenFiles();
    assertEquals(files.length, 1);
    assertEquals(files[0].specName, "log");
    assertEquals(files[0].name, "log-12.1");
    assert(files[0].content.length <= 1024);
    const text = new TextDecoder().decode(files[0].content);
    assert(text.startsWith("line "), "cut to a whole line");
    assert(text.endsWith("line 2000 of the log\n"));
    const written = getWrittenResources();
    assertEquals(written.length, 1);
    assertEquals(written[0].specName, "logtail");
    assertEquals(written[0].name, "logtail-12.1");
    assertEquals(written[0].data.truncated, true);
    assertEquals(written[0].data.keptBytes, files[0].content.length);
    assertEquals(written[0].data.bytes, 2000 * 21);
    assertEquals(written[0].data.lines, text.split("\n").length - 1);
    assertEquals(result.dataHandles.length, 2);
  }),
});

Deno.test({
  name: "artifacts and annotations list a build's kept files and notes",
  ignore: !NET,
  fn: withFake(repoRoutes, async (fake) => {
    const files = testContext({ host: fake.host });
    await behavior.methods.artifacts.execute({ number: 13 }, files.context);
    const artifacts = files.getWrittenResources()[0];
    assertEquals(artifacts.name, "artifacts-13");
    assertEquals(artifacts.data.count, 2);
    assertEquals((artifacts.data.artifacts as Record<string, unknown>[])[0], {
      path: "game-linux.tar.zst",
      url: "/artifacts/example/game/13/game-linux.tar.zst",
    });

    const notes = testContext({ host: fake.host });
    await behavior.methods.annotations.execute({ number: 12 }, notes.context);
    const annotations = notes.getWrittenResources()[0];
    assertEquals(annotations.name, "annotations-12");
    assertEquals(annotations.data.count, 2);
    assertEquals(annotations.data.errors, 1);
    assertEquals(
      (annotations.data.annotations as Record<string, unknown>[])[0],
      {
        context: "tests",
        style: "error",
        body: "2 tests failed:\n- test_boot\n- test_rollback",
      },
    );
  }),
});

Deno.test({
  name: "queue and agents read the coordinator-wide state",
  ignore: !NET,
  fn: withFake(repoRoutes, async (fake) => {
    const queue = testContext({ host: fake.host });
    await behavior.methods.queue.execute({}, queue.context);
    const q = queue.getWrittenResources()[0];
    assertEquals(q.name, "queue");
    assertEquals(q.data.running, 1);
    assertEquals(q.data.waiting, 2);
    assertEquals(q.data.heldBack, 1);
    const waiting = q.data.waitingJobs as Record<string, unknown>[];
    assertEquals(waiting[0].heldBack, "no macos agent online");
    assertFalse("heldBack" in waiting[1], "null is dropped");
    assertEquals(waiting[1].position, 2);
    const running = q.data.runningJobs as Record<string, unknown>[];
    assertEquals(running[0].lastOutput, "2026-09-24T16:11:30+00:00");

    const agents = testContext({ host: fake.host });
    await behavior.methods.agents.execute({}, agents.context);
    const a = agents.getWrittenResources()[0];
    assertEquals(a.name, "agents");
    assertEquals(a.data.count, 2);
    assertEquals(a.data.connected, 1);
    assertEquals(a.data.busy, 1);
  }),
});

Deno.test({
  name:
    "org-builds lists an organization's builds under /api/v2 and needs an organization",
  ignore: !NET,
  fn: withFake(repoRoutes, async (fake) => {
    const { context, getWrittenResources } = testContext({ host: fake.host });
    await behavior.methods["org-builds"].execute(
      { organization: "acme", limit: 10 },
      context,
    );
    assertEquals(fake.calls[0].path, "/api/v2/organizations/acme/builds");
    assertEquals(fake.calls[0].query.get("limit"), "10");
    const written = getWrittenResources()[0];
    assertEquals(written.name, "orgbuilds-acme");
    assertEquals(written.data.count, 1);
    assertEquals(written.data.truncated, false);
    const rows = written.data.builds as Record<string, unknown>[];
    assertEquals(rows[0].pipeline, "game");
    assertEquals(rows[0].owner, "example");

    const bare = testContext({ host: fake.host });
    await assertRejects(
      () => behavior.methods["org-builds"].execute({ limit: 10 }, bare.context),
      Error,
      "needs an organization",
    );
    assertEquals(fake.calls.length, 1, "nothing was requested");
  }),
});

Deno.test({
  name: "rebuild posts with the token, then reads and writes the new build",
  ignore: !NET,
  fn: withFake(
    (call) => {
      if (call.method === "POST" && call.path.endsWith("/builds/12/rebuild")) {
        return authorized(call) ?? Response.json(BUILD_PASSED, { status: 202 });
      }
      return repoRoutes(call);
    },
    async (fake) => {
      const { context, getWrittenResources, getLogs } = testContext({
        host: fake.host,
        token: TOKEN,
      });
      await behavior.methods.rebuild.execute({ number: 12 }, context);
      assertEquals(
        fake.calls.map((c) => `${c.method} ${c.path}`),
        [
          "POST /api/repos/example/game/builds/12/rebuild",
          "GET /api/repos/example/game/builds/13",
        ],
      );
      assertEquals(
        fake.calls[0].headers.get("authorization"),
        `token ${TOKEN}`,
      );
      assertEquals(
        fake.calls[1].headers.get("authorization"),
        null,
        "the re-read is a read",
      );
      const written = getWrittenResources();
      assertEquals(written.map((w) => w.name), ["build-13", "summary-13"]);
      assertEquals(written[0].data.rebuiltFrom, 12);
      assertEquals(written[1].data.passed, true);
      for (const log of getLogs()) {
        assertFalse(JSON.stringify([log.message, log.args]).includes(TOKEN));
      }
    },
  ),
});

Deno.test({
  name:
    "writes refuse to run without a token and write nothing when the API refuses",
  ignore: !NET,
  fn: withFake(
    (call) =>
      call.method === "POST"
        ? authorized(call) ?? Response.json({}, { status: 202 })
        : undefined,
    async (fake) => {
      const bare = testContext({ host: fake.host });
      await assertRejects(
        () => behavior.methods.cancel.execute({ number: 12 }, bare.context),
        Error,
        "needs a forge token",
      );
      assertEquals(fake.calls.length, 0, "nothing was requested");

      const wrong = testContext({ host: fake.host, token: "not-the-token" });
      const error = await assertRejects(
        () => behavior.methods.rebuild.execute({ number: 12 }, wrong.context),
        BuildqError,
      );
      assertEquals(error.status, 401);
      assertStringIncludes(
        error.message,
        "POST /api/repos/example/game/builds/12/rebuild: 401",
      );
      assertStringIncludes(error.message, "token required");
      assertEquals(wrong.getWrittenResources().length, 0);
    },
  ),
});

Deno.test({
  name: "cancel accepts a build that already ended and re-reads it",
  ignore: !NET,
  fn: withFake(
    (call) => {
      if (call.method === "POST" && call.path.endsWith("/builds/13/cancel")) {
        return authorized(call) ?? Response.json(BUILD_PASSED, { status: 409 });
      }
      if (call.method === "POST" && call.path.endsWith("/builds/15/cancel")) {
        return authorized(call) ??
          Response.json({ ...BUILD_BLOCKED, state: "canceling" }, {
            status: 202,
          });
      }
      return repoRoutes(call);
    },
    async (fake) => {
      const ended = testContext({ host: fake.host, token: TOKEN });
      await behavior.methods.cancel.execute({ number: 13 }, ended.context);
      assertEquals(ended.getWrittenResources()[1].data.state, "passed");
      const warnings = ended.getLogs().filter((l) => l.level === "warning");
      assertEquals(warnings.length, 1);
      assertStringIncludes(warnings[0].message, "already ended");

      const live = testContext({ host: fake.host, token: TOKEN });
      await behavior.methods.cancel.execute({ number: 15 }, live.context);
      assertEquals(
        fake.calls.slice(2).map((c) => `${c.method} ${c.path}`),
        [
          "POST /api/repos/example/game/builds/15/cancel",
          "GET /api/repos/example/game/builds/15",
        ],
      );
      assertEquals(
        live.getLogs().filter((l) => l.level === "warning").length,
        0,
      );
    },
  ),
});

Deno.test({
  name:
    "unblock puts the fields as JSON, then re-reads the build; a refusal names the field",
  ignore: !NET,
  fn: withFake(
    (call) => {
      if (call.method === "PUT" && call.path.endsWith("/jobs/15.2/unblock")) {
        const refused = authorized(call);
        if (refused) return refused;
        const body = JSON.parse(call.body) as {
          fields: Record<string, string>;
        };
        if (body.fields.branch === "nope") {
          return Response.json(
            { message: "branch: not one of beta, default" },
            { status: 422 },
          );
        }
        return Response.json({
          ...BUILD_BLOCKED.jobs[1],
          state: "passed",
          unblocked_by: "someone@example.com",
          unblocked_at: "2026-09-24T16:30:00+00:00",
        });
      }
      return repoRoutes(call);
    },
    async (fake) => {
      const { context, getWrittenResources } = testContext({
        host: fake.host,
        token: TOKEN,
      });
      await behavior.methods.unblock.execute(
        {
          number: 15,
          job: "15.2",
          fields: { branch: "beta", notes: "hotfix" },
        },
        context,
      );
      assertEquals(fake.calls[0].method, "PUT");
      assertEquals(
        fake.calls[0].headers.get("content-type"),
        "application/json",
      );
      assertEquals(JSON.parse(fake.calls[0].body), {
        fields: { branch: "beta", notes: "hotfix" },
      });
      assertEquals(fake.calls[1].path, "/api/repos/example/game/builds/15");
      assertEquals(getWrittenResources().map((w) => w.name), [
        "build-15",
        "summary-15",
      ]);

      const refused = testContext({ host: fake.host, token: TOKEN });
      const error = await assertRejects(
        () =>
          behavior.methods.unblock.execute(
            { number: 15, job: "15.2", fields: { branch: "nope" } },
            refused.context,
          ),
        BuildqError,
      );
      assertEquals(error.status, 422);
      assertStringIncludes(error.message, "branch: not one of beta, default");
      assertEquals(refused.getWrittenResources().length, 0);
    },
  ),
});
