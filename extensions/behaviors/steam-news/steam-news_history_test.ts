/**
 * Unit tests for the Steam news behavior's `fetch` and `list` methods, the
 * history half of the behavior, and for what the whole behavior declares.
 * Every test injects a fetch, a clock and a query, so nothing here reaches
 * Steam or a swamp datastore.
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
  AUTHED_URL,
  behavior,
  DEFAULT_COUNT,
  type Fetcher,
  fetchNews,
  type Listing,
  listPosts,
  markNew,
  MAX_COUNT,
  type MethodContext,
  type News,
  NEWS_URL,
  type Post,
  type RecordedNews,
} from "./steam-news.ts";
import source from "./steam-news.ts" with { type: "text" };

const APP_ID = 440;
const MODEL_ID = "00000000-0000-4000-8000-000000000440";
const NOW = new Date("2026-10-22T12:00:00.000Z");

/** Raw Steam items in the shape GetNewsForApp v2 returned for app 440. */
const RAW_PATCH = {
  gid: "1003",
  title: "Team Fortress 2 Update Released",
  url: "https://store.steampowered.com/news/1003/",
  is_external_url: true,
  author: "erics",
  contents: "An update to Team Fortress 2 has been released.",
  feedlabel: "Community Announcements",
  date: 1792179520,
  feedname: "steam_community_announcements",
  feed_type: 1,
  appid: APP_ID,
  tags: ["patchnotes"],
};
const RAW_UPDATE = {
  gid: "1002",
  title: "Team Fortress 2 Update Released",
  url: "https://store.steampowered.com/news/1002/",
  is_external_url: false,
  author: "Valve",
  contents: "* Fixed some maps not tracking play time correctly",
  feedlabel: "Product Update",
  date: 1792179480,
  feedname: "steam_updates",
  feed_type: 0,
  appid: APP_ID,
};
const RAW_BLOG = {
  gid: "1001",
  title: "A post on the blog",
  url: "https://example.com/blog/1001",
  is_external_url: true,
  author: "",
  contents: "Words.",
  feedlabel: "TF2 Blog",
  date: 1792000000,
  feedname: "tf2_blog",
  feed_type: 0,
  appid: APP_ID,
};

/** A GetNewsForApp body holding the given items. */
function newsBody(items: unknown[], count = 3958): string {
  return JSON.stringify({
    appnews: { appid: APP_ID, newsitems: items, count },
  });
}

/** A fetch that answers every request with one status and body, recording the URLs. */
function fakeFetch(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): { fetcher: Fetcher; urls: string[]; inits: (RequestInit | undefined)[] } {
  const urls: string[] = [];
  const inits: (RequestInit | undefined)[] = [];
  const fetcher: Fetcher = (input, init) => {
    urls.push(input);
    inits.push(init);
    return Promise.resolve(new Response(body, { status, headers }));
  };
  return { fetcher, urls, inits };
}

/** A test context with the behavior's global arguments, id and an optional query. */
function testContext(
  queryData?: (predicate: string) => Promise<unknown[]>,
): {
  context: MethodContext;
  written: ReturnType<typeof createModelTestContext>["getWrittenResources"];
  logs: ReturnType<typeof createModelTestContext>["getLogs"];
} {
  const test = createModelTestContext({ globalArgs: { appId: APP_ID } });
  const context: MethodContext = {
    ...test.context,
    globalArgs: { appId: APP_ID },
    modelId: MODEL_ID,
    queryData,
  };
  return {
    context,
    written: test.getWrittenResources,
    logs: test.getLogs,
  };
}

/** A query that answers with the given stored records. */
function stored(records: unknown[]): (predicate: string) => Promise<unknown[]> {
  return () => Promise.resolve(records);
}

/** A stored news record as queryData returns it. */
function record(version: number, news: News): unknown {
  return { version, name: `app-${news.appId}`, attributes: news };
}

