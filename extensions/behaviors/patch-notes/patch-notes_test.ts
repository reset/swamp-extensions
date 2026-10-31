/**
 * Unit tests for the patch-notes behavior. Every request goes through a mocked
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
  apiRoot,
  behavior,
  categoryOf,
  type Context,
  ForgeError,
  type GlobalArgs,
  markdownToBbcode,
  normalizePull,
  orderCategories,
  type Pull,
  renderMarkdown,
} from "./patch-notes.ts";
import source from "./patch-notes.ts" with { type: "text" };

const GITHUB: GlobalArgs = {
  forge: "github",
  owner: "example-studio",
  repo: "example-game",
  base: "main",
  labelPrefix: "patch:",
  keepAuthors: false,
};

const FORGEJO: GlobalArgs = {
  ...GITHUB,
  forge: "forgejo",
  apiUrl: "https://forge.example.com/api/v1/",
  token: "forge-token-for-tests",
};

function testContext(
  globalArgs: GlobalArgs,
  storedResources: Record<string, Record<string, unknown>> = {},
): {
  context: Context;
  getWrittenResources: ModelTestContextResult["getWrittenResources"];
  getWrittenFiles: ModelTestContextResult["getWrittenFiles"];
  getLogs: ModelTestContextResult["getLogs"];
} {
  const result = createModelTestContext({
    globalArgs: { ...globalArgs },
    storedResources,
  });
  const context = { ...result.context, globalArgs } as unknown as Context;
  return {
    context,
    getWrittenResources: result.getWrittenResources,
    getWrittenFiles: result.getWrittenFiles,
    getLogs: result.getLogs,
  };
}

function githubCommit(sha: string, date: string): Record<string, unknown> {
  return { sha, commit: { committer: { date } } };
}

function rawPull(
  number: number,
  mergedAt: string | null,
  labels: string[] = [],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    number,
    title: `Change ${number} `,
    labels: labels.map((name) => ({ id: number, name })),
    merged_at: mergedAt,
    updated_at: mergedAt ?? "2026-10-07T00:00:00Z",
    html_url: `https://forge.example.com/pulls/${number}`,
    merge_commit_sha: mergedAt === null ? null : `m${number}`,
    base: { ref: "main" },
    user: { login: `author-${number}` },
    body: "should not be kept",
    ...extra,
  };
}

const START = "2026-10-01T00:00:00Z";
const END = "2026-10-10T00:00:00Z";

/**
 * Answers GitHub's commit, compare and pulls routes. The compare lists the
 * merge commits of the pull requests numbered in `inRange`, and reports
 * `total` commits (all of them unless given).
 */
function githubRoutes(
  pages: Record<string, unknown>[][],
  inRange: number[] = [],
  total?: number,
) {
  return (req: Request): Response => {
    const url = new URL(req.url);
    if (url.pathname.includes("/compare/")) {
      return Response.json({
        total_commits: total ?? inRange.length,
        commits: inRange.map((n) => ({ sha: `m${n}` })),
      });
    }
    if (url.pathname.endsWith("/commits/v1.0.0")) {
      return Response.json(githubCommit("aaa", START));
    }
    if (url.pathname.endsWith("/commits/v1.1.0")) {
      return Response.json(githubCommit("bbb", END));
    }
    if (url.pathname.endsWith("/pulls")) {
      const page = Number(url.searchParams.get("page"));
      return Response.json(pages[page - 1] ?? []);
    }
    return Response.json({ message: "Not Found" }, { status: 404 });
  };
}

Deno.test("global arguments default github, main and the patch: prefix", () => {
  const parsed = behavior.globalArguments.parse({ owner: "o", repo: "r" });
  assertEquals(parsed.forge, "github");
  assertEquals(parsed.base, "main");
  assertEquals(parsed.labelPrefix, "patch:");
  assertFalse(parsed.keepAuthors);
  assertEquals(apiRoot(parsed), "https://api.github.com");
  assertFalse(
    behavior.globalArguments.safeParse({ owner: "o/../x", repo: "r" }).success,
  );
  assertFalse(
    behavior.globalArguments.safeParse({ owner: "o", repo: "r", token: "" })
      .success,
  );
});

