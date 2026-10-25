/**
 * Unit tests for the workq behavior. Every request goes to an in-process fake
 * workq behind Deno.serve on 127.0.0.1 that answers the documented shapes,
 * including the 409 refusals and request receipts: nothing here touches a
 * deployed workq. The server tests need `--allow-net=127.0.0.1` and are
 * skipped without it.
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
  type Context,
  type GlobalArgs,
  normalizeEvent,
  normalizeItemSummary,
  summarize,
  WorkqError,
} from "./workq.ts";
import source from "./workq.ts" with { type: "text" };

const CLIENT_ID = "0123456789abcdef0123456789abcdef.access";
const CLIENT_SECRET = "client-secret-for-tests-only";
const ORG = "acme";
const PROJECT = "rog";

const ALICE = { id: "p-alice", email: "alice@example.com", name: "Alice" };
const BOT = { id: "p-bot", email: "bot@example.com", name: "Automation" };
const LOGIN = "https://example.cloudflareaccess.com/cdn-cgi/access/login/x";

const STATUS_GROUPS: Record<string, string> = {
  Backlog: "backlog",
  Todo: "unstarted",
  "In Progress": "started",
  Done: "completed",
  Cancelled: "cancelled",
};

const NET = Deno.permissions.querySync({ name: "net", host: "127.0.0.1" })
  .state === "granted";

// ---------------------------------------------------------------------------
// Fixtures in the API's own shapes
// ---------------------------------------------------------------------------

type Raw = Record<string, unknown>;

function rawItem(number: number, overrides: Raw = {}): Raw {
  const status = (overrides.status as string | undefined) ?? "Todo";
  return {
    id: 1000 + number,
    key: `ROG-${number}`,
    org: ORG,
    project: PROJECT,
    number,
    type: "Task",
    status,
    statusGroup: STATUS_GROUPS[status],
    title: `Item ${number}`,
    priority: "medium",
    assignee: null,
    labels: [],
    dueDate: null,
    parent: null,
    rank: null,
    release: null,
    sprint: null,
    milestone: null,
    revision: 1,
    externalSource: null,
    externalId: null,
    createdBy: ALICE,
    createdAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-01T10:00:00.000Z",
    completedAt: null,
    body: `Secret body of ${number}: do not keep`,
    links: [],
    comments: 0,
    attachments: 0,
    ...overrides,
  };
}

function rawRelease(version: string, overrides: Raw = {}): Raw {
  return {
    id: `r-${version}`,
    version,
    tag: `v${version}`,
    kind: "release",
    shippedAt: "2026-10-10T12:00:00.000Z",
    notesUrl: null,
    builtWith: null,
    steps: [],
    items: 0,
    createdBy: BOT,
    createdAt: "2026-10-10T12:00:00.000Z",
    updatedAt: "2026-10-10T12:00:00.000Z",
    ...overrides,
  };
}

function rawSprint(number: number, overrides: Raw = {}): Raw {
  return {
    id: `s-${number}`,
    number,
    startsOn: "2026-10-01",
    endsOn: "2026-10-14",
    state: "past",
    goal: null,
    tag: null,
    notesUrl: null,
    planningUrl: null,
    items: 0,
    completed: 0,
    createdBy: ALICE,
    createdAt: "2026-09-30T09:00:00.000Z",
    updatedAt: "2026-09-30T09:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The fake workq
// ---------------------------------------------------------------------------

/** One request the fake received. */
interface Call {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
}

function json(body: unknown, status = 200, headers: HeadersInit = {}) {
  return Response.json(body, { status, headers });
}

function refuse(status: number, error: string, details?: Raw): Response {
  return json(details === undefined ? { error } : { error, details }, status);
}

/** An in-memory workq: the documented routes this behavior calls, in their documented shapes. */
class FakeWorkq {
  calls: Call[] = [];
  items = new Map<string, Raw>();
  events = new Map<string, Raw[]>();
  comments = new Map<string, Raw[]>();
  releases: Raw[] = [];
  sprints: Raw[] = [];
  receipts = new Map<string, { content: string; response: Response }>();
  /** Answers instead of the routes when it returns a response. */
  override: ((call: Call) => Response | undefined) | undefined;
  private nextNumber = 1;
  private nextEvent = 1;
  private nextComment = 1;

