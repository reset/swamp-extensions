/**
 * Unit tests for the itch.io behavior's API half (`games`, `latest` by game
 * id and `credentials`), and for what the whole behavior declares: its
 * methods and resources, the upgrade from either line that held the name, and
 * the argument descriptions the registry reads. Every test injects a fetch and
 * a clock, and the fixtures follow the sample responses in itch.io's
 * server-side API reference, so nothing here reaches itch.io.
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
  CREDENTIALS_URL,
  diffGames,
  type Fetcher,
  fetchGames,
  fetchLatest,
  type Game,
  GAMES_URL,
  type GamesRecord,
  type MethodContext,
  WHARF_LATEST_URL,
} from "./itch.ts";
import source from "./itch.ts" with { type: "text" };

/** A made-up key; the tests assert it never leaves the Authorization header. */
const API_KEY = "test-key-0000000000000000000000000000";
const NOW = new Date("2026-10-22T12:00:00.000Z");
const EARLIER = "2026-10-21T12:00:00.000Z";
const clock = (at: Date | string) => () => new Date(at).getTime();

/** The `/profile/games` sample response from itch.io's reference, one game. */
const X_MOON = {
  cover_url:
    "http://img.itch.io/aW1hZ2UvMy8xODM3LnBuZw==/315x250%23/y2uYQI.png",
  created_at: "2013-03-03T23:02:14Z",
  downloads_count: 109,
  id: 3,
  min_price: 0,
  traits: ["p_windows", "p_linux", "p_osx"],
  classification: "game",
  published: true,
  published_at: "2013-03-03T23:02:14Z",
  purchases_count: 4,
  short_text: "Humans have been colonizing planets. It's time to stop them!",
  title: "X-Moon",
  type: "default",
  url: "http://leafo.itch.io/x-moon",
  user: {
    id: 1,
    username: "leafo",
    display_name: "leafo",
    url: "http://leafo.itch.io",
    cover_url: "http://img.itch.io/avatar.png",
  },
  views_count: 2682,
  earnings: [{ currency: "USD", amount_formatted: "$50.47", amount: 5047 }],
};

/** A second game with the fields an unpublished page leaves out. */
const DRAFT = {
  id: 9,
  title: "Draft",
  classification: "game",
  type: "default",
  published: false,
  created_at: "2026-10-01T00:00:00Z",
};

/** X-Moon as the behavior records it. */
const X_MOON_RECORDED: Game = {
  id: 3,
  title: "X-Moon",
  published: true,
  publishedAt: "2013-03-03T23:02:14Z",
  minPrice: 0,
  viewsCount: 2682,
  downloadsCount: 109,
  purchasesCount: 4,
  earnings: [{ currency: "USD", amount: 5047 }],
};

/** X-Moon as 2026.10.22.x recorded it, with the fields no longer kept. */
const X_MOON_RECORDED_BEFORE = {
  ...X_MOON_RECORDED,
  url: "http://leafo.itch.io/x-moon",
  classification: "game",
  type: "default",
  createdAt: "2013-03-03T23:02:14Z",
};

/** A fetch that answers every request with one status and body, recording the requests. */
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

/** A fetch answering `/profile/games` with these games. */
function gamesFetch(games: unknown[]) {
  return fakeFetch(200, JSON.stringify({ games }));
}

/** A test context for an API-shaped instance and, optionally, stored records. */
function testContext(
  storedResources: Record<string, Record<string, unknown>> = {},
  globalArgs: Record<string, unknown> = { apiKey: API_KEY },
): {
  context: MethodContext;
  written: ReturnType<typeof createModelTestContext>["getWrittenResources"];
  logs: ReturnType<typeof createModelTestContext>["getLogs"];
} {
  const parsed = behavior.globalArguments.parse(globalArgs);
  const test = createModelTestContext({
    globalArgs: parsed,
    storedResources,
  });
  const context = {
    ...test.context,
    globalArgs: parsed,
  } as unknown as MethodContext;
  return { context, written: test.getWrittenResources, logs: test.getLogs };
}

/** The header the request sent under this name, ignoring case. */
function header(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name);
}

