/**
 * Unit tests for the Wwise behavior. Every session runs against an in-memory
 * WAMP router through an injected socket, so nothing here needs Wwise. Where
 * the test runner allows loopback network access, the same router also
 * answers behind Deno.serve and Deno.upgradeWebSocket, which proves the
 * behavior over a real WebSocket.
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
  boundWaql,
  type Context,
  countBySeverity,
  type GlobalArgs,
  normalizeLogEntry,
  redactUrl,
  type Socket,
  type SocketFactory,
  WaapiError,
  WaapiSession,
  waqlForGuids,
} from "./wwise.ts";
import source from "./wwise.ts" with { type: "text" };

const HOST = "ws://wwise.example.test:8080/waapi";
const REALM = "realm1";

const guid = (n: number): string =>
  `{00000000-0000-4000-8000-${String(n).padStart(12, "0")}}`;

const INFO = {
  sessionId: guid(1),
  apiVersion: 1,
  displayName: "Wwise",
  branch: "wwise_v2024.1",
  copyright: "Copyright (c) Audiokinetic Inc.",
  version: {
    displayName: "v2024.1.2",
    year: 2024,
    major: 1,
    minor: 2,
    build: 8726,
    nickname: "",
    schema: 120,
  },
  configuration: "release",
  platform: "x64",
  isCommandLine: false,
  processId: 4321,
  processPath: "C:\\Wwise\\Authoring\\x64\\Release\\bin\\Wwise.exe",
  directories: {
    install: "C:\\Wwise",
    authoring: "C:\\Wwise\\Authoring",
    bin: "C:\\Wwise\\Authoring\\x64\\Release\\bin",
    help: "C:\\Wwise\\Authoring\\Help",
    user: "C:\\Users\\builder\\AppData\\Roaming\\Audiokinetic",
  },
};

const PROJECT = {
  name: "ExampleGame",
  displayTitle: "ExampleGame - Wwise",
  path: "Z:\\projects\\ExampleGame\\ExampleGame.wproj",
  id: guid(2),
  isDirty: true,
  currentLanguageId: guid(3),
  referenceLanguageId: guid(3),
  currentPlatformId: guid(4),
  languages: [{ id: guid(3), name: "English(US)", shortId: 684519430 }],
  platforms: [
    {
      id: guid(4),
      name: "Windows",
      baseName: "Windows",
      baseDisplayName: "Windows",
      soundBankPath: "Z:\\projects\\ExampleGame\\GeneratedSoundBanks\\Windows",
      copiedMediaPath:
        "Z:\\projects\\ExampleGame\\GeneratedSoundBanks\\Windows",
    },
  ],
  defaultConversion: { id: guid(5), name: "Default Conversion Settings" },
  directories: {
    root: "Z:\\projects\\ExampleGame",
    cache: "Z:\\projects\\ExampleGame\\.cache",
    originals: "Z:\\projects\\ExampleGame\\Originals",
    soundBankOutputRoot: "Z:\\projects\\ExampleGame\\GeneratedSoundBanks",
    commands: "Z:\\projects\\ExampleGame\\Add-ons\\Commands",
    properties: "Z:\\projects\\ExampleGame",
  },
};

/** Every object the fake project holds, by GUID, as object.get would answer. */
const OBJECTS: Record<string, Record<string, unknown>> = {};
const EVENTS: Record<string, unknown>[] = [];
const SOUNDS: Record<string, unknown>[] = [];
const BANKS: Record<string, unknown>[] = [];
for (let i = 1; i <= 12; i++) {
  const event = {
    id: guid(100 + i),
    name: `Play_Sound_${String(i).padStart(2, "0")}`,
    path: `\\Events\\Default Work Unit\\Play_Sound_${
      String(i).padStart(2, "0")
    }`,
    notes: i === 1 ? "The first one" : "",
    type: "Event",
  };
  EVENTS.push(event);
  OBJECTS[event.id] = event;
}
for (let i = 1; i <= 5; i++) {
  const sound = {
    id: guid(200 + i),
    name: `Sound_${i}`,
    path: `\\Containers\\Default Work Unit\\Sound_${i}`,
    type: "Sound",
    Volume: -i,
  };
  SOUNDS.push(sound);
  OBJECTS[sound.id] = sound;
}
for (const [i, name] of ["Main", "Music", "Empty"].entries()) {
  const bank = {
    id: guid(300 + i),
    name,
    path: `\\SoundBanks\\Default Work Unit\\${name}`,
    notes: "",
    type: "SoundBank",
    soundbankBnkFilePath: name === "Empty"
      ? undefined
      : `Z:\\projects\\ExampleGame\\GeneratedSoundBanks\\Windows\\${name}.bnk`,
  };
  BANKS.push(bank);
  OBJECTS[bank.id] = bank;
}
const INCLUSIONS: Record<string, unknown[]> = {
  [guid(300)]: [
    { object: guid(101), filter: ["events", "structures", "media"] },
    { object: guid(102), filter: ["events"] },
  ],
  [guid(301)]: [{ object: guid(201), filter: ["structures", "media"] }],
  [guid(302)]: [],
};

const GENERATION_LOGS = [
  {
    severity: "Message",
    time: 1_760_000_000,
    messageId: "GenerationStarted",
    message: "SoundBank generation started",
    platform: { id: guid(4), name: "Windows" },
  },
  {
    severity: "Warning",
    time: 1_760_000_001,
    messageId: "MissingSource",
    message: "Audio source is missing",
    platform: { id: guid(4), name: "Windows" },
    parameters: ["Sound_3"],
  },
  {
    severity: "Message",
    time: 1_760_000_002,
    messageId: "GenerationDone",
    message: "SoundBank generation completed",
  },
];

const ERROR_LOG = {
  severity: "Error",
  time: 1_760_000_001,
  messageId: "EventNotFound",
  message: "Event Play_Missing referenced by SoundBank Main was not found",
  platform: { id: guid(4), name: "Windows" },
};

// ---------------------------------------------------------------------------
// A WAMP router that answers like WAAPI
// ---------------------------------------------------------------------------

