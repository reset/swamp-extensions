/**
 * Unit tests for the Steamworks builds behavior. Every test injects a fetch, a
 * clock and, where it reads back, a query. The fixtures follow the answer
 * shapes observed from `ISteamApps/GetAppBetas` and `GetAppBuilds` on
 * 2026-10-23, with made-up app, branch, build and depot ids, so nothing here
 * reaches Valve or a swamp datastore.
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
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20261016.58";
import {
  behavior,
  type BuildsRecord,
  compare,
  fetchBranches,
  fetchBuilds,
  type Fetcher,
  KEY_HEADER,
  type MethodContext,
  methodUrl,
  summarise,
  USER_AGENT,
  VERSION,
} from "./steamworks_builds.ts";
import source from "./steamworks_builds.ts" with { type: "text" };
import manifest from "./manifest.yaml" with { type: "text" };

/** The version the manifest publishes, which the User-Agent names. */
const MANIFEST_VERSION = /^version: "([^"]+)"$/m.exec(manifest)?.[1];

const APP_ID = 480;
const MODEL_ID = "00000000-0000-4000-8000-000000000091";
/** A made-up key; the tests assert it never leaves the x-webapi-key header. */
const KEY = "FAKEKEY1111111111111111111111111";
const NOW = new Date("2026-10-23T12:00:00.000Z");

/** A GetAppBetas answer in the observed shape. */
function betasAnswer(
  branches: Record<string, { build: number; password?: number }>,
): unknown {
  const betas: Record<string, unknown> = {};
  for (const [name, branch] of Object.entries(branches)) {
    betas[name] = {
      BuildID: branch.build,
      Description: `${name} branch`,
      ReqPassword: branch.password ?? 0,
      ReqLocalCS: 0,
    };
  }
  return { response: { betas, result: 1, message: "" } };
}

/** A GetAppBuilds answer in the observed shape, with an AccountIDCreator that must never be kept. */
function buildsAnswer(builds: { id: number; created: number }[]): unknown {
  const map: Record<string, unknown> = {};
  for (const build of builds) {
    map[String(build.id)] = {
      BuildID: build.id,
      CreationTime: build.created,
      Description: `build ${build.id}`,
      AccountIDCreator: 987654321,
      depots: {
        "1001": {
          DepotID: 1001,
          DepotVersionGID: "1234567890123456789",
          TotalOriginalBytes: "2048",
          TotalCompressedBytes: "1024",
        },
      },
    };
  }
  return { response: { builds: map, result: 1, message: "" } };
}

/** One canned answer of a fake fetch. */
interface Answer {
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** A fetch answering GetAppBetas and GetAppBuilds by URL, recording the requests. */
function fakeFetch(
  betas: Answer,
  builds: Answer = { body: buildsAnswer([]) },
): { fetcher: Fetcher; urls: string[]; inits: (RequestInit | undefined)[] } {
  const urls: string[] = [];
  const inits: (RequestInit | undefined)[] = [];
  const fetcher: Fetcher = (input, init) => {
    urls.push(input);
    inits.push(init);
    const answer = input.includes("GetAppBetas") ? betas : builds;
    const body = typeof answer.body === "string"
      ? answer.body
      : JSON.stringify(answer.body);
    return Promise.resolve(
      new Response(body, {
        status: answer.status ?? 200,
        headers: answer.headers ?? {},
      }),
    );
  };
  return { fetcher, urls, inits };
}

/** A test context with global arguments and a query over the given stored records. */
function testContext(stored: unknown[] = []): {
  context: MethodContext;
  written: ReturnType<typeof createModelTestContext>["getWrittenResources"];
  logs: ReturnType<typeof createModelTestContext>["getLogs"];
  predicates: string[];
} {
  const globalArgs = { apiKey: KEY, appId: APP_ID };
  const test = createModelTestContext({ globalArgs });
  const predicates: string[] = [];
  const context: MethodContext = {
    ...test.context,
    globalArgs,
    modelId: MODEL_ID,
    queryData: (predicate) => {
      predicates.push(predicate);
      return Promise.resolve(stored);
    },
  };
  return {
    context,
    written: test.getWrittenResources,
    logs: test.getLogs,
    predicates,
  };
}

/** The header the request sent under this name, ignoring case. */
function header(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name);
}

/** A stored version as swamp's queryData returns it. */
function stored(version: number, record: BuildsRecord): unknown {
  return { version, attributes: record };
}

const T1 = 1_790_000_000;
const T2 = 1_790_086_400;