Deno.test("forgejo needs an apiUrl", () => {
  const parsed = behavior.globalArguments.parse({
    forge: "forgejo",
    owner: "o",
    repo: "r",
  });
  try {
    apiRoot(parsed);
    throw new Error("expected a ForgeError");
  } catch (error) {
    assert(error instanceof ForgeError);
    assertStringIncludes(error.message, "apiUrl is required");
  }
});

Deno.test("the upgrade to 2026.10.31.1 keeps a drafter instance's arguments", () => {
  const upgrade = behavior.upgrades[behavior.upgrades.length - 1];
  assertEquals(upgrade.toVersion, behavior.version);
  const minimal = { owner: "example-studio", repo: "example-game" };
  const github = { ...minimal, forge: "github", base: "main" };
  const forgejo = {
    forge: "forgejo",
    apiUrl: "https://forge.example.com/api/v1",
    owner: "example-studio",
    repo: "example-game",
    base: "release",
    token: "${{ vault.get(default, forge-read-token) }}",
    labelPrefix: "notes:",
    keepAuthors: true,
  };
  for (const old of [minimal, github, forgejo]) {
    const written = structuredClone(old);
    const upgraded = upgrade.upgradeAttributes(old);
    assertEquals(upgraded, written);
    assertEquals(old, written);
    assert(behavior.globalArguments.safeParse(upgraded).success);
  }
});

Deno.test("the upgrade refuses arguments the drafter never took, naming the change", () => {
  const upgrade = behavior.upgrades[behavior.upgrades.length - 1];
  const announcer = {
    appId: 440,
    webhookUrl: "${{ vault.get(notifications, patch-notes-webhook) }}",
  };
  const error = (() => {
    try {
      upgrade.upgradeAttributes(announcer);
    } catch (thrown) {
      return thrown as Error;
    }
    throw new Error("expected the upgrade to throw");
  })();
  assertStringIncludes(
    error.message,
    "does not take (appId, webhookUrl) and no owner or repo",
  );
  assertStringIncludes(error.message, "no owner or repo");
  assertStringIncludes(error.message, "2026.10.22.1");
  assertStringIncludes(error.message, "@reset/steam-news");

  const stray = { owner: "o", repo: "r", appId: 440 };
  const strayError = (() => {
    try {
      upgrade.upgradeAttributes(stray);
    } catch (thrown) {
      return thrown as Error;
    }
    throw new Error("expected the upgrade to throw");
  })();
  assertStringIncludes(strayError.message, "does not take (appId).");
  assertFalse(strayError.message.includes("no owner"));

  const missingRepo = (() => {
    try {
      upgrade.upgradeAttributes({ owner: "o" });
    } catch (thrown) {
      return thrown as Error;
    }
    throw new Error("expected the upgrade to throw");
  })();
  assertStringIncludes(missingRepo.message, "no repo");
});