Deno.test("games sends the key as a Bearer header and never in the URL", async () => {
  const { fetcher, urls, inits } = gamesFetch([X_MOON]);
  const { context } = testContext();
  await behavior.methods.games.execute(
    { _fetch: fetcher, _now: clock(NOW) },
    context,
  );
  assertEquals(urls, [GAMES_URL]);
  assertEquals(inits[0]?.method, "GET");
  assertEquals(header(inits[0], "authorization"), `Bearer ${API_KEY}`);
  assertEquals(inits[0]?.redirect, "error");
  assertFalse(urls[0].includes(API_KEY));
  assert(inits[0]?.signal instanceof AbortSignal);
});

Deno.test("the key appears in no written record and no log", async () => {
  const { fetcher } = gamesFetch([X_MOON]);
  const { context, written, logs } = testContext();
  await behavior.methods.games.execute(
    { _fetch: fetcher, _now: clock(NOW) },
    context,
  );
  const credentials = fakeFetch(200, '{"type":"key"}');
  await behavior.methods.credentials.execute(
    { _fetch: credentials.fetcher, _now: clock(NOW) },
    context,
  );
  assertEquals(written().length, 2);
  assertFalse(JSON.stringify(written()).includes(API_KEY));
  assertFalse(JSON.stringify(logs()).includes(API_KEY));
});

Deno.test("the first games version records ids, titles, states and counts, and no changes", async () => {
  const { fetcher } = gamesFetch([DRAFT, X_MOON]);
  const { context, written } = testContext();
  await behavior.methods.games.execute(
    { _fetch: fetcher, _now: clock(NOW) },
    context,
  );
  const writes = written();
  assertEquals(writes.length, 1);
  assertEquals(writes[0].specName, "games");
  assertEquals(writes[0].name, "my-games");
  assertEquals(writes[0].data, {
    fetchedAt: NOW.toISOString(),
    games: [
      X_MOON_RECORDED,
      {
        id: 9,
        title: "Draft",
        published: false,
        publishedAt: null,
        minPrice: null,
        viewsCount: null,
        downloadsCount: null,
        purchasesCount: null,
        earnings: [],
      },
    ],
    changes: null,
  });
});

Deno.test("a game record keeps no page address, owner or cover", async () => {
  const { context, written } = testContext();
  await behavior.methods.games.execute(
    { _fetch: gamesFetch([X_MOON]).fetcher, _now: clock(NOW) },
    context,
  );
  const recorded = JSON.stringify(written()[0].data);
  for (const absent of ["leafo", "itch.io", "url", "user", "cover"]) {
    assertFalse(recorded.includes(absent), `${absent} was recorded`);
  }
});

Deno.test("a later games version reports added, removed and changed games", async () => {
  const previous: GamesRecord = {
    fetchedAt: EARLIER,
    games: [
      X_MOON_RECORDED,
      { ...X_MOON_RECORDED, id: 7, title: "Gone" },
    ],
    changes: null,
  };
  const { fetcher } = gamesFetch([
    {
      ...X_MOON,
      views_count: 2700,
      downloads_count: 112,
      earnings: [
        { currency: "USD", amount_formatted: "$55.47", amount: 5547 },
        { currency: "EUR", amount_formatted: "€1.00", amount: 100 },
      ],
    },
    { ...DRAFT, published: true, published_at: "2026-10-22T09:00:00Z" },
  ]);
  const { context, written } = testContext({ "my-games": { ...previous } });
  await behavior.methods.games.execute(
    { _fetch: fetcher, _now: clock(NOW) },
    context,
  );
  assertEquals(written()[0].data.changes, {
    since: EARLIER,
    added: [{ id: 9, title: "Draft" }],
    removed: [{ id: 7, title: "Gone" }],
    changed: [
      {
        id: 3,
        title: "X-Moon",
        fields: [
          { field: "viewsCount", from: 2682, to: 2700, delta: 18 },
          { field: "downloadsCount", from: 109, to: 112, delta: 3 },
          { field: "earnings.EUR", from: null, to: 100, delta: null },
          { field: "earnings.USD", from: 5047, to: 5547, delta: 500 },
        ],
      },
    ],
  });
});

