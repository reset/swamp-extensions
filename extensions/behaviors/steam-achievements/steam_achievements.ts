/**
 * Records a Steam app's global achievement unlock percentages over time and
 * summarises the history. `sample` reads Steam's public, keyless Web API method
 * `ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2` once and writes
 * every achievement's percentage as a new version of the app's `sample`
 * resource; `summarise` reads every recorded version back and writes, per
 * achievement, its first and latest percentage and the change, the rarest and
 * most common achievements, and those added or removed since the first sample.
 *
 * No API key or credential is involved: the method is public. The schema
 * method that carries display names needs a key, so achievements are named by
 * their API names. `fetch` is injectable through the `_fetch` method argument
 * so tests never reach Steam.
 *
 * @module
 */

import { z } from "npm:zod@4";

/** The Steam Web API method this behavior reads; the app id is passed as `gameid`. */
export const PERCENTAGES_URL =
  "https://api.steampowered.com/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/";

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

const AchievementSchema = z.object({
  name: z.string().min(1),
  percent: z.number().min(0).max(100),
});

/** One achievement and the share of the app's players who have unlocked it. */
export interface Achievement {
  /** The achievement's API name, e.g. "TF_KILL_NEMESIS". */
  name: string;
  /** Percentage of players who have unlocked it, 0 to 100. */
  percent: number;
}

const _AchievementMatch: Same<z.infer<typeof AchievementSchema>, Achievement> =
  true;

const SampleSchema = z.object({
  appId: z.number().int().positive(),
  count: z.number().int().positive(),
  achievements: z.array(AchievementSchema).min(1),
  sampledAt: z.iso.datetime(),
});

/** One recorded reading, as stored in one version of the `sample` resource. */
export interface Sample {
  /** Steam app id the achievements belong to. */
  appId: number;
  /** How many achievements Steam reported. */
  count: number;
  /** Every achievement and its percentage, in Steam's order, most common first. */
  achievements: Achievement[];
  /** ISO-8601 time the percentages were read. */
  sampledAt: string;
}

const _SampleMatch: Same<z.infer<typeof SampleSchema>, Sample> = true;

const TrendSchema = z.object({
  name: z.string().min(1),
  first: z.number().min(0).max(100),
  firstSeenAt: z.iso.datetime(),
  latest: z.number().min(0).max(100),
  lastSeenAt: z.iso.datetime(),
  change: z.number().min(-100).max(100),
});

/** One achievement across the summarised samples. */
export interface Trend {
  /** The achievement's API name. */
  name: string;
  /** Its percentage in the earliest sample that has it. */
  first: number;
  /** When that earliest sample was recorded. */
  firstSeenAt: string;
  /** Its percentage in the most recent sample that has it. */
  latest: number;
  /** When that most recent sample was recorded. */
  lastSeenAt: string;
  /** `latest` minus `first`, in percentage points, rounded to six decimals. */
  change: number;
}

const _TrendMatch: Same<z.infer<typeof TrendSchema>, Trend> = true;

