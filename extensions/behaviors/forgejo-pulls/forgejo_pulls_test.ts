/**
 * Unit tests for the Forgejo pull request behavior. Every request goes to an
 * in-process fake forge served on 127.0.0.1, so the real transport (headers,
 * query, redirects, status codes) is exercised and nothing here touches a
 * network beyond loopback. The fake answers the routes the behavior calls the
 * way Forgejo's swagger documents them.
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
  asksOf,
  behavior,
  type Context,
  countAsks,
  ForgejoError,
  gateOf,
  type GlobalArgs,
  normalizeComment,
  normalizePull,
  normalizeStatus,
  repoOf,
} from "./forgejo_pulls.ts";

const TOKEN = "forge-token-for-tests";
const ACCESS_ID = "access-id-for-tests.access";
const ACCESS_SECRET = "access-secret-for-tests";
const OWNER = "studio";
const REPO = "game";
const MARKERS = { mergeMarker: "=merge=", rushMarker: "=rush=" };

const NET = Deno.permissions.querySync({ name: "net", host: "127.0.0.1" })
  .state === "granted";

// ---------------------------------------------------------------------------
// The fake forge
// ---------------------------------------------------------------------------

/** One request the fake forge received. */
interface Received {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  body: string;
}

function rawPull(
  number: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 5000 + number,
    number,
    title: `Change ${number}`,
    body: "Describes the change.",
    state: "open",
    draft: false,
    merged: false,
    mergeable: true,
    head: { ref: `feature/${number}`, sha: `a${number}`.padEnd(40, "0") },
    base: { ref: "main", sha: "b".repeat(40) },
    user: { login: "someone", email: "someone@example.com" },
    comments: 2,
    html_url: `https://forge.example.com/${OWNER}/${REPO}/pulls/${number}`,
    created_at: "2026-10-20T09:00:00+02:00",
    updated_at: "2026-10-21T09:00:00+02:00",
    closed_at: null,
    merged_at: null,
    merge_commit_sha: null,
    requested_reviewers: [{ login: "reviewer" }],
    ...extra,
  };
}

function rawStatus(
  id: number,
  context: string,
  status: string,
): Record<string, unknown> {
  return {
    id,
    context,
    status,
    description: `${context} says ${status}`,
    target_url: `https://ci.example.com/builds/${id}`,
    creator: { login: "bot", email: "bot@example.com" },
    created_at: "2026-10-21T09:10:00+02:00",
    updated_at: "2026-10-21T09:20:00+02:00",
  };
}

function rawComment(id: number, body: string): Record<string, unknown> {
  return {
    id,
    body,
    user: { login: "someone", email: "someone@example.com" },
    html_url:
      `https://forge.example.com/${OWNER}/${REPO}/pulls/7#issuecomment-${id}`,
    created_at: "2026-10-21T10:00:00+02:00",
    updated_at: "2026-10-21T10:00:00+02:00",
  };
}

/** An in-memory forge that answers the routes the behavior calls. */
class FakeForge {
  received: Received[] = [];
  pulls = new Map<number, Record<string, unknown>>();
  statuses = new Map<string, Record<string, unknown>[]>();
  comments = new Map<number, Record<string, unknown>[]>();
  nextCommentId = 900;
  /** Require the Cloudflare Access headers, redirecting without them. */
  requireAccess = false;
  /** Answers instead of the routes when it returns a Response. */
  override: (received: Received) => Response | undefined = () => undefined;

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const received: Received = {
      method: request.method,
      path: url.pathname,
      query: url.searchParams,
      headers: request.headers,
      body: await request.text(),
    };
    this.received.push(received);
    const overridden = this.override(received);
    if (overridden !== undefined) return overridden;
    if (
      this.requireAccess &&
      (request.headers.get("cf-access-client-id") !== ACCESS_ID ||
        request.headers.get("cf-access-client-secret") !== ACCESS_SECRET)
    ) {
      return new Response("", {
        status: 302,
        headers: {
          Location:
            "https://studio.cloudflareaccess.com/cdn-cgi/access/login/forge.example.com",
        },
      });
    }
    if (request.headers.get("authorization") !== `token ${TOKEN}`) {
      return Response.json({ message: "token is required" }, { status: 401 });
    }
    const prefix = `/api/v1/repos/${OWNER}/${REPO}/`;
    if (!url.pathname.startsWith(prefix)) {
      return Response.json({ message: "Not Found" }, { status: 404 });
    }
    const rest = url.pathname.slice(prefix.length).split("/");
    const page = Number(url.searchParams.get("page") ?? "1");
    const limit = Number(url.searchParams.get("limit") ?? "30");