Deno.test("a version recorded by 2026.10.22.x reads back and compares", async () => {
  const before = {
    fetchedAt: EARLIER,
    games: [X_MOON_RECORDED_BEFORE],
    changes: null,
  };
  const { context, written, logs } = testContext({ "my-games": before });
  await behavior.methods.games.execute(
    {
      _fetch: gamesFetch([{ ...X_MOON, purchases_count: 5 }]).fetcher,
      _now: clock(NOW),
    },
    context,
  );
  assertFalse(logs().some((log) => log.level === "warning"));
  assertEquals(written()[0].data.changes, {
    since: EARLIER,
    added: [],
    removed: [],
    changed: [{
      id: 3,
      title: "X-Moon",
      fields: [{ field: "purchasesCount", from: 4, to: 5, delta: 1 }],
    }],
  });
});

Deno.test("an unchanged game is not listed as changed", () => {
  const changes = diffGames(
    { fetchedAt: EARLIER, games: [X_MOON_RECORDED], changes: null },
    [X_MOON_RECORDED],
  );
  assertEquals(changes, {
    since: EARLIER,
    added: [],
    removed: [],
    changed: [],
  });
});

Deno.test("unpublishing a game is reported as a published change", () => {
  const changes = diffGames(
    { fetchedAt: EARLIER, games: [X_MOON_RECORDED], changes: null },
    [{ ...X_MOON_RECORDED, published: false }],
  );
  assertEquals(changes.changed[0].fields, [
    { field: "published", from: true, to: false, delta: null },
  ]);
});

Deno.test("running games twice compares with the version the first run wrote", async () => {
  const { context, written } = testContext();
  await behavior.methods.games.execute(
    { _fetch: gamesFetch([X_MOON]).fetcher, _now: clock(EARLIER) },
    context,
  );
  await behavior.methods.games.execute(
    {
      _fetch: gamesFetch([{ ...X_MOON, purchases_count: 5 }]).fetcher,
      _now: clock(NOW),
    },
    context,
  );
  const second = written()[1].data as unknown as GamesRecord;
  assertEquals(second.changes?.since, EARLIER);
  assertEquals(second.changes?.changed[0].fields, [
    { field: "purchasesCount", from: 4, to: 5, delta: 1 },
  ]);
});

Deno.test("a previous record in another shape is recorded over with a warning", async () => {
  const { fetcher } = gamesFetch([X_MOON]);
  const { context, written, logs } = testContext({
    "my-games": { unexpected: true },
  });
  await behavior.methods.games.execute(
    { _fetch: fetcher, _now: clock(NOW) },
    context,
  );
  assertEquals(written()[0].data.changes, null);
  assert(logs().some((log) => log.level === "warning"));
});

Deno.test("an errors array is reported with the status and a hint, writing nothing", async () => {
  const { fetcher } = fakeFetch(401, '{"errors":["invalid key"]}');
  const { context, written } = testContext();
  const error = await assertRejects(
    () => behavior.methods.games.execute({ _fetch: fetcher }, context),
    Error,
  );
  assertStringIncludes(error.message, "HTTP 401");
  assertStringIncludes(error.message, "invalid key");
  assertStringIncludes(error.message, "missing, invalid or revoked");
  assertFalse(error.message.includes(API_KEY));
  assertEquals(written().length, 0);
});

Deno.test("an errors array with HTTP 200 is still an error", async () => {
  const { fetcher } = fakeFetch(200, '{"errors":["invalid game"]}');
  await assertRejects(
    () => fetchLatest(fetcher, 3, "windows"),
    Error,
    "invalid game",
  );
});

Deno.test("a rate limit names HTTP 429 and Retry-After", async () => {
  const { fetcher } = fakeFetch(429, "Too Many Requests", {
    "retry-after": "30",
  });
  const error = await assertRejects(
    () => fetchGames(fetcher, API_KEY),
    Error,
  );
  assertStringIncludes(error.message, "HTTP 429");
  assertStringIncludes(error.message, "retry after 30 seconds");
});

