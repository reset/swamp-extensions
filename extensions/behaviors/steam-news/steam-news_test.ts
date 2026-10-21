/**
 * Unit tests for the Steam news behavior. Every request goes through a mocked
 * fetch: nothing here touches the network.
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
  withMockedFetch,
} from "jsr:@swamp-club/swamp-testing@0.20261016.58";
import {
  behavior,
  type Context,
  type GlobalArgs,
  matchItem,
  normalizeItem,
  SteamNewsError,
} from "./steam-news.ts";

const APP = 480;
const KEY = "publisher-key-for-tests";
const ANN = "steam_community_announcements";
const SINCE = "2026-10-01T00:00:00Z";
const SINCE_UNIX = Date.parse(SINCE) / 1000;

function testContext(overrides: Partial<GlobalArgs> = {}): {
  context: Context;
  getWrittenResources: ModelTestContextResult["getWrittenResources"];
  getLogs: ModelTestContextResult["getLogs"];
} {
  const globalArgs: GlobalArgs = { appId: APP, ...overrides };
  const result = createModelTestContext({ globalArgs: { ...globalArgs } });
  const context: Context = { ...result.context, globalArgs };
  return {
    context,
    getWrittenResources: result.getWrittenResources,
    getLogs: result.getLogs,
  };
}

function post(
  gid: number,
  date: number,
  title = `Post ${gid}`,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    gid: String(gid),
    title,
    url: `https://store.example/news/${gid}`,
    is_external_url: true,
    author: "a-person",
    contents: `Body of post ${gid}`,
    feedlabel: "Community Announcements",
    date,
    feedname: ANN,
    feed_type: 1,
    appid: APP,
    tags: ["patchnotes"],
    ...extra,
  };
}

function answer(items: Record<string, unknown>[], count?: number): Response {
  return Response.json({
    appnews: { appid: APP, newsitems: items, count: count ?? items.length },
  });
}

const schemas = {
  global: behavior.globalArguments,
  news: behavior.methods.news.arguments,
  find: behavior.methods.find.arguments,
};

Deno.test("global arguments require a positive app id and keep the key optional", () => {
  assertEquals(schemas.global.parse({ appId: 440 }), { appId: 440 });
  assertFalse(schemas.global.safeParse({}).success);
  assertFalse(schemas.global.safeParse({ appId: 0 }).success);
  assertFalse(schemas.global.safeParse({ appId: 1, webApiKey: "" }).success);
});

Deno.test("the publisher key is declared sensitive", () => {
  const meta = schemas.global.shape.webApiKey.meta();
  assertEquals(meta?.sensitive, true);
});

Deno.test("news arguments default to 20 posts without bodies or authors", () => {
  assertEquals(schemas.news.parse({}), {
    count: 20,
    maxLength: 300,
    includeContents: false,
    includeAuthor: false,
  });
  assertFalse(schemas.news.safeParse({ count: 101 }).success);
  assertFalse(schemas.news.safeParse({ before: "yesterday" }).success);
});

Deno.test("find arguments need text and a start time", () => {
  assertFalse(schemas.find.safeParse({ since: SINCE }).success);
  assertFalse(schemas.find.safeParse({ text: "1.2.0" }).success);
  assertEquals(schemas.find.parse({ text: "1.2.0", since: SINCE }), {
    text: "1.2.0",
    since: SINCE,
    searchContents: false,
    caseSensitive: false,
  });
});

Deno.test("normalizeItem converts the date and tolerates missing fields", () => {
  const item = normalizeItem(post(7, 1_792_179_520));
  assertEquals(item.gid, "7");
  assertEquals(item.date, new Date(1_792_179_520 * 1000).toISOString());
  assertEquals(item.feedName, ANN);
  assertEquals(item.tags, ["patchnotes"]);
  const bare = normalizeItem({ gid: 8 });
  assertEquals(bare.title, "");
  assertEquals(bare.tags, []);
  assertEquals(bare.author, undefined);
});

Deno.test("matchItem searches the title, and the body only when asked", () => {
  const item = normalizeItem(post(1, 1, "Update 1.2.0 is live", {
    contents: "Fixes for build 4711",
  }));
  assertEquals(matchItem(item, "1.2.0", false, false), "title");
  assertEquals(matchItem(item, "UPDATE", false, false), "title");
  assertEquals(matchItem(item, "UPDATE", false, true), undefined);
  assertEquals(matchItem(item, "4711", false, false), undefined);
  assertEquals(matchItem(item, "4711", true, false), "contents");
});

Deno.test("news calls the public method and drops bodies and authors", async () => {
  const { context, getWrittenResources } = testContext();
  const { calls } = await withMockedFetch(
    [answer([post(2, SINCE_UNIX + 10), post(1, SINCE_UNIX)], 40)],
    () =>
      behavior.methods.news.execute(
        schemas.news.parse({ count: 2, feeds: [ANN] }),
        context,
      ),
  );
  assertEquals(calls.length, 1);
  const url = new URL(calls[0].url);
  assertEquals(
    url.origin + url.pathname,
    "https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/",
  );
  assertEquals(url.searchParams.get("appid"), String(APP));
  assertEquals(url.searchParams.get("count"), "2");
  assertEquals(url.searchParams.get("feeds"), ANN);
  assertEquals(url.searchParams.get("maxlength"), "1");
  assertEquals(calls[0].headers["x-webapi-key"], undefined);

  const [written] = getWrittenResources();
  assertEquals(written.specName, "news");
  const data = written.data as Record<string, unknown>;
  assertEquals(data.count, 2);
  assertEquals(data.totalCount, 40);
  assertEquals(data.truncated, true);
  assertEquals(data.authed, false);
  const items = data.items as Record<string, unknown>[];
  assertEquals(items[0].gid, "2");
  assertEquals(items[0].author, undefined);
  assertEquals(items[0].contents, undefined);
  assert(behavior.resources.news.schema.safeParse(data).success);
});

Deno.test("news keeps bodies and authors when asked, and passes before", async () => {
  const { context, getWrittenResources } = testContext();
  const before = "2026-10-05T00:00:00Z";
  const { calls } = await withMockedFetch(
    [answer([post(1, SINCE_UNIX)])],
    () =>
      behavior.methods.news.execute(
        schemas.news.parse({
          includeContents: true,
          includeAuthor: true,
          maxLength: 0,
          before,
        }),
        context,
      ),
  );
  const url = new URL(calls[0].url);
  assertEquals(url.searchParams.get("maxlength"), "0");
  assertEquals(
    url.searchParams.get("enddate"),
    String(Date.parse(before) / 1000),
  );
  assertEquals(url.searchParams.get("feeds"), null);
  const data = getWrittenResources()[0].data as Record<string, unknown>;
  const items = data.items as Record<string, unknown>[];
  assertEquals(items[0].author, "a-person");
  assertEquals(items[0].contents, "Body of post 1");
  assertEquals(data.truncated, false);
});

Deno.test("a publisher key calls the authed method with the key in a header", async () => {
  const { context, getWrittenResources } = testContext({ webApiKey: KEY });
  const { calls } = await withMockedFetch(
    [answer([post(1, SINCE_UNIX)])],
    () => behavior.methods.news.execute(schemas.news.parse({}), context),
  );
  const url = new URL(calls[0].url);
  assertEquals(
    url.origin + url.pathname,
    "https://partner.steam-api.com/ISteamNews/GetNewsForAppAuthed/v2/",
  );
  assertEquals(calls[0].headers["x-webapi-key"], KEY);
  assertFalse(calls[0].url.includes(KEY), "the key stays out of the URL");
  const data = getWrittenResources()[0].data as Record<string, unknown>;
  assertEquals(data.authed, true);
  assertFalse(JSON.stringify(data).includes(KEY));
});

Deno.test("posts from feeds not asked for are dropped with a warning", async () => {
  const { context, getWrittenResources, getLogs } = testContext();
  await withMockedFetch(
    // Steam ignores an unknown feed name and answers with every feed.
    [answer([
      post(2, SINCE_UNIX, "news", { feedname: "other_feed" }),
      post(1, SINCE_UNIX),
    ])],
    () =>
      behavior.methods.news.execute(
        schemas.news.parse({ feeds: [ANN] }),
        context,
      ),
  );
  const data = getWrittenResources()[0].data as Record<string, unknown>;
  assertEquals(data.count, 1);
  assert(
    getLogs().some((log) =>
      log.level === "warning" && log.message.includes("misspelled")
    ),
  );
});

Deno.test("a 403 throws with the status and a hint, and writes nothing", async () => {
  const { context, getWrittenResources } = testContext();
  const error = await withMockedFetch(
    [Response.json({}, { status: 403 })],
    () =>
      assertRejects(
        () => behavior.methods.news.execute(schemas.news.parse({}), context),
        SteamNewsError,
      ),
  );
  assertEquals(error.result.status, 403);
  assertStringIncludes(error.result.message, "no public news");
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("an answer without newsitems is refused", async () => {
  const { context } = testContext();
  await withMockedFetch(
    [Response.json({ appnews: { appid: APP } })],
    () =>
      assertRejects(
        () => behavior.methods.news.execute(schemas.news.parse({}), context),
        SteamNewsError,
        "no appnews.newsitems",
      ),
  );
  await withMockedFetch(
    [new Response("<html>", { status: 200 })],
    () =>
      assertRejects(
        () => behavior.methods.news.execute(schemas.news.parse({}), context),
        SteamNewsError,
        "not JSON",
      ),
  );
});

Deno.test("find matches a title in the window and stops at an older post", async () => {
  const { context, getWrittenResources } = testContext();
  const { calls } = await withMockedFetch(
    [
      answer([
        post(3, SINCE_UNIX + 100, "Patch 1.2.0 notes"),
        post(2, SINCE_UNIX + 50, "Dev diary"),
        post(1, SINCE_UNIX - 10, "Patch 1.2.0 preview"),
      ]),
    ],
    () =>
      behavior.methods.find.execute(
        schemas.find.parse({ text: "1.2.0", since: SINCE, feeds: [ANN] }),
        context,
      ),
  );
  assertEquals(calls.length, 1);
  assertEquals(new URL(calls[0].url).searchParams.get("count"), "100");
  const data = getWrittenResources()[0].data as Record<string, unknown>;
  assertEquals(data.found, true);
  assertEquals(data.matchCount, 1, "the post before since is not counted");
  assertEquals(data.searched, 2);
  assertEquals(data.complete, true);
  const matches = data.matches as Record<string, unknown>[];
  assertEquals(matches[0].gid, "3");
  assertEquals(matches[0].inTitle, true);
  assert(behavior.resources.find.schema.safeParse(data).success);
});

Deno.test("find reports not found when the window holds no match", async () => {
  const { context, getWrittenResources } = testContext();
  await withMockedFetch(
    [answer([post(1, SINCE_UNIX + 5, "Dev diary")])],
    () =>
      behavior.methods.find.execute(
        schemas.find.parse({ text: "1.2.0", since: SINCE }),
        context,
      ),
  );
  const data = getWrittenResources()[0].data as Record<string, unknown>;
  assertEquals(data.found, false);
  assertEquals(
    data.complete,
    true,
    "the feed ran out, so the window is covered",
  );
});

Deno.test("find searches bodies with searchContents and asks for full bodies", async () => {
  const { context, getWrittenResources } = testContext();
  const { calls } = await withMockedFetch(
    [answer([
      post(1, SINCE_UNIX + 5, "Update released", { contents: "Build 1.2.0" }),
    ])],
    () =>
      behavior.methods.find.execute(
        schemas.find.parse({
          text: "1.2.0",
          since: SINCE,
          searchContents: true,
        }),
        context,
      ),
  );
  assertEquals(new URL(calls[0].url).searchParams.get("maxlength"), "0");
  const data = getWrittenResources()[0].data as Record<string, unknown>;
  const matches = data.matches as Record<string, unknown>[];
  assertEquals(matches[0].inTitle, false);
  assertFalse(JSON.stringify(data).includes("a-person"), "no author kept");
});

Deno.test("find pages back with an inclusive enddate and drops the repeat", async () => {
  const { context, getWrittenResources } = testContext();
  const first = Array.from(
    { length: 100 },
    (_, i) => post(1000 - i, SINCE_UNIX + 1000 - i),
  );
  const oldest = SINCE_UNIX + 901;
  const second = [
    post(901, oldest),
    post(900, oldest - 1, "Patch 1.2.0"),
    post(1, SINCE_UNIX - 1),
  ];
  const { calls } = await withMockedFetch(
    [answer(first, 500), answer(second, 500)],
    () =>
      behavior.methods.find.execute(
        schemas.find.parse({ text: "1.2.0", since: SINCE }),
        context,
      ),
  );
  assertEquals(calls.length, 2);
  assertEquals(
    new URL(calls[1].url).searchParams.get("enddate"),
    String(oldest),
  );
  const data = getWrittenResources()[0].data as Record<string, unknown>;
  assertEquals(data.found, true);
  assertEquals(data.searched, 101, "post 901 is counted once");
  assertEquals(data.pagesFetched, 2);
  assertEquals(data.complete, true);
});

Deno.test("find says the window was not covered when the page cap is reached", async () => {
  const { context, getWrittenResources, getLogs } = testContext();
  let page = 0;
  const { calls } = await withMockedFetch(
    () => {
      const top = 1_000_000 - page * 100;
      page++;
      return answer(
        Array.from(
          { length: 100 },
          (_, i) => post(top - i, SINCE_UNIX + top - i),
        ),
        5000,
      );
    },
    () =>
      behavior.methods.find.execute(
        schemas.find.parse({ text: "1.2.0", since: SINCE }),
        context,
      ),
  );
  assertEquals(calls.length, 10);
  const data = getWrittenResources()[0].data as Record<string, unknown>;
  assertEquals(data.found, false);
  assertEquals(data.complete, false);
  assert(getLogs().some((log) => log.level === "warning"));
});

Deno.test("find stops when a full page holds nothing new", async () => {
  const { context, getWrittenResources } = testContext();
  const same = Array.from({ length: 100 }, (_, i) => post(i, SINCE_UNIX + 5));
  const { calls } = await withMockedFetch(
    [answer(same, 300), answer(same, 300)],
    () =>
      behavior.methods.find.execute(
        schemas.find.parse({ text: "1.2.0", since: SINCE }),
        context,
      ),
  );
  assertEquals(calls.length, 2);
  const data = getWrittenResources()[0].data as Record<string, unknown>;
  assertEquals(data.complete, false);
  assertEquals(data.searched, 100);
});

Deno.test("a post without a gid or date is refused rather than trusted", async () => {
  const { context, getWrittenResources } = testContext();
  await withMockedFetch(
    [answer([post(2, SINCE_UNIX + 5), { gid: "1", title: "no date" }])],
    () =>
      assertRejects(
        () =>
          behavior.methods.find.execute(
            schemas.find.parse({ text: "x", since: SINCE }),
            context,
          ),
        SteamNewsError,
        "no gid or date",
      ),
  );
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("a network failure names the method and app; an error body is kept", async () => {
  const { context } = testContext();
  await withMockedFetch(
    () => {
      throw new TypeError("connection reset");
    },
    () =>
      assertRejects(
        () => behavior.methods.news.execute(schemas.news.parse({}), context),
        SteamNewsError,
        "GetNewsForApp for app 480: request failed: connection reset",
      ),
  );
  await withMockedFetch(
    [new Response("upstream busy", { status: 503 })],
    () =>
      assertRejects(
        () => behavior.methods.news.execute(schemas.news.parse({}), context),
        SteamNewsError,
        "503: upstream busy",
      ),
  );
});