    if (rest[0] === "pulls" && rest.length === 1) {
      const state = url.searchParams.get("state") ?? "open";
      const all = [...this.pulls.values()].filter((p) =>
        state === "all" || p.state === state
      );
      const rows = all.slice((page - 1) * limit, page * limit);
      return Response.json(rows, {
        headers: { "X-Total-Count": String(all.length) },
      });
    }
    if (rest[0] === "pulls" && rest.length === 2) {
      const pull = this.pulls.get(Number(rest[1]));
      return pull === undefined
        ? Response.json({ message: "Not Found" }, { status: 404 })
        : Response.json(pull);
    }
    if (rest[0] === "commits" && rest[2] === "status") {
      const all = this.statuses.get(rest[1]) ?? [];
      const rows = all.slice((page - 1) * limit, page * limit);
      const states = new Set(all.map((s) => s.status));
      const state = all.length === 0
        ? ""
        : states.has("failure") || states.has("error")
        ? "failure"
        : states.has("pending")
        ? "pending"
        : "success";
      return Response.json({
        state,
        sha: rest[1],
        total_count: all.length,
        statuses: rows,
        repository: { full_name: `${OWNER}/${REPO}` },
      });
    }
    if (rest[0] === "issues" && rest[2] === "comments") {
      const number = Number(rest[1]);
      if (!this.pulls.has(number)) {
        return Response.json({ message: "Not Found" }, { status: 404 });
      }
      const list = this.comments.get(number) ?? [];
      if (request.method === "GET") {
        return Response.json(list, {
          headers: { "X-Total-Count": String(list.length) },
        });
      }
      const body = JSON.parse(received.body).body;
      const comment = rawComment(this.nextCommentId++, body);
      this.comments.set(number, [...list, comment]);
      const pull = this.pulls.get(number)!;
      this.pulls.set(number, { ...pull, comments: list.length + 1 });
      return Response.json(comment, { status: 201 });
    }
    return Response.json({ message: "Not Found" }, { status: 404 });
  }
}

function serve(
  forge: FakeForge,
): { host: string; shutdown: () => Promise<void> } {
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (request) => forge.handle(request),
  );
  return {
    host: `http://127.0.0.1:${server.addr.port}`,
    shutdown: () => server.shutdown(),
  };
}

function testContext(
  host: string,
  overrides: Partial<GlobalArgs> = {},
): {
  context: Context;
  getWrittenResources: ModelTestContextResult["getWrittenResources"];
  getLogs: ModelTestContextResult["getLogs"];
} {
  const globalArgs: GlobalArgs = {
    host,
    token: TOKEN,
    owner: OWNER,
    repo: REPO,
    ...MARKERS,
    ...overrides,
  };
  const result = createModelTestContext({ globalArgs: { ...globalArgs } });
  const context: Context = { ...result.context, globalArgs };
  return {
    context,
    getWrittenResources: result.getWrittenResources,
    getLogs: result.getLogs,
  };
}

/** Runs a test against a fresh fake forge, when loopback is allowed. */
function forgeTest(
  name: string,
  fn: (forge: FakeForge, host: string) => Promise<void>,
): void {
  Deno.test({
    name: `${name} (needs --allow-net=127.0.0.1)`,
    ignore: !NET,
    fn: async () => {
      const forge = new FakeForge();
      const server = serve(forge);
      try {
        await fn(forge, server.host);
      } finally {
        await server.shutdown();
      }
    },
  });
}

function paths(forge: FakeForge): string[] {
  return forge.received.map((r) => `${r.method} ${r.path}`);
}

const SECRETS = [TOKEN, ACCESS_SECRET];

function assertNoSecret(value: unknown): void {
  const text = JSON.stringify(value);
  for (const secret of SECRETS) assertFalse(text.includes(secret));
}

// ---------------------------------------------------------------------------
// Schemas and pure functions
// ---------------------------------------------------------------------------