Deno.test("a server error is reported as transient", async () => {
  const { fetcher } = fakeFetch(502, "<html>Bad Gateway</html>");
  const error = await assertRejects(
    () => fetchGames(fetcher, API_KEY),
    Error,
  );
  assertStringIncludes(error.message, "HTTP 502");
  assertStringIncludes(error.message, "transient");
});

Deno.test("a network failure is reported with its cause", async () => {
  const fetcher: Fetcher = () =>
    Promise.reject(new TypeError("connection refused"));
  const error = await assertRejects(
    () => fetchGames(fetcher, API_KEY),
    Error,
  );
  assertStringIncludes(error.message, "request failed: connection refused");
});

Deno.test("a body that is not JSON is reported with its status", async () => {
  const { fetcher } = fakeFetch(404, "<html>Not Found</html>");
  const error = await assertRejects(
    () => fetchGames(fetcher, API_KEY),
    Error,
  );
  assertStringIncludes(error.message, "HTTP 404, body is not JSON");
});

Deno.test("a games body not in the documented shape is rejected", async () => {
  for (
    const body of [
      "{}",
      "null",
      '{"games":{}}',
      '{"games":[{"title":"No id"}]}',
      '{"games":[{"id":3,"title":"X","views_count":"many"}]}',
    ]
  ) {
    const { fetcher } = fakeFetch(200, body);
    await assertRejects(() => fetchGames(fetcher, API_KEY), Error);
  }
});

Deno.test("a cancelled run aborts the request", async () => {
  const controller = new AbortController();
  let seen: AbortSignal | undefined;
  const fetcher: Fetcher = (_input, init) => {
    seen = init?.signal ?? undefined;
    controller.abort();
    return Promise.resolve(new Response('{"games":[]}'));
  };
  await fetchGames(fetcher, API_KEY, controller.signal);
  assertEquals(seen?.aborted, true);
});

Deno.test("latest by game id requests the documented URL and sends no key", async () => {
  const { fetcher, urls, inits } = fakeFetch(200, '{"latest":"1.2.3"}');
  const { context, written } = testContext();
  await behavior.methods.latest.execute(
    { gameId: 123, channel: "osx-final", _fetch: fetcher, _now: clock(NOW) },
    context,
  );
  assertEquals(urls, [
    `${WHARF_LATEST_URL}?game_id=123&channel_name=osx-final`,
  ]);
  assertEquals(header(inits[0], "authorization"), null);
  assertEquals(written()[0].specName, "channel");
  assertEquals(written()[0].name, "game-123-osx-final");
  assertEquals(written()[0].data, {
    gameId: 123,
    channel: "osx-final",
    latest: "1.2.3",
    checkedAt: NOW.toISOString(),
    previous: null,
    changed: false,
  });
});

Deno.test("latest by game id records a build without a user version as null", async () => {
  const { fetcher } = fakeFetch(200, "{}");
  const { context, written } = testContext();
  await behavior.methods.latest.execute(
    { gameId: 123, channel: "win32-beta", _fetch: fetcher, _now: clock(NOW) },
    context,
  );
  assertEquals(written()[0].data.latest, null);
});

Deno.test("latest by game id reports a new version against the previous one", async () => {
  const { context, written } = testContext({
    "game-123-osx-final": {
      gameId: 123,
      channel: "osx-final",
      latest: "105",
      checkedAt: EARLIER,
      previous: null,
      changed: false,
    },
  });
  await behavior.methods.latest.execute(
    {
      gameId: 123,
      channel: "osx-final",
      _fetch: fakeFetch(200, '{"latest":"106"}').fetcher,
      _now: clock(NOW),
    },
    context,
  );
  assertEquals(written()[0].data.previous, {
    latest: "105",
    checkedAt: EARLIER,
  });
  assertEquals(written()[0].data.changed, true);
  await behavior.methods.latest.execute(
    {
      gameId: 123,
      channel: "osx-final",
      _fetch: fakeFetch(200, '{"latest":"106"}').fetcher,
      _now: clock(NOW),
    },
    context,
  );
  assertEquals(written()[1].data.changed, false);
});