Deno.test("sample calls GetAppBetas then GetAppBuilds at the partner URLs", async () => {
  const { fetcher, urls } = fakeFetch(
    { body: betasAnswer({ public: { build: 200 } }) },
    { body: buildsAnswer([{ id: 200, created: T1 }]) },
  );
  const { context } = testContext();
  await behavior.methods.sample.execute(
    { _fetch: fetcher, _now: () => NOW, count: 5 },
    context,
  );
  assertEquals(urls, [
    `https://partner.steam-api.com/ISteamApps/GetAppBetas/v1/?appid=${APP_ID}`,
    `https://partner.steam-api.com/ISteamApps/GetAppBuilds/v1/?appid=${APP_ID}&count=5`,
  ]);
  assertEquals(
    methodUrl("GetAppBuilds", APP_ID),
    `https://partner.steam-api.com/ISteamApps/GetAppBuilds/v1/?appid=${APP_ID}`,
  );
});

Deno.test("the key is sent only in the x-webapi-key header, never in a URL, record or log", async () => {
  const { fetcher, urls, inits } = fakeFetch(
    { body: betasAnswer({ public: { build: 200 } }) },
    { body: buildsAnswer([{ id: 200, created: T1 }]) },
  );
  const { context, written, logs } = testContext();
  await behavior.methods.sample.execute(
    { _fetch: fetcher, _now: () => NOW },
    context,
  );
  assertEquals(KEY_HEADER, "x-webapi-key");
  assertEquals(urls.length, 2);
  for (const [i, url] of urls.entries()) {
    assertEquals(header(inits[i], KEY_HEADER), KEY);
    assertEquals(header(inits[i], "user-agent"), USER_AGENT);
    assertEquals(inits[i]?.redirect, "error");
    assertFalse(url.includes(KEY));
    assertFalse(url.includes("key="));
  }
  assertFalse(JSON.stringify(written()).includes(KEY));
  assertFalse(JSON.stringify(logs()).includes(KEY));
});

Deno.test("sample records each branch's live build with its creation time and depots", async () => {
  const { fetcher } = fakeFetch(
    {
      body: betasAnswer({
        public: { build: 200 },
        beta: { build: 201, password: 1 },
      }),
    },
    {
      body: buildsAnswer([{ id: 200, created: T1 }, { id: 201, created: T2 }]),
    },
  );
  const { context, written } = testContext();
  await behavior.methods.sample.execute(
    { _fetch: fetcher, _now: () => NOW },
    context,
  );
  const data = written()[0]?.data as unknown as BuildsRecord;
  assertEquals(written()[0]?.name, `builds-${APP_ID}`);
  assertEquals(data.branches.map((branch) => branch.name), ["beta", "public"]);
  const beta = data.branches[0];
  assertEquals(beta?.buildId, 201);
  assertEquals(beta?.passwordRequired, true);
  assertEquals(beta?.buildCreatedAt, new Date(T2 * 1000).toISOString());
  assertEquals(beta?.buildDepots?.[0], {
    depotId: 1001,
    depotVersionGid: "1234567890123456789",
    totalOriginalBytes: "2048",
    totalCompressedBytes: "1024",
  });
  assertEquals(data.builds.map((build) => build.buildId), [201, 200]);
  assertEquals(data.changedBranches, []);
  assertEquals(data.previousFetchedAt, null);
});

Deno.test("the creating account is never recorded", async () => {
  const { fetcher } = fakeFetch(
    { body: betasAnswer({ public: { build: 200 } }) },
    { body: buildsAnswer([{ id: 200, created: T1 }]) },
  );
  const { context, written } = testContext();
  await behavior.methods.sample.execute(
    { _fetch: fetcher, _now: () => NOW },
    context,
  );
  const text = JSON.stringify(written());
  assertFalse(text.includes("987654321"));
  assertFalse(text.includes("AccountIDCreator"));
});

Deno.test("a branch whose live build changed since the previous version is flagged", () => {
  const first = compare(
    APP_ID,
    [{
      name: "public",
      description: "",
      passwordRequired: false,
      reqLocalCS: 0,
      buildId: 200,
    }],
    [],
    null,
    10,
    "2026-10-22T12:00:00.000Z",
  );
  const second = compare(
    APP_ID,
    [
      {
        name: "public",
        description: "",
        passwordRequired: false,
        reqLocalCS: 0,
        buildId: 202,
      },
      {
        name: "beta",
        description: "",
        passwordRequired: false,
        reqLocalCS: 0,
        buildId: 203,
      },
    ],
    [],
    first,
    10,
    "2026-10-23T12:00:00.000Z",
  );
  assertEquals(second.changedBranches, ["public"]);
  assertEquals(
    second.branches.find((branch) => branch.name === "beta")?.changed,
    false,
  );
  assertEquals(second.previousFetchedAt, "2026-10-22T12:00:00.000Z");
  const third = compare(APP_ID, [], [], second, 10, "2026-10-24T12:00:00.000Z");
  assertEquals(third.removedBranches, ["beta", "public"]);
});