type Reply =
  | { result: Record<string, unknown> }
  | { error: string; message?: string }
  | { raw: (requestId: number) => string[] }
  | { hang: true }
  | { close: true };

type Procedure = (
  args: Record<string, unknown>,
  options: Record<string, unknown>,
) => Reply | Promise<Reply>;

interface RouterCall {
  uri: string;
  args: Record<string, unknown>;
  options: Record<string, unknown>;
}

/** Handles WAMP frames the way Wwise's WAMP endpoint does, for one realm. */
class Router {
  calls: RouterCall[] = [];
  hellos: unknown[] = [];
  goodbyes: unknown[] = [];

  constructor(
    readonly procedures: Record<string, Procedure>,
    readonly options: { realm?: string; abortReason?: string } = {},
  ) {}

  async handle(
    text: string,
    send: (text: string) => void,
    close: () => void,
  ): Promise<void> {
    const frame = JSON.parse(text) as unknown[];
    switch (frame[0]) {
      case 1: {
        this.hellos.push(frame);
        const realm = this.options.realm ?? REALM;
        if (this.options.abortReason !== undefined) {
          send(JSON.stringify([
            3,
            { message: "refused by the router" },
            this.options.abortReason,
          ]));
        } else if (frame[1] !== realm) {
          send(JSON.stringify([
            3,
            { message: `no realm ${String(frame[1])}` },
            "wamp.error.no_such_realm",
          ]));
        } else {
          send(JSON.stringify([2, 4242, { roles: { dealer: {} } }]));
        }
        return;
      }
      case 48: {
        const requestId = frame[1] as number;
        const options = (frame[2] ?? {}) as Record<string, unknown>;
        const uri = frame[3] as string;
        const args = (frame[5] ?? {}) as Record<string, unknown>;
        this.calls.push({ uri, args, options });
        const procedure = this.procedures[uri];
        if (procedure === undefined) {
          send(JSON.stringify([
            8,
            48,
            requestId,
            {},
            "wamp.error.no_such_procedure",
          ]));
          return;
        }
        const reply = await procedure(args, options);
        if ("hang" in reply) return;
        if ("close" in reply) {
          close();
          return;
        }
        if ("raw" in reply) {
          for (const line of reply.raw(requestId)) send(line);
          return;
        }
        if ("error" in reply) {
          send(JSON.stringify([
            8,
            48,
            requestId,
            {},
            reply.error,
            [],
            reply.message === undefined ? {} : { message: reply.message },
          ]));
          return;
        }
        send(JSON.stringify([50, requestId, {}, [], reply.result]));
        return;
      }
      case 6:
        this.goodbyes.push(frame);
        send(JSON.stringify([6, {}, "wamp.close.goodbye_and_out"]));
        close();
        return;
      default:
        throw new Error(`router got WAMP message ${String(frame[0])}`);
    }
  }
}

/** Projects an object to the accessors asked for, as object.get does. */
function project(
  object: Record<string, unknown>,
  accessors: string[],
): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const accessor of accessors) {
    if (object[accessor] !== undefined) row[accessor] = object[accessor];
  }
  return row;
}

/** Answers the few WAQL shapes the behavior sends. */
function objectGet(
  args: Record<string, unknown>,
  options: Record<string, unknown>,
): Reply {
  const waql = String(args.waql ?? "");
  const accessors = (options.return as string[] | undefined) ?? ["id", "name"];
  let objects: Record<string, unknown>[];
  if (waql.startsWith("$ from type Event")) {
    objects = EVENTS;
  } else if (waql.startsWith("$ from type SoundBank")) {
    objects = BANKS;
  } else if (waql.startsWith("$ from type Sound")) {
    objects = SOUNDS;
  } else if (waql.startsWith('$ "{')) {
    objects = [...waql.matchAll(/"(\{[^"]+\})"/g)]
      .map((match) => OBJECTS[match[1] ?? ""])
      .filter((object) => object !== undefined);
  } else {
    return { error: "wamp.error.invalid_argument", message: "Invalid WAQL" };
  }
  const skip = Number(/skip (\d+)/.exec(waql)?.[1] ?? 0);
  const take = Number(/take (\d+)/.exec(waql)?.[1] ?? objects.length);
  return {
    result: {
      return: objects.slice(skip, skip + take).map((object) =>
        project(object, accessors)
      ),
    },
  };
}

