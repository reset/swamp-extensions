/**
 * Records a Steam app's concurrent player count over time and summarises the
 * history. `sample` reads Steam's public, keyless Web API method
 * `ISteamUserStats/GetNumberOfCurrentPlayers/v1` once and writes the count as a
 * new version of the app's `sample` resource; `summarise` reads every recorded
 * version back and writes the minimum, maximum and latest count.
 *
 * No API key or credential is involved: the method is public. `fetch` is
 * injectable through the `_fetch` method argument so tests never reach Steam.
 *
 * @module
 */

import { z } from "npm:zod@4";

/** The Steam Web API method this behavior reads. */
export const PLAYER_COUNT_URL =
  "https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/";

/** How long one request to Steam may take before it is abandoned. */
export const REQUEST_TIMEOUT_MS = 15_000;

/** `true` only when the zod output type and the hand-written interface describe the same shape. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

const GlobalArgsSchema = z.object({
  appId: z.number().int().positive().describe(
    "Steam app id to sample, e.g. 440 for Team Fortress 2",
  ),
});

/** Global arguments of a behavior instance: the one Steam app it samples. */
export interface GlobalArgs {
  /** Steam app id. */
  appId: number;
}

const _GlobalArgsMatch: Same<z.infer<typeof GlobalArgsSchema>, GlobalArgs> =
  true;

const PointSchema = z.object({
  playerCount: z.number().int().nonnegative(),
  sampledAt: z.iso.datetime(),
});

/** A player count and the moment it was recorded. */
export interface Point {
  /** Concurrent players Steam reported. */
  playerCount: number;
  /** ISO-8601 time the count was read. */
  sampledAt: string;
}

const _PointMatch: Same<z.infer<typeof PointSchema>, Point> = true;

const SampleSchema = z.object({
  appId: z.number().int().positive(),
  playerCount: z.number().int().nonnegative(),
  sampledAt: z.iso.datetime(),
});

/** One recorded player count, as stored in one version of the `sample` resource. */
export interface Sample extends Point {
  /** Steam app id the count belongs to. */
  appId: number;
}

const _SampleMatch: Same<z.infer<typeof SampleSchema>, Sample> = true;

const SummarySchema = z.object({
  appId: z.number().int().positive(),
  samples: z.number().int().positive(),
  since: z.iso.datetime().nullable(),
  first: PointSchema,
  min: PointSchema,
  max: PointSchema,
  latest: PointSchema,
  summarisedAt: z.iso.datetime(),
});

/** The summary of an app's recorded samples. */
export interface Summary {
  /** Steam app id the samples belong to. */
  appId: number;
  /** How many samples were summarised. */
  samples: number;
  /** The lower bound on recording time, or null when every sample counted. */
  since: string | null;
  /** The earliest sample. */
  first: Point;
  /** The lowest count, the earliest one on a tie. */
  min: Point;
  /** The highest count, the earliest one on a tie. */
  max: Point;
  /** The most recent sample. */
  latest: Point;
  /** ISO-8601 time the summary was written. */
  summarisedAt: string;
}

const _SummaryMatch: Same<z.infer<typeof SummarySchema>, Summary> = true;

const SampleArgsSchema = z.object({});

const SummariseArgsSchema = z.object({
  since: z.string().pipe(z.iso.datetime()).optional().describe(
    "Only summarise samples recorded at or after this ISO-8601 time; all samples when omitted",
  ),
});

/** Arguments of the `summarise` method. */
export interface SummariseArgs {
  /** Only samples recorded at or after this ISO-8601 time count. */
  since?: string;
}

const _SummariseArgsMatch: Same<
  z.infer<typeof SummariseArgsSchema>,
  SummariseArgs
> = true;

/** The subset of `fetch` the `sample` method uses. Tests replace it. */
export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

/** Injectable dependencies, set by tests and otherwise defaulted to the runtime. */
export interface Injected {
  /** Replaces the global `fetch`. */
  _fetch?: Fetcher;
  /** Replaces the clock, returning the current time. */
  _now?: () => Date;
}

/** The logger fields this module uses, as swamp's LogTape logger provides them. */
export interface Logger {
  /** User-visible progress. */
  info(message: string, properties?: Record<string, unknown>): void;
  /** Recoverable trouble. */
  warning(message: string, properties?: Record<string, unknown>): void;
}

/** A handle swamp returns for a written record. */
export interface DataHandle {
  /** The record's data name. */
  name: string;
}