Deno.test("sample compares with the latest recorded version of its own app", async () => {
  const previous = compare(
    APP_ID,
    [{
      name: "public",
      description: "",
      passwordRequired: false,
      reqLocalCS: 0,
      buildId: 200,
    }],
    [],
    null,
    10,
    "2026-10-22T12:00:00.000Z",
  );
  const { fetcher } = fakeFetch({
    body: betasAnswer({ public: { build: 205 } }),
  });
  const { context, written, predicates } = testContext([stored(1, previous)]);
  await behavior.methods.sample.execute(
    { _fetch: fetcher, _now: () => NOW },
    context,
  );
  assertStringIncludes(predicates[0] ?? "", JSON.stringify(MODEL_ID));
  assertStringIncludes(predicates[0] ?? "", `builds-${APP_ID}`);
  assertEquals(
    (written()[0]?.data as unknown as BuildsRecord).changedBranches,
    [
      "public",
    ],
  );
});

Deno.test("a 403 explains the key and stops before GetAppBuilds, without the key", async () => {
  const { fetcher, urls } = fakeFetch({ status: 403, body: `denied ${KEY}` });
  const { context, written } = testContext();
  const error = await assertRejects(() =>
    behavior.methods.sample.execute(
      { _fetch: fetcher, _now: () => NOW },
      context,
    )
  );
  assertStringIncludes(String(error), "HTTP 403");
  assertFalse(String(error).includes(KEY));
  assertEquals(urls.length, 1);
  assertEquals(written().length, 0);
});

Deno.test("a result other than 1 names Valve's message, and errors never carry the key", async () => {
  await assertRejects(
    () =>
      fetchBranches(
        fakeFetch({
          body: { response: { result: 2, message: `bad app ${KEY}` } },
        }).fetcher,
        KEY,
        APP_ID,
      ),
    Error,
    "result 2: bad app [redacted]",
  );
  await assertRejects(
    () =>
      fetchBranches(fakeFetch({ status: 500, body: KEY }).fetcher, KEY, APP_ID),
    Error,
    "transient",
  );
  await assertRejects(
    () =>
      fetchBranches(
        fakeFetch({ status: 429, body: "", headers: { "retry-after": "30" } })
          .fetcher,
        KEY,
        APP_ID,
      ),
    Error,
    "retry after 30 seconds",
  );
  await assertRejects(
    () => fetchBranches(fakeFetch({ body: "not json" }).fetcher, KEY, APP_ID),
    Error,
    "not JSON",
  );
  await assertRejects(
    () =>
      fetchBuilds(
        fakeFetch({ body: "" }, { body: { response: { result: 1 } } }).fetcher,
        KEY,
        APP_ID,
        10,
      ),
    Error,
    "observed builds map",
  );
  const failing: Fetcher = () =>
    Promise.reject(new Error(`connect failed for ${KEY}`));
  const error = await assertRejects(() => fetchBranches(failing, KEY, APP_ID));
  assertStringIncludes(String(error), "request failed");
  assertFalse(String(error).includes(KEY));
});

Deno.test("sample refuses a count out of range before any request", async () => {
  const { fetcher, urls } = fakeFetch({ body: betasAnswer({}) });
  const { context } = testContext();
  await assertRejects(
    () =>
      behavior.methods.sample.execute(
        { _fetch: fetcher, _now: () => NOW, count: 101 },
        context,
      ),
    Error,
    "count 101",
  );
  assertEquals(urls.length, 0);
});

const V1 = compare(
  APP_ID,
  [{
    name: "public",
    description: "",
    passwordRequired: false,
    reqLocalCS: 0,
    buildId: 200,
  }],
  [{
    buildId: 200,
    createdAt: "2026-10-20T00:00:00.000Z",
    description: "first",
    depots: [],
  }],
  null,
  10,
  "2026-10-21T12:00:00.000Z",
);
const V2 = compare(
  APP_ID,
  [
    {
      name: "public",
      description: "",
      passwordRequired: false,
      reqLocalCS: 0,
      buildId: 202,
    },
    {
      name: "beta",
      description: "",
      passwordRequired: false,
      reqLocalCS: 0,
      buildId: 203,
    },
  ],
  [{
    buildId: 203,
    createdAt: "2026-10-22T00:00:00.000Z",
    description: "newest",
    depots: [],
  }],
  V1,
  10,
  "2026-10-22T12:00:00.000Z",
);
const V3 = compare(
  APP_ID,
  [
    {
      name: "public",
      description: "",
      passwordRequired: false,
      reqLocalCS: 0,
      buildId: 200,
    },
    {
      name: "beta",
      description: "",
      passwordRequired: false,
      reqLocalCS: 0,
      buildId: 203,
    },
  ],
  [],
  V2,
  10,
  "2026-10-23T12:00:00.000Z",
);