  seed(items: Raw[]): void {
    for (const item of items) {
      this.items.set(item.key as string, item);
      this.nextNumber = Math.max(this.nextNumber, (item.number as number) + 1);
    }
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const text = await request.text();
    const call: Call = {
      method: request.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: Object.fromEntries(request.headers),
      body: text === "" ? undefined : JSON.parse(text),
    };
    this.calls.push(call);
    const forced = this.override?.(call);
    if (forced !== undefined) return forced;

    // Access: no token is sent to sign in, an unlisted id is not a caller.
    const id = request.headers.get("cf-access-client-id");
    const secret = request.headers.get("cf-access-client-secret");
    if (id === null) {
      return new Response(null, { status: 302, headers: { Location: LOGIN } });
    }
    if (id !== CLIENT_ID) return refuse(403, "not a service caller");
    if (secret !== CLIENT_SECRET) return refuse(401, "no Access assertion");

    if (!url.pathname.startsWith("/api/v1/")) return refuse(404, "not found");
    const path = url.pathname.slice("/api/v1".length);
    const body = (call.body ?? {}) as Raw;
    let match: RegExpMatchArray | null;

    if (path === "/me") {
      return json({
        id: BOT.id,
        email: BOT.email,
        name: BOT.name,
        serviceAdmin: false,
        groups: ["sg-automation@example.com"],
        orgs: [{
          id: ORG,
          name: "Acme",
          createdAt: "2026-09-01T00:00:00.000Z",
          role: null,
        }],
        projects: this.projects(),
      });
    }
    if ((match = path.match(/^\/orgs\/([^/]+)\/projects$/))) {
      if (match[1] !== ORG) return refuse(404, "org not found");
      return json(this.projects());
    }
    if ((match = path.match(/^\/orgs\/([^/]+)\/projects\/([^/]+)\/items$/))) {
      if (match[1] !== ORG || !["rog", "wiki"].includes(match[2])) {
        return refuse(404, "project not found");
      }
      if (request.method === "POST") {
        return this.create(match[2], body);
      }
      return this.list(call.query);
    }
    if ((match = path.match(/^\/orgs\/([^/]+)\/items\/([^/]+)$/))) {
      const item = match[1] === ORG ? this.items.get(match[2]) : undefined;
      if (item === undefined) return refuse(404, "item not found");
      if (request.method === "PATCH") return this.change(item, body);
      return json(item);
    }
    if ((match = path.match(/^\/orgs\/([^/]+)\/items\/([^/]+)\/history$/))) {
      if (!this.items.has(match[2])) return refuse(404, "item not found");
      return json(this.events.get(match[2]) ?? []);
    }
    if ((match = path.match(/^\/orgs\/([^/]+)\/items\/([^/]+)\/comments$/))) {
      if (!this.items.has(match[2])) return refuse(404, "item not found");
      return this.comment(match[2], body);
    }
    if (
      (match = path.match(/^\/orgs\/([^/]+)\/projects\/([^/]+)\/releases$/))
    ) {
      return json(this.releases);
    }
    if (
      (match = path.match(
        /^\/orgs\/([^/]+)\/projects\/([^/]+)\/releases\/([^/]+)$/,
      ))
    ) {
      const version = match[3];
      const release = this.releases.find((r) => r.version === version);
      return release === undefined
        ? refuse(404, "release not found")
        : json(release);
    }
    if ((match = path.match(/^\/orgs\/([^/]+)\/projects\/([^/]+)\/sprints$/))) {
      return json(this.sprints);
    }
    return refuse(404, "not found");
  }

  private projects(): Raw[] {
    return [
      {
        id: "proj-rog",
        org: ORG,
        slug: "rog",
        keyPrefix: "ROG",
        name: "Rog",
        description: "",
        tracker: true,
        createdAt: "2026-09-01T00:00:00.000Z",
        role: "member",
      },
      {
        id: "proj-wiki",
        org: ORG,
        slug: "wiki",
        keyPrefix: "WIKI",
        name: "Wiki",
        description: "",
        tracker: false,
        createdAt: "2026-09-01T00:00:00.000Z",
        role: "member",
      },
    ];
  }

  private list(query: Record<string, string>): Response {
    let rows = [...this.items.values()];
    if (query.release !== undefined) {
      rows = rows.filter((r) =>
        query.release === "none"
          ? r.release === null
          : r.release === query.release
      );
    }
    if (query.group !== undefined) {
      rows = rows.filter((r) => r.statusGroup === query.group);
    }
    if (query.status !== undefined) {
      rows = rows.filter((r) => r.status === query.status);
    }
    rows.sort((a, b) => (b.number as number) - (a.number as number));
    const offset = Number(query.offset ?? 0);
    const limit = Number(query.limit ?? 50);
    return json(
      rows.slice(offset, offset + limit).map((row) => {
        const {
          body: _body,
          links: _links,
          comments: _c,
          attachments: _a,
          ...summary
        } = row;
        return summary;
      }),
    );
  }

  private create(project: string, body: Raw): Response {
    if (project === "wiki") {
      return refuse(409, "the project has no tracker", { code: "no-tracker" });
    }
    if (body.externalSource !== undefined) {
      const existing = [...this.items.values()].find((r) =>
        r.externalSource === body.externalSource &&
        r.externalId === body.externalId
      );
      if (existing !== undefined) return json(existing, 200);
    }
    const number = this.nextNumber++;
    const item = rawItem(number, {
      title: body.title,
      body: body.body ?? "",
      type: body.type ?? "Task",
      status: body.status ?? "Todo",
      priority: body.priority ?? "medium",
      labels: body.labels ?? [],
      assignee: body.assignee === undefined ? null : ALICE,
      externalSource: body.externalSource ?? null,
      externalId: body.externalId ?? null,
      createdBy: BOT,
    });
    this.items.set(item.key as string, item);
    this.record(item, "created", null, null);
    return json(item, 201);
  }

  private change(item: Raw, body: Raw): Response {
    const requestId = body.requestId as string | undefined;
    const content = JSON.stringify(body);
    if (requestId !== undefined) {
      const receipt = this.receipts.get(requestId);
      if (receipt !== undefined) {
        if (receipt.content !== content) {
          return refuse(409, "the request id was used for other content", {
            code: "request",
          });
        }
        const replay = receipt.response.clone();
        replay.headers.set("Replayed", "true");
        return replay;
      }
    }
    const response = this.apply(item, body);
    if (requestId !== undefined) {
      this.receipts.set(requestId, { content, response: response.clone() });
    }
    return response;
  }

  private apply(item: Raw, body: Raw): Response {
    if (body.revision !== item.revision) {
      return refuse(409, "the item has moved on", {
        code: "revision",
        current: item,
      });
    }
    const status = body.status as string | undefined;
    if (status !== undefined && item.status === "Done" && status !== "Done") {
      return refuse(409, `the workflow does not move Done to ${status}`, {
        code: "transition",
      });
    }
    const revision = (item.revision as number) + 1;
    for (
      const field of [
        "title",
        "body",
        "type",
        "status",
        "priority",
        "labels",
        "dueDate",
        "parent",
        "release",
        "sprint",
        "milestone",
      ]
    ) {
      if (body[field] !== undefined && body[field] !== item[field]) {
        this.record(item, field, item[field], body[field], revision);
        item[field] = body[field];
      }
    }
    if (body.assignee !== undefined) {
      const assignee = body.assignee === null ? null : ALICE;
      this.record(item, "assignee", item.assignee, assignee, revision);
      item.assignee = assignee;
    }
    if (status !== undefined) {
      item.statusGroup = STATUS_GROUPS[status];
      item.completedAt = item.statusGroup === "completed"
        ? "2026-10-20T08:00:00.000Z"
        : null;
    }
    item.revision = revision;
    item.updatedAt = "2026-10-20T08:00:00.000Z";
    return json(item);
  }