/** What a method returns to swamp. */
export interface MethodResult {
  /** Handles of the records the method wrote. */
  dataHandles: DataHandle[];
}

/** One stored record, as swamp's `queryData` returns it. */
export interface DataRecord {
  /** Version number of this record. */
  version: number;
  /** The record's parsed JSON content. */
  attributes: Record<string, unknown>;
}

/** The context fields the methods read. */
export interface MethodContext {
  /** Validated global arguments of the behavior instance. */
  globalArgs: GlobalArgs;
  /** Id of this behavior instance, used to find its own recorded samples. */
  modelId: string;
  /** Cancellation from swamp. */
  signal?: AbortSignal;
  /** Structured logger. */
  logger: Logger;
  /** Writes a validated record under a resource spec. */
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<DataHandle>;
  /** CEL query over stored data; a predicate naming `version` searches every version. */
  queryData?: (predicate: string) => Promise<unknown[]>;
}

/** The data name an app's samples are written under. */
export function sampleName(appId: number): string {
  return `app-${appId}`;
}

/** The data name an app's summary is written under. */
export function summaryName(appId: number): string {
  return `summary-${appId}`;
}

/**
 * Reads one app's current player count from Steam. Throws a specific error for
 * a network failure, a rate limit, an app Steam has no count for, or a body
 * that is not the documented shape.
 */