/** A stored post with defaults for the fields a test does not care about. */
function post(fields: Partial<Post> & { gid: string }): Post {
  return {
    title: `Post ${fields.gid}`,
    url: `https://store.steampowered.com/news/${fields.gid}/`,
    feedName: "steam_community_announcements",
    feedLabel: "Community Announcements",
    publishedAt: "2026-10-20T00:00:00.000Z",
    tags: [],
    isPatchNotes: false,
    isExternalUrl: false,
    author: "",
    contents: "",
    feedType: 1,
    isNew: false,
    ...fields,
  };
}

/** A stored news version holding the given posts. */
function news(posts: Post[], fetchedAt = "2026-10-21T12:00:00.000Z"): News {
  return {
    appId: APP_ID,
    fetchedAt,
    totalPosts: posts.length,
    previousFetchedAt: null,
    newCount: 0,
    newGids: [],
    posts,
  };
}

Deno.test("fetch requests the documented URL with app id, count and maxlength", async () => {
  const { fetcher, urls, inits } = fakeFetch(200, newsBody([RAW_PATCH]));
  const { context } = testContext(stored([]));
  await behavior.methods.fetch.execute(
    { count: 5, maxLength: 300, _fetch: fetcher, _now: () => NOW },
    context,
  );
  assertEquals(urls, [`${NEWS_URL}?appid=440&count=5&maxlength=300`]);
  assertEquals(inits[0]?.method, "GET");
  assert(inits[0]?.signal instanceof AbortSignal);
});

Deno.test("fetch defaults to ten posts at full length", async () => {
  const { fetcher, urls } = fakeFetch(200, newsBody([]));
  const { context } = testContext(stored([]));
  await behavior.methods.fetch.execute(
    { _fetch: fetcher, _now: () => NOW },
    context,
  );
  assertEquals(urls, [`${NEWS_URL}?appid=440&count=10&maxlength=0`]);
});

Deno.test("fetch maps Steam's fields and records every post new on the first read", async () => {
  const { fetcher } = fakeFetch(200, newsBody([RAW_PATCH, RAW_UPDATE]));
  const { context, written } = testContext(stored([]));
  const result = await behavior.methods.fetch.execute(
    { _fetch: fetcher, _now: () => NOW },
    context,
  );
  const writes = written();
  assertEquals(writes.length, 1);
  assertEquals(writes[0].specName, "news");
  assertEquals(writes[0].name, "app-440");
  const data = writes[0].data as unknown as News;
  assertEquals(data.appId, APP_ID);
  assertEquals(data.fetchedAt, NOW.toISOString());
  assertEquals(data.totalPosts, 3958);
  assertEquals(data.previousFetchedAt, null);
  assertEquals(data.newCount, 2);
  assertEquals(data.newGids, ["1003", "1002"]);
  assertEquals(data.posts[0], {
    gid: "1003",
    title: "Team Fortress 2 Update Released",
    url: "https://store.steampowered.com/news/1003/",
    feedName: "steam_community_announcements",
    feedLabel: "Community Announcements",
    publishedAt: "2026-10-16T19:38:40.000Z",
    tags: ["patchnotes"],
    isPatchNotes: true,
    isExternalUrl: true,
    contents: "An update to Team Fortress 2 has been released.",
    feedType: 1,
    isNew: true,
  });
  assertEquals(data.posts[1]?.tags, []);
  assertEquals(data.posts[1]?.isPatchNotes, false);
  assertEquals(result.dataHandles.length, 1);
});

Deno.test("fetch keeps the author only when asked", async () => {
  const { fetcher } = fakeFetch(200, newsBody([RAW_PATCH, RAW_BLOG]));
  const { context, written } = testContext(stored([]));
  await behavior.methods.fetch.execute(
    { includeAuthor: true, _fetch: fetcher, _now: () => NOW },
    context,
  );
  const data = written()[0].data as unknown as News;
  assertEquals(data.posts.map((p) => p.author), ["erics", ""]);
  assert(behavior.resources.news.schema.strict().safeParse(data).success);
});