function wwiseProcedures(
  overrides: Record<string, Procedure> = {},
): Record<string, Procedure> {
  return {
    "ak.wwise.core.getInfo": () => ({ result: INFO }),
    "ak.wwise.core.getProjectInfo": () => ({ result: PROJECT }),
    "ak.wwise.core.object.get": objectGet,
    "ak.wwise.core.soundbank.getInclusions": (args) => ({
      result: { inclusions: INCLUSIONS[String(args.soundbank)] ?? [] },
    }),
    "ak.wwise.core.soundbank.generate": () => ({
      result: { logs: GENERATION_LOGS },
    }),
    "ak.wwise.core.project.save": () => ({ result: {} }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// An in-memory socket in front of the router
// ---------------------------------------------------------------------------

type SocketMode = "open" | "refuse" | "silent";

class FakeSocket extends EventTarget implements Socket {
  readyState = 0;
  sent: string[] = [];

  constructor(
    readonly url: string,
    readonly protocols: string[],
    private readonly router: Router,
    mode: SocketMode,
  ) {
    super();
    queueMicrotask(() => {
      if (mode === "refuse") {
        this.readyState = 3;
        this.dispatchEvent(new Event("error"));
        this.dispatchEvent(new CloseEvent("close", { code: 1006 }));
      } else if (mode === "open") {
        this.readyState = 1;
        this.dispatchEvent(new Event("open"));
      }
    });
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error("socket is not open");
    this.sent.push(data);
    // A real socket delivers answers on a later turn; so does this one, so a
    // frame handler never runs inside the send that caused it.
    queueMicrotask(() => {
      this.router
        .handle(data, (text) => this.deliver(text), () => this.serverClose())
        .catch((error) => {
          throw error;
        });
    });
  }

  deliver(text: string): void {
    if (this.readyState === 1) {
      this.dispatchEvent(new MessageEvent("message", { data: text }));
    }
  }

  serverClose(code = 1000, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(new CloseEvent("close", { code, reason }));
  }

  close(code?: number, reason?: string): void {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    this.dispatchEvent(
      new CloseEvent("close", { code: code ?? 1000, reason: reason ?? "" }),
    );
  }
}

function fakeSockets(
  router: Router,
  mode: SocketMode = "open",
): { factory: SocketFactory; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = [];
  const factory: SocketFactory = (url, protocols) => {
    const socket = new FakeSocket(url, protocols, router, mode);
    sockets.push(socket);
    return socket;
  };
  return { factory, sockets };
}

function wwise(
  overrides: Record<string, Procedure> = {},
  mode: SocketMode = "open",
): { router: Router; factory: SocketFactory; sockets: FakeSocket[] } {
  const router = new Router(wwiseProcedures(overrides));
  return { router, ...fakeSockets(router, mode) };
}

function testContext(
  overrides: Partial<GlobalArgs> = {},
  signal?: AbortSignal,
): {
  context: Context;
  getWrittenResources: ModelTestContextResult["getWrittenResources"];
  getLogs: ModelTestContextResult["getLogs"];
} {
  const globalArgs: GlobalArgs = {
    host: HOST,
    timeoutSeconds: 1,
    ...overrides,
  };
  const result = createModelTestContext({
    globalArgs: { ...globalArgs },
    signal,
  });
  const context: Context = { ...result.context, globalArgs };
  return {
    context,
    getWrittenResources: result.getWrittenResources,
    getLogs: result.getLogs,
  };
}

const tick = (ms = 5): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const { info, query, events, banks, generate, save } = behavior.methods;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

Deno.test("global arguments default the host and the timeout, and reject other schemes", () => {
  const parsed = behavior.globalArguments.parse({});
  assertEquals(parsed.host, "ws://127.0.0.1:8080/waapi");
  assertEquals(parsed.timeoutSeconds, 30);
  assertFalse(
    behavior.globalArguments.safeParse({ host: "http://127.0.0.1:8090/waapi" })
      .success,
  );
  assertFalse(
    behavior.globalArguments.safeParse({ timeoutSeconds: 0 }).success,
  );
  assert(
    behavior.globalArguments.safeParse({
      host: "wss://wwise.example.com/waapi",
    }).success,
  );
});

Deno.test("boundWaql appends skip and take and insists on the $ prefix", () => {
  assertEquals(
    boundWaql("$ from type Event", 0, 10),
    "$ from type Event take 11",
  );
  assertEquals(
    boundWaql("  $ from type Sound where volume < 0 ", 20, 5),
    "$ from type Sound where volume < 0 skip 20 take 6",
  );
  assertRejects(
    () => Promise.resolve().then(() => boundWaql("from type Event", 0, 1)),
    Error,
    "starts with $",
  );
});

Deno.test("waqlForGuids quotes GUIDs and refuses anything else", () => {
  assertEquals(
    waqlForGuids([guid(1), guid(2)]),
    `$ "${guid(1)}", "${guid(2)}"`,
  );
  assertRejects(
    () => Promise.resolve().then(() => waqlForGuids(['" select children'])),
    WaapiError,
    "is not an object GUID",
  );
});

Deno.test("redactUrl strips userinfo and leaves the rest", () => {
  assertEquals(
    redactUrl("ws://user:secret@wwise.example.test:8080/waapi"),
    "ws://wwise.example.test:8080/waapi",
  );
  assertEquals(redactUrl("not a url"), "not a url");
});

Deno.test("generation log helpers count severities and drop entries without a message", () => {
  const entries = [...GENERATION_LOGS, ERROR_LOG, {
    severity: "Fatal Error",
    message: "x",
  }]
    .map(normalizeLogEntry)
    .filter((entry) => entry !== undefined);
  assertEquals(countBySeverity(entries), {
    messages: 2,
    warnings: 1,
    errors: 1,
    fatal: 1,
  });
  assertEquals(entries[1]?.parameters, ["Sound_3"]);
  assertEquals(entries[2]?.platform, undefined);
  assertEquals(normalizeLogEntry({ severity: "Error" }), undefined);
  assertEquals(normalizeLogEntry("text"), undefined);
});

// ---------------------------------------------------------------------------
// info
// ---------------------------------------------------------------------------

Deno.test("info opens a WAMP session as a caller on realm1 with wamp.2.json and writes the record", async () => {
  const { router, factory, sockets } = wwise();
  const { context, getWrittenResources, getLogs } = testContext();
  const result = await info.execute({ _socket: factory }, context);

  assertEquals(sockets.length, 1);
  const socket = sockets[0];
  assert(socket !== undefined);
  assertEquals(socket.url, HOST);
  assertEquals(socket.protocols, ["wamp.2.json"]);
  assertEquals(
    JSON.parse(socket.sent[0] ?? ""),
    [1, "realm1", { roles: { caller: {} } }],
  );
  assertEquals(
    router.calls.map((call) => call.uri),
    ["ak.wwise.core.getInfo", "ak.wwise.core.getProjectInfo"],
  );
  const call = JSON.parse(socket.sent[1] ?? "") as unknown[];
  assertEquals(call.slice(0, 1), [48]);
  assertEquals(call.slice(2), [{}, "ak.wwise.core.getInfo", [], {}]);
  assertEquals(router.goodbyes.length, 1, "the session said GOODBYE");
  assertEquals(socket.readyState, 3, "the socket is closed");

  const written = getWrittenResources();
  assertEquals(written.map((w) => [w.specName, w.name]), [["info", "info"]]);
  const data = written[0]?.data ?? {};
  assertEquals(data.host, HOST);
  const wwiseInfo = data.wwise as Record<string, unknown>;
  assertEquals(wwiseInfo.version, INFO.version);
  assertEquals(wwiseInfo.platform, "x64");
  assertEquals(wwiseInfo.processId, 4321);
  assertEquals(wwiseInfo.directories, INFO.directories);
  assertFalse("copyright" in wwiseInfo, "unknown fields are dropped");
  const projectInfo = data.project as Record<string, unknown>;
  assertEquals(projectInfo.name, "ExampleGame");
  assertEquals(projectInfo.isDirty, true);
  assertEquals(projectInfo.platforms, [
    {
      id: guid(4),
      name: "Windows",
      baseName: "Windows",
      soundBankPath: PROJECT.platforms[0]?.soundBankPath,
    },
  ]);
  assertEquals(projectInfo.languages, PROJECT.languages);
  assertEquals(
    (projectInfo.directories as Record<string, string>).soundBankOutputRoot,
    PROJECT.directories.soundBankOutputRoot,
  );
  assertEquals(result.dataHandles.length, 1);
  assert(
    getLogs().some((log) =>
      log.level === "info" && log.message.includes("{version}")
    ),
  );
});

Deno.test("info records project null with a warning when no project answers", async () => {
  const { factory } = wwise({
    "ak.wwise.core.getProjectInfo": () => ({
      error: "ak.wwise.error.no_project",
      message: "No project is open",
    }),
  });
  const { context, getWrittenResources, getLogs } = testContext();
  await info.execute({ _socket: factory }, context);
  assertEquals(getWrittenResources()[0]?.data.project, null);
  const warning = getLogs().find((log) => log.level === "warning");
  assert(warning !== undefined, "a warning was logged");
  assertStringIncludes(JSON.stringify(warning.args), "No project is open");
});

Deno.test("info fails without writing when the answer is not Wwise's", async () => {
  const { factory } = wwise({
    "ak.wwise.core.getInfo": () => ({ result: { hello: "world" } }),
  });
  const { context, getWrittenResources } = testContext();
  const error = await assertRejects(
    () => info.execute({ _socket: factory }, context),
    WaapiError,
    "carries no version object",
  );
  assertEquals(error.code, "protocol");
  assertEquals(getWrittenResources(), []);
});

// ---------------------------------------------------------------------------
// Connecting
// ---------------------------------------------------------------------------

Deno.test("a refused connection fails with a connect error that names the host and the preference", async () => {
  const { factory, router } = wwise({}, "refuse");
  const { context, getWrittenResources } = testContext();
  const error = await assertRejects(
    () => info.execute({ _socket: factory }, context),
    WaapiError,
    `${HOST}: could not connect`,
  );
  assertEquals(error.code, "connect");
  assertStringIncludes(error.message, "Wwise Authoring API enabled");
  assertEquals(router.calls, []);
  assertEquals(getWrittenResources(), []);
});

Deno.test("a socket that never opens fails at the timeout and is closed", async () => {
  const { factory, sockets } = wwise({}, "silent");
  const { context } = testContext({ timeoutSeconds: 1 });
  const error = await assertRejects(
    () => info.execute({ _socket: factory }, context),
    WaapiError,
    "no WAMP session within 1 seconds",
  );
  assertEquals(error.code, "timeout");
  assertEquals(sockets[0]?.readyState, 3);
});

Deno.test("an ABORT answer to HELLO fails with its reason and message", async () => {
  const router = new Router(wwiseProcedures(), {
    abortReason: "wamp.error.not_authorized",
  });
  const { factory, sockets } = fakeSockets(router);
  const { context } = testContext();
  const error = await assertRejects(
    () => events.execute({ offset: 0, limit: 10, _socket: factory }, context),
    WaapiError,
    "refused the WAMP session: wamp.error.not_authorized (refused by the router)",
  );
  assertEquals(error.code, "connect");
  assertEquals(sockets[0]?.readyState, 3);
});

Deno.test("a session rejected for the realm reports the router's reason", async () => {
  const router = new Router(wwiseProcedures(), { realm: "other" });
  const { factory } = fakeSockets(router);
  const error = await assertRejects(
    () =>
      WaapiSession.connect({
        url: HOST,
        timeoutMs: 1000,
        socket: factory,
      }),
    WaapiError,
    "wamp.error.no_such_realm",
  );
  assertStringIncludes(error.message, "no realm realm1");
});

Deno.test("a cancelled run fails before connecting and while a call is pending", async () => {
  const aborted = new AbortController();
  aborted.abort();
  const { factory, router } = wwise();
  const before = testContext({}, aborted.signal);
  const early = await assertRejects(
    () => info.execute({ _socket: factory }, before.context),
    WaapiError,
    "cancelled",
  );
  assertEquals(early.code, "aborted");
  assertEquals(router.calls, []);

  const controller = new AbortController();
  const hanging = wwise({ "ak.wwise.core.getInfo": () => ({ hang: true }) });
  const { context, getWrittenResources } = testContext({}, controller.signal);
  const pending = assertRejects(
    () => info.execute({ _socket: hanging.factory }, context),
    WaapiError,
    "cancelled",
  );
  await tick();
  assertEquals(hanging.router.calls.length, 1, "the call was sent");
  controller.abort();
  await pending;
  assertEquals(hanging.sockets[0]?.readyState, 3);
  assertEquals(getWrittenResources(), []);
});

// ---------------------------------------------------------------------------
// query
// ---------------------------------------------------------------------------

Deno.test("query asks for one object more than the limit, keeps the return list and marks truncation", async () => {
  const { router, factory } = wwise();
  const { context, getWrittenResources } = testContext();
  await query.execute(
    {
      waql: "$ from type Sound where volume < 0",
      return: ["id", "name", "Volume"],
      offset: 1,
      limit: 3,
      name: "quiet-sounds",
      platform: "Windows",
      _socket: factory,
    },
    context,
  );
  assertEquals(router.calls.length, 1);
  assertEquals(router.calls[0]?.args, {
    waql: "$ from type Sound where volume < 0 skip 1 take 4",
  });
  assertEquals(router.calls[0]?.options, {
    return: ["id", "name", "Volume"],
    platform: "Windows",
  });
  const written = getWrittenResources();
  assertEquals(written.map((w) => [w.specName, w.name]), [
    ["query", "query-quiet-sounds"],
  ]);
  const data = written[0]?.data ?? {};
  assertEquals(data.waql, "$ from type Sound where volume < 0");
  assertEquals(data.offset, 1);
  assertEquals(data.limit, 3);
  assertEquals(data.count, 3);
  assertEquals(data.truncated, true);
  assertEquals(data.platform, "Windows");
  assertFalse("language" in data);
  assertEquals(data.objects, [
    { id: guid(202), name: "Sound_2", Volume: -2 },
    { id: guid(203), name: "Sound_3", Volume: -3 },
    { id: guid(204), name: "Sound_4", Volume: -4 },
  ]);
});

Deno.test("query is not truncated when fewer objects matched than the limit", async () => {
  const { factory } = wwise();
  const { context, getWrittenResources } = testContext();
  await query.execute(
    {
      waql: "$ from type Sound",
      return: ["name"],
      offset: 0,
      limit: 100,
      name: "query",
      _socket: factory,
    },
    context,
  );
  const data = getWrittenResources()[0]?.data ?? {};
  assertEquals(getWrittenResources()[0]?.name, "query-query");
  assertEquals(data.count, 5);
  assertEquals(data.truncated, false);
});

Deno.test("query refuses a query without the $ prefix before connecting", async () => {
  const { factory, router, sockets } = wwise();
  const { context } = testContext();
  assertFalse(
    behavior.methods.query.arguments.safeParse({ waql: "from type Sound" })
      .success,
  );
  await assertRejects(
    () =>
      query.execute(
        {
          waql: "from type Sound",
          return: ["id"],
          offset: 0,
          limit: 10,
          name: "query",
          _socket: factory,
        },
        context,
      ),
    Error,
    "starts with $",
  );
  assertEquals(sockets, []);
  assertEquals(router.calls, []);
});

Deno.test("query surfaces Wwise's ERROR with its URI and message, and writes nothing", async () => {
  const { factory } = wwise();
  const { context, getWrittenResources } = testContext();
  const error = await assertRejects(
    () =>
      query.execute(
        {
          waql: "$ frm typo",
          return: ["id"],
          offset: 0,
          limit: 10,
          name: "query",
          _socket: factory,
        },
        context,
      ),
    WaapiError,
    "ak.wwise.core.object.get: Invalid WAQL (wamp.error.invalid_argument)",
  );
  assertEquals(error.code, "call");
  assertEquals(error.uri, "wamp.error.invalid_argument");
  assertEquals(getWrittenResources(), []);
});

Deno.test("a procedure Wwise does not have is reported by its WAMP URI", async () => {
  const router = new Router({});
  const { factory } = fakeSockets(router);
  const { context } = testContext();
  const error = await assertRejects(
    () =>
      save.execute(
        { autoCheckOutToSourceControl: true, _socket: factory },
        context,
      ),
    WaapiError,
    "wamp.error.no_such_procedure",
  );
  assertEquals(error.uri, "wamp.error.no_such_procedure");
});

// ---------------------------------------------------------------------------
// events and banks
// ---------------------------------------------------------------------------

Deno.test("events lists Events with id, name, path and notes", async () => {
  const { router, factory } = wwise();
  const { context, getWrittenResources } = testContext();
  await events.execute({ offset: 0, limit: 100, _socket: factory }, context);
  assertEquals(router.calls[0]?.args, { waql: "$ from type Event take 101" });
  assertEquals(router.calls[0]?.options, {
    return: ["id", "name", "path", "notes"],
  });
  const data = getWrittenResources()[0]?.data ?? {};
  assertEquals(getWrittenResources()[0]?.name, "events");
  assertEquals(data.count, 12);
  assertEquals(data.truncated, false);
  const list = data.events as Record<string, unknown>[];
  assertEquals(list[0], {
    id: guid(101),
    name: "Play_Sound_01",
    path: "\\Events\\Default Work Unit\\Play_Sound_01",
    notes: "The first one",
  });
  assertFalse("type" in (list[1] ?? {}), "only the asked accessors are kept");
});

Deno.test("events honors the offset and skips an answer without id and name", async () => {
  const { factory } = wwise({
    "ak.wwise.core.object.get": (args, options) => {
      const reply = objectGet(args, options);
      if ("result" in reply) {
        (reply.result.return as unknown[]).push({ path: "\\Events\\Odd" });
      }
      return reply;
    },
  });
  const { context, getWrittenResources, getLogs } = testContext();
  await events.execute({ offset: 10, limit: 3, _socket: factory }, context);
  const data = getWrittenResources()[0]?.data ?? {};
  assertEquals(data.offset, 10);
  assertEquals(data.count, 2);
  assertEquals(data.truncated, false);
  assertEquals(
    (data.events as Record<string, unknown>[]).map((event) => event.name),
    ["Play_Sound_11", "Play_Sound_12"],
  );
  assert(getLogs().some((log) => log.level === "warning"));
});

Deno.test("banks lists SoundBanks with resolved inclusions and bnk paths", async () => {
  const { router, factory } = wwise();
  const { context, getWrittenResources } = testContext();
  await banks.execute({ offset: 0, limit: 10, _socket: factory }, context);
  assertEquals(
    router.calls.map((call) => call.uri),
    [
      "ak.wwise.core.object.get",
      "ak.wwise.core.soundbank.getInclusions",
      "ak.wwise.core.object.get",
      "ak.wwise.core.soundbank.getInclusions",
      "ak.wwise.core.object.get",
      "ak.wwise.core.soundbank.getInclusions",
    ],
  );
  assertEquals(router.calls[1]?.args, { soundbank: guid(300) });
  assertEquals(router.calls[2]?.args, {
    waql: `$ "${guid(101)}", "${guid(102)}"`,
  });
  assertEquals(router.calls[2]?.options, {
    return: ["id", "name", "type", "path"],
  });
  const data = getWrittenResources()[0]?.data ?? {};
  assertEquals(getWrittenResources()[0]?.name, "banks");
  assertEquals(data.count, 3);
  assertEquals(data.truncated, false);
  const list = data.banks as Record<string, unknown>[];
  assertEquals(list[0], {
    id: guid(300),
    name: "Main",
    path: "\\SoundBanks\\Default Work Unit\\Main",
    notes: "",
    bnkFilePath:
      "Z:\\projects\\ExampleGame\\GeneratedSoundBanks\\Windows\\Main.bnk",
    inclusions: [
      {
        object: guid(101),
        name: "Play_Sound_01",
        type: "Event",
        path: "\\Events\\Default Work Unit\\Play_Sound_01",
        filter: ["events", "structures", "media"],
      },
      {
        object: guid(102),
        name: "Play_Sound_02",
        type: "Event",
        path: "\\Events\\Default Work Unit\\Play_Sound_02",
        filter: ["events"],
      },
    ],
  });
  assertEquals((list[1]?.inclusions as unknown[]).length, 1);
  assertEquals(list[2]?.inclusions, []);
  assertFalse("bnkFilePath" in (list[2] ?? {}), "no path before generation");
});

Deno.test("banks keeps an inclusion whose object no longer resolves", async () => {
  const { factory } = wwise({
    "ak.wwise.core.soundbank.getInclusions": () => ({
      result: { inclusions: [{ object: guid(999), filter: ["media"] }] },
    }),
  });
  const { context, getWrittenResources } = testContext();
  await banks.execute({ offset: 0, limit: 1, _socket: factory }, context);
  const data = getWrittenResources()[0]?.data ?? {};
  assertEquals(data.truncated, true);
  const list = data.banks as Record<string, unknown>[];
  assertEquals(list[0]?.inclusions, [{ object: guid(999), filter: ["media"] }]);
});

// ---------------------------------------------------------------------------
// generate
// ---------------------------------------------------------------------------

const GENERATE_ARGS = {
  banks: ["Main", "Music"],
  platforms: ["Windows"],
  languages: [],
  skipLanguages: false,
  rebuildSoundBanks: false,
  clearAudioFileCache: false,
  writeToDisk: true,
  rebuildInitBank: false,
  deadlineSeconds: 60,
  failOnError: true,
  logLimit: 500,
};

Deno.test("generate sends the bank and platform list and records the log with counts", async () => {
  const { router, factory } = wwise();
  const { context, getWrittenResources, getLogs } = testContext();
  await generate.execute({ ...GENERATE_ARGS, _socket: factory }, context);
  assertEquals(router.calls.length, 1);
  assertEquals(router.calls[0]?.uri, "ak.wwise.core.soundbank.generate");
  assertEquals(router.calls[0]?.args, {
    soundbanks: [{ name: "Main" }, { name: "Music" }],
    platforms: ["Windows"],
    skipLanguages: false,
    rebuildSoundBanks: false,
    clearAudioFileCache: false,
    writeToDisk: true,
    rebuildInitBank: false,
  });
  const written = getWrittenResources();
  assertEquals(written.map((w) => [w.specName, w.name]), [
    ["generation", "generation"],
  ]);
  const data = written[0]?.data ?? {};
  assertEquals(data.banks, ["Main", "Music"]);
  assertEquals(data.platforms, ["Windows"]);
  assertEquals(data.succeeded, true);
  assertFalse("error" in data);
  assertEquals(data.counts, { messages: 2, warnings: 1, errors: 0, fatal: 0 });
  assertEquals(data.logCount, 3);
  assertEquals(data.logTruncated, false);
  const logs = data.logs as Record<string, unknown>[];
  assertEquals(logs[1]?.severity, "Warning");
  assertEquals(logs[1]?.parameters, ["Sound_3"]);
  assertEquals(logs[1]?.platform, { id: guid(4), name: "Windows" });
  assert(typeof data.seconds === "number");
  assert(
    getLogs().some((log) =>
      log.level === "info" && log.message.includes("Generation {outcome}")
    ),
  );
});

Deno.test("generate asks for every bank, platform and language when the lists are empty", async () => {
  const { router, factory } = wwise();
  const { context } = testContext();
  await generate.execute(
    {
      ...GENERATE_ARGS,
      banks: [],
      platforms: [],
      languages: [],
      rebuildInitBank: true,
      _socket: factory,
    },
    context,
  );
  const args = router.calls[0]?.args ?? {};
  assertEquals(args.soundbanks, []);
  assertFalse("platforms" in args);
  assertFalse("languages" in args);
  assertEquals(args.rebuildInitBank, true);
});

Deno.test("generate fails on a logged error by default and writes nothing", async () => {
  const { factory } = wwise({
    "ak.wwise.core.soundbank.generate": () => ({
      result: {
        logs: [...GENERATION_LOGS, ERROR_LOG],
        error: ERROR_LOG.message,
      },
    }),
  });
  const { context, getWrittenResources } = testContext();
  const error = await assertRejects(
    () => generate.execute({ ...GENERATE_ARGS, _socket: factory }, context),
    Error,
    "SoundBank generation failed with 1 errors and 0 fatal errors (1 warnings)",
  );
  assertStringIncludes(error.message, "Play_Missing");
  assertEquals(getWrittenResources(), []);
});

Deno.test("generate with failOnError off records the failure and the first error", async () => {
  const { factory } = wwise({
    "ak.wwise.core.soundbank.generate": () => ({
      result: { logs: [...GENERATION_LOGS, ERROR_LOG] },
    }),
  });
  const { context, getWrittenResources } = testContext();
  await generate.execute(
    { ...GENERATE_ARGS, failOnError: false, _socket: factory },
    context,
  );
  const data = getWrittenResources()[0]?.data ?? {};
  assertEquals(data.succeeded, false);
  assertEquals(data.error, ERROR_LOG.message);
  assertEquals(data.counts, { messages: 2, warnings: 1, errors: 1, fatal: 0 });
});

Deno.test("generate bounds the log it keeps and says so", async () => {
  const { factory } = wwise();
  const { context, getWrittenResources } = testContext();
  await generate.execute(
    { ...GENERATE_ARGS, logLimit: 2, _socket: factory },
    context,
  );
  const data = getWrittenResources()[0]?.data ?? {};
  assertEquals(data.logCount, 3);
  assertEquals(data.logTruncated, true);
  assertEquals((data.logs as unknown[]).length, 2);
  assertEquals(data.counts, { messages: 2, warnings: 1, errors: 0, fatal: 0 });
});

Deno.test("generate gives up at its deadline, not at the session timeout", async () => {
  const { factory, sockets } = wwise({
    "ak.wwise.core.soundbank.generate": () => ({ hang: true }),
  });
  const { context, getWrittenResources } = testContext({
    timeoutSeconds: 3600,
  });
  const started = Date.now();
  const error = await assertRejects(
    () =>
      generate.execute(
        { ...GENERATE_ARGS, deadlineSeconds: 1, _socket: factory },
        context,
      ),
    WaapiError,
    "ak.wwise.core.soundbank.generate: Wwise did not answer within 1 seconds",
  );
  assertEquals(error.code, "timeout");
  assert(Date.now() - started < 3000, "the deadline, not the timeout, fired");
  assertEquals(sockets[0]?.readyState, 3, "the socket was closed");
  assertEquals(getWrittenResources(), []);
});

// ---------------------------------------------------------------------------
// save
// ---------------------------------------------------------------------------

Deno.test("save calls project.save and records the project's dirty state after it", async () => {
  const { router, factory } = wwise({
    "ak.wwise.core.getProjectInfo": () => ({
      result: { ...PROJECT, isDirty: false },
    }),
  });
  const { context, getWrittenResources } = testContext();
  await save.execute(
    { autoCheckOutToSourceControl: false, _socket: factory },
    context,
  );
  assertEquals(
    router.calls.map((call) => [call.uri, call.args]),
    [
      ["ak.wwise.core.project.save", { autoCheckOutToSourceControl: false }],
      ["ak.wwise.core.getProjectInfo", {}],
    ],
  );
  const written = getWrittenResources();
  assertEquals(written.map((w) => [w.specName, w.name]), [["save", "save"]]);
  const data = written[0]?.data ?? {};
  assertEquals(data.autoCheckOutToSourceControl, false);
  assertEquals((data.project as Record<string, unknown>).isDirty, false);
});

Deno.test("save fails without writing when Wwise refuses", async () => {
  const { factory } = wwise({
    "ak.wwise.core.project.save": () => ({
      error: "ak.wwise.error.source_control",
      message: "Checkout failed",
    }),
  });
  const { context, getWrittenResources } = testContext();
  await assertRejects(
    () =>
      save.execute(
        { autoCheckOutToSourceControl: true, _socket: factory },
        context,
      ),
    WaapiError,
    "Checkout failed (ak.wwise.error.source_control)",
  );
  assertEquals(getWrittenResources(), []);
});

// ---------------------------------------------------------------------------
// Session behavior
// ---------------------------------------------------------------------------

Deno.test("a call that Wwise never answers fails at the session timeout", async () => {
  const { factory, sockets } = wwise({
    "ak.wwise.core.getInfo": () => ({ hang: true }),
  });
  const { context, getWrittenResources } = testContext({ timeoutSeconds: 1 });
  const error = await assertRejects(
    () => info.execute({ _socket: factory }, context),
    WaapiError,
    "ak.wwise.core.getInfo: Wwise did not answer within 1 seconds",
  );
  assertEquals(error.code, "timeout");
  assertEquals(sockets[0]?.readyState, 3);
  assertEquals(getWrittenResources(), []);
});

Deno.test("malformed frames fail the call as protocol errors", async () => {
  const cases: Array<[string, string]> = [
    ["not json", "not JSON"],
    ["{}", "not a non-empty array"],
    ['["x", 1]', "no message code"],
  ];
  for (const [raw, expected] of cases) {
    const { factory, sockets } = wwise({
      "ak.wwise.core.getInfo": () => ({ raw: () => [raw] }),
    });
    const { context, getLogs } = testContext();
    const error = await assertRejects(
      () => info.execute({ _socket: factory }, context),
      WaapiError,
      expected,
    );
    assertEquals(error.code, "protocol");
    assertEquals(sockets[0]?.readyState, 3);
    assert(getLogs().some((log) => log.level === "warning"));
  }
  const notKwargs = wwise({
    "ak.wwise.core.getInfo": () => ({
      raw: (requestId) => [JSON.stringify([50, requestId, {}, [], 5])],
    }),
  });
  const error = await assertRejects(
    () => info.execute({ _socket: notKwargs.factory }, testContext().context),
    WaapiError,
    "RESULT carries no keyword results",
  );
  assertEquals(error.code, "protocol");
});

Deno.test("frames that are not for the pending call are ignored", async () => {
  const session = await WaapiSession.connect({
    url: HOST,
    timeoutMs: 1000,
    socket: wwise({
      "ak.wwise.core.getInfo": () => ({
        raw: (requestId) => [
          JSON.stringify([99, 1]),
          JSON.stringify([50, requestId + 100, {}, [], { other: true }]),
          JSON.stringify([8, 32, requestId, {}, "wamp.error.other"]),
          JSON.stringify([36, 1, 2, {}]),
          JSON.stringify([50, requestId, {}, [], { answered: true }]),
        ],
      }),
      "ak.wwise.core.project.save": () => ({
        raw: (requestId) => [JSON.stringify([50, requestId, {}])],
      }),
    }).factory,
  });
  assertEquals(session.sessionId, 4242);
  assertEquals(await session.call("ak.wwise.core.getInfo"), { answered: true });
  assertEquals(await session.call("ak.wwise.core.project.save"), {});
  await session.close();
});

Deno.test("a GOODBYE from Wwise fails the pending call and is answered", async () => {
  const { factory, sockets } = wwise({
    "ak.wwise.core.getInfo": () => ({
      raw: () => [
        JSON.stringify([6, { message: "bye" }, "wamp.close.system_shutdown"]),
      ],
    }),
  });
  const { context } = testContext();
  const error = await assertRejects(
    () => info.execute({ _socket: factory }, context),
    WaapiError,
    "Wwise closed the WAMP session: wamp.close.system_shutdown",
  );
  assertEquals(error.code, "closed");
  const socket = sockets[0];
  assert(socket !== undefined);
  assert(
    socket.sent.some((frame) => frame.includes("wamp.close.goodbye_and_out")),
    "the session answered GOODBYE",
  );
  assertEquals(socket.readyState, 3);
});

Deno.test("a connection that drops under a call fails it as closed", async () => {
  const { factory } = wwise({
    "ak.wwise.core.getInfo": () => ({ close: true }),
  });
  const { context, getWrittenResources } = testContext();
  const error = await assertRejects(
    () => info.execute({ _socket: factory }, context),
    WaapiError,
    "the connection closed under a call (code 1000)",
  );
  assertEquals(error.code, "closed");
  assertEquals(getWrittenResources(), []);
});

Deno.test("close says GOODBYE once, waits for the answer, and is idempotent", async () => {
  const { router, factory, sockets } = wwise();
  const session = await WaapiSession.connect({
    url: "ws://user:secret@wwise.example.test:8080/waapi",
    timeoutMs: 1000,
    socket: factory,
  });
  assertEquals(session.url, HOST, "userinfo is not kept");
  await session.close();
  await session.close();
  assertEquals(router.goodbyes, [[6, {}, "wamp.close.close_realm"]]);
  assertEquals(sockets[0]?.readyState, 3);
  const error = await assertRejects(
    () => session.call("ak.wwise.core.getInfo"),
    WaapiError,
    "the WAMP session is closed",
  );
  assertEquals(error.code, "closed");
});

Deno.test("every method resource validates against its declared schema", async () => {
  const { factory } = wwise();
  const { context, getWrittenResources } = testContext();
  await info.execute({ _socket: factory }, context);
  await query.execute(
    {
      waql: "$ from type Sound",
      return: ["id", "name", "Volume"],
      offset: 0,
      limit: 2,
      name: "query",
      _socket: factory,
    },
    context,
  );
  await events.execute({ offset: 0, limit: 5, _socket: factory }, context);
  await banks.execute({ offset: 0, limit: 5, _socket: factory }, context);
  await generate.execute({ ...GENERATE_ARGS, _socket: factory }, context);
  await save.execute(
    { autoCheckOutToSourceControl: true, _socket: factory },
    context,
  );
  const written = getWrittenResources();
  assertEquals(
    written.map((record) => record.specName),
    ["info", "query", "events", "banks", "generation", "save"],
  );
  assertEquals(new Set(written.map((record) => record.name)).size, 6);
  for (const record of written) {
    const spec =
      behavior.resources[record.specName as keyof typeof behavior.resources];
    const parsed = spec.schema.safeParse(record.data);
    assert(
      parsed.success,
      `${record.specName}: ${JSON.stringify(parsed.error?.issues)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Over a real WebSocket, when the test runner allows loopback network access
// ---------------------------------------------------------------------------

const NET = Deno.permissions.querySync({ name: "net", host: "127.0.0.1" })
  .state === "granted";

function serve(router: Router): {
  url: string;
  requestedProtocols: string[];
  shutdown: () => Promise<void>;
} {
  const requestedProtocols: string[] = [];
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (request) => {
      requestedProtocols.push(
        request.headers.get("sec-websocket-protocol") ?? "",
      );
      const { socket, response } = Deno.upgradeWebSocket(request, {
        protocol: "wamp.2.json",
      });
      socket.addEventListener("message", (event) => {
        router
          .handle(
            String(event.data),
            (text) => socket.send(text),
            () => socket.close(),
          )
          .catch((error) => {
            throw error;
          });
      });
      return response;
    },
  );
  return {
    url: `ws://127.0.0.1:${server.addr.port}/waapi`,
    requestedProtocols,
    shutdown: () => server.shutdown(),
  };
}

Deno.test({
  name:
    "info over Deno.serve negotiates wamp.2.json and writes the record (needs --allow-net=127.0.0.1)",
  ignore: !NET,
  fn: async () => {
    const router = new Router(wwiseProcedures());
    const server = serve(router);
    try {
      const { context, getWrittenResources } = testContext({
        host: server.url,
      });
      await info.execute({}, context);
      assertEquals(server.requestedProtocols, ["wamp.2.json"]);
      assertEquals(
        router.calls.map((call) => call.uri),
        ["ak.wwise.core.getInfo", "ak.wwise.core.getProjectInfo"],
      );
      assertEquals(router.goodbyes.length, 1);
      const data = getWrittenResources()[0]?.data ?? {};
      assertEquals(data.host, server.url);
      assertEquals((data.wwise as Record<string, unknown>).platform, "x64");
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name:
    "a deadline over a real socket fails the call and closes the connection (needs --allow-net=127.0.0.1)",
  ignore: !NET,
  fn: async () => {
    const router = new Router(
      wwiseProcedures({
        "ak.wwise.core.soundbank.generate": () => ({ hang: true }),
      }),
    );
    const server = serve(router);
    try {
      const { context, getWrittenResources } = testContext({
        host: server.url,
      });
      const error = await assertRejects(
        () =>
          generate.execute({ ...GENERATE_ARGS, deadlineSeconds: 1 }, context),
        WaapiError,
        "did not answer within 1 seconds",
      );
      assertEquals(error.code, "timeout");
      assertEquals(getWrittenResources(), []);
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test("every argument's description is written where the registry reads it", () => {
  // swamp's registry reads arguments from the source text, not the running
  // behavior: the fields written inside the schema's own `z.object({ ... })`,
  // each starting `name: z.<type>(` on one line, with its description in
  // `.describe("...")` as a double-quoted string literal. A spread, a shared
  // schema constant, a field split after `z` or written `z.iso.datetime()`
  // is left out of the registry's argument list; `.meta({ description })`, a
  // constant or a template literal leaves its description empty.
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