export async function fetchPlayerCount(
  fetcher: Fetcher,
  appId: number,
  signal?: AbortSignal,
): Promise<number> {
  const url = new URL(PLAYER_COUNT_URL);
  url.searchParams.set("appid", String(appId));
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const where = `GetNumberOfCurrentPlayers for app ${appId}`;
  let response: Response;
  try {
    response = await fetcher(url.toString(), {
      method: "GET",
      headers: { accept: "application/json" },
      signal: combined,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${where}: request failed: ${detail}`);
  }
  if (response.status === 429) {
    await response.body?.cancel();
    const retryAfter = response.headers.get("retry-after");
    throw new Error(
      `${where}: Steam rate limited the request (HTTP 429)` +
        (retryAfter ? `, retry after ${retryAfter} seconds` : ""),
    );
  }
  if (response.status >= 500) {
    const text = await response.text();
    throw new Error(
      `${where}: Steam is unavailable (HTTP ${response.status}), a transient failure, retry later: ${
        text.slice(0, 200)
      }`,
    );
  }
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(
      `${where}: HTTP ${response.status}, body is not JSON: ${
        text.slice(0, 200)
      }`,
    );
  }
  const inner = body !== null && typeof body === "object"
    ? (body as Record<string, unknown>).response
    : undefined;
  const fields = inner !== null && typeof inner === "object"
    ? inner as Record<string, unknown>
    : undefined;
  if (fields === undefined) {
    throw new Error(
      `${where}: HTTP ${response.status}, no "response" object in ${
        text.slice(0, 200)
      }`,
    );
  }
  const result = fields.result;
  const count = fields.player_count;
  if (
    response.ok && result === 1 && typeof count === "number" &&
    Number.isInteger(count) && count >= 0
  ) {
    return count;
  }
  if (result !== 1 && typeof result === "number") {
    throw new Error(
      `${where}: Steam has no player count for this app (HTTP ${response.status}, result ${result}); ` +
        "check that the app id exists on Steam",
    );
  }
  throw new Error(
    `${where}: HTTP ${response.status}, unexpected response ${
      text.slice(0, 200)
    }`,
  );
}

/**
 * Summarises samples: the first, minimum, maximum and latest count by
 * recording time. On a tie the earliest sample is kept as the minimum or
 * maximum. Throws when there are no samples.
 */
export function summarise(
  appId: number,
  samples: readonly Sample[],
  since: string | null,
  summarisedAt: string,
): Summary {
  if (samples.length === 0) {
    throw new Error(`No samples to summarise for app ${appId}`);
  }
  const ordered = [...samples].sort((a, b) =>
    Date.parse(a.sampledAt) - Date.parse(b.sampledAt)
  );
  const point = (sample: Sample): Point => ({
    playerCount: sample.playerCount,
    sampledAt: sample.sampledAt,
  });
  let min = ordered[0];
  let max = ordered[0];
  for (const sample of ordered) {
    if (sample.playerCount < min.playerCount) {
      min = sample;
    }
    if (sample.playerCount > max.playerCount) {
      max = sample;
    }
  }
  return {
    appId,
    samples: ordered.length,
    since,
    first: point(ordered[0]),
    min: point(min),
    max: point(max),
    latest: point(ordered[ordered.length - 1]),
    summarisedAt,
  };
}

/** The Steam concurrent players behavior. */
export const behavior = {
  type: "@reset/steam-players",
  version: "2026.10.30.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    sample: {
      description:
        "One app's concurrent player count at one moment; every sample is a new version",
      schema: SampleSchema,
      lifetime: "infinite",
      garbageCollection: "365d",
    },
    summary: {
      description:
        "The first, minimum, maximum and latest of an app's recorded player counts",
      schema: SummarySchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    sample: {
      description:
        "Read the app's current player count from Steam's public Web API and record it as a new version",
      arguments: SampleArgsSchema,
      execute: async (
        args: Injected,
        context: MethodContext,
      ): Promise<MethodResult> => {
        const { globalArgs, logger } = context;
        const fetcher = args._fetch ?? globalThis.fetch;
        const now = args._now ?? (() => new Date());
        logger.info("Reading the current player count of app {appId}", {
          appId: globalArgs.appId,
        });
        const playerCount = await fetchPlayerCount(
          fetcher,
          globalArgs.appId,
          context.signal,
        );
        const data: Sample = {
          appId: globalArgs.appId,
          playerCount,
          sampledAt: now().toISOString(),
        };
        const handle = await context.writeResource(
          "sample",
          sampleName(globalArgs.appId),
          { ...data },
        );
        logger.info("App {appId} has {playerCount} players", {
          appId: globalArgs.appId,
          playerCount,
        });
        return { dataHandles: [handle] };
      },
    },
    summarise: {
      description:
        "Summarise the recorded samples: count, first, minimum, maximum and latest player count",
      arguments: SummariseArgsSchema,
      execute: async (
        args: SummariseArgs & Injected,
        context: MethodContext,
      ): Promise<MethodResult> => {
        const { globalArgs, logger } = context;
        const now = args._now ?? (() => new Date());
        const since = args.since ?? null;
        if (context.queryData === undefined) {
          throw new Error(
            "summarise needs swamp's queryData to read the recorded samples; upgrade swamp",
          );
        }
        logger.info("Reading the recorded samples of app {appId}", {
          appId: globalArgs.appId,
        });
        const name = sampleName(globalArgs.appId);
        const predicate = `modelId == ${JSON.stringify(context.modelId)} && ` +
          `specName == "sample" && name == ${
            JSON.stringify(name)
          } && version >= 0`;
        const records = await context.queryData(predicate);
        const sinceMs = since === null ? -Infinity : Date.parse(since);
        const samples: Sample[] = [];
        let skipped = 0;
        for (const record of records) {
          const attributes = record !== null && typeof record === "object"
            ? (record as Partial<DataRecord>).attributes
            : undefined;
          const parsed = SampleSchema.safeParse(attributes);
          if (!parsed.success || parsed.data.appId !== globalArgs.appId) {
            skipped += 1;
            continue;
          }
          if (Date.parse(parsed.data.sampledAt) >= sinceMs) {
            samples.push(parsed.data);
          }
        }
        if (skipped > 0) {
          logger.warning(
            "Skipped {skipped} stored samples that are not a sample of app {appId}",
            { skipped, appId: globalArgs.appId },
          );
        }
        if (samples.length === 0) {
          throw new Error(
            `No samples of app ${globalArgs.appId} recorded` +
              (since === null ? "" : ` since ${since}`) +
              "; run the sample method first",
          );
        }
        const data = summarise(
          globalArgs.appId,
          samples,
          since,
          now().toISOString(),
        );
        const handle = await context.writeResource(
          "summary",
          summaryName(globalArgs.appId),
          { ...data },
        );
        logger.info(
          "Summarised {samples} samples of app {appId}: min {min}, max {max}, latest {latest}",
          {
            samples: data.samples,
            appId: globalArgs.appId,
            min: data.min.playerCount,
            max: data.max.playerCount,
            latest: data.latest.playerCount,
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
  upgrades: [
    {
      toVersion: "2026.10.30.1",
      description:
        "Moved to the swamp-extensions repository, which is now the extension's published home; arguments and behavior unchanged",
      upgradeAttributes: (old: Record<string, unknown>): Record<
        string,
        unknown
      > => old,
    },
  ],
};