Deno.test("fetch with a publisher key calls the authed method with the key in a header", async () => {
  const { fetcher, urls, inits } = fakeFetch(200, newsBody([RAW_PATCH]));
  const test = testContext(stored([]));
  const context: MethodContext = {
    ...test.context,
    globalArgs: { appId: APP_ID, webApiKey: "publisher-key-for-tests" },
  };
  await behavior.methods.fetch.execute(
    { _fetch: fetcher, _now: () => NOW },
    context,
  );
  assertEquals(urls, [`${AUTHED_URL}?appid=440&count=10&maxlength=0`]);
  const headers = inits[0]?.headers as Record<string, string>;
  assertEquals(headers["x-webapi-key"], "publisher-key-for-tests");
  assert(!urls[0].includes("publisher-key-for-tests"));
});

Deno.test("a version recorded with authors before 2026.10.30.1 still reads back", async () => {
  const recorded = news([post({ gid: "1002", author: "Valve" })]);
  const { context, written } = testContext(stored([record(1, recorded)]));
  await behavior.methods.list.execute({ _now: () => NOW }, context);
  assertEquals((written()[0].data as unknown as Listing).recordedPosts, 1);
});

Deno.test("the upgrade keeps either line's global arguments as written", () => {
  const upgrade = behavior.upgrades[behavior.upgrades.length - 1];
  assertEquals(upgrade.toVersion, behavior.version);
  const board = { appId: 440 };
  const keyed = { appId: 480, webApiKey: "publisher-key-for-tests" };
  for (const old of [board, keyed]) {
    const upgraded = upgrade.upgradeAttributes({ ...old });
    assertEquals(upgraded, old);
    assert(behavior.globalArguments.safeParse(upgraded).success);
  }
});

Deno.test("both lines' methods and resources are declared under distinct names", () => {
  assertEquals(Object.keys(behavior.resources).sort(), [
    "find",
    "listing",
    "news",
    "posts",
  ]);
  assertEquals(Object.keys(behavior.methods).sort(), [
    "fetch",
    "find",
    "list",
    "news",
  ]);
});

Deno.test("fetch flags only the gids the previous version lacked", async () => {
  const older = news([post({ gid: "1001" })], "2026-10-20T12:00:00.000Z");
  const previous = news(
    [post({ gid: "1002" }), post({ gid: "1001" })],
    "2026-10-21T12:00:00.000Z",
  );
  const { fetcher } = fakeFetch(
    200,
    newsBody([RAW_PATCH, RAW_UPDATE, RAW_BLOG]),
  );
  const { context, written } = testContext(
    stored([record(2, previous), record(1, older)]),
  );
  await behavior.methods.fetch.execute(
    { _fetch: fetcher, _now: () => NOW },
    context,
  );
  const data = written()[0].data as unknown as News;
  assertEquals(data.previousFetchedAt, "2026-10-21T12:00:00.000Z");
  assertEquals(data.newCount, 1);
  assertEquals(data.newGids, ["1003"]);
  assertEquals(data.posts.map((p) => p.isNew), [true, false, false]);
});

Deno.test("fetch queries every version of its own news", async () => {
  const predicates: string[] = [];
  const { fetcher } = fakeFetch(200, newsBody([]));
  const { context } = testContext((predicate) => {
    predicates.push(predicate);
    return Promise.resolve([]);
  });
  await behavior.methods.fetch.execute(
    { _fetch: fetcher, _now: () => NOW },
    context,
  );
  assertEquals(predicates.length, 1);
  assertStringIncludes(predicates[0] ?? "", `modelId == "${MODEL_ID}"`);
  assertStringIncludes(predicates[0] ?? "", 'specName == "news"');
  assertStringIncludes(predicates[0] ?? "", 'name == "app-440"');
  assertStringIncludes(predicates[0] ?? "", "version >= 0");
});