Deno.test("latest without a gameId needs the target, and writes nothing", async () => {
  const { context, written } = testContext();
  const { fetcher, urls } = fakeFetch(200, '{"latest":"1"}');
  await assertRejects(
    () =>
      behavior.methods.latest.execute(
        { channel: "windows", _fetch: fetcher },
        context,
      ),
    Error,
    "latest without a gameId needs the target global argument",
  );
  assertEquals(urls, []);
  assertEquals(written().length, 0);
});

Deno.test("credentials records type and scopes from the documented sample", async () => {
  const { fetcher, urls, inits } = fakeFetch(
    200,
    '{"type":"key","scopes":["profile:me","profile:games"]}',
  );
  const { context, written } = testContext();
  await behavior.methods.credentials.execute(
    { _fetch: fetcher, _now: clock(NOW) },
    context,
  );
  assertEquals(urls, [CREDENTIALS_URL]);
  assertEquals(header(inits[0], "authorization"), `Bearer ${API_KEY}`);
  assertEquals(inits[0]?.redirect, "error");
  assertEquals(written()[0].data, {
    type: "key",
    scopes: ["profile:me", "profile:games"],
    expiresAt: null,
    checkedAt: NOW.toISOString(),
  });
});

Deno.test("games and credentials need the key, and request nothing without it", async () => {
  const { context, written } = testContext({}, { target: "studio/game" });
  for (const method of ["games", "credentials"] as const) {
    const { fetcher, urls } = fakeFetch(200, '{"games":[],"type":"key"}');
    await assertRejects(
      () => behavior.methods[method].execute({ _fetch: fetcher }, context),
      Error,
      `${method} needs the apiKey global argument`,
    );
    assertEquals(urls, []);
  }
  assertEquals(written().length, 0);
});

Deno.test("push and status need the target, and run no butler without it", async () => {
  const { context, written } = testContext();
  let runs = 0;
  const runner = () => {
    runs++;
    return Promise.resolve({
      code: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
    });
  };
  await assertRejects(
    () =>
      behavior.methods.push.execute({
        directory: "build",
        channel: "windows-beta",
        ifChanged: false,
        dryRun: false,
        hidden: false,
        fixPermissions: false,
        ignore: [],
        timeoutSeconds: 60,
        _runner: runner,
      }, context),
    Error,
    "push needs the target global argument",
  );
  await assertRejects(
    () =>
      behavior.methods.status.execute({
        waitSeconds: 0,
        intervalSeconds: 15,
        timeoutSeconds: 60,
        _runner: runner,
      }, context),
    Error,
    "status needs the target global argument",
  );
  assertEquals(runs, 0);
  assertEquals(written().length, 0);
});

Deno.test("a method fails clearly without readResource", async () => {
  const { context } = testContext();
  const bare: MethodContext = { ...context };
  delete bare.readResource;
  await assertRejects(
    () =>
      behavior.methods.games.execute(
        { _fetch: gamesFetch([]).fetcher },
        bare,
      ),
    Error,
    "readResource",
  );
});

Deno.test("the method arguments and global arguments validate", () => {
  const globals = behavior.globalArguments;
  assert(globals.safeParse({ apiKey: "k" }).success);
  assert(!globals.safeParse({ apiKey: "" }).success);
  assert(globals.safeParse({}).success);
  const latestArgs = behavior.methods.latest.arguments;
  assert(latestArgs.safeParse({ gameId: 3, channel: "windows-beta" }).success);
  assert(latestArgs.safeParse({ channel: "windows-beta" }).success);
  assert(!latestArgs.safeParse({ gameId: 0, channel: "windows" }).success);
  assert(!latestArgs.safeParse({ gameId: 3, channel: "a b" }).success);
  assert(!latestArgs.safeParse({ gameId: 3, channel: "" }).success);
});

Deno.test("the API key is marked sensitive and asks for a vault expression", () => {
  const meta = behavior.globalArguments.shape.apiKey.meta();
  assertEquals(meta?.sensitive, true);
  assertStringIncludes(String(meta?.description), "vault.get");
});