Deno.test("global arguments need host and token and default the markers", () => {
  const parsed = behavior.globalArguments.parse({
    host: "https://forge.example.com",
    token: "t",
  });
  assertEquals(parsed.mergeMarker, "=merge=");
  assertEquals(parsed.rushMarker, "=rush=");
  assertEquals(parsed.owner, undefined);
  assertFalse(behavior.globalArguments.safeParse({ token: "t" }).success);
  assertFalse(
    behavior.globalArguments.safeParse({ host: "forge", token: "t" }).success,
  );
  assertFalse(
    behavior.globalArguments.safeParse({
      host: "https://forge.example.com",
      token: "",
    }).success,
  );
});

Deno.test("statuses needs exactly one of number or sha", () => {
  const schema = behavior.methods.statuses.arguments;
  assertFalse(schema.safeParse({}).success);
  assertFalse(schema.safeParse({ number: 1, sha: "abc1234" }).success);
  assertFalse(schema.safeParse({ sha: "not-hex" }).success);
  assert(schema.safeParse({ number: 1 }).success);
  assertEquals(schema.parse({ sha: "ABC1234" }).required, []);
});

Deno.test("asksOf reads markers the way the merge bot does", () => {
  assertEquals(asksOf("=merge=", MARKERS), "merge");
  assertEquals(asksOf("  =merge= please", MARKERS), "merge");
  assertEquals(asksOf("Fixes it.\n\n=rush= prod is down", MARKERS), "rush");
  assertEquals(asksOf("=merge=\n=rush=", MARKERS), "rush");
  assertEquals(asksOf("Please =merge= this", MARKERS), "none");
  assertEquals(asksOf("- =merge=", MARKERS), "none");
  assertEquals(asksOf("> =merge=", MARKERS), "none");
  assertEquals(asksOf("`=merge=`", MARKERS), "none");
  assertEquals(asksOf("```\n=merge=\n```\nnot asked", MARKERS), "none");
  assertEquals(asksOf("~~~\n=rush=\n~~~\n=merge=", MARKERS), "merge");
  assertEquals(asksOf("", MARKERS), "none");
  assertEquals(
    asksOf("!land", { mergeMarker: "!land", rushMarker: "!land-now" }),
    "merge",
  );
});

Deno.test("gateOf and countAsks judge contexts and comments", () => {
  const statuses = [
    normalizeStatus(rawStatus(1, "buildq", "success")),
    normalizeStatus(rawStatus(2, "lint", "pending")),
  ];
  assertEquals(gateOf(statuses, []), {
    contexts: [],
    passed: true,
    unmet: [],
  });
  assertEquals(gateOf(statuses, ["buildq"]).passed, true);
  assertEquals(gateOf(statuses, ["buildq", "lint", "deploy"]), {
    contexts: ["buildq", "lint", "deploy"],
    passed: false,
    unmet: ["lint: pending", "deploy: missing"],
  });
  assertEquals(
    countAsks([
      normalizeComment(rawComment(1, "=merge="), MARKERS),
      normalizeComment(rawComment(2, "looks good"), MARKERS),
      normalizeComment(rawComment(3, "=rush="), MARKERS),
      normalizeComment(rawComment(4, "=merge= after lunch"), MARKERS),
    ]),
    { merge: 2, rush: 1 },
  );
});

Deno.test("normalizers keep the documented fields and refuse odd input", () => {
  const pull = normalizePull(rawPull(3, { body: "=merge=" }), MARKERS);
  assertEquals(pull.asks, "merge");
  assertEquals(pull.headRef, "feature/3");
  assertFalse("closedAt" in pull, "nulls are dropped");
  assertNoSecret(pull);
  assertFalse(JSON.stringify(pull).includes("someone"));
  assertEquals(
    normalizePull({ number: "4", head: null, base: 1 }, MARKERS),
    {
      number: 4,
      title: "",
      state: "unknown",
      draft: false,
      merged: false,
      headRef: "",
      headSha: "",
      baseRef: "",
      baseSha: "",
      createdAt: "",
      updatedAt: "",
      comments: 0,
      htmlUrl: "",
      asks: "none",
    },
  );
  assertRejectsSync(() => normalizePull([], MARKERS), "not an object");
  assertRejectsSync(() => normalizePull({ id: 1 }, MARKERS), "no number");

  const status = normalizeStatus({
    id: 9,
    context: "buildq",
    state: "success",
    description: "x".repeat(300),
  });
  assertEquals(status.state, "success", "state is read when status is absent");
  assertEquals(status.description?.length, 200);
  assertRejectsSync(() => normalizeStatus({ context: "x" }), "no id");

  assertEquals(normalizeComment({ id: 1 }, MARKERS), {
    id: 1,
    createdAt: "",
    updatedAt: "",
    asks: "none",
  });
  assertRejectsSync(
    () => normalizeComment({ body: "=merge=" }, MARKERS),
    "no id",
  );
});