const SummarySchema = z.object({
  appId: z.number().int().positive(),
  samples: z.number().int().positive(),
  since: z.iso.datetime().nullable(),
  firstSampledAt: z.iso.datetime(),
  latestSampledAt: z.iso.datetime(),
  count: z.number().int().positive(),
  rarest: AchievementSchema,
  mostCommon: AchievementSchema,
  added: z.array(z.string()),
  removed: z.array(z.string()),
  achievements: z.array(TrendSchema),
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
  /** When the earliest summarised sample was recorded. */
  firstSampledAt: string;
  /** When the most recent summarised sample was recorded. */
  latestSampledAt: string;
  /** How many achievements the most recent sample has. */
  count: number;
  /** The lowest percentage in the most recent sample, the first by name on a tie. */
  rarest: Achievement;
  /** The highest percentage in the most recent sample, the first by name on a tie. */
  mostCommon: Achievement;
  /** Names in the most recent sample that the earliest sample lacks, sorted. */
  added: string[];
  /** Names in the earliest sample that the most recent sample lacks, sorted. */
  removed: string[];
  /** Every achievement seen in any summarised sample, sorted by name. */
  achievements: Trend[];
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

/** The URL `sample` requests for one app. */
export function percentagesUrl(appId: number): string {
  const url = new URL(PERCENTAGES_URL);
  url.searchParams.set("gameid", String(appId));
  return url.toString();
}

/**
 * A percentage as Steam sends it, a decimal string such as "49.5" (a number is
 * accepted too), or undefined when it is not a finite value from 0 to 100.
 */
export function parsePercent(value: unknown): number | undefined {
  let parsed: number;
  if (typeof value === "number") {
    parsed = value;
  } else if (typeof value === "string" && /^\d+(\.\d+)?$/.test(value)) {
    parsed = Number(value);
  } else {
    return undefined;
  }
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100
    ? parsed
    : undefined;
}

/** A difference of two percentages without the float noise of one-decimal inputs. */
function difference(latest: number, first: number): number {
  return Math.round((latest - first) * 1e6) / 1e6;
}

/**
 * Reads one app's global achievement percentages from Steam. Throws a specific
 * error for a network failure, a rate limit, a server error, an app Steam has
 * no achievement statistics for, or a body that is not the documented shape.
 */
export async function fetchPercentages(
  fetcher: Fetcher,
  appId: number,
  signal?: AbortSignal,
): Promise<Achievement[]> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const where = `GetGlobalAchievementPercentagesForApp for app ${appId}`;
  let response: Response;
  try {
    response = await fetcher(percentagesUrl(appId), {
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
  if (response.status === 403 || response.status === 404) {
    throw new Error(
      `${where}: Steam has no public achievement statistics for this app (HTTP ${response.status}); check that the app id exists and has achievements`,
    );
  }
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
  const top = body !== null && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : undefined;
  const wrapper = top?.achievementpercentages;
  const list = wrapper !== null && typeof wrapper === "object"
    ? (wrapper as Record<string, unknown>).achievements
    : undefined;
  if (!response.ok || !Array.isArray(list)) {
    throw new Error(
      `${where}: HTTP ${response.status}, no "achievementpercentages.achievements" array in ${
        text.slice(0, 200)
      }`,
    );
  }
  if (list.length === 0) {
    throw new Error(
      `${where}: Steam reported no achievements for this app; check that the app id exists and has achievements`,
    );
  }
  const seen = new Set<string>();
  const achievements: Achievement[] = [];
  for (const entry of list) {
    const fields = entry !== null && typeof entry === "object"
      ? entry as Record<string, unknown>
      : undefined;
    const name = fields?.name;
    const percent = parsePercent(fields?.percent);
    if (typeof name !== "string" || name === "" || percent === undefined) {
      throw new Error(
        `${where}: HTTP ${response.status}, unexpected achievement ${
          JSON.stringify(entry).slice(0, 200)
        }`,
      );
    }
    if (seen.has(name)) {
      throw new Error(
        `${where}: HTTP ${response.status}, achievement ${name} appears twice`,
      );
    }
    seen.add(name);
    achievements.push({ name, percent });
  }
  return achievements;
}

/** The lowest or highest percentage, the first by name on a tie. */
function extreme(
  achievements: readonly Achievement[],
  better: (candidate: number, best: number) => boolean,
): Achievement | undefined {
  let best: Achievement | undefined;
  for (const achievement of achievements) {
    if (
      best === undefined || better(achievement.percent, best.percent) ||
      (achievement.percent === best.percent && achievement.name < best.name)
    ) {
      best = achievement;
    }
  }
  return best === undefined ? undefined : { ...best };
}

/**
 * Summarises samples: per achievement its first and latest percentage and the
 * change, the rarest and most common achievements of the most recent sample,
 * and the names added or removed between the earliest and the most recent
 * sample. Throws when there are no samples.
 */
export function summarise(
  appId: number,
  samples: readonly Sample[],
  since: string | null,
  summarisedAt: string,
): Summary {
  const ordered = [...samples].sort((a, b) =>
    Date.parse(a.sampledAt) - Date.parse(b.sampledAt)
  );
  const first = ordered[0];
  const latest = ordered[ordered.length - 1];
  if (first === undefined || latest === undefined) {
    throw new Error(`No samples to summarise for app ${appId}`);
  }
  const trends = new Map<string, Trend>();
  for (const sample of ordered) {
    for (const { name, percent } of sample.achievements) {
      const trend = trends.get(name);
      if (trend === undefined) {
        trends.set(name, {
          name,
          first: percent,
          firstSeenAt: sample.sampledAt,
          latest: percent,
          lastSeenAt: sample.sampledAt,
          change: 0,
        });
      } else {
        trend.latest = percent;
        trend.lastSeenAt = sample.sampledAt;
        trend.change = difference(percent, trend.first);
      }
    }
  }
  const rarest = extreme(latest.achievements, (a, b) => a < b);
  const mostCommon = extreme(latest.achievements, (a, b) => a > b);
  if (rarest === undefined || mostCommon === undefined) {
    throw new Error(
      `The sample of app ${appId} at ${latest.sampledAt} has no achievements`,
    );
  }
  const firstNames = new Set(first.achievements.map(({ name }) => name));
  const latestNames = new Set(latest.achievements.map(({ name }) => name));
  const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return {
    appId,
    samples: ordered.length,
    since,
    firstSampledAt: first.sampledAt,
    latestSampledAt: latest.sampledAt,
    count: latest.achievements.length,
    rarest,
    mostCommon,
    added: [...latestNames].filter((name) => !firstNames.has(name)).sort(
      byName,
    ),
    removed: [...firstNames].filter((name) => !latestNames.has(name)).sort(
      byName,
    ),
    achievements: [...trends.values()].sort((a, b) => byName(a.name, b.name)),
    summarisedAt,
  };
}

/** The Steam global achievement percentage behavior. */
export const behavior = {
  type: "@reset/steam-achievements",
  version: "2026.10.30.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    sample: {
      description:
        "One app's global achievement unlock percentages at one moment; every sample is a new version",
      schema: SampleSchema,
      lifetime: "infinite",
      garbageCollection: "365d",
    },
    summary: {
      description:
        "Per achievement the first and latest percentage and the change, the rarest and most common, and the achievements added or removed",
      schema: SummarySchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    sample: {
      description:
        "Read the app's global achievement percentages from Steam's public Web API and record them as a new version",
      arguments: SampleArgsSchema,
      execute: async (
        args: Injected,
        context: MethodContext,
      ): Promise<MethodResult> => {
        const { globalArgs, logger } = context;
        const fetcher = args._fetch ?? globalThis.fetch;
        const now = args._now ?? (() => new Date());
        logger.info(
          "Reading the global achievement percentages of app {appId}",
          {
            appId: globalArgs.appId,
          },
        );
        const achievements = await fetchPercentages(
          fetcher,
          globalArgs.appId,
          context.signal,
        );
        const data: Sample = {
          appId: globalArgs.appId,
          count: achievements.length,
          achievements,
          sampledAt: now().toISOString(),
        };
        const handle = await context.writeResource(
          "sample",
          sampleName(globalArgs.appId),
          { ...data },
        );
        logger.info("App {appId} has {count} achievements", {
          appId: globalArgs.appId,
          count: data.count,
        });
        return { dataHandles: [handle] };
      },
    },
    summarise: {
      description:
        "Summarise the recorded samples: per achievement first, latest and change, the rarest and most common, and those added or removed",
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
          "Summarised {samples} samples of app {appId}: rarest {rarest} at {rarestPercent}%, {added} added, {removed} removed",
          {
            samples: data.samples,
            appId: globalArgs.appId,
            rarest: data.rarest.name,
            rarestPercent: data.rarest.percent,
            added: data.added.length,
            removed: data.removed.length,
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