Deno.test("fetch logs what it read", async () => {
  const { fetcher } = fakeFetch(200, newsBody([RAW_PATCH]));
  const { context, logs } = testContext(stored([]));
  await behavior.methods.fetch.execute(
    { _fetch: fetcher, _now: () => NOW },
    context,
  );
  assert(logs().some((log) => log.level === "info"));
});

Deno.test("fetch fails clearly without queryData and writes nothing", async () => {
  const { fetcher, urls } = fakeFetch(200, newsBody([RAW_PATCH]));
  const { context, written } = testContext();
  await assertRejects(
    () => behavior.methods.fetch.execute({ _fetch: fetcher }, context),
    Error,
    "queryData",
  );
  assertEquals(urls.length, 0);
  assertEquals(written().length, 0);
});

Deno.test("an app Steam refuses fails with the app id and status, writing nothing", async () => {
  const { fetcher } = fakeFetch(403, "<html>Forbidden</html>");
  const { context, written } = testContext(stored([]));
  const error = await assertRejects(
    () => behavior.methods.fetch.execute({ _fetch: fetcher }, context),
    Error,
  );
  assertStringIncludes(error.message, "app 440");
  assertStringIncludes(error.message, "HTTP 403");
  assertStringIncludes(error.message, "check that the app id exists");
  assertEquals(written().length, 0);
});

Deno.test("a rate limit names HTTP 429 and Retry-After", async () => {
  const { fetcher } = fakeFetch(429, "Too Many Requests", {
    "retry-after": "30",
  });
  const error = await assertRejects(
    () => fetchNews(fetcher, APP_ID, 10, 0),
    Error,
  );
  assertStringIncludes(error.message, "HTTP 429");
  assertStringIncludes(error.message, "retry after 30 seconds");
});

Deno.test("a server error is reported as transient", async () => {
  const { fetcher } = fakeFetch(503, "<html>Service Unavailable</html>");
  const error = await assertRejects(
    () => fetchNews(fetcher, APP_ID, 10, 0),
    Error,
  );
  assertStringIncludes(error.message, "HTTP 503");
  assertStringIncludes(error.message, "transient");
});

Deno.test("a network failure is reported with its cause", async () => {
  const fetcher: Fetcher = () =>
    Promise.reject(new TypeError("connection refused"));
  const error = await assertRejects(
    () => fetchNews(fetcher, APP_ID, 10, 0),
    Error,
  );
  assertStringIncludes(error.message, "request failed: connection refused");
});

Deno.test("a body that is not JSON is reported with its status", async () => {
  const { fetcher } = fakeFetch(200, "<html><body>Oops</body></html>");
  const error = await assertRejects(
    () => fetchNews(fetcher, APP_ID, 10, 0),
    Error,
  );
  assertStringIncludes(error.message, "HTTP 200, body is not JSON");
});

Deno.test("a JSON body without the documented news shape is rejected", async () => {
  for (
    const body of [
      "{}",
      "null",
      '{"appnews":{}}',
      '{"appnews":{"newsitems":"none"}}',
      newsBody([{ ...RAW_PATCH, gid: 1003 }]),
      newsBody([{ ...RAW_PATCH, date: "yesterday" }]),
      newsBody([{ ...RAW_PATCH, tags: "patchnotes" }]),
    ]
  ) {
    const { fetcher } = fakeFetch(200, body);
    await assertRejects(
      () => fetchNews(fetcher, APP_ID, 10, 0),
      Error,
      "unexpected response",
    );
  }
});

Deno.test("a cancelled run aborts the request", async () => {
  const controller = new AbortController();
  let seen: AbortSignal | undefined;
  const fetcher: Fetcher = (_input, init) => {
    seen = init?.signal ?? undefined;
    controller.abort();
    return Promise.resolve(new Response(newsBody([])));
  };
  await fetchNews(fetcher, APP_ID, 10, 0, controller.signal);
  assertEquals(seen?.aborted, true);
});