function assertRejectsSync(fn: () => unknown, includes: string): void {
  let message = "";
  try {
    fn();
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assertStringIncludes(message, includes);
}

Deno.test("repoOf falls back to the globals and refuses a missing repository", () => {
  const globals: GlobalArgs = {
    host: "https://forge.example.com",
    token: "t",
    ...MARKERS,
  };
  assertEquals(repoOf({ owner: "a", repo: "b" }, globals), {
    owner: "a",
    repo: "b",
  });
  assertEquals(repoOf({ repo: "b" }, { ...globals, owner: "g" }), {
    owner: "g",
    repo: "b",
  });
  assertRejectsSync(
    () => repoOf({ owner: "a" }, globals),
    "needs a repository",
  );
});

// ---------------------------------------------------------------------------
// Over the fake forge
// ---------------------------------------------------------------------------

forgeTest(
  "pulls sends the token and Access headers, pages until a short page",
  async (forge, host) => {
    forge.requireAccess = true;
    for (let n = 1; n <= 53; n++) {
      forge.pulls.set(n, rawPull(n, n === 2 ? { state: "closed" } : {}));
    }
    const { context, getWrittenResources, getLogs } = testContext(host, {
      accessClientId: ACCESS_ID,
      accessClientSecret: ACCESS_SECRET,
    });
    const result = await behavior.methods.pulls.execute(
      { state: "open", page: 1, pages: 3 },
      context,
    );

    assertEquals(paths(forge), [
      `GET /api/v1/repos/${OWNER}/${REPO}/pulls`,
      `GET /api/v1/repos/${OWNER}/${REPO}/pulls`,
    ], "a short second page ends the loop");
    const first = forge.received[0];
    assertEquals(first.headers.get("authorization"), `token ${TOKEN}`);
    assertEquals(first.headers.get("cf-access-client-id"), ACCESS_ID);
    assertEquals(first.headers.get("cf-access-client-secret"), ACCESS_SECRET);
    assertEquals(first.headers.get("accept"), "application/json");
    assertEquals(first.query.get("state"), "open");
    assertEquals(first.query.get("page"), "1");
    assertEquals(first.query.get("limit"), "50");
    assertEquals(forge.received[1].query.get("page"), "2");

    const written = getWrittenResources();
    assertEquals(result.dataHandles.length, 1);
    assertEquals(written.map((w) => [w.specName, w.name]), [
      ["pulls", `pulls-${OWNER}-${REPO}`],
    ]);
    const data = behavior.resources.pulls.schema.parse(written[0].data);
    assertEquals(data.count, 52);
    assertEquals(data.pagesFetched, 2);
    assertEquals(data.truncated, false);
    assertEquals(data.state, "open");
    assertEquals(data.pulls[0].number, 1);
    assertEquals(data.pulls[0].mergeable, true);
    assertEquals(data.pulls[0].headSha, "a1".padEnd(40, "0"));
    const serialized = JSON.stringify(data);
    assertFalse(serialized.includes("Describes the change"), "no body");
    assertFalse(serialized.includes("someone"), "no login or email");
    assertFalse(serialized.includes("reviewer"), "no reviewers");
    assertNoSecret(getLogs());
  },
);

forgeTest(
  "pulls marks a full last page truncated and honours X-Total-Count",
  async (forge, host) => {
    for (let n = 1; n <= 50; n++) forge.pulls.set(n, rawPull(n));
    const exact = testContext(host);
    await behavior.methods.pulls.execute(
      { state: "all", page: 1, pages: 1 },
      exact.context,
    );
    assertEquals(
      exact.getWrittenResources()[0].data.truncated,
      false,
      "50 rows of 50 counted: nothing beyond",
    );

    forge.pulls.set(51, rawPull(51));
    const more = testContext(host);
    await behavior.methods.pulls.execute(
      { state: "all", page: 1, pages: 1 },
      more.context,
    );
    assertEquals(more.getWrittenResources()[0].data.truncated, true);

    forge.override = (received) =>
      received.path.endsWith("/pulls")
        ? Response.json([...forge.pulls.values()].slice(0, 50))
        : undefined;
    const uncounted = testContext(host);
    await behavior.methods.pulls.execute(
      { state: "all", page: 1, pages: 1 },
      uncounted.context,
    );
    assertEquals(
      uncounted.getWrittenResources()[0].data.truncated,
      true,
      "a full page with no count may have more",
    );
  },
);

forgeTest(
  "a refused answer throws with its status and hint and writes nothing",
  async (forge, host) => {
    const { context, getWrittenResources, getLogs } = testContext(host, {
      token: "wrong",
    });
    const error = await assertRejects(
      () =>
        behavior.methods.pulls.execute(
          { state: "open", page: 1, pages: 1 },
          context,
        ),
      ForgejoError,
    );
    assertEquals(error.status, 401);
    assertStringIncludes(
      error.message,
      "GET /api/v1/repos/studio/game/pulls: 401",
    );
    assertStringIncludes(error.message, "token is required");
    assertStringIncludes(error.message, "missing or invalid");
    assertEquals(getWrittenResources().length, 0);
    assertNoSecret(getLogs());
    assertEquals(forge.received.length, 1);
  },
);

forgeTest(
  "a redirect from an access proxy names the missing Access headers",
  async (forge, host) => {
    forge.requireAccess = true;
    const { context, getWrittenResources } = testContext(host);
    const error = await assertRejects(
      () => behavior.methods.pull.execute({ number: 1 }, context),
      ForgejoError,
    );
    assertEquals(error.status, 302);
    assertStringIncludes(error.message, "studio.cloudflareaccess.com");
    assertStringIncludes(error.message, "accessClientId");
    assertEquals(getWrittenResources().length, 0);
  },
);

forgeTest(
  "half an Access pair is refused before any request",
  async (forge, host) => {
    const { context, getWrittenResources } = testContext(host, {
      accessClientId: ACCESS_ID,
    });
    await assertRejects(
      () => behavior.methods.pull.execute({ number: 1 }, context),
      Error,
      "set both or neither",
    );
    assertEquals(forge.received.length, 0);
    assertEquals(getWrittenResources().length, 0);
  },
);

forgeTest(
  "errors map 404, 429, 500 and non-JSON answers",
  async (forge, host) => {
    const run = (args: { number: number }) => {
      const { context } = testContext(host);
      return assertRejects(
        () => behavior.methods.pull.execute(args, context),
        ForgejoError,
      );
    };
    const missing = await run({ number: 404 });
    assertEquals(missing.status, 404);
    assertStringIncludes(missing.message, "Not Found");
    assertStringIncludes(missing.message, "cannot see the repository");

    forge.override = () =>
      new Response("slow down", {
        status: 429,
        headers: { "Retry-After": "17" },
      });
    const limited = await run({ number: 1 });
    assertEquals(limited.status, 429);
    assertEquals(limited.retryAfterSeconds, 17);
    assertStringIncludes(limited.message, "retry after 17 seconds");

    forge.override = () => new Response("", { status: 500 });
    const broken = await run({ number: 1 });
    assertEquals(broken.status, 500);
    assertStringIncludes(broken.message, "500 Internal Server Error");

    forge.override = () => new Response("<html>", { status: 200 });
    const html = await run({ number: 1 });
    assertStringIncludes(html.message, "not JSON");
  },
);

forgeTest(
  "a missing repository is refused before any request",
  async (forge, host) => {
    const { context } = testContext(host, {
      owner: undefined,
      repo: undefined,
    });
    await assertRejects(
      () => behavior.methods.pull.execute({ number: 1 }, context),
      Error,
      "needs a repository",
    );
    assertEquals(forge.received.length, 0);
  },
);

forgeTest(
  "pull reads one pull request, with the ask its body carries",
  async (forge, host) => {
    forge.pulls.set(
      7,
      rawPull(7, { body: "Fixes it.\n\n=merge=", draft: true }),
    );
    const { context, getWrittenResources } = testContext(host, {
      owner: "other",
      repo: "place",
    });
    const result = await behavior.methods.pull.execute(
      { owner: OWNER, repo: REPO, number: 7 },
      context,
    );
    assertEquals(paths(forge), [`GET /api/v1/repos/${OWNER}/${REPO}/pulls/7`]);
    const written = getWrittenResources();
    assertEquals(written[0].specName, "pull");
    assertEquals(written[0].name, `pull-${OWNER}-${REPO}-7`);
    assertEquals(result.dataHandles.map((h) => h.name), [written[0].name]);
    const data = behavior.resources.pull.schema.parse(written[0].data);
    assertEquals(data.owner, OWNER);
    assertEquals(data.repo, REPO);
    assertEquals(data.host, host);
    assertEquals(data.asks, "merge");
    assertEquals(data.draft, true);
    assertEquals(data.comments, 2);
    assertFalse(JSON.stringify(data).includes("Fixes it"));
  },
);

forgeTest(
  "statuses by number reads the head commit and judges the required contexts",
  async (forge, host) => {
    const sha = "a7".padEnd(40, "0");
    forge.pulls.set(7, rawPull(7));
    forge.statuses.set(sha, [
      rawStatus(1, "buildq", "success"),
      rawStatus(2, "lint", "failure"),
    ]);
    const { context, getWrittenResources } = testContext(host);
    await behavior.methods.statuses.execute(
      { number: 7, required: ["buildq", "lint", "sign"] },
      context,
    );
    assertEquals(paths(forge), [
      `GET /api/v1/repos/${OWNER}/${REPO}/pulls/7`,
      `GET /api/v1/repos/${OWNER}/${REPO}/commits/${sha}/status`,
    ]);
    assertEquals(forge.received[1].query.get("limit"), "50");
    const written = getWrittenResources();
    assertEquals(written[0].name, `statuses-${OWNER}-${REPO}-7`);
    const data = behavior.resources.statuses.schema.parse(written[0].data);
    assertEquals(data.number, 7);
    assertEquals(data.sha, sha);
    assertEquals(data.state, "failure");
    assertEquals(data.count, 2);
    assertEquals(data.truncated, false);
    assertEquals(data.required, {
      contexts: ["buildq", "lint", "sign"],
      passed: false,
      unmet: ["lint: failure", "sign: missing"],
    });
    assertEquals(data.statuses[0], {
      id: 1,
      context: "buildq",
      state: "success",
      description: "buildq says success",
      targetUrl: "https://ci.example.com/builds/1",
      createdAt: "2026-10-21T09:10:00+02:00",
      updatedAt: "2026-10-21T09:20:00+02:00",
    });
    assertFalse(JSON.stringify(data).includes("bot@"), "no creator");
  },
);

forgeTest(
  "statuses by sha pages through many contexts and passes a met gate",
  async (forge, host) => {
    const sha = "c".repeat(40);
    forge.statuses.set(
      sha,
      Array.from(
        { length: 120 },
        (_, i) => rawStatus(i + 1, `check-${i + 1}`, "success"),
      ),
    );
    const { context, getWrittenResources } = testContext(host);
    await behavior.methods.statuses.execute(
      { sha, required: ["check-1", "check-120"] },
      context,
    );
    assertEquals(
      forge.received.map((r) => r.query.get("page")),
      ["1", "2", "3"],
      "120 rows of 50 per page need three pages",
    );
    const data = behavior.resources.statuses.schema.parse(
      getWrittenResources()[0].data,
    );
    assertEquals(
      getWrittenResources()[0].name,
      `statuses-${OWNER}-${REPO}-${sha}`,
    );
    assertFalse("number" in data);
    assertEquals(data.count, 120);
    assertEquals(data.truncated, false);
    assertEquals(data.state, "success");
    assertEquals(data.required.passed, true);
  },
);

forgeTest(
  "statuses with none reported writes state none and an unmet gate",
  async (forge, host) => {
    const sha = "d".repeat(40);
    const { context, getWrittenResources } = testContext(host);
    await behavior.methods.statuses.execute(
      { sha, required: ["buildq"] },
      context,
    );
    const data = behavior.resources.statuses.schema.parse(
      getWrittenResources()[0].data,
    );
    assertEquals(data.state, "none");
    assertEquals(data.count, 0);
    assertEquals(data.required.unmet, ["buildq: missing"]);

    forge.override = () => Response.json(null);
    const nulled = testContext(host);
    await behavior.methods.statuses.execute(
      { sha, required: [] },
      nulled.context,
    );
    const empty = behavior.resources.statuses.schema.parse(
      nulled.getWrittenResources()[0].data,
    );
    assertEquals(
      empty.state,
      "none",
      "an older forge answers null for no statuses",
    );
    assertEquals(empty.required.passed, true);
  },
);

forgeTest("statuses marks a capped read truncated", async (forge, host) => {
  const sha = "e".repeat(40);
  forge.statuses.set(
    sha,
    Array.from(
      { length: 501 },
      (_, i) => rawStatus(i + 1, `check-${i + 1}`, "success"),
    ),
  );
  const { context, getWrittenResources } = testContext(host);
  await behavior.methods.statuses.execute({ sha, required: [] }, context);
  assertEquals(forge.received.length, 10, "ten pages at most");
  const data = behavior.resources.statuses.schema.parse(
    getWrittenResources()[0].data,
  );
  assertEquals(data.count, 500);
  assertEquals(data.truncated, true);
});

forgeTest(
  "comments keeps ids, timestamps and asks, never text or people",
  async (forge, host) => {
    forge.pulls.set(7, rawPull(7));
    forge.comments.set(7, [
      rawComment(1, "Looks fine to me, someone@example.com"),
      rawComment(2, "=merge="),
      rawComment(3, "=rush= prod is down"),
    ]);
    const { context, getWrittenResources } = testContext(host);
    await behavior.methods.comments.execute({ number: 7 }, context);
    assertEquals(paths(forge), [
      `GET /api/v1/repos/${OWNER}/${REPO}/issues/7/comments`,
    ]);
    const written = getWrittenResources();
    assertEquals(written[0].name, `comments-${OWNER}-${REPO}-7`);
    const data = behavior.resources.comments.schema.parse(written[0].data);
    assertEquals(data.count, 3);
    assertEquals(data.asks, { merge: 1, rush: 1 });
    assertEquals(data.comments.map((c) => [c.id, c.asks]), [
      [1, "none"],
      [2, "merge"],
      [3, "rush"],
    ]);
    const serialized = JSON.stringify(data);
    assertFalse(serialized.includes("Looks fine"));
    assertFalse(serialized.includes("example.com"));
    assertFalse(serialized.includes("someone"));
    assertFalse(serialized.includes("prod is down"));
  },
);

forgeTest(
  "comment posts the text and keeps its id, never the text",
  async (forge, host) => {
    forge.pulls.set(7, rawPull(7));
    const { context, getWrittenResources, getLogs } = testContext(host);
    const result = await behavior.methods.comment.execute(
      { number: 7, body: "Rebased onto main." },
      context,
    );
    assertEquals(paths(forge), [
      `POST /api/v1/repos/${OWNER}/${REPO}/issues/7/comments`,
    ]);
    assertEquals(
      forge.received[0].headers.get("content-type"),
      "application/json",
    );
    assertEquals(JSON.parse(forge.received[0].body), {
      body: "Rebased onto main.",
    });
    const written = getWrittenResources();
    assertEquals(written[0].specName, "comment");
    assertEquals(written[0].name, `comment-${OWNER}-${REPO}-900`);
    assertEquals(result.dataHandles.map((h) => h.name), [written[0].name]);
    const data = behavior.resources.comment.schema.parse(written[0].data);
    assertEquals(data.id, 900);
    assertEquals(data.number, 7);
    assertEquals(data.asks, "none");
    assertStringIncludes(data.htmlUrl, "#issuecomment-900");
    assertFalse(JSON.stringify(data).includes("Rebased"));
    assertFalse(JSON.stringify(getLogs()).includes("Rebased"), "not logged");
  },
);

forgeTest("a refused post leaves nothing written", async (forge, host) => {
  forge.pulls.set(7, rawPull(7));
  forge.override = (received) =>
    received.method === "POST"
      ? Response.json({ message: "user does not have write access" }, {
        status: 403,
      })
      : undefined;
  const { context, getWrittenResources } = testContext(host);
  const error = await assertRejects(
    () => behavior.methods.comment.execute({ number: 7, body: "x" }, context),
    ForgejoError,
  );
  assertEquals(error.status, 403);
  assertStringIncludes(error.message, "write access");
  assertStringIncludes(error.message, "lacks the scope");
  assertEquals(getWrittenResources().length, 0);

  forge.override = (received) =>
    received.method === "POST" ? Response.json({ body: "x" }) : undefined;
  await assertRejects(
    () => behavior.methods.comment.execute({ number: 7, body: "x" }, context),
    Error,
    "no comment id",
  );
  assertEquals(getWrittenResources().length, 0);
});

forgeTest(
  "ask-merge reads, posts the merge marker, re-reads and writes both",
  async (forge, host) => {
    forge.pulls.set(7, rawPull(7));
    forge.comments.set(7, [rawComment(1, "first"), rawComment(2, "second")]);
    const { context, getWrittenResources, getLogs } = testContext(host);
    const result = await behavior.methods["ask-merge"].execute(
      { number: 7 },
      context,
    );
    assertEquals(paths(forge), [
      `GET /api/v1/repos/${OWNER}/${REPO}/pulls/7`,
      `POST /api/v1/repos/${OWNER}/${REPO}/issues/7/comments`,
      `GET /api/v1/repos/${OWNER}/${REPO}/pulls/7`,
    ]);
    assertEquals(JSON.parse(forge.received[1].body), { body: "=merge=" });
    const written = getWrittenResources();
    assertEquals(written.map((w) => [w.specName, w.name]), [
      ["comment", `comment-${OWNER}-${REPO}-900`],
      ["pull", `pull-${OWNER}-${REPO}-7`],
    ]);
    assertEquals(result.dataHandles.length, 2);
    const comment = behavior.resources.comment.schema.parse(written[0].data);
    assertEquals(comment.asks, "merge");
    const pull = behavior.resources.pull.schema.parse(written[1].data);
    assertEquals(pull.comments, 3, "the re-read sees the new comment");
    assert(
      getLogs().some((log) =>
        JSON.stringify([log.message, log.args]).includes("Asking to merge")
      ),
    );
  },
);

forgeTest(
  "ask-rush posts the rush marker, with custom markers honoured",
  async (forge, host) => {
    forge.pulls.set(7, rawPull(7));
    const { context, getWrittenResources } = testContext(host, {
      mergeMarker: "!land",
      rushMarker: "!land-now",
    });
    await behavior.methods["ask-rush"].execute({ number: 7 }, context);
    assertEquals(JSON.parse(forge.received[1].body), { body: "!land-now" });
    const comment = behavior.resources.comment.schema.parse(
      getWrittenResources()[0].data,
    );
    assertEquals(comment.asks, "rush");
  },
);

forgeTest(
  "ask-merge refuses a merged or closed pull request without posting",
  async (forge, host) => {
    forge.pulls.set(
      8,
      rawPull(8, {
        state: "closed",
        merged: true,
        merged_at: "2026-10-21T11:00:00+02:00",
        merge_commit_sha: "f".repeat(40),
      }),
    );
    forge.pulls.set(9, rawPull(9, { state: "closed" }));
    const merged = testContext(host);
    await assertRejects(
      () =>
        behavior.methods["ask-merge"].execute({ number: 8 }, merged.context),
      Error,
      "already merged",
    );
    const closed = testContext(host);
    await assertRejects(
      () => behavior.methods["ask-rush"].execute({ number: 9 }, closed.context),
      Error,
      "is closed, not open",
    );
    assertEquals(
      paths(forge),
      [
        `GET /api/v1/repos/${OWNER}/${REPO}/pulls/8`,
        `GET /api/v1/repos/${OWNER}/${REPO}/pulls/9`,
      ],
      "nothing is posted",
    );
    assertEquals(merged.getWrittenResources().length, 0);
    assertEquals(closed.getWrittenResources().length, 0);
  },
);

forgeTest("a cancelled run aborts the request", async (forge, host) => {
  forge.pulls.set(7, rawPull(7));
  const controller = new AbortController();
  const { context, getWrittenResources } = testContext(host);
  controller.abort();
  await assertRejects(
    () =>
      behavior.methods.pull.execute(
        { number: 7 },
        { ...context, signal: controller.signal },
      ),
    Error,
  );
  assertEquals(getWrittenResources().length, 0);
});