Deno.test("written records conform to their resource schemas", async () => {
  const { context, written } = testContext();
  await behavior.methods.games.execute(
    { _fetch: gamesFetch([X_MOON, DRAFT]).fetcher, _now: clock(NOW) },
    context,
  );
  await behavior.methods.games.execute(
    { _fetch: gamesFetch([DRAFT]).fetcher, _now: clock(NOW) },
    context,
  );
  await behavior.methods.latest.execute(
    {
      gameId: 3,
      channel: "windows",
      _fetch: fakeFetch(200, '{"latest":"1"}').fetcher,
      _now: clock(NOW),
    },
    context,
  );
  await behavior.methods.credentials.execute(
    { _fetch: fakeFetch(200, '{"type":"key"}').fetcher, _now: clock(NOW) },
    context,
  );
  const writes = written();
  assertEquals(writes.length, 4);
  for (const write of writes) {
    const spec = behavior
      .resources[write.specName as keyof typeof behavior.resources];
    assert(
      spec.schema.strict().safeParse(write.data).success,
      `${write.specName} does not conform`,
    );
  }
});

Deno.test("resource times must be ISO date-times", () => {
  const credentials = {
    type: "key",
    scopes: null,
    expiresAt: null,
    checkedAt: NOW.toISOString(),
  };
  const schema = behavior.resources.credentials.schema;
  assert(schema.safeParse(credentials).success);
  assertFalse(
    schema.safeParse({ ...credentials, checkedAt: "October 22" }).success,
  );
  const latest = {
    target: "studio/game",
    channel: "windows",
    fetchedAt: "yesterday",
  };
  assertFalse(behavior.resources.latest.schema.safeParse(latest).success);
});

Deno.test("both lines' methods and resources are declared under distinct names", () => {
  assertEquals(Object.keys(behavior.methods).sort(), [
    "credentials",
    "games",
    "latest",
    "push",
    "status",
    "version",
  ]);
  assertEquals(Object.keys(behavior.resources).sort(), [
    "channel",
    "credentials",
    "games",
    "latest",
    "push",
    "status",
    "version",
  ]);
});

Deno.test("the upgrade to 2026.10.31.1 keeps either line's global arguments as written", () => {
  const upgrade = behavior.upgrades[behavior.upgrades.length - 1];
  assertEquals(upgrade.toVersion, behavior.version);
  const butlerLine = {
    target: "studio/game",
    butler: "butler",
    apiKey: "${{ vault.get(default, itch-api-key) }}",
  };
  const butlerLineFull = {
    ...butlerLine,
    butler: "/opt/butler/butler",
    identity: "/home/ci/.config/itch/second_creds",
  };
  const butlerLoggedIn = { target: "studio/game" };
  const apiLine = { apiKey: "${{ vault.get(default, itch-api-key) }}" };
  for (const old of [butlerLine, butlerLineFull, butlerLoggedIn, apiLine]) {
    const written = structuredClone(old);
    const upgraded = upgrade.upgradeAttributes(old);
    assertEquals(upgraded, written);
    assertEquals(old, written);
    const parsed = behavior.globalArguments.safeParse(upgraded);
    assert(parsed.success, JSON.stringify(old));
  }
});

Deno.test("every argument's description is written where the registry reads it", () => {
  // swamp's registry reads argument descriptions from the source text: a field
  // that starts `name: z.<type>(` and carries `.describe("...")` with a string
  // literal. `.meta({ description })` or a template literal leaves the
  // registry's description empty, and a field split as `name: z` then
  // `.string()` on the next line is left out of the registry's argument list.
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const schemas: { shape: Record<string, { description?: string }> }[] = [
    behavior.globalArguments,
    ...Object.values(behavior.methods).map((method) => method.arguments),
  ];
  const unread: string[] = [];
  let fields = 0;
  for (const schema of schemas) {
    for (const [name, field] of Object.entries(schema.shape)) {
      fields++;
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
  // 4 global, 10 push, 4 status and 2 latest arguments.
  assertEquals(fields, 20);
});