Deno.test("markNew with no previous version marks everything new", () => {
  const fetched = {
    posts: [post({ gid: "1" }), post({ gid: "2" })],
    totalPosts: 2,
  };
  const data = markNew(APP_ID, fetched, null, NOW.toISOString());
  assertEquals(data.newGids, ["1", "2"]);
  assertEquals(data.previousFetchedAt, null);
});

const RECORDED: RecordedNews[] = [
  {
    version: 1,
    news: news([
      post({
        gid: "a",
        publishedAt: "2026-10-01T00:00:00.000Z",
        feedName: "tf2_blog",
        feedLabel: "TF2 Blog",
      }),
      post({
        gid: "b",
        title: "Old title",
        publishedAt: "2026-10-10T00:00:00.000Z",
        tags: ["patchnotes"],
        isPatchNotes: true,
      }),
    ]),
  },
  {
    version: 2,
    news: news([
      post({
        gid: "c",
        publishedAt: "2026-10-20T00:00:00.000Z",
        tags: ["patchnotes", "mod_reviewed"],
        isPatchNotes: true,
      }),
      post({
        gid: "b",
        title: "New title",
        publishedAt: "2026-10-10T00:00:00.000Z",
        tags: ["patchnotes"],
        isPatchNotes: true,
      }),
    ]),
  },
];

Deno.test("listPosts unions versions, newest first, latest copy of each gid", () => {
  const listing = listPosts(APP_ID, RECORDED, {}, NOW.toISOString());
  assertEquals(listing.recordedPosts, 3);
  assertEquals(listing.matched, 3);
  assertEquals(listing.posts.map((p) => p.gid), ["c", "b", "a"]);
  assertEquals(listing.posts[1]?.title, "New title");
  assertEquals(listing.byFeed, {
    "Community Announcements": 2,
    "TF2 Blog": 1,
  });
  assertEquals(listing.newestAt, "2026-10-20T00:00:00.000Z");
  assertEquals(listing.oldestAt, "2026-10-01T00:00:00.000Z");
  assertEquals(listing.filter, {
    patchNotesOnly: false,
    feedName: null,
    tag: null,
    since: null,
    limit: null,
  });
});

Deno.test("listPosts filters patch notes, feed, tag and since, and limits", () => {
  const at = NOW.toISOString();
  const ids = (args: Parameters<typeof listPosts>[2]) =>
    listPosts(APP_ID, RECORDED, args, at).posts.map((p) => p.gid);
  assertEquals(ids({ patchNotesOnly: true }), ["c", "b"]);
  assertEquals(ids({ feedName: "tf2_blog" }), ["a"]);
  assertEquals(ids({ tag: "mod_reviewed" }), ["c"]);
  assertEquals(ids({ since: "2026-10-10T00:00:00.000Z" }), ["c", "b"]);
  const limited = listPosts(APP_ID, RECORDED, { limit: 1 }, at);
  assertEquals(limited.posts.map((p) => p.gid), ["c"]);
  assertEquals(limited.matched, 3);
  const none = listPosts(APP_ID, RECORDED, { tag: "absent" }, at);
  assertEquals(none.matched, 0);
  assertEquals(none.newestAt, null);
  assertEquals(none.byFeed, {});
});

Deno.test("the list method writes the listing of its own recorded news", async () => {
  const { context, written } = testContext(
    stored(RECORDED.map((r) => record(r.version, r.news))),
  );
  await behavior.methods.list.execute(
    { patchNotesOnly: true, _now: () => NOW },
    context,
  );
  const writes = written();
  assertEquals(writes.length, 1);
  assertEquals(writes[0].specName, "listing");
  assertEquals(writes[0].name, "listing-440");
  assertEquals(writes[0].data.matched, 2);
  assertEquals(writes[0].data.listedAt, NOW.toISOString());
});