Deno.test("every argument's description is written where the registry reads it", () => {
  // swamp's registry reads argument descriptions from the source text: a field
  // that starts `name: z.<type>(` and carries `.describe("...")` with a string
  // literal. A field split as `name: z` then `.string()` on the next line is
  // left out of the registry's argument list.
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

Deno.test("resource times must be ISO date-times", () => {
  const bbcode = {
    createdAt: "2026-10-31T00:00:00.000Z",
    source: "argument",
    length: 0,
    bbcode: "",
  };
  assert(behavior.resources.bbcode.schema.safeParse(bbcode).success);
  assertFalse(
    behavior.resources.bbcode.schema.safeParse({
      ...bbcode,
      createdAt: "October 31",
    }).success,
  );
});

Deno.test("gather on github keeps merges in (start, end] and stops at start", async () => {
  const { context, getWrittenResources } = testContext(GITHUB);
  const page1 = [
    // Merged a second after the end commit's date, by the end commit itself.
    rawPull(9, "2026-10-10T00:00:01Z", ["patch:fix"]),
    rawPull(10, "2026-10-06T00:00:00Z"), // in the window, not in the range
    rawPull(8, "2026-10-09T00:00:00Z", ["patch:fix", "ui"]),
    rawPull(7, null, ["patch:fix"]), // closed unmerged
    rawPull(6, "2026-10-05T00:00:00Z", ["patch:new-content"]),
    rawPull(5, "2026-10-04T00:00:00Z", [], { base: { ref: "release" } }),
    rawPull(4, "2026-10-03T00:00:00Z"),
    ...Array.from({ length: 94 }, (_, i) => rawPull(100 + i, null)),
  ];
  const page2 = [
    // Merged a second after the start commit's date, by the start commit.
    rawPull(3, "2026-10-01T00:00:01Z", ["patch:fix"]),
    rawPull(2, "2026-09-20T00:00:00Z", ["patch:fix"]),
  ];
  const { calls } = await withMockedFetch(
    githubRoutes(
      [page1, page2, [rawPull(1, "2026-10-02T00:00:00Z")]],
      [4, 6, 8, 9, 77],
    ),
    () =>
      behavior.methods.gather.execute(
        { start: "v1.0.0", end: "v1.1.0", maxPages: 10 },
        context,
      ),
  );

  assertEquals(
    calls.length,
    5,
    "two refs, the compare and two pages; page 3 never read",
  );
  const compare = new URL(calls[2].url);
  assertEquals(
    compare.pathname,
    "/repos/example-studio/example-game/compare/aaa...bbb",
  );
  assertEquals(compare.searchParams.get("per_page"), "100");
  assertEquals(calls[0].headers["accept"], "application/vnd.github+json");
  assertEquals(calls[0].headers["x-github-api-version"], "2022-11-28");
  assertFalse("authorization" in calls[0].headers, "no token, no header");
  const pulls = new URL(calls[3].url);
  assertEquals(
    pulls.origin + pulls.pathname,
    "https://api.github.com/repos/example-studio/example-game/pulls",
  );
  assertEquals(pulls.searchParams.get("state"), "closed");
  assertEquals(pulls.searchParams.get("base"), "main");
  assertEquals(pulls.searchParams.get("sort"), "updated");
  assertEquals(pulls.searchParams.get("direction"), "desc");
  assertEquals(pulls.searchParams.get("per_page"), "100");

  const written = getWrittenResources();
  assertEquals(written.length, 1);
  const data = written[0].data as Record<string, unknown>;
  assertEquals(written[0].specName, "gather");
  assertEquals(data.count, 4);
  assertEquals(data.commits, 5);
  assertEquals(data.truncated, false);
  assertEquals(data.pagesFetched, 2);
  assertEquals(data.byCategory, { "new-content": 1, fix: 2, uncategorized: 1 });
  const kept = data.pulls as Pull[];
  assertEquals(
    kept.map((p) => p.number),
    [4, 6, 8, 9],
    "by ancestry, oldest merge first",
  );
  assertEquals(kept[0].mergeCommit, "m4");
  assertEquals(kept[2].title, "Change 8", "title trimmed");
  assertEquals(kept[2].labels, ["patch:fix", "ui"]);
  assertFalse("author" in kept[0], "authors are dropped by default");
  assertFalse("body" in kept[0]);
  assertEquals((data.start as Record<string, unknown>).sha, "aaa");
  assertEquals(
    (data.end as Record<string, unknown>).date,
    "2026-10-10T00:00:00.000Z",
  );
});

Deno.test("gather marks the result truncated when maxPages stops it", async () => {
  const { context, getWrittenResources, getLogs } = testContext(GITHUB);
  const full = Array.from(
    { length: 100 },
    (_, i) => rawPull(500 + i, "2026-10-08T00:00:00Z"),
  );
  await withMockedFetch(
    githubRoutes([full, full], full.map((row) => row.number as number)),
    () =>
      behavior.methods.gather.execute(
        { start: "v1.0.0", end: "v1.1.0", maxPages: 1 },
        context,
      ),
  );
  const data = getWrittenResources()[0].data as Record<string, unknown>;
  assertEquals(data.truncated, true);
  assertEquals(data.count, 100);
  assert(
    getLogs().some((log) =>
      log.level === "warning" && log.message.includes("raise maxPages")
    ),
  );
});

Deno.test("gather marks the result truncated when the compare is incomplete", async () => {
  const { context, getWrittenResources, getLogs } = testContext(GITHUB);
  await withMockedFetch(
    githubRoutes([[rawPull(4, "2026-10-03T00:00:00Z")]], [4], 300),
    () =>
      behavior.methods.gather.execute(
        { start: "v1.0.0", end: "v1.1.0", maxPages: 1 },
        context,
      ),
  );
  const data = getWrittenResources()[0].data as Record<string, unknown>;
  assertEquals(data.truncated, true);
  assertEquals(data.commits, 300);
  assert(
    getLogs().some((log) =>
      log.level === "warning" && log.message.includes("commits between")
    ),
  );
});

Deno.test("gather falls back to the merge time when no merge commit is reported", async () => {
  const { context, getWrittenResources } = testContext(GITHUB);
  await withMockedFetch(
    githubRoutes([[
      rawPull(4, "2026-10-03T00:00:00Z", [], { merge_commit_sha: null }),
      rawPull(5, "2026-10-11T00:00:00Z", [], { merge_commit_sha: null }),
    ]]),
    () =>
      behavior.methods.gather.execute(
        { start: "v1.0.0", end: "v1.1.0", maxPages: 1 },
        context,
      ),
  );
  const data = getWrittenResources()[0].data as Record<string, unknown>;
  assertEquals((data.pulls as Pull[]).map((p) => p.number), [4]);
  assertFalse("mergeCommit" in (data.pulls as Pull[])[0]);
});

Deno.test("gather on forgejo uses token auth, commits?sha and limit paging", async () => {
  const { context, getWrittenResources } = testContext({
    ...FORGEJO,
    keepAuthors: true,
  });
  const { calls } = await withMockedFetch(
    (req) => {
      const url = new URL(req.url);
      if (url.pathname.endsWith("/commits")) {
        const sha = url.searchParams.get("sha");
        return Response.json([
          githubCommit(
            sha === "v1.0.0" ? "aaa" : "ccc",
            sha === "v1.0.0" ? START : END,
          ),
        ]);
      }
      if (url.pathname.includes("/compare/")) {
        return Response.json({ total_commits: 1, commits: [{ sha: "m12" }] });
      }
      return Response.json([
        rawPull(12, "2026-10-06T00:00:00Z", ["patch:balance"]),
      ]);
    },
    () =>
      behavior.methods.gather.execute(
        { start: "v1.0.0", maxPages: 10 },
        context,
      ),
  );
  assertEquals(calls.length, 4);
  assertEquals(
    new URL(calls[2].url).pathname,
    "/api/v1/repos/example-studio/example-game/compare/aaa...ccc",
  );
  assertEquals(
    calls[0].headers["authorization"],
    "token forge-token-for-tests",
  );
  const commits = new URL(calls[0].url);
  assertEquals(
    commits.origin + commits.pathname,
    "https://forge.example.com/api/v1/repos/example-studio/example-game/commits",
  );
  assertEquals(commits.searchParams.get("limit"), "1");
  assertEquals(
    new URL(calls[1].url).searchParams.get("sha"),
    "main",
    "end defaults to the base branch",
  );
  const pulls = new URL(calls[3].url);
  assertEquals(pulls.searchParams.get("sort"), "recentupdate");
  assertEquals(pulls.searchParams.get("limit"), "50");
  const data = getWrittenResources()[0].data as Record<string, unknown>;
  assertEquals((data.pulls as Pull[])[0].author, "author-12");
  assertEquals(data.truncated, false, "a short page is the last page");
});

Deno.test("gather refuses an end older than start and writes nothing", async () => {
  const { context, getWrittenResources } = testContext(GITHUB);
  await assertRejects(
    () =>
      withMockedFetch(
        githubRoutes([]),
        () =>
          behavior.methods.gather.execute(
            { start: "v1.1.0", end: "v1.0.0", maxPages: 1 },
            context,
          ),
      ),
    ForgeError,
    "older than start",
  );
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("errors name the status, the hint and a spent rate limit", async () => {
  const { context, getWrittenResources } = testContext({
    ...GITHUB,
    token: "secret-token",
  });
  const { calls } = await withMockedFetch(
    () =>
      Response.json(
        { message: "API rate limit exceeded" },
        {
          status: 403,
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": "1790000000",
          },
        },
      ),
    () =>
      assertRejects(
        () =>
          behavior.methods.gather.execute(
            { start: "v1.0.0", maxPages: 1 },
            context,
          ),
        ForgeError,
        "403 API rate limit exceeded (the token lacks access, or the rate limit is spent) rate limit spent until 2026-09-21",
      ),
  );
  assertEquals(calls[0].headers["authorization"], "Bearer secret-token");
  assertEquals(getWrittenResources().length, 0);

  const notFound = testContext(GITHUB);
  await withMockedFetch(
    () => new Response("", { status: 404, statusText: "Not Found" }),
    () =>
      assertRejects(
        () =>
          behavior.methods.gather.execute(
            { start: "nope", maxPages: 1 },
            notFound.context,
          ),
        ForgeError,
        "404 Not Found (no such repository or ref",
      ),
  );
  const notJson = testContext(GITHUB);
  await withMockedFetch(
    () => new Response("<html>", { status: 200 }),
    () =>
      assertRejects(
        () =>
          behavior.methods.gather.execute(
            { start: "v1.0.0", maxPages: 1 },
            notJson.context,
          ),
        ForgeError,
        "answer was not JSON",
      ),
  );
  const noDate = testContext(GITHUB);
  await withMockedFetch(
    () => Response.json({ sha: "aaa", commit: {} }),
    () =>
      assertRejects(
        () =>
          behavior.methods.gather.execute(
            { start: "v1.0.0", maxPages: 1 },
            noDate.context,
          ),
        ForgeError,
        "no commit with a date",
      ),
  );
});

Deno.test("categoryOf, normalizePull and orderCategories handle odd input", () => {
  assertEquals(
    categoryOf(["ui", "patch:fix", "patch:balance"], "patch:"),
    "fix",
  );
  assertEquals(categoryOf(["patch:", "ui"], "patch:"), "uncategorized");
  assertEquals(categoryOf(["ui"], ""), "ui");
  assertEquals(normalizePull("x", "main", "patch:", false), undefined);
  assertEquals(
    normalizePull({ number: 1, merged_at: "not a date" }, "main", "", false),
    undefined,
  );
  const bare = normalizePull(
    { number: 2, merged_at: "2026-10-02T00:00:00Z", labels: "nope" },
    "main",
    "patch:",
    true,
  );
  assertEquals(bare?.labels, []);
  assertEquals(bare?.title, "");
  assertEquals(bare?.author, undefined);
  assertEquals(
    orderCategories(["uncategorized", "fix", "art", "balance", "fix"], [
      "balance",
      "missing",
    ]),
    ["balance", "art", "fix", "uncategorized"],
  );
});

const GATHERED = {
  fetchedAt: "2026-10-11T00:00:00.000Z",
  forge: "github",
  repository: "example-studio/example-game",
  base: "main",
  start: { ref: "v1.0.0", sha: "aaa", date: START },
  end: { ref: "v1.1.0", sha: "bbb", date: END },
  commits: 4,
  pagesFetched: 1,
  count: 4,
  truncated: false,
  byCategory: { fix: 2, internal: 1, "new-content": 1 },
  pulls: [
    {
      number: 4,
      title: "Fix the **save** crash",
      labels: ["patch:fix"],
      category: "fix",
      mergedAt: "2026-10-03T00:00:00.000Z",
      url: "u4",
    },
    {
      number: 5,
      title: "Bump CI image",
      labels: ["patch:internal"],
      category: "internal",
      mergedAt: "2026-10-04T00:00:00.000Z",
      url: "u5",
    },
    {
      number: 6,
      title: "Add the swamp biome",
      labels: ["patch:new-content"],
      category: "new-content",
      mergedAt: "2026-10-05T00:00:00.000Z",
      url: "u6",
    },
    {
      number: 3,
      title: "Fix [UI] overlap",
      labels: ["patch:fix"],
      category: "fix",
      mergedAt: "2026-10-02T00:00:00.000Z",
      url: "u3",
    },
  ],
};

Deno.test("draft groups by category in order, excludes and writes the notes file", async () => {
  const { context, getWrittenResources, getWrittenFiles } = testContext(
    GITHUB,
    { gather: GATHERED },
  );
  await behavior.methods.draft.execute(
    {
      title: "Update 1.1",
      order: ["new-content"],
      exclude: ["internal"],
      numbers: true,
    },
    context,
  );
  const expected = [
    "# Update 1.1",
    "",
    "## New content",
    "",
    "- Add the swamp biome (#6)",
    "",
    "## Fix",
    "",
    "- Fix [UI] overlap (#3)",
    "- Fix the **save** crash (#4)",
    "",
  ].join("\n");
  const resource = getWrittenResources()[0];
  assertEquals(resource.specName, "draft");
  const data = resource.data as Record<string, unknown>;
  assertEquals(data.markdown, expected);
  assertEquals(data.count, 3);
  assertEquals(data.excluded, 1);
  assertEquals(data.range, "v1.0.0..v1.1.0");
  assertEquals(data.categories, [
    { name: "new-content", heading: "New content", count: 1 },
    { name: "fix", heading: "Fix", count: 2 },
  ]);
  const files = getWrittenFiles();
  assertEquals(files.length, 1);
  assertEquals(files[0].specName, "notes");
  assertEquals(new TextDecoder().decode(files[0].content), expected);
});

Deno.test("draft without a gather fails before writing", async () => {
  const { context, getWrittenResources, getWrittenFiles } = testContext(GITHUB);
  await assertRejects(
    () =>
      behavior.methods.draft.execute(
        { title: "t", order: [], exclude: [], numbers: false },
        context,
      ),
    ForgeError,
    "run the gather method first",
  );
  assertEquals(getWrittenResources().length, 0);
  assertEquals(getWrittenFiles().length, 0);
});

Deno.test("renderMarkdown leaves numbers off when asked", () => {
  const { markdown } = renderMarkdown(GATHERED.pulls, {
    title: "T",
    order: [],
    exclude: [],
    numbers: false,
  });
  assertStringIncludes(markdown, "- Bump CI image\n");
  assertFalse(markdown.includes("(#"));
});

Deno.test("markdownToBbcode converts headings, lists, emphasis and links", () => {
  const markdown = [
    "# Update 1.1",
    "",
    "## Fixes",
    "- Fix the **save** crash",
    "- Fix *italic* and _also italic_ and ~~gone~~",
    "- See [the wiki](https://example.com/wiki) for `details`",
    "1. first",
    "2. second",
    "",
    "---",
    "#### Deep heading",
    "keep player_spawn_point as is",
  ].join("\n");
  assertEquals(
    markdownToBbcode(markdown),
    [
      "[h1]Update 1.1[/h1]",
      "",
      "[h2]Fixes[/h2]",
      "[list]",
      "[*]Fix the [b]save[/b] crash",
      "[*]Fix [i]italic[/i] and [i]also italic[/i] and [strike]gone[/strike]",
      "[*]See [url=https://example.com/wiki]the wiki[/url] for details",
      "[/list]",
      "[olist]",
      "[*]first",
      "[*]second",
      "[/olist]",
      "",
      "[hr][/hr]",
      "[h3]Deep heading[/h3]",
      "keep player_spawn_point as is",
      "",
    ].join("\n"),
  );
});

Deno.test("bbcode renders the latest draft, or a markdown argument", async () => {
  const fromDraft = testContext(GITHUB, {
    draft: {
      createdAt: "2026-10-11T00:00:00.000Z",
      repository: "example-studio/example-game",
      range: "v1.0.0..v1.1.0",
      title: "T",
      count: 1,
      excluded: 0,
      truncated: false,
      categories: [{ name: "fix", heading: "Fix", count: 1 }],
      markdown: "# T\n\n## Fix\n\n- One (#1)\n",
    },
  });
  await behavior.methods.bbcode.execute({}, fromDraft.context);
  const data = fromDraft.getWrittenResources()[0].data as Record<
    string,
    unknown
  >;
  assertEquals(data.source, "draft");
  assertEquals(
    data.bbcode,
    "[h1]T[/h1]\n\n[h2]Fix[/h2]\n\n[list]\n[*]One (#1)\n[/list]\n",
  );
  assertEquals(data.length, (data.bbcode as string).length);
  assertEquals(fromDraft.getWrittenFiles()[0].specName, "steam");

  const fromArg = testContext(GITHUB);
  await behavior.methods.bbcode.execute(
    { markdown: "**hi**" },
    fromArg.context,
  );
  const argData = fromArg.getWrittenResources()[0].data as Record<
    string,
    unknown
  >;
  assertEquals(argData.source, "argument");
  assertEquals(argData.bbcode, "[b]hi[/b]\n");

  const neither = testContext(GITHUB);
  await assertRejects(
    () => behavior.methods.bbcode.execute({}, neither.context),
    ForgeError,
    "run draft first",
  );
  assertEquals(neither.getWrittenResources().length, 0);
});
