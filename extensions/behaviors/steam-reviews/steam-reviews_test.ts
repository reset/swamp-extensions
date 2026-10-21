/**
 * Unit tests for the Steam reviews behavior. Every request goes through a
 * mocked fetch: nothing here touches the network.
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
  countReviews,
  type GlobalArgs,
  normalizeReview,
  parsePage,
  type RecentArgs,
  redact,
  share,
  SteamReviewsError,
  type SummaryArgs,
} from "./steam-reviews.ts";

const APP_ID = 480;
const KEY = "publisher-key-for-tests";
const UNTIL = 1_800_000_000;
const DAY = 86_400;

function testContext(overrides: Partial<GlobalArgs> = {}): {
  context: Context;
  getWrittenResources: ModelTestContextResult["getWrittenResources"];
  getLogs: ModelTestContextResult["getLogs"];
} {
  const globalArgs: GlobalArgs = { appId: APP_ID, ...overrides };
  const result = createModelTestContext({ globalArgs: { ...globalArgs } });
  const context: Context = { ...result.context, globalArgs };
  return {
    context,
    getWrittenResources: result.getWrittenResources,
    getLogs: result.getLogs,
  };
}

function rawReview(
  id: number,
  votedUp: boolean,
  created: number,
  language = "english",
): Record<string, unknown> {
  return {
    recommendationid: String(id),
    author: {
      steamid: `7656119800000${id}`,
      playtime_at_review: 120,
      playtime_forever: 600,
      last_played: created,
    },
    language,
    review: `Review text ${id}`,
    timestamp_created: created,
    timestamp_updated: created,
    voted_up: votedUp,
    votes_up: 1,
    weighted_vote_score: 0.5,
  };
}

function page(
  reviews: Record<string, unknown>[],
  cursor: string | undefined,
  summary: Record<string, unknown> = { num_reviews: reviews.length },
): Response {
  return Response.json({
    response: {
      query_summary: summary,
      reviews,
      cursor,
      total_matching: reviews.length,
    },
  });
}

function inputOf(url: string): Record<string, unknown> {
  return JSON.parse(new URL(url).searchParams.get("input_json") ?? "{}");
}

function recentArgs(extra: Record<string, unknown> = {}): RecentArgs {
  return behavior.methods.recent.arguments.parse({
    until: UNTIL,
    days: 7,
    ...extra,
  });
}

function summaryArgs(extra: Record<string, unknown> = {}): SummaryArgs {
  return behavior.methods.summary.arguments.parse(extra);
}

Deno.test("global arguments require the app id and mark the key sensitive", () => {
  const schema = behavior.globalArguments;
  assertFalse(schema.safeParse({}).success);
  assertFalse(schema.safeParse({ appId: 0 }).success);
  assertEquals(schema.parse({ appId: 480 }), { appId: 480 });
  assertEquals(schema.shape.key.meta()?.sensitive, true);
});

Deno.test("method arguments default to every language and Steam purchasers", () => {
  assertEquals(summaryArgs(), {
    languages: ["all"],
    purchaseType: "steam",
    includeOfftopic: false,
  });
  const recent = recentArgs();
  assertEquals(recent.perPage, 100);
  assertEquals(recent.maxPages, 10);
  assertFalse(recent.keepAuthor);
  assertFalse(recent.keepText);
  assertFalse(
    behavior.methods.recent.arguments.safeParse({ perPage: 101 }).success,
  );
  assertFalse(
    behavior.methods.recent.arguments.safeParse({ since: 10, until: 5 })
      .success,
    "since after until is refused",
  );
});

Deno.test("summary reads the score fields and writes summary", async () => {
  const { context, getWrittenResources } = testContext({ key: KEY });
  const { calls } = await withMockedFetch(
    [
      page([rawReview(1, true, UNTIL)], "next", {
        num_reviews: 1,
        review_score: 8,
        review_score_desc: "Very Positive",
        total_positive: 900,
        total_negative: 100,
        total_reviews: 1000,
      }),
    ],
    () => behavior.methods.summary.execute(summaryArgs(), context),
  );
  assertEquals(calls.length, 1);
  const url = new URL(calls[0].url);
  assertEquals(
    url.origin + url.pathname,
    "https://api.steampowered.com/IUserReviewsService/GetAppReviews/v1/",
  );
  assertEquals(url.searchParams.get("key"), KEY);
  assertEquals(inputOf(calls[0].url), {
    appid: APP_ID,
    languages: ["all"],
    review_type: 0,
    purchase_type: 0,
    filter_offtopic_activity: true,
    filter: 1,
    num_per_page: 1,
    cursor: "*",
  });
  const written = getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals([written[0].specName, written[0].name], ["summary", "summary"]);
  const data = written[0].data as Record<string, unknown>;
  assertEquals(data.reviewScore, 8);
  assertEquals(data.reviewScoreDesc, "Very Positive");
  assertEquals(data.totalReviews, 1000);
  assertEquals(data.positiveShare, 0.9);
  assertEquals(data.appId, APP_ID);
  behavior.resources.summary.schema.parse(data);
});

Deno.test("summary maps purchase type and off-topic options", async () => {
  const { context } = testContext();
  const { calls } = await withMockedFetch(
    [page([], undefined, { num_reviews: 0, total_reviews: 0 })],
    () =>
      behavior.methods.summary.execute(
        summaryArgs({
          purchaseType: "all",
          includeOfftopic: true,
          languages: ["german"],
        }),
        context,
      ),
  );
  const input = inputOf(calls[0].url);
  assertEquals(input.purchase_type, 1);
  assertEquals(input.filter_offtopic_activity, false);
  assertEquals(input.languages, ["german"]);
  assertEquals(new URL(calls[0].url).searchParams.get("key"), null);
});

Deno.test("summary of an app with no reviews has a null share", async () => {
  const { context, getWrittenResources } = testContext();
  await withMockedFetch(
    [
      page([], undefined, {
        num_reviews: 0,
        review_score: 0,
        review_score_desc: "No user reviews",
        total_positive: 0,
        total_negative: 0,
        total_reviews: 0,
      }),
    ],
    () => behavior.methods.summary.execute(summaryArgs(), context),
  );
  const data = getWrittenResources()[0].data as Record<string, unknown>;
  assertEquals(data.positiveShare, null);
  assertEquals(data.totalReviews, 0);
});

Deno.test("summary refuses an answer without score fields and writes nothing", async () => {
  const { context, getWrittenResources } = testContext();
  await assertRejects(
    () =>
      withMockedFetch(
        [page([], undefined, { num_reviews: 0 })],
        () => behavior.methods.summary.execute(summaryArgs(), context),
      ),
    SteamReviewsError,
    "no score fields",
  );
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("summary names the empty response Steam gives an app with no store page", async () => {
  const { context } = testContext();
  await assertRejects(
    () =>
      withMockedFetch(
        [Response.json({ response: {} })],
        () => behavior.methods.summary.execute(summaryArgs(), context),
      ),
    SteamReviewsError,
    "no store page",
  );
});

Deno.test("recent counts an empty response as an empty window", async () => {
  const { context, getWrittenResources } = testContext();
  await withMockedFetch(
    [Response.json({ response: {} })],
    () => behavior.methods.recent.execute(recentArgs(), context),
  );
  const data = getWrittenResources()[0].data as Record<string, unknown>;
  assertEquals(data.count, 0);
  assertEquals(data.stopReason, "empty");
});

Deno.test("recent pages by cursor until Steam returns an empty page", async () => {
  const { context, getWrittenResources } = testContext();
  const { calls } = await withMockedFetch(
    [
      page([
        rawReview(1, true, UNTIL - 10),
        rawReview(2, false, UNTIL - 20, "german"),
      ], "c1"),
      page([rawReview(3, true, UNTIL - 30)], "c2"),
      page([], "c3"),
    ],
    () => behavior.methods.recent.execute(recentArgs(), context),
  );
  assertEquals(calls.length, 3);
  const inputs = calls.map((call) => inputOf(call.url));
  assertEquals(inputs.map((input) => input.cursor), ["*", "c1", "c2"]);
  assertEquals(inputs[0].date_range_start, UNTIL - 7 * DAY);
  assertEquals(inputs[0].date_range_end, UNTIL);
  assertEquals(inputs[0].filter, 1);
  assertEquals(inputs[0].num_per_page, 100);

  const written = getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals([written[0].specName, written[0].name], ["recent", "recent"]);
  const data = written[0].data as Record<string, unknown>;
  assertEquals(data.count, 3);
  assertEquals(data.positive, 2);
  assertEquals(data.negative, 1);
  assertEquals(data.positiveShare, 2 / 3);
  assertEquals(data.byLanguage, {
    english: { positive: 2, negative: 0 },
    german: { positive: 0, negative: 1 },
  });
  assertEquals(data.stopReason, "empty");
  assertEquals(data.truncated, false);
  assertEquals(data.pagesFetched, 3);
  behavior.resources.recent.schema.parse(data);
});

Deno.test("recent keeps no author or text unless asked", async () => {
  const { context, getWrittenResources } = testContext();
  await withMockedFetch(
    [page([rawReview(1, true, UNTIL - 10)], "c1"), page([], "c2")],
    () => behavior.methods.recent.execute(recentArgs(), context),
  );
  const data = getWrittenResources()[0].data as Record<string, unknown>;
  const reviews = data.reviews as Record<string, unknown>[];
  assertEquals(reviews, [{
    recommendationId: "1",
    votedUp: true,
    timestampCreated: UNTIL - 10,
    language: "english",
  }]);
  assertEquals(data.keptAuthor, false);
  assertEquals(data.keptText, false);
  const serialized = JSON.stringify(data);
  assertFalse(serialized.includes("765611980"), "no SteamID is kept");
  assertFalse(serialized.includes("Review text"), "no text is kept");
});

Deno.test("recent keeps author and text when asked, text cut to 2000", async () => {
  const { context, getWrittenResources } = testContext();
  const long = rawReview(1, true, UNTIL - 10);
  long.review = "x".repeat(5000);
  await withMockedFetch(
    [page([long], "c1"), page([], "c2")],
    () =>
      behavior.methods.recent.execute(
        recentArgs({ keepAuthor: true, keepText: true }),
        context,
      ),
  );
  const data = getWrittenResources()[0].data as Record<string, unknown>;
  const [review] = data.reviews as Record<string, unknown>[];
  assertEquals(review.authorSteamId, "76561198000001");
  assertEquals(review.playtimeAtReviewMinutes, 120);
  assertEquals((review.text as string).length, 2000);
  assertEquals(data.keptAuthor, true);
  assertEquals(data.keptText, true);
});

Deno.test("recent stops at the first review older than the window", async () => {
  const { context, getWrittenResources } = testContext();
  const { calls } = await withMockedFetch(
    [
      page([
        rawReview(1, true, UNTIL - DAY),
        rawReview(2, false, UNTIL - 8 * DAY),
        rawReview(3, false, UNTIL - 9 * DAY),
      ], "c1"),
    ],
    () => behavior.methods.recent.execute(recentArgs(), context),
  );
  assertEquals(calls.length, 1, "no page after the window ends");
  const data = getWrittenResources()[0].data as Record<string, unknown>;
  assertEquals(data.count, 1);
  assertEquals(data.stopReason, "window");
  assertEquals(data.truncated, false);
});

Deno.test("recent stops on a repeated cursor and drops duplicate reviews", async () => {
  const { context, getWrittenResources } = testContext();
  const { calls } = await withMockedFetch(
    [
      page([rawReview(1, true, UNTIL - 10)], "c1"),
      page([rawReview(1, true, UNTIL - 10)], "c1"),
    ],
    () => behavior.methods.recent.execute(recentArgs(), context),
  );
  assertEquals(calls.length, 2);
  const data = getWrittenResources()[0].data as Record<string, unknown>;
  assertEquals(data.count, 1);
  assertEquals(data.stopReason, "cursorRepeat");
  assertEquals(data.truncated, false);
});

Deno.test("recent reports truncation at the page limit", async () => {
  const { context, getWrittenResources, getLogs } = testContext();
  const { calls } = await withMockedFetch(
    (req) => {
      const cursor = String(inputOf(req.url).cursor);
      const n = cursor === "*" ? 0 : Number(cursor.slice(1));
      return page([rawReview(n + 1, n % 2 === 0, UNTIL - n - 1)], `c${n + 1}`);
    },
    () =>
      behavior.methods.recent.execute(
        recentArgs({ maxPages: 3, perPage: 1 }),
        context,
      ),
  );
  assertEquals(calls.length, 3);
  const data = getWrittenResources()[0].data as Record<string, unknown>;
  assertEquals(data.count, 3);
  assertEquals(data.stopReason, "pageLimit");
  assertEquals(data.truncated, true);
  assert(
    getLogs().some((log) =>
      log.level === "warning" && log.message.includes("not exhausted")
    ),
  );
});

Deno.test("recent with no reviews in the window has a null share", async () => {
  const { context, getWrittenResources } = testContext();
  await withMockedFetch(
    [page([], undefined)],
    () => behavior.methods.recent.execute(recentArgs(), context),
  );
  const data = getWrittenResources()[0].data as Record<string, unknown>;
  assertEquals(data.count, 0);
  assertEquals(data.positiveShare, null);
  assertEquals(data.stopReason, "empty");
});

Deno.test("recent uses since over days and skips malformed reviews", async () => {
  const { context, getWrittenResources, getLogs } = testContext();
  const { calls } = await withMockedFetch(
    [
      page([
        { recommendationid: "9", language: "english" },
        rawReview(1, true, UNTIL - 10),
        rawReview(5, true, UNTIL + 10),
      ], "c1"),
      page([], "c2"),
    ],
    () =>
      behavior.methods.recent.execute(
        recentArgs({ since: UNTIL - 100, days: 1 }),
        context,
      ),
  );
  assertEquals(inputOf(calls[0].url).date_range_start, UNTIL - 100);
  const data = getWrittenResources()[0].data as Record<string, unknown>;
  assertEquals(data.since, UNTIL - 100);
  assertEquals(data.count, 1, "the malformed and the future review are out");
  assert(getLogs().some((log) => log.level === "warning"));
});

Deno.test("a 429 fails with the retry hint and writes nothing", async () => {
  const { context, getWrittenResources } = testContext();
  const error = await assertRejects(
    () =>
      withMockedFetch(
        [
          new Response("Too Many Requests", {
            status: 429,
            headers: { "Retry-After": "30" },
          }),
        ],
        () => behavior.methods.recent.execute(recentArgs(), context),
      ),
    SteamReviewsError,
  );
  assertEquals(error.status, 429);
  assertEquals(error.retryAfterSeconds, 30);
  assertStringIncludes(error.message, "retry after 30 seconds");
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("an error status names the status and eresult, never the key", async () => {
  const { context } = testContext({ key: KEY });
  const error = await assertRejects(
    () =>
      withMockedFetch(
        [
          new Response("<html>Forbidden</html>", {
            status: 403,
            statusText: "Forbidden",
            headers: { "x-eresult": "15" },
          }),
        ],
        () => behavior.methods.summary.execute(summaryArgs(), context),
      ),
    SteamReviewsError,
  );
  assertEquals(error.status, 403);
  assertStringIncludes(error.message, "eresult 15");
  assertStringIncludes(error.message, "not allowed for this app");
  assertFalse(error.message.includes(KEY));
});

Deno.test("a network failure is reported without the key", async () => {
  const { context } = testContext({ key: KEY });
  const error = await assertRejects(
    () =>
      withMockedFetch(
        (req) => {
          throw new TypeError(`error sending request for url (${req.url})`);
        },
        () => behavior.methods.summary.execute(summaryArgs(), context),
      ),
    SteamReviewsError,
  );
  assertStringIncludes(error.message, "request failed");
  assertStringIncludes(error.message, "[redacted]");
  assertFalse(error.message.includes(KEY));
});

Deno.test("an answer that is not JSON or has no response object fails", async () => {
  const { context } = testContext();
  await assertRejects(
    () =>
      withMockedFetch(
        [new Response("<html></html>", { status: 200 })],
        () => behavior.methods.summary.execute(summaryArgs(), context),
      ),
    SteamReviewsError,
    "not JSON",
  );
  await assertRejects(
    () =>
      withMockedFetch(
        [Response.json({ success: 1 })],
        () => behavior.methods.summary.execute(summaryArgs(), context),
      ),
    SteamReviewsError,
    "no response object",
  );
});

Deno.test("helpers: share, parsePage, normalizeReview, countReviews, redact", () => {
  assertEquals(share(1, 4), 0.25);
  assertEquals(share(0, 0), null);
  const parsed = parsePage({
    response: { reviews: [1, rawReview(1, true, 5)] },
  });
  assertEquals(parsed.reviews.length, 1, "non-object rows are dropped");
  assertEquals(parsed.score, undefined);
  assertEquals(
    normalizeReview(
      { ...rawReview(2, false, 5), recommendationid: 2 },
      false,
      false,
    )
      ?.recommendationId,
    "2",
  );
  assertEquals(
    normalizeReview({ recommendationid: "3", voted_up: "yes" }, false, false),
    undefined,
  );
  assertEquals(countReviews([]).positiveShare, null);
  assertEquals(redact("a k%2Fb k/b", "k/b"), "a [redacted] [redacted]");
  assertEquals(redact("text", undefined), "text");
});