Deno.test("the list method skips records that are not news of its app", async () => {
  const { context, written, logs } = testContext(
    stored([
      record(1, news([post({ gid: "x" })])),
      record(2, { ...news([post({ gid: "y" })]), appId: 730 }),
      { version: 3, attributes: { unexpected: true } },
      { attributes: news([post({ gid: "z" })]) },
      null,
    ]),
  );
  await behavior.methods.list.execute({ _now: () => NOW }, context);
  assertEquals(written()[0].data.recordedPosts, 1);
  assert(logs().some((log) => log.level === "warning"));
});

Deno.test("the list method fails before writing when nothing was fetched", async () => {
  const { context, written } = testContext(stored([]));
  await assertRejects(
    () => behavior.methods.list.execute({}, context),
    Error,
    "run the fetch method first",
  );
  assertEquals(written().length, 0);
});

Deno.test("the list method fails clearly without queryData", async () => {
  const { context } = testContext();
  await assertRejects(
    () => behavior.methods.list.execute({}, context),
    Error,
    "queryData",
  );
});

Deno.test("the method arguments and global arguments validate", () => {
  assert(behavior.globalArguments.safeParse({ appId: 440 }).success);
  assert(!behavior.globalArguments.safeParse({ appId: 0 }).success);
  assert(!behavior.globalArguments.safeParse({ appId: "440" }).success);
  const fetchArgs = behavior.methods.fetch.arguments;
  assert(fetchArgs.safeParse({}).success);
  assert(fetchArgs.safeParse({ count: 100, maxLength: 0 }).success);
  assert(!fetchArgs.safeParse({ count: 0 }).success);
  assert(!fetchArgs.safeParse({ count: 101 }).success);
  assert(!fetchArgs.safeParse({ maxLength: -1 }).success);
  const listArgs = behavior.methods.list.arguments;
  assert(listArgs.safeParse({}).success);
  assert(
    listArgs.safeParse({
      patchNotesOnly: true,
      feedName: "steam_updates",
      tag: "patchnotes",
      since: "2026-10-01T00:00:00Z",
      limit: 5,
    }).success,
  );
  assert(!listArgs.safeParse({ since: "yesterday" }).success);
  assert(!listArgs.safeParse({ limit: 0 }).success);
  assert(!listArgs.safeParse({ feedName: "" }).success);
});

Deno.test("written records conform to their resource schemas", async () => {
  const { fetcher } = fakeFetch(
    200,
    newsBody([RAW_PATCH, RAW_UPDATE, RAW_BLOG]),
  );
  const fetched = testContext(stored([]));
  await behavior.methods.fetch.execute(
    { _fetch: fetcher, _now: () => NOW },
    fetched.context,
  );
  assert(
    behavior.resources.news.schema.strict().safeParse(
      fetched.written()[0].data,
    ).success,
  );
  const listed = testContext(
    stored(RECORDED.map((r) => record(r.version, r.news))),
  );
  await behavior.methods.list.execute({ _now: () => NOW }, listed.context);
  assert(
    behavior.resources.listing.schema.strict().safeParse(
      listed.written()[0].data,
    ).success,
  );
});

Deno.test("every argument's description is written where the registry reads it", () => {
  // swamp's registry reads argument descriptions from the source text: a field
  // that starts `name: z.<type>(` and carries `.describe("...")` with a string
  // literal. `.meta({ description })` or a template literal leaves the
  // registry's description empty, and a field that starts `z.iso.datetime()`
  // is left out of the registry's argument list.
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

Deno.test("the count argument's description states the current bounds", () => {
  assertStringIncludes(
    String(behavior.methods.fetch.arguments.shape.count.description),
    `1 to ${MAX_COUNT}; ${DEFAULT_COUNT} when omitted`,
  );
});