  private comment(key: string, body: Raw): Response {
    const list = this.comments.get(key) ?? [];
    if (body.externalSource !== undefined) {
      const existing = list.find((c) =>
        c.externalSource === body.externalSource &&
        c.externalId === body.externalId
      );
      if (existing !== undefined) return json(existing, 200);
    }
    const comment = {
      id: this.nextComment++,
      author: BOT,
      body: body.body,
      externalSource: body.externalSource ?? null,
      externalId: body.externalId ?? null,
      createdAt: "2026-10-20T08:30:00.000Z",
      editedAt: null,
    };
    list.push(comment);
    this.comments.set(key, list);
    const item = this.items.get(key)!;
    item.comments = list.length;
    return json(comment, 201);
  }

  record(
    item: Raw,
    field: string,
    old: unknown,
    next: unknown,
    revision = item.revision as number,
  ): void {
    const key = item.key as string;
    const list = this.events.get(key) ?? [];
    list.push({
      id: this.nextEvent++,
      at: "2026-10-20T08:00:00.000Z",
      actor: { id: BOT.id, name: BOT.name },
      revision,
      field,
      old,
      new: next,
      externalSource: null,
      externalId: null,
    });
    this.events.set(key, list);
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  fake: FakeWorkq;
  host: string;
  context: Context;
  getWrittenResources: ModelTestContextResult["getWrittenResources"];
  getLogs: ModelTestContextResult["getLogs"];
  /** A fresh context against the same fake with other global arguments. */
  withGlobals(overrides: Partial<GlobalArgs>): {
    context: Context;
    getWrittenResources: ModelTestContextResult["getWrittenResources"];
    getLogs: ModelTestContextResult["getLogs"];
  };
}

function testContext(globalArgs: GlobalArgs) {
  const result = createModelTestContext({ globalArgs: { ...globalArgs } });
  const context: Context = { ...result.context, globalArgs };
  return {
    context,
    getWrittenResources: result.getWrittenResources,
    getLogs: result.getLogs,
  };
}

/** Runs a test with a fake workq listening on loopback, shut down afterwards. */
function serverTest(
  name: string,
  fn: (harness: Harness) => Promise<void>,
  seed: (fake: FakeWorkq) => void = () => {},
): void {
  Deno.test({
    name: `${name} (needs --allow-net=127.0.0.1)`,
    ignore: !NET,
    fn: async () => {
      const fake = new FakeWorkq();
      seed(fake);
      const server = Deno.serve(
        { hostname: "127.0.0.1", port: 0, onListen() {} },
        (request) => fake.handle(request),
      );
      const host = `http://127.0.0.1:${server.addr.port}`;
      try {
        const globals: GlobalArgs = {
          host,
          clientId: CLIENT_ID,
          clientSecret: CLIENT_SECRET,
          org: ORG,
          project: PROJECT,
        };
        const base = testContext(globals);
        await fn({
          fake,
          host,
          ...base,
          withGlobals: (overrides) => testContext({ ...globals, ...overrides }),
        });
        for (const log of base.getLogs()) {
          assertFalse(
            JSON.stringify([log.message, log.args]).includes(CLIENT_SECRET),
            "the secret never reaches a log",
          );
        }
      } finally {
        await server.shutdown();
      }
    },
  });
}

function assertNoPersonalData(data: unknown): void {
  const serialized = JSON.stringify(data);
  assertFalse(serialized.includes("@example.com"), "no email is kept");
  assertFalse(serialized.includes("Secret body"), "no item body is kept");
}

function seedBacklog(fake: FakeWorkq): void {
  fake.seed([
    rawItem(1, { status: "Done", release: "1.8.2", priority: "high" }),
    rawItem(2, { status: "In Progress", release: "1.8.2", assignee: ALICE }),
    rawItem(3, { status: "Todo", release: "1.8.2", labels: ["audio"] }),
    rawItem(4, { status: "Backlog", rank: 2.5 }),
    rawItem(5, { status: "Cancelled", release: "1.8.1", completedAt: null }),
  ]);
  fake.releases = [
    rawRelease("1.8.2", {
      items: 3,
      notesUrl: "https://notes.example.com/1.8.2",
      builtWith: { project: "tech", version: "0.9.0", restricted: false },
      steps: [{ name: "wiki", done: true }, { name: "deploy", done: false }],
    }),
    rawRelease("1.8.1", {
      kind: "hotfix",
      items: 1,
      builtWith: { restricted: true },
    }),
  ];
  fake.sprints = [
    rawSprint(1, { items: 2, completed: 2 }),
    rawSprint(2, {
      startsOn: "2026-10-15",
      endsOn: "2026-10-28",
      state: "current",
      goal: "Ship 1.8.2",
      tag: "sprint-2",
      items: 3,
      completed: 1,
    }),
  ];
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

Deno.test("global arguments need a host URL and both token halves", () => {
  const schema = behavior.globalArguments;
  assert(
    schema.safeParse({
      host: "https://workq.example.com",
      clientId: "id",
      clientSecret: "secret",
    }).success,
  );
  assertFalse(schema.safeParse({ clientId: "id", clientSecret: "s" }).success);
  assertFalse(
    schema.safeParse({
      host: "workq.example.com",
      clientId: "id",
      clientSecret: "s",
    })
      .success,
  );
  assertFalse(
    schema.safeParse({ host: "https://workq.example.com", clientId: "id" })
      .success,
  );
  assertFalse(
    schema.safeParse({
      host: "https://workq.example.com",
      clientId: "id",
      clientSecret: "s",
      org: "Not A Slug",
    }).success,
  );
});

Deno.test("method arguments refuse what the API would refuse", () => {
  const item = behavior.methods.item.arguments;
  assert(item.safeParse({ key: "ROG-12" }).success);
  assertFalse(item.safeParse({ key: "rog-12" }).success);
  assertFalse(item.safeParse({}).success);

  const change = behavior.methods.change_item.arguments;
  assertFalse(
    change.safeParse({ key: "ROG-12", revision: 3 }).success,
    "a change needs a field",
  );
  assert(change.safeParse({ key: "ROG-12", status: "Done" }).success);
  assert(change.safeParse({ key: "ROG-12", assignee: null }).success);
  assertFalse(
    change.safeParse({ key: "ROG-12", status: "Done", requestId: "not-a-uuid" })
      .success,
  );

  const create = behavior.methods.create_item.arguments;
  assertFalse(
    create.safeParse({ title: "x", externalSource: "jira" }).success,
    "externalSource and externalId go together",
  );
  assert(
    create.safeParse({ title: "x", externalSource: "jira", externalId: "J-1" })
      .success,
  );

  const list = behavior.methods.list_items.arguments;
  const parsed = list.parse({});
  assertEquals([parsed.limit, parsed.offset, parsed.pages], [50, 0, 1]);
  assert(list.safeParse({ sprint: "current" }).success);
  assert(list.safeParse({ sprint: "12" }).success);
  assert(list.safeParse({ sprint: 12 }).success, "YAML inputs send a number");
  assertFalse(list.safeParse({ sprint: "next" }).success);
  assertFalse(list.safeParse({ sprint: 0 }).success);
  assertFalse(list.safeParse({ limit: 201 }).success);
});

// ---------------------------------------------------------------------------
// Methods, against the fake
// ---------------------------------------------------------------------------

serverTest(
  "me sends the service token and keeps ids and roles only",
  async (h) => {
    await behavior.methods.me.execute({}, h.context);
    assertEquals(h.fake.calls.length, 1);
    assertEquals(h.fake.calls[0].method, "GET");
    assertEquals(h.fake.calls[0].path, "/api/v1/me");
    assertEquals(h.fake.calls[0].headers["cf-access-client-id"], CLIENT_ID);
    assertEquals(
      h.fake.calls[0].headers["cf-access-client-secret"],
      CLIENT_SECRET,
    );
    assertEquals(h.fake.calls[0].headers["accept"], "application/json");

    const written = h.getWrittenResources();
    assertEquals(written.map((w) => [w.specName, w.name]), [["me", "me"]]);
    const me = written[0].data;
    assertEquals(me.id, BOT.id);
    assertEquals(me.name, BOT.name);
    assertEquals(me.serviceAdmin, false);
    assertEquals(me.groups, 1, "groups are counted, not kept");
    assertEquals(me.orgs, [{ id: ORG, name: "Acme" }]);
    const projects = me.projects as Record<string, unknown>[];
    assertEquals(projects.length, 2);
    assertEquals(projects[0].keyPrefix, "ROG");
    assertEquals(projects[0].role, "member");
    assertEquals(me.host, h.host);
    assertNoPersonalData(me);
  },
);

serverTest(
  "projects lists an org and names the instance after it",
  async (h) => {
    await behavior.methods.projects.execute({}, h.context);
    assertEquals(h.fake.calls[0].path, `/api/v1/orgs/${ORG}/projects`);
    const written = h.getWrittenResources();
    assertEquals(written[0].specName, "projects");
    assertEquals(written[0].name, `projects-${ORG}`);
    assertEquals(written[0].data.count, 2);
    assertEquals(written[0].data.org, ORG);

    const other = h.withGlobals({ org: undefined });
    await assertRejects(
      () => behavior.methods.projects.execute({}, other.context),
      Error,
      "needs an org",
    );
    assertEquals(other.getWrittenResources().length, 0);
    assertEquals(h.fake.calls.length, 1, "no request without an org");
  },
);

serverTest(
  "list_items sends the filters, pages until a short page and summarizes",
  async (h) => {
    const args = behavior.methods.list_items.arguments.parse({
      release: "1.8.2",
      assignee: "alice@example.com",
      unranked: false,
      limit: 2,
      pages: 3,
    });
    await behavior.methods.list_items.execute(args, h.context);

    assertEquals(h.fake.calls.length, 2, "a short second page ends the loop");
    const first = h.fake.calls[0];
    assertEquals(first.path, `/api/v1/orgs/${ORG}/projects/${PROJECT}/items`);
    assertEquals(first.query, {
      release: "1.8.2",
      assignee: "alice@example.com",
      limit: "2",
      offset: "0",
    });
    assertEquals(h.fake.calls[1].query.offset, "2");

    const written = h.getWrittenResources();
    assertEquals(written.map((w) => [w.specName, w.name]), [
      ["items", `items-${ORG}-${PROJECT}`],
      ["summary", `summary-${ORG}-${PROJECT}`],
    ]);
    const items = written[0].data;
    assertEquals(items.count, 3);
    assertEquals(items.truncated, false);
    assertEquals(items.pagesFetched, 2);
    assertEquals(items.limit, 2);
    assertEquals(items.offset, 0);
    assertEquals(
      items.filters,
      { release: "1.8.2" },
      "the assignee filter is sent but not kept",
    );
    const rows = items.items as Record<string, unknown>[];
    assertEquals(rows.map((r) => r.key), ["ROG-3", "ROG-2", "ROG-1"]);
    assertEquals(rows[1].assigneeId, ALICE.id);
    assertFalse("assignee" in rows[1]);
    assertFalse("assigneeId" in rows[0], "nulls are dropped");
    assertEquals(rows[0].labels, ["audio"]);
    assertEquals(rows[2].statusGroup, "completed");
    assertEquals(rows[2].createdById, ALICE.id);
    assertNoPersonalData(items);

    const summary = written[1].data;
    assertEquals(summary.count, 3);
    assertEquals(summary.byGroup, {
      backlog: 0,
      unstarted: 1,
      started: 1,
      completed: 1,
      cancelled: 0,
    });
    assertEquals(summary.byStatus, { Done: 1, "In Progress": 1, Todo: 1 });
    assertEquals(summary.byPriority, { high: 1, medium: 2 });
    assertEquals(summary.unfinished, 2);
    assertEquals(summary.unassigned, 2);
    assertEquals(summary.filters, { release: "1.8.2" });
  },
  seedBacklog,
);

serverTest(
  "list_items marks a full last page truncated and passes every filter through",
  async (h) => {
    const args = behavior.methods.list_items.arguments.parse({
      view: "board",
      status: "Todo",
      group: "unstarted",
      type: "Bug",
      label: "audio",
      parent: "ROG-1",
      unranked: true,
      sprint: "current",
      milestone: "none",
      query: "crash",
      order: "rank",
      limit: 1,
    });
    await behavior.methods.list_items.execute(args, h.context);
    assertEquals(h.fake.calls[0].query, {
      view: "board",
      status: "Todo",
      group: "unstarted",
      type: "Bug",
      label: "audio",
      parent: "ROG-1",
      unranked: "true",
      sprint: "current",
      milestone: "none",
      q: "crash",
      order: "rank",
      limit: "1",
      offset: "0",
    });
    const items = h.getWrittenResources()[0].data;
    assertEquals(items.count, 1);
    assertEquals(items.truncated, true, "one row at limit one: more may exist");
    assertEquals((items.filters as Record<string, unknown>).query, "crash");
    assertEquals((items.filters as Record<string, unknown>).unranked, true);
  },
  seedBacklog,
);

serverTest(
  "list_items needs a project and writes nothing without one",
  async (h) => {
    const bare = h.withGlobals({ project: undefined });
    const args = behavior.methods.list_items.arguments.parse({});
    await assertRejects(
      () => behavior.methods.list_items.execute(args, bare.context),
      Error,
      "needs an org and a project",
    );
    assertEquals(bare.getWrittenResources().length, 0);
    assertEquals(h.fake.calls.length, 0);
  },
);

serverTest(
  "item keeps counts and links, never the body, and a missing key writes nothing",
  async (h) => {
    await behavior.methods.item.execute({ key: "ROG-2" }, h.context);
    assertEquals(h.fake.calls[0].path, `/api/v1/orgs/${ORG}/items/ROG-2`);
    const written = h.getWrittenResources();
    assertEquals(written[0].specName, "item");
    assertEquals(written[0].name, "item-ROG-2");
    const item = written[0].data;
    assertEquals(item.comments, 2);
    assertEquals(item.attachments, 1);
    assertEquals(item.links, [
      {
        id: "l-1",
        kind: "blocks",
        direction: "out",
        key: "ROG-3",
        status: "Todo",
        restricted: false,
      },
      {
        id: "l-2",
        kind: "relates",
        direction: "in",
        key: "SEC-9",
        restricted: true,
      },
    ]);
    assertEquals(item.host, h.host);
    assertFalse("body" in item);
    assertNoPersonalData(item);

    const missing = h.withGlobals({});
    const error = await assertRejects(
      () => behavior.methods.item.execute({ key: "ROG-99" }, missing.context),
      WorkqError,
    );
    assertEquals(error.status, 404);
    assertStringIncludes(
      error.message,
      "GET /api/v1/orgs/acme/items/ROG-99: 404",
    );
    assertStringIncludes(error.message, "item not found");
    assertStringIncludes(error.message, "not visible to the caller's grants");
    assertEquals(missing.getWrittenResources().length, 0);
  },
  (fake) => {
    fake.seed([
      rawItem(2, {
        status: "In Progress",
        assignee: ALICE,
        comments: 2,
        attachments: 1,
        links: [
          {
            id: "l-1",
            kind: "blocks",
            direction: "out",
            item: {
              key: "ROG-3",
              title: "Item 3",
              status: "Todo",
              restricted: false,
            },
          },
          {
            id: "l-2",
            kind: "relates",
            direction: "in",
            item: { key: "SEC-9", restricted: true },
          },
        ],
      }),
    ]);
  },
);

serverTest(
  "create_item posts only what was given, and the same external pair creates nothing twice",
  async (h) => {
    const args = behavior.methods.create_item.arguments.parse({
      title: "Audio device lost on alt-tab",
      body: "Steps: ...",
      type: "Bug",
      labels: ["audio"],
      externalSource: "crashq",
      externalId: "crash-42",
    });
    await behavior.methods.create_item.execute(args, h.context);
    const call = h.fake.calls[0];
    assertEquals(call.method, "POST");
    assertEquals(call.path, `/api/v1/orgs/${ORG}/projects/${PROJECT}/items`);
    assertEquals(call.headers["content-type"], "application/json");
    assertEquals(call.body, {
      title: "Audio device lost on alt-tab",
      body: "Steps: ...",
      type: "Bug",
      labels: ["audio"],
      externalSource: "crashq",
      externalId: "crash-42",
    });
    const written = h.getWrittenResources();
    assertEquals(written[0].name, "item-ROG-1");
    assertEquals(written[0].data.type, "Bug");
    assertEquals(written[0].data.createdById, BOT.id);
    assertFalse("body" in written[0].data);
    assert(h.getLogs().some((log) => log.message.startsWith("Created item")));

    const again = h.withGlobals({});
    await behavior.methods.create_item.execute(args, again.context);
    assertEquals(h.fake.items.size, 1, "nothing was created twice");
    assertEquals(again.getWrittenResources()[0].name, "item-ROG-1");
    assert(
      again.getLogs().some((log) => log.message.includes("already existed")),
    );
  },
);

serverTest(
  "create_item surfaces a 409 with its code and writes nothing",
  async (h) => {
    const args = behavior.methods.create_item.arguments.parse({
      project: "wiki",
      title: "A page, not an item",
    });
    const error = await assertRejects(
      () => behavior.methods.create_item.execute(args, h.context),
      WorkqError,
    );
    assertEquals(error.status, 409);
    assertEquals(error.code, "no-tracker");
    assertStringIncludes(
      error.message,
      "the project has no tracker (code no-tracker)",
    );
    assertEquals(h.getWrittenResources().length, 0);
  },
);

serverTest(
  "change_item reads the revision first, sends a request id and writes the answer",
  async (h) => {
    const args = behavior.methods.change_item.arguments.parse({
      key: "ROG-3",
      status: "In Progress",
      labels: ["audio", "crash"],
      assignee: null,
    });
    await behavior.methods.change_item.execute(args, h.context);
    assertEquals(
      h.fake.calls.map((c) => `${c.method} ${c.path}`),
      [
        `GET /api/v1/orgs/${ORG}/items/ROG-3`,
        `PATCH /api/v1/orgs/${ORG}/items/ROG-3`,
      ],
    );
    const body = h.fake.calls[1].body as Record<string, unknown>;
    assertEquals(body.revision, 1);
    assertEquals(body.status, "In Progress");
    assertEquals(body.labels, ["audio", "crash"]);
    assertEquals(body.assignee, null, "null clears the assignee and is sent");
    assertFalse("title" in body, "fields left out are not sent");
    assert(/^[0-9a-f-]{36}$/.test(String(body.requestId)), "a UUID was made");

    const written = h.getWrittenResources();
    assertEquals(written[0].name, "item-ROG-3");
    assertEquals(written[0].data.revision, 2);
    assertEquals(written[0].data.status, "In Progress");
    assertEquals(written[0].data.statusGroup, "started");
    assertEquals(written[0].data.labels, ["audio", "crash"]);
  },
  seedBacklog,
);

serverTest(
  "change_item at a given revision skips the read, and a stale one fails with the item as it stands",
  async (h) => {
    const fresh = behavior.methods.change_item.arguments.parse({
      key: "ROG-3",
      revision: 1,
      title: "Renamed",
    });
    await behavior.methods.change_item.execute(fresh, h.context);
    assertEquals(h.fake.calls.length, 1, "no read when the revision is given");
    assertEquals(h.getWrittenResources()[0].data.revision, 2);

    const stale = h.withGlobals({});
    const error = await assertRejects(
      () => behavior.methods.change_item.execute(fresh, stale.context),
      WorkqError,
    );
    assertEquals(error.status, 409);
    assertEquals(error.code, "revision");
    assertEquals(error.current?.revision, 2);
    assertEquals(error.current?.title, "Renamed");
    assertStringIncludes(
      error.message,
      "PATCH /api/v1/orgs/acme/items/ROG-3: 409 stale revision, the item is at revision 2 (status Todo); read it again and retry",
    );
    assertEquals(stale.getWrittenResources().length, 0);
    assertFalse(
      JSON.stringify(error.current).includes("Secret body"),
      "the current item on the error carries no body either",
    );
  },
  seedBacklog,
);

serverTest("change_item surfaces a refused transition", async (h) => {
  const args = behavior.methods.change_item.arguments.parse({
    key: "ROG-1",
    status: "Todo",
  });
  const error = await assertRejects(
    () => behavior.methods.change_item.execute(args, h.context),
    WorkqError,
  );
  assertEquals(error.code, "transition");
  assertStringIncludes(
    error.message,
    "does not move Done to Todo (code transition)",
  );
  assertEquals(h.getWrittenResources().length, 0);
}, seedBacklog);

serverTest(
  "change_item resent with its request id is answered from the receipt, not written twice",
  async (h) => {
    const requestId = "6f1c2a0e-3b4d-4c5e-8f6a-7b8c9d0e1f2a";
    const args = behavior.methods.change_item.arguments.parse({
      key: "ROG-4",
      revision: 1,
      requestId,
      status: "Todo",
    });
    await behavior.methods.change_item.execute(args, h.context);
    assertEquals(h.fake.items.get("ROG-4")?.revision, 2);

    const resend = h.withGlobals({});
    await behavior.methods.change_item.execute(args, resend.context);
    assertEquals(
      h.fake.items.get("ROG-4")?.revision,
      2,
      "nothing was done twice",
    );
    assertEquals(resend.getWrittenResources()[0].data.revision, 2);
    assert(
      resend.getLogs().some((log) =>
        log.level === "warning" &&
        log.message.includes("answered from its receipt")
      ),
    );

    const other = h.withGlobals({});
    const error = await assertRejects(
      () =>
        behavior.methods.change_item.execute(
          { ...args, status: "In Progress" },
          other.context,
        ),
      WorkqError,
    );
    assertEquals(error.code, "request");
  },
  seedBacklog,
);

serverTest(
  "comment posts Markdown and keeps its length, never its text",
  async (h) => {
    const args = behavior.methods.comment.arguments.parse({
      key: "ROG-2",
      body: "Fixed in build 1234, please verify.",
    });
    await behavior.methods.comment.execute(args, h.context);
    const call = h.fake.calls[0];
    assertEquals(call.method, "POST");
    assertEquals(call.path, `/api/v1/orgs/${ORG}/items/ROG-2/comments`);
    assertEquals(call.body, { body: "Fixed in build 1234, please verify." });
    const written = h.getWrittenResources();
    assertEquals(written[0].specName, "comment");
    assertEquals(written[0].name, "comment-ROG-2-1");
    assertEquals(written[0].data.bodyLength, 35);
    assertEquals(written[0].data.authorId, BOT.id);
    assertEquals(written[0].data.key, "ROG-2");
    assertFalse(JSON.stringify(written[0].data).includes("Fixed in build"));
    assertNoPersonalData(written[0].data);

    const again = behavior.methods.comment.arguments.parse({
      key: "ROG-2",
      body: "Imported",
      externalSource: "jira",
      externalId: "c-1",
    });
    await behavior.methods.comment.execute(again, h.context);
    await behavior.methods.comment.execute(again, h.context);
    assertEquals(
      h.fake.comments.get("ROG-2")?.length,
      2,
      "the pair posted once",
    );
  },
  seedBacklog,
);

serverTest(
  "history keeps values for statuses and names, drops them for text and people",
  async (h) => {
    await behavior.methods.history.execute({ key: "ROG-3" }, h.context);
    assertEquals(
      h.fake.calls[0].path,
      `/api/v1/orgs/${ORG}/items/ROG-3/history`,
    );
    const written = h.getWrittenResources();
    assertEquals(written[0].specName, "history");
    assertEquals(written[0].name, "history-ROG-3");
    assertEquals(written[0].data.count, 4);
    assertEquals(written[0].data.revision, 3);
    assertEquals(written[0].data.key, "ROG-3");
    const events = written[0].data.events as Record<string, unknown>[];
    assertEquals(events[0], {
      id: 1,
      at: "2026-10-20T08:00:00.000Z",
      actorId: BOT.id,
      revision: 1,
      field: "created",
    });
    assertEquals(events[1], {
      id: 2,
      at: "2026-10-20T08:00:00.000Z",
      actorId: BOT.id,
      revision: 2,
      field: "status",
      old: "Todo",
      new: "In Progress",
    });
    assertEquals(events[2].field, "title");
    assertFalse("old" in events[2] || "new" in events[2]);
    assertEquals(events[3].field, "assignee");
    assertFalse("new" in events[3]);
    assertNoPersonalData(written[0].data);
  },
  (fake) => {
    seedBacklog(fake);
    const item = fake.items.get("ROG-3")!;
    fake.record(item, "created", null, null, 1);
    fake.record(item, "status", "Todo", "In Progress", 2);
    fake.record(item, "title", "Item 3", "Secret body renamed", 3);
    fake.record(item, "assignee", null, ALICE, 3);
  },
);

serverTest(
  "releases and release keep versions, tags, dates and counts",
  async (h) => {
    await behavior.methods.releases.execute({}, h.context);
    assertEquals(
      h.fake.calls[0].path,
      `/api/v1/orgs/${ORG}/projects/${PROJECT}/releases`,
    );
    const list = h.getWrittenResources()[0];
    assertEquals(list.specName, "releases");
    assertEquals(list.name, `releases-${ORG}-${PROJECT}`);
    assertEquals(list.data.count, 2);
    const rows = list.data.releases as Record<string, unknown>[];
    assertEquals(rows[0], {
      id: "r-1.8.2",
      version: "1.8.2",
      tag: "v1.8.2",
      kind: "release",
      shippedAt: "2026-10-10T12:00:00.000Z",
      notesUrl: "https://notes.example.com/1.8.2",
      builtWith: { project: "tech", version: "0.9.0", restricted: false },
      steps: 2,
      stepsDone: 1,
      items: 3,
      createdById: BOT.id,
      createdAt: "2026-10-10T12:00:00.000Z",
      updatedAt: "2026-10-10T12:00:00.000Z",
    });
    assertEquals(rows[1].kind, "hotfix");
    assertEquals(rows[1].builtWith, { restricted: true });
    assertFalse("notesUrl" in rows[1]);
    assertNoPersonalData(list.data);

    const one = h.withGlobals({});
    await behavior.methods.release.execute({ version: "1.8.2" }, one.context);
    assertEquals(
      h.fake.calls[1].path,
      `/api/v1/orgs/${ORG}/projects/${PROJECT}/releases/1.8.2`,
    );
    const release = one.getWrittenResources()[0];
    assertEquals(release.specName, "release");
    assertEquals(release.name, `release-${ORG}-${PROJECT}-1.8.2`);
    assertEquals(release.data.items, 3);
    assertEquals(release.data.org, ORG);
    assertEquals(release.data.project, PROJECT);

    const missing = h.withGlobals({});
    const error = await assertRejects(
      () =>
        behavior.methods.release.execute({ version: "9.9.9" }, missing.context),
      WorkqError,
    );
    assertEquals(error.status, 404);
    assertEquals(missing.getWrittenResources().length, 0);
  },
  seedBacklog,
);

serverTest(
  "sprints keeps the schedule and names the current one",
  async (h) => {
    await behavior.methods.sprints.execute({}, h.context);
    assertEquals(
      h.fake.calls[0].path,
      `/api/v1/orgs/${ORG}/projects/${PROJECT}/sprints`,
    );
    const written = h.getWrittenResources()[0];
    assertEquals(written.specName, "sprints");
    assertEquals(written.name, `sprints-${ORG}-${PROJECT}`);
    assertEquals(written.data.count, 2);
    assertEquals(written.data.current, 2);
    const rows = written.data.sprints as Record<string, unknown>[];
    assertEquals(rows[1], {
      id: "s-2",
      number: 2,
      startsOn: "2026-10-15",
      endsOn: "2026-10-28",
      state: "current",
      goal: "Ship 1.8.2",
      tag: "sprint-2",
      items: 3,
      completed: 1,
      createdById: ALICE.id,
      createdAt: "2026-09-30T09:00:00.000Z",
      updatedAt: "2026-09-30T09:00:00.000Z",
    });
    assertFalse("goal" in rows[0]);
    assertNoPersonalData(written.data);

    const none = h.withGlobals({});
    h.fake.sprints = [];
    await behavior.methods.sprints.execute({}, none.context);
    assertFalse("current" in none.getWrittenResources()[0].data);
  },
  seedBacklog,
);

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

serverTest(
  "a token Access does not admit fails before anything is written",
  async (h) => {
    const unlisted = h.withGlobals({ clientId: "unlisted.access" });
    const forbidden = await assertRejects(
      () => behavior.methods.me.execute({}, unlisted.context),
      WorkqError,
    );
    assertEquals(forbidden.status, 403);
    assertStringIncludes(forbidden.message, "not a service caller");
    assertStringIncludes(forbidden.message, "not a listed service caller");
    assertEquals(unlisted.getWrittenResources().length, 0);

    const wrongSecret = h.withGlobals({ clientSecret: "wrong" });
    const unauthorized = await assertRejects(
      () => behavior.methods.me.execute({}, wrongSecret.context),
      WorkqError,
    );
    assertEquals(unauthorized.status, 401);
    assertStringIncludes(unauthorized.message, "does not verify");

    // Access answers a request with no token by redirecting it to sign in.
    h.fake.override = () =>
      new Response(null, { status: 302, headers: { Location: LOGIN } });
    const redirected = await assertRejects(
      () => behavior.methods.me.execute({}, h.context),
      WorkqError,
    );
    assertEquals(redirected.status, 302);
    assertStringIncludes(redirected.message, "redirected (302) to sign in");
    assertEquals(h.getWrittenResources().length, 0);
  },
);

serverTest(
  "rate limits, non-JSON answers and server errors are named",
  async (h) => {
    h.fake.override = () =>
      new Response("slow down", {
        status: 429,
        headers: { "Retry-After": "9" },
      });
    const limited = await assertRejects(
      () => behavior.methods.me.execute({}, h.context),
      WorkqError,
    );
    assertEquals(limited.status, 429);
    assertEquals(limited.retryAfterSeconds, 9);
    assertStringIncludes(limited.message, "retry after 9 seconds");

    h.fake.override = () =>
      new Response("<html>sign in</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    const html = await assertRejects(
      () => behavior.methods.me.execute({}, h.context),
      WorkqError,
    );
    assertStringIncludes(html.message, "GET /api/v1/me: answer was not JSON");

    h.fake.override = () => json({ error: "internal error" }, 500);
    const failed = await assertRejects(
      () => behavior.methods.me.execute({}, h.context),
      WorkqError,
    );
    assertEquals(failed.status, 500);
    assertStringIncludes(failed.message, "500 internal error");
    assertEquals(h.getWrittenResources().length, 0);
  },
);

serverTest("host joins a trailing slash and a path prefix", async (h) => {
  const prefixed = h.withGlobals({ host: `${h.host}/tracker/` });
  h.fake.override = (call) =>
    call.path === "/tracker/api/v1/me"
      ? json({ id: "p-x", name: "X" })
      : undefined;
  await behavior.methods.me.execute({}, prefixed.context);
  assertEquals(h.fake.calls[0].path, "/tracker/api/v1/me");
  assertEquals(prefixed.getWrittenResources()[0].data.id, "p-x");
});

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

Deno.test("normalizers and summarize handle odd input", () => {
  assertEquals(
    normalizeItemSummary(rawItem(7, { assignee: ALICE, rank: 1.5 })).assigneeId,
    ALICE.id,
  );
  assertEquals(
    normalizeItemSummary(rawItem(7, { statusGroup: undefined })).statusGroup,
    "unknown",
  );
  let thrown = false;
  try {
    normalizeItemSummary({ id: 1, key: "ROG-1" });
  } catch {
    thrown = true;
  }
  assert(thrown, "an item without a revision is refused");

  assertEquals(
    normalizeEvent({
      id: 3,
      at: "t",
      actor: { id: "p", name: "N" },
      revision: 2,
      field: "labels",
      old: [],
      new: ["audio"],
    }),
    {
      id: 3,
      at: "t",
      actorId: "p",
      revision: 2,
      field: "labels",
      old: [],
      new: ["audio"],
    },
  );
  assertEquals(
    normalizeEvent({ id: 4, actor: {}, field: "body", old: "a", new: "b" }),
    { id: 4, at: "", actorId: "", revision: 0, field: "body" },
  );

  const summary = summarize([
    normalizeItemSummary(rawItem(1, { statusGroup: "weird", status: "Odd" })),
  ]);
  assertEquals(summary.byGroup.backlog, 0);
  assertEquals(summary.byStatus, { Odd: 1 });
  assertEquals(
    summary.unfinished,
    0,
    "an unknown group is not counted as open",
  );
  assertEquals(summary.unassigned, 1);
});

Deno.test("every argument's description is written where the registry reads it", () => {
  // swamp's registry reads arguments from the source text, not the running
  // behavior: the fields written inside the schema's own `z.object({ ... })`,
  // each starting `name: z.<type>(` on one line, with its description in
  // `.describe("...")` as a string literal. The registry reads a single-quoted
  // literal too; this test matches only the double-quoted one, so a
  // description holds no double quote. A spread, a shared schema constant, a
  // field split after `z` or written `z.iso.datetime()` is left out of the
  // registry's argument list; `.meta({ description })`, a constant or a
  // template literal leaves its description empty.
  const objects = objectLiterals(source);
  const schemas: { shape: Record<string, { description?: string }> }[] = [
    behavior.globalArguments,
    ...Object.values(behavior.methods).map((method) => method.arguments),
  ];
  const unread: string[] = [];
  for (const schema of schemas) {
    const names = Object.keys(schema.shape);
    if (names.length === 0) {
      continue;
    }
    const written = objects.find((fields) =>
      fields.length === names.length &&
      fields.every((field, i) => field.startsWith(`${names[i]}:`))
    );
    for (const [i, name] of names.entries()) {
      const text = written?.[i] ?? "";
      const description = schema.shape[name].description;
      const read = description !== undefined &&
        new RegExp(`^${name}:[ \\t]*z\\.\\w+\\(`).test(text) &&
        new RegExp(`\\.describe\\(\\s*${escape(JSON.stringify(description))}`)
          .test(text);
      if (!read) {
        unread.push(name);
      }
    }
  }
  assertEquals(unread, []);
});

/** `text` with every regular-expression metacharacter escaped. */
function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The top-level fields of every `z.object({ ... })` literal in `text`, as written. */
function objectLiterals(text: string): string[][] {
  const objects: string[][] = [];
  const opener = /z\.object\(\{/g;
  for (const match of text.matchAll(opener)) {
    const fields: string[] = [];
    let depth = 0;
    let quote = "";
    let start = match.index + match[0].length;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (quote) {
        if (c === "\\") {
          i++;
        } else if (c === quote) {
          quote = "";
        }
      } else if (c === '"' || c === "'" || c === "`") {
        quote = c;
      } else if ("([{".includes(c)) {
        depth++;
      } else if (depth > 0 && ")]}".includes(c)) {
        depth--;
      } else if (depth === 0 && (c === "," || c === "}")) {
        const field = text.slice(start, i).trim();
        if (field) {
          fields.push(field);
        }
        start = i + 1;
        if (c === "}") {
          break;
        }
      }
    }
    objects.push(fields);
  }
  return objects;
}