Deno.test("summarise reports each branch's builds, moves and the newest build", () => {
  const summary = summarise(APP_ID, [V3, V1, V2], null, NOW.toISOString());
  assertEquals(summary.samples, 3);
  assertEquals(summary.firstFetchedAt, "2026-10-21T12:00:00.000Z");
  const publicBranch = summary.branches.find((branch) =>
    branch.name === "public"
  );
  assertEquals(publicBranch?.history.map((entry) => entry.buildId), [
    200,
    202,
    200,
  ]);
  assertEquals(publicBranch?.moves, 2);
  assertEquals(publicBranch?.currentBuildId, 200);
  assertEquals(
    summary.branches.find((branch) => branch.name === "beta")?.moves,
    0,
  );
  assertEquals(summary.newestBuild?.buildId, 203);
});

Deno.test("summarise filters to one branch and fails on an unknown one", () => {
  const only = summarise(APP_ID, [V1, V2], "beta", NOW.toISOString());
  assertEquals(only.branches.map((branch) => branch.name), ["beta"]);
  let failed = false;
  try {
    summarise(APP_ID, [V1], "nightly", NOW.toISOString());
  } catch {
    failed = true;
  }
  assert(failed);
});

Deno.test("the summarise method fails before writing when nothing is recorded", async () => {
  const { context, written } = testContext([]);
  await assertRejects(
    () => behavior.methods.summarise.execute({ _now: () => NOW }, context),
    Error,
    "run the sample method first",
  );
  assertEquals(written().length, 0);
});

Deno.test("the User-Agent names the version the manifest publishes", () => {
  assertEquals(VERSION, behavior.version);
  assertEquals(VERSION, MANIFEST_VERSION);
  assertEquals(
    USER_AGENT,
    `@reset/steamworks-builds/${MANIFEST_VERSION} (swamp extension)`,
  );
});

Deno.test("the key is marked sensitive and the arguments validate", () => {
  const globals = behavior.globalArguments;
  assertEquals(globals.shape.apiKey.meta()?.sensitive, true);
  assert(globals.safeParse({ apiKey: "k", appId: 480 }).success);
  assert(!globals.safeParse({ apiKey: "", appId: 480 }).success);
  assert(!globals.safeParse({ apiKey: "k", appId: 0 }).success);
  assert(behavior.methods.sample.arguments.safeParse({ count: 100 }).success);
  assert(!behavior.methods.sample.arguments.safeParse({ count: 0 }).success);
  assert(
    behavior.methods.summarise.arguments.safeParse({ branch: "public" })
      .success,
  );
  assert(
    !behavior.methods.summarise.arguments.safeParse({ branch: "" }).success,
  );
});

Deno.test("written records conform to their resource schemas", async () => {
  const sampled = testContext();
  await behavior.methods.sample.execute(
    {
      _fetch: fakeFetch(
        { body: betasAnswer({ public: { build: 200 } }) },
        { body: buildsAnswer([{ id: 200, created: T1 }]) },
      ).fetcher,
      _now: () => NOW,
    },
    sampled.context,
  );
  assert(
    behavior.resources.builds.schema.strict().safeParse(
      sampled.written()[0]?.data,
    )
      .success,
  );
  const summarised = testContext([stored(1, V1), stored(2, V2)]);
  await behavior.methods.summarise.execute(
    { _now: () => NOW },
    summarised.context,
  );
  assert(
    behavior.resources.summary.schema.strict().safeParse(
      summarised.written()[0]?.data,
    ).success,
  );
});

Deno.test("every argument's description is written where the registry reads it", () => {
  // swamp's registry reads argument descriptions from the source text: a field
  // that starts `name: z.<type>(` and carries `.describe("...")` with a string
  // literal.
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const schemas: { shape: Record<string, { description?: string }> }[] = [
    behavior.globalArguments,
    ...Object.values(behavior.methods).map((method) => method.arguments),
  ];
  const unread: string[] = [];
  for (const schema of schemas) {
    for (const [name, field] of Object.entries(schema.shape)) {
      const description = field.description;
      const starts = new RegExp(`(?<![.\\w])${name}:\\s*z\\.\\w+\\(`);
      const described = description !== undefined && new RegExp(
        `\\.describe\\(\\s*${escape(JSON.stringify(description))}`,
      ).test(source);
      if (!described || !starts.test(source)) {
        unread.push(name);
      }
    }
  }
  assertEquals(unread, []);
});
