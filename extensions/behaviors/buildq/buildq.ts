/**
 * A Swamp behavior for buildq's HTTP API, a self-hosted continuous-integration
 * coordinator in Buildkite's shape. It lists and reads builds, reads a job's
 * log tail, artifacts and annotations, reads the queue and the agents, lists
 * an organization's builds, and rebuilds, cancels and unblocks builds. Every
 * method writes what it read as a resource, so a workflow can assert on it
 * with CEL. Resources keep ids, states, timestamps, durations and one-line
 * summaries only: never who pushed, asked for or answered a build.
 *
 * @module
 */

import { z } from "npm:zod@4";

const ACCESS_ID_HEADER = "CF-Access-Client-Id";
const ACCESS_SECRET_HEADER = "CF-Access-Client-Secret";

/** buildq lists 50 builds unless a limit is given. */
const BUILDS_PAGE_SIZE = 50;
/** buildq lists at most 500 builds across repositories. */
const BUILDS_LIMIT = 500;
/** KiB of a job's log the `log` method keeps unless told otherwise. */
const LOG_TAIL_KIB = 64;
/** Most KiB of a job's log the `log` method keeps. */
const LOG_TAIL_KIB_LIMIT = 4096;
/** Longest one-line summary, prompt or subject a resource keeps. */
const LINE_LIMIT = 300;
/** Longest annotation body a resource keeps. */
const BODY_LIMIT = 2000;

/** The states a job can be in, as the API names them. */
const JOB_STATES = [
  "scheduled",
  "assigned",
  "running",
  "canceling",
  "passed",
  "failed",
  "canceled",
  "skipped",
  "blocked",
  "unblocked",
  "broken",
] as const;

/** Job states that fail nothing and hold nothing open: an answered block. */
const SETTLED_STATES = ["passed", "unblocked"];

/** The states a build has ended in. */
const FINISHED_STATES = ["passed", "failed", "canceled", "skipped"];

/** What a status code means when the answer carries no message of its own. */
const STATUS_HINTS: Record<number, string> = {
  401: "no credential was sent, or buildq did not take it: reads send " +
    "apiToken, rebuild, cancel and unblock the forge token",
  403: "the credential may not do this: a read-scoped apiToken reads only " +
    "builds and one build, a block is answered only with a forge token, " +
    "and the forge token needs read:user and an owner who is a buildq user " +
    "and can push to the repository",
  404: "no such build, job, pipeline or organization, or apiToken may not " +
    "see it",
  409: "the build has ended, or the block is not waiting for an answer",
  422: "the request names something the build or the forge does not have",
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Global arguments every method reads from the behavior definition. */
export interface GlobalArgs {
  /** Base URL of the coordinator, such as https://buildq.example.net. */
  host: string;
  /** Forge owner of the repository, with `repo`. */
  owner?: string;
  /** Name of the repository, with `owner`. */
  repo?: string;
  /** Organization slug, with `pipeline`; also the default of org-builds. */
  organization?: string;
  /** Pipeline slug, with `organization`. */
  pipeline?: string;
  /**
   * buildq API token sent as `Authorization: Bearer` on every request but
   * rebuild, cancel and unblock: a management token or a personal token.
   * Sensitive.
   */
  apiToken?: string;
  /** Forge token sent as `Authorization: token` on writes. Sensitive. */
  token?: string;
  /** Cloudflare Access service token id, with `accessClientSecret`. */
  accessClientId?: string;
  /** Cloudflare Access service token secret. Sensitive. */
  accessClientSecret?: string;
}

/** The logger methods this behavior calls. */
export interface Logger {
  /** Internal detail, such as a request made. */
  debug(message: string, ...args: unknown[]): void;
  /** What a method is about to do and what it did. */
  info(message: string, ...args: unknown[]): void;
  /** A recoverable oddity in an answer. */
  warning(message: string, ...args: unknown[]): void;
}

/** The handle a resource or file write returns. */
export interface DataHandle {
  /** Instance name of the written data. */
  name: string;
}

/** The file writer methods this behavior calls. */
export interface FileWriter {
  /** Writes the whole file as UTF-8 text and returns its handle. */
  writeText(text: string): Promise<DataHandle>;
}

/** The parts of Swamp's method context this behavior uses. */
export interface Context {
  /** Parsed global arguments of the behavior definition. */
  globalArgs: GlobalArgs;
  /** Cancels requests in flight when the run is cancelled. */
  signal: AbortSignal;
  /** Structured logger. */
  logger: Logger;
  /** Writes a resource validated against its spec and returns its handle. */
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<DataHandle>;
  /** Opens a file of a spec for writing. */
  createFileWriter: (specName: string, name: string) => FileWriter;
}

/** What every method returns. */
export interface MethodResult {
  /** Handles of the resources and files the method wrote. */
  dataHandles: DataHandle[];
}

/** One phase of a job's run, as the agent timed it. */
export interface Phase {
  /** fetch, lfs, checkout, command, artifacts, cleanup or upload. */
  name: string;
  /** When the phase started, ISO 8601. */
  startedAt: string;
  /** When it ended; absent for one still running when the agent reported. */
  finishedAt?: string;
  /** Its length in seconds, when it ended. */
  seconds?: number;
}

/** One job of a build, as the `build` and `builds` resources keep it. */
export interface Job {
  /** The job's id, `<build>.<n>`. */
  id: string;
  /** The job's name: `make ci`, or the step's label. */
  name: string;
  /** scheduled, assigned, running, canceling, passed, failed, canceled, skipped or broken. */
  state: string;
  /** script, or manual for a block. */
  type: string;
  /** Whether the job neither holds the build open nor fails it. */
  optional: boolean;
  /** Exit code of the check, when one exited. */
  exitStatus?: number;
  /** Why a job failed without its check deciding it, when it did. */
  signalReason?: string;
  /** One line on why the job ended as it did, or what it waits on. */
  summary?: string;
  /** When the job was queued for an agent, ISO 8601. */
  runnableAt?: string;
  /** When an agent started it, ISO 8601. */
  started?: string;
  /** When it ended, ISO 8601. */
  finished?: string;
  /** Name of the agent that ran it. */
  agent?: string;
  /** linux, macos or windows. */
  platform?: string;
  /** A block's key. */
  key?: string;
  /** A block's prompt, cut to 300 characters. */
  prompt?: string;
  /** Keys of a block's fields, in order. */
  fieldKeys?: string[];
  /** Whether a block has been answered. Who answered is never kept. */
  unblocked?: boolean;
  /** When a block was answered, ISO 8601. */
  unblockedAt?: string;
  /** Whether a step's automatic retry took the job again. */
  retried?: boolean;
  /** How many times it was retried. */
  retriesCount?: number;
  /** Whether a step's soft_fail forgave the failure. */
  softFailed?: boolean;
  /** The claim a remote agent runs it under, for finding it in the agent's journal. */
  lease?: string;
  /** The agent's latest report while it holds the job, ISO 8601. */
  lastSeen?: string;
  /** When the log last gained content while the job runs, ISO 8601. */
  lastOutput?: string;
  /** Seconds between runnableAt and started. */
  waitSeconds?: number;
  /** Seconds between started and finished. */
  durationSeconds?: number;
  /** The phases the run went through, in order, once the agent reported. */
  phases?: Phase[];
}

/** One build, as the `build` and `builds` resources keep it. */
export interface Build {
  /** The build's number. */
  number: number;
  /** Branch built. */
  branch: string;
  /** Full ref built, when reported. */
  ref?: string;
  /** Commit built. */
  commit: string;
  /** First line of the commit's message. */
  subject: string;
  /** scheduled, running, blocked, failing, failed, canceling, canceled, skipped or passed. */
  state: string;
  /** Whether a block waits for a person. */
  blocked: boolean;
  /** When the build was recorded, ISO 8601. */
  created: string;
  /** When its first job started, ISO 8601. */
  started?: string;
  /** When it ended, ISO 8601. */
  finished?: string;
  /** webhook, api or ui, when reported. */
  source?: string;
  /** Number of the build this one is a rebuild of. */
  rebuiltFrom?: number;
  /** Forge owner, when the API names it. */
  owner?: string;
  /** Repository name, when the API names it. */
  repo?: string;
  /** Organization slug, for a build under a pipeline. */
  organization?: string;
  /** Pipeline slug, for a build under a pipeline. */
  pipeline?: string;
  /** Seconds between started and finished. */
  durationSeconds?: number;
  /** The build's jobs, in the order their steps run. */
  jobs: Job[];
}

/** A job reduced to what a workflow asserts on. */
export interface JobSummary {
  /** The job's id. */
  id: string;
  /** The job's name. */
  name: string;
  /** The job's state. */
  state: string;
  /** Whether the job is optional. */
  optional: boolean;
  /** Exit code of the check, when one exited. */
  exitStatus?: number;
  /** Why it failed without its check deciding it, when it did. */
  signalReason?: string;
  /** One line on why the job ended as it did. */
  summary?: string;
  /** Seconds waited for an agent. */
  waitSeconds?: number;
  /** Seconds the job ran. */
  durationSeconds?: number;
  /** Seconds per phase, by name, for the phases that ended. */
  phaseSeconds: Record<string, number>;
}

/** Job counts by state. */
export type JobStateCounts = Record<(typeof JOB_STATES)[number], number>;

/** A build reduced to what a workflow asserts on. */
export interface BuildSummary {
  /** The build's number. */
  number: number;
  /** Branch built. */
  branch: string;
  /** Commit built. */
  commit: string;
  /** The build's state. */
  state: string;
  /** Whether a block waits for a person. */
  blocked: boolean;
  /** Whether the state is passed. */
  passed: boolean;
  /** Whether the state is passed, failed, canceled or skipped. */
  finished: boolean;
  /** Seconds between started and finished. */
  durationSeconds?: number;
  /** Counts of jobs by state. */
  jobStates: JobStateCounts;
  /** Required jobs in state failed. */
  failedJobs: number;
  /** The first required job that is not passed, in one line. */
  reason?: string;
  /** The jobs. */
  jobs: JobSummary[];
}

/** One kept artifact. */
export interface Artifact {
  /** Path under out/artifacts/ as the job left it. */
  path: string;
  /** URL that serves it. */
  url: string;
}

/** One annotation a job left. */
export interface Annotation {
  /** The annotation's context, its name within the build. */
  context: string;
  /** success, info, warning or error. */
  style: string;
  /** The body, cut to 2000 characters. */
  body: string;
}

/** A job an agent holds, as the `queue` resource keeps it. */
export interface RunningJob {
  /** Forge owner. */
  owner: string;
  /** Repository name. */
  repo: string;
  /** Build number. */
  build: number;
  /** Job id. */
  job: string;
  /** The job's label. */
  label?: string;
  /** Branch built. */
  branch?: string;
  /** Commit built. */
  commit?: string;
  /** Commit subject. */
  subject?: string;
  /** Platform the job needs. */
  platform?: string;
  /** Name of the agent holding it. */
  agent?: string;
  /** When it started, ISO 8601. */
  started?: string;
  /** The agent's latest report, ISO 8601. */
  lastSeen?: string;
  /** When its log last gained content, ISO 8601. */
  lastOutput?: string;
  /** The claim the agent runs it under. */
  lease?: string;
}

/** A job waiting for an agent, as the `queue` resource keeps it. */
export interface WaitingJob {
  /** Forge owner. */
  owner: string;
  /** Repository name. */
  repo: string;
  /** Build number. */
  build: number;
  /** Job id. */
  job: string;
  /** The job's label. */
  label?: string;
  /** Branch built. */
  branch?: string;
  /** Commit built. */
  commit?: string;
  /** Commit subject. */
  subject?: string;
  /** Platform the job needs. */
  platform?: string;
  /** Its place in the order agents take jobs, 1 next. */
  position?: number;
  /** When it became runnable, ISO 8601. */
  queued?: string;
  /** Why no agent that could run it has, beyond waiting its turn. */
  heldBack?: string;
}

/** One agent, as the `agents` resource keeps it. */
export interface Agent {
  /** The agent's name. */
  name: string;
  /** connected or disconnected. */
  connectionState: string;
  /** Whether it holds a job. */
  busy: boolean;
  /** Its latest report, ISO 8601. */
  lastSeen?: string;
  /** Its tags, `key=value`, the OS first. */
  metaData: string[];
  /** The machine it runs on. */
  host?: string;
  /** The OS user it runs as. */
  owner?: string;
  /** Its systemd unit. */
  unit?: string;
  /** The job it holds. */
  job?: RunningJob;
}

/** Arguments of the `builds` method. */
export interface BuildsArgs {
  /** How many builds to list, newest first. */
  limit: number;
  /** Only builds of this branch. */
  branch?: string;
  /** Only builds whose commit starts with this prefix. */
  commit?: string;
}

/** Arguments naming one build. */
export interface BuildArgs {
  /** The build's number. */
  number: number;
}

/** Arguments of the `log` method. */
export interface LogArgs extends BuildArgs {
  /** The job's id. Defaults to the build's first job, `<number>.1`. */
  job?: string;
  /** How many KiB of the log's end to keep. */
  tailKiB: number;
}

/** Arguments of the `org-builds` method. */
export interface OrgBuildsArgs {
  /** Organization slug. Falls back to the global organization. */
  organization?: string;
  /** How many builds to list, newest first. */
  limit: number;
}

/** Arguments of the `unblock` method. */
export interface UnblockArgs extends BuildArgs {
  /** The block's job id. */
  job: string;
  /** A value per field key. A field left out takes its default. */
  fields: Record<string, string>;
}

/** One request to the API. */
export interface RequestOptions {
  /** HTTP method. */
  method: "GET" | "POST" | "PUT";
  /** Path under the host, starting with /api/. */
  path: string;
  /** Query parameters. Undefined values are left out. */
  query?: Record<string, string | number | undefined>;
  /** JSON body for POST and PUT. */
  body?: Record<string, unknown>;
  /**
   * Whether to send the forge token, which only rebuild, cancel and unblock
   * take, instead of the API token every other request sends.
   */
  authorize?: boolean;
  /** Whether to return the body as text rather than parsed JSON. */
  text?: boolean;
  /** Error statuses to return rather than throw, with their body. */
  accept?: number[];
}

/** An answer from the API. */
export interface Answer {
  /** HTTP status. */
  status: number;
  /** The parsed JSON body, or the text when `text` was asked for. */
  body: unknown;
}

/** An answer the API refused, with its HTTP status. */
export class BuildqError extends Error {
  /** HTTP status of the answer. */
  readonly status: number;

  /** Builds the error. */
  constructor(message: string, status: number) {
    super(message);
    this.name = "BuildqError";
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Schemas (private: the exported interfaces above are the public types, and
// `satisfies` keeps each schema in step with its interface)
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  host: z.url()
    .describe(
      "Base URL of the coordinator, such as https://buildq.example.net.",
    ),
  owner: z.string()
    .min(1)
    .optional()
    .describe("Forge owner of the repository, with repo."),
  repo: z.string()
    .min(1)
    .optional()
    .describe("Name of the repository, with owner."),
  organization: z.string()
    .min(1)
    .optional()
    .describe(
      "Organization slug, with pipeline: builds are then read under /api/v2/organizations. Also the default of org-builds.",
    ),
  pipeline: z.string()
    .min(1)
    .optional()
    .describe("Pipeline slug, with organization."),
  apiToken: z.string()
    .min(1)
    .optional()
    .meta({ sensitive: true })
    .describe(
      "buildq API token, sent as Authorization: Bearer on every request but rebuild, cancel and unblock, and needed by every method: a management token of the organization or a personal token (pt_). A read-scoped management token reads only builds, one build and the pipeline lookup, not logs, artifacts, annotations, the queue or the agents.",
    ),
  token: z.string()
    .min(1)
    .optional()
    .meta({ sensitive: true })
    .describe(
      "Forge token sent as Authorization: token on rebuild, cancel and unblock, the only requests buildq takes it on. It needs read:user, and its owner must be a buildq user who can push to the repository.",
    ),
  accessClientId: z.string()
    .min(1)
    .optional()
    .describe(
      "Cloudflare Access service token id, sent as CF-Access-Client-Id on every request, for a coordinator Cloudflare Access still stands in front of. buildq does not take it as a credential: reads still need apiToken.",
    ),
  accessClientSecret: z.string()
    .min(1)
    .optional()
    .meta({ sensitive: true })
    .describe("Cloudflare Access service token secret."),
})
  .refine(
    (value) => (value.owner === undefined) === (value.repo === undefined),
    {
      message: "Give owner and repo together.",
    },
  )
  .refine(
    (value) =>
      (value.organization === undefined) === (value.pipeline === undefined) ||
      value.pipeline === undefined,
    { message: "pipeline needs organization." },
  )
  .refine(
    (value) =>
      (value.accessClientId === undefined) ===
        (value.accessClientSecret === undefined),
    { message: "Give accessClientId and accessClientSecret together." },
  ) satisfies z.ZodType<GlobalArgs>;

const BuildArgsSchema = z.object({
  number: z.number().int().positive().describe("The build's number."),
}) satisfies z.ZodType<BuildArgs>;

const BuildsArgsSchema = z.object({
  limit: z.number()
    .int()
    .min(1)
    .max(BUILDS_LIMIT)
    .default(BUILDS_PAGE_SIZE)
    .describe("How many builds to list, newest first."),
  branch: z.string().min(1).optional().describe("Only builds of this branch."),
  commit: z.string()
    .min(1)
    .optional()
    .describe("Only builds whose commit starts with this prefix."),
}) satisfies z.ZodType<BuildsArgs>;

const LogArgsSchema = z.object({
  number: z.number().int().positive().describe("The build's number."),
  job: z.string()
    .min(1)
    .optional()
    .describe("The job's id, such as 13.1. Defaults to the build's first job."),
  tailKiB: z.number()
    .int()
    .min(1)
    .max(LOG_TAIL_KIB_LIMIT)
    .default(LOG_TAIL_KIB)
    .describe("How many KiB of the log's end to keep."),
}) satisfies z.ZodType<LogArgs>;

const OrgBuildsArgsSchema = z.object({
  organization: z.string()
    .min(1)
    .optional()
    .describe("Organization slug. Falls back to the global organization."),
  limit: z.number()
    .int()
    .min(1)
    .max(BUILDS_LIMIT)
    .default(BUILDS_PAGE_SIZE)
    .describe("How many builds to list, newest first."),
}) satisfies z.ZodType<OrgBuildsArgs>;

const UnblockArgsSchema = z.object({
  number: z.number().int().positive().describe("The build's number."),
  job: z.string().min(1).describe("The block's job id, such as 13.2."),
  fields: z.record(z.string(), z.string())
    .describe("A value per field key. A field left out takes its default."),
}) satisfies z.ZodType<UnblockArgs>;

const PhaseSchema = z.object({
  name: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  seconds: z.number().optional(),
}) satisfies z.ZodType<Phase>;

const JobSchema = z.object({
  id: z.string(),
  name: z.string(),
  state: z.string(),
  type: z.string(),
  optional: z.boolean(),
  exitStatus: z.number().int().optional(),
  signalReason: z.string().optional(),
  summary: z.string().optional(),
  runnableAt: z.string().optional(),
  started: z.string().optional(),
  finished: z.string().optional(),
  agent: z.string().optional(),
  platform: z.string().optional(),
  key: z.string().optional(),
  prompt: z.string().optional(),
  fieldKeys: z.array(z.string()).optional(),
  unblocked: z.boolean().optional(),
  unblockedAt: z.string().optional(),
  retried: z.boolean().optional(),
  retriesCount: z.number().int().optional(),
  softFailed: z.boolean().optional(),
  lease: z.string().optional(),
  lastSeen: z.string().optional(),
  lastOutput: z.string().optional(),
  waitSeconds: z.number().optional(),
  durationSeconds: z.number().optional(),
  phases: z.array(PhaseSchema).optional(),
}) satisfies z.ZodType<Job>;

const BuildSchema = z.object({
  number: z.number().int(),
  branch: z.string(),
  ref: z.string().optional(),
  commit: z.string(),
  subject: z.string(),
  state: z.string(),
  blocked: z.boolean(),
  created: z.string(),
  started: z.string().optional(),
  finished: z.string().optional(),
  source: z.string().optional(),
  rebuiltFrom: z.number().int().optional(),
  owner: z.string().optional(),
  repo: z.string().optional(),
  organization: z.string().optional(),
  pipeline: z.string().optional(),
  durationSeconds: z.number().optional(),
  jobs: z.array(JobSchema),
}) satisfies z.ZodType<Build>;

const JobSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  state: z.string(),
  optional: z.boolean(),
  exitStatus: z.number().int().optional(),
  signalReason: z.string().optional(),
  summary: z.string().optional(),
  waitSeconds: z.number().optional(),
  durationSeconds: z.number().optional(),
  phaseSeconds: z.record(z.string(), z.number()),
}) satisfies z.ZodType<JobSummary>;

const JobStateCountsSchema = z.object({
  scheduled: z.number().int(),
  assigned: z.number().int(),
  running: z.number().int(),
  canceling: z.number().int(),
  passed: z.number().int(),
  failed: z.number().int(),
  canceled: z.number().int(),
  skipped: z.number().int(),
  blocked: z.number().int(),
  unblocked: z.number().int(),
  broken: z.number().int(),
}) satisfies z.ZodType<JobStateCounts>;

const BuildSummarySchema = z.object({
  number: z.number().int(),
  branch: z.string(),
  commit: z.string(),
  state: z.string(),
  blocked: z.boolean(),
  passed: z.boolean(),
  finished: z.boolean(),
  durationSeconds: z.number().optional(),
  jobStates: JobStateCountsSchema,
  failedJobs: z.number().int(),
  reason: z.string().optional(),
  jobs: z.array(JobSummarySchema),
}) satisfies z.ZodType<BuildSummary>;

/** What every resource starts with: when and where it was read. */
const StampShape = {
  fetchedAt: z.iso.datetime(),
  host: z.string(),
};

/** Which builds a repository resource is about. */
const ScopeShape = {
  owner: z.string().optional(),
  repo: z.string().optional(),
  organization: z.string().optional(),
  pipeline: z.string().optional(),
};

const BuildsResourceSchema = z.object({
  ...StampShape,
  ...ScopeShape,
  filters: z.object({
    branch: z.string().optional(),
    commit: z.string().optional(),
  }),
  limit: z.number().int(),
  count: z.number().int(),
  truncated: z.boolean(),
  builds: z.array(BuildSchema),
});

const BuildResourceSchema = BuildSchema.extend({
  ...StampShape,
});

const SummaryResourceSchema = BuildSummarySchema.extend({
  ...StampShape,
});

const ArtifactSchema = z.object({
  path: z.string(),
  url: z.string(),
}) satisfies z.ZodType<Artifact>;

const ArtifactsResourceSchema = z.object({
  ...StampShape,
  ...ScopeShape,
  number: z.number().int(),
  count: z.number().int(),
  artifacts: z.array(ArtifactSchema),
});

const AnnotationSchema = z.object({
  context: z.string(),
  style: z.string(),
  body: z.string(),
}) satisfies z.ZodType<Annotation>;

const AnnotationsResourceSchema = z.object({
  ...StampShape,
  ...ScopeShape,
  number: z.number().int(),
  count: z.number().int(),
  errors: z.number().int(),
  annotations: z.array(AnnotationSchema),
});

const LogTailResourceSchema = z.object({
  ...StampShape,
  ...ScopeShape,
  number: z.number().int(),
  job: z.string(),
  bytes: z.number().int(),
  keptBytes: z.number().int(),
  truncated: z.boolean(),
  lines: z.number().int(),
});

const QueueJobShape = {
  owner: z.string(),
  repo: z.string(),
  build: z.number().int(),
  job: z.string(),
  label: z.string().optional(),
  branch: z.string().optional(),
  commit: z.string().optional(),
  subject: z.string().optional(),
  platform: z.string().optional(),
};

const RunningJobSchema = z.object({
  ...QueueJobShape,
  agent: z.string().optional(),
  started: z.string().optional(),
  lastSeen: z.string().optional(),
  lastOutput: z.string().optional(),
  lease: z.string().optional(),
}) satisfies z.ZodType<RunningJob>;

const WaitingJobSchema = z.object({
  ...QueueJobShape,
  position: z.number().int().optional(),
  queued: z.string().optional(),
  heldBack: z.string().optional(),
}) satisfies z.ZodType<WaitingJob>;

const QueueResourceSchema = z.object({
  ...StampShape,
  running: z.number().int(),
  waiting: z.number().int(),
  heldBack: z.number().int(),
  runningJobs: z.array(RunningJobSchema),
  waitingJobs: z.array(WaitingJobSchema),
});

const AgentSchema = z.object({
  name: z.string(),
  connectionState: z.string(),
  busy: z.boolean(),
  lastSeen: z.string().optional(),
  metaData: z.array(z.string()),
  host: z.string().optional(),
  owner: z.string().optional(),
  unit: z.string().optional(),
  job: RunningJobSchema.optional(),
}) satisfies z.ZodType<Agent>;

const AgentsResourceSchema = z.object({
  ...StampShape,
  count: z.number().int(),
  connected: z.number().int(),
  busy: z.number().int(),
  agents: z.array(AgentSchema),
});

const OrgBuildsResourceSchema = z.object({
  ...StampShape,
  organization: z.string(),
  limit: z.number().int(),
  count: z.number().int(),
  truncated: z.boolean(),
  builds: z.array(BuildSchema),
});

// ---------------------------------------------------------------------------
// Answer parsing
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asLine(value: unknown, limit = LINE_LIMIT): string | undefined {
  const text = asString(value);
  return text === undefined ? undefined : text.slice(0, limit);
}

function asInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** Drops undefined values so a resource holds only what the API answered. */
function compact<T extends Record<string, unknown>>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) out[key] = entry;
  }
  return out as T;
}

/** Seconds from one ISO 8601 timestamp to another, or undefined. */
export function secondsBetween(
  from: unknown,
  to: unknown,
): number | undefined {
  const start = typeof from === "string" ? Date.parse(from) : Number.NaN;
  const end = typeof to === "string" ? Date.parse(to) : Number.NaN;
  if (Number.isNaN(start) || Number.isNaN(end)) return undefined;
  return Math.round(end - start) / 1000;
}

function normalizePhase(raw: unknown): Phase | undefined {
  if (!isRecord(raw)) return undefined;
  const name = asString(raw.name);
  const startedAt = asString(raw.started_at);
  if (name === undefined || startedAt === undefined) return undefined;
  const finishedAt = asString(raw.finished_at);
  return compact({
    name,
    startedAt,
    finishedAt,
    seconds: secondsBetween(startedAt, finishedAt),
  });
}

function fieldKeysOf(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const keys: string[] = [];
  for (const field of raw) {
    const key = isRecord(field) ? asString(field.key) : undefined;
    if (key !== undefined) keys.push(key);
  }
  return keys;
}

/**
 * Reduces a job answer to the fields the `build` and `builds` resources keep.
 * `unblocked_by`, a person, becomes the boolean `unblocked`.
 */
export function normalizeJob(raw: unknown): Job {
  if (!isRecord(raw)) throw new Error("job answer is not an object");
  const id = asString(raw.id);
  if (id === undefined) throw new Error("job answer carries no id");
  const type = asString(raw.type) ?? "script";
  const started = asString(raw.started);
  const finished = asString(raw.finished);
  const phases = Array.isArray(raw.phases)
    ? raw.phases.map(normalizePhase).filter((p) => p !== undefined)
    : undefined;
  const unblockedAt = asString(raw.unblocked_at);
  const unblocked = type === "manual"
    ? unblockedAt !== undefined || typeof raw.unblocked_by === "string"
    : undefined;
  return compact({
    id,
    name: asString(raw.name) ?? "",
    state: asString(raw.state) ?? "unknown",
    type,
    optional: asBoolean(raw.optional) ?? false,
    exitStatus: asInteger(raw.exit_status),
    signalReason: asString(raw.signal_reason),
    summary: asLine(raw.summary),
    runnableAt: asString(raw.runnable_at),
    started,
    finished,
    agent: asString(raw.agent),
    platform: asString(raw.platform),
    key: asString(raw.key),
    prompt: asLine(raw.prompt),
    fieldKeys: fieldKeysOf(raw.fields),
    unblocked,
    unblockedAt,
    retried: asBoolean(raw.retried),
    retriesCount: asInteger(raw.retries_count),
    softFailed: asBoolean(raw.soft_failed),
    lease: asString(raw.lease),
    lastSeen: asString(raw.last_seen),
    lastOutput: asString(raw.last_output),
    waitSeconds: secondsBetween(raw.runnable_at, started),
    durationSeconds: secondsBetween(started, finished),
    phases,
  });
}

/**
 * Reduces a build answer to the fields the `build` and `builds` resources
 * keep. `creator` and `requested_by` name people and are dropped; `env` and
 * `meta_data` are whatever a caller or a job set, and are dropped too.
 */
export function normalizeBuild(raw: unknown): Build {
  if (!isRecord(raw)) throw new Error("build answer is not an object");
  const number = asInteger(raw.number);
  if (number === undefined) throw new Error("build answer carries no number");
  const started = asString(raw.started);
  const finished = asString(raw.finished);
  const jobs = Array.isArray(raw.jobs) ? raw.jobs.map(normalizeJob) : [];
  return compact({
    number,
    branch: asString(raw.branch) ?? "",
    ref: asString(raw.ref),
    commit: asString(raw.commit) ?? "",
    subject: asLine(raw.subject) ?? "",
    state: asString(raw.state) ?? "unknown",
    blocked: asBoolean(raw.blocked) ?? false,
    created: asString(raw.created) ?? "",
    started,
    finished,
    source: asString(raw.source),
    rebuiltFrom: asInteger(raw.rebuilt_from),
    owner: asString(raw.owner),
    repo: asString(raw.repo),
    organization: asString(raw.organization),
    pipeline: asString(raw.pipeline),
    durationSeconds: secondsBetween(started, finished),
    jobs,
  });
}

/** Reduces a build to what a workflow asserts on. */
export function summarize(build: Build): BuildSummary {
  const jobStates: JobStateCounts = {
    scheduled: 0,
    assigned: 0,
    running: 0,
    canceling: 0,
    passed: 0,
    failed: 0,
    canceled: 0,
    skipped: 0,
    blocked: 0,
    unblocked: 0,
    broken: 0,
  };
  let failedJobs = 0;
  let reason: string | undefined;
  const jobs: JobSummary[] = [];
  for (const job of build.jobs) {
    if (job.state in jobStates) jobStates[job.state as keyof JobStateCounts]++;
    if (!job.optional && job.state === "failed") failedJobs++;
    if (
      !job.optional && !SETTLED_STATES.includes(job.state) &&
      reason === undefined
    ) {
      const detail = job.summary ??
        job.signalReason ??
        (job.exitStatus === undefined ? undefined : `exit ${job.exitStatus}`);
      reason = `${job.id} ${job.name} ${job.state}` +
        (detail === undefined ? "" : `: ${detail}`);
    }
    const phaseSeconds: Record<string, number> = {};
    for (const phase of job.phases ?? []) {
      if (phase.seconds !== undefined) phaseSeconds[phase.name] = phase.seconds;
    }
    jobs.push(
      compact({
        id: job.id,
        name: job.name,
        state: job.state,
        optional: job.optional,
        exitStatus: job.exitStatus,
        signalReason: job.signalReason,
        summary: job.summary,
        waitSeconds: job.waitSeconds,
        durationSeconds: job.durationSeconds,
        phaseSeconds,
      }),
    );
  }
  return compact({
    number: build.number,
    branch: build.branch,
    commit: build.commit,
    state: build.state,
    blocked: build.blocked,
    passed: build.state === "passed",
    finished: FINISHED_STATES.includes(build.state),
    durationSeconds: build.durationSeconds,
    jobStates,
    failedJobs,
    reason,
    jobs,
  });
}

/** Reduces an artifact answer to its path and URL. */
export function normalizeArtifact(raw: unknown): Artifact {
  if (!isRecord(raw)) throw new Error("artifact answer is not an object");
  const path = asString(raw.path);
  if (path === undefined) throw new Error("artifact answer carries no path");
  return { path, url: asString(raw.url) ?? "" };
}

/** Reduces an annotation answer, cutting the body to 2000 characters. */
export function normalizeAnnotation(raw: unknown): Annotation {
  if (!isRecord(raw)) throw new Error("annotation answer is not an object");
  return {
    context: asString(raw.context) ?? "",
    style: asString(raw.style) ?? "",
    body: asLine(raw.body, BODY_LIMIT) ?? "",
  };
}

function queueJobOf(raw: Record<string, unknown>): {
  owner: string;
  repo: string;
  build: number;
  job: string;
  label?: string;
  branch?: string;
  commit?: string;
  subject?: string;
  platform?: string;
} {
  const build = asInteger(raw.build);
  const job = asString(raw.job);
  if (build === undefined || job === undefined) {
    throw new Error("queue entry carries no build and job");
  }
  return compact({
    owner: asString(raw.owner) ?? "",
    repo: asString(raw.repo) ?? "",
    build,
    job,
    label: asLine(raw.label),
    branch: asString(raw.branch),
    commit: asString(raw.commit),
    subject: asLine(raw.subject),
    platform: asString(raw.platform),
  });
}

/** Reduces a running queue entry, or an agent's job, to what `queue` keeps. */
export function normalizeRunningJob(raw: unknown): RunningJob {
  if (!isRecord(raw)) throw new Error("running job answer is not an object");
  return compact({
    ...queueJobOf(raw),
    agent: asString(raw.agent),
    started: asString(raw.started),
    lastSeen: asString(raw.last_seen),
    lastOutput: asString(raw.last_output),
    lease: asString(raw.lease),
  });
}

/** Reduces a waiting queue entry to what `queue` keeps. */
export function normalizeWaitingJob(raw: unknown): WaitingJob {
  if (!isRecord(raw)) throw new Error("waiting job answer is not an object");
  return compact({
    ...queueJobOf(raw),
    position: asInteger(raw.position),
    queued: asString(raw.queued),
    heldBack: asLine(raw.held_back),
  });
}

function metaDataOf(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((entry): entry is string => typeof entry === "string");
  }
  if (isRecord(raw)) {
    return Object.entries(raw).map(([key, value]) => `${key}=${String(value)}`);
  }
  return [];
}

/** Reduces an agent answer to what the `agents` resource keeps. */
export function normalizeAgent(raw: unknown): Agent {
  if (!isRecord(raw)) throw new Error("agent answer is not an object");
  const name = asString(raw.name);
  if (name === undefined) throw new Error("agent answer carries no name");
  return compact({
    name,
    connectionState: asString(raw.connection_state) ?? "unknown",
    busy: asBoolean(raw.busy) ?? isRecord(raw.job),
    lastSeen: asString(raw.last_seen),
    metaData: metaDataOf(raw.meta_data),
    host: asString(raw.host),
    owner: asString(raw.owner),
    unit: asString(raw.unit),
    job: isRecord(raw.job) ? normalizeRunningJob(raw.job) : undefined,
  });
}

/** The rows of a list answer under `key`, or a bare array. */
function rowsOf(result: unknown, key: string): unknown[] {
  if (Array.isArray(result)) return result;
  if (isRecord(result) && Array.isArray(result[key])) {
    return result[key] as unknown[];
  }
  return [];
}

function messageOf(parsed: unknown): string | undefined {
  if (!isRecord(parsed)) return undefined;
  return asString(parsed.message) ?? asString(parsed.error);
}

/**
 * The last `kib` KiB of a log, cut to a line boundary when a line was cut,
 * with the log's size and how much was kept, in bytes.
 */
export function tailOf(
  text: string,
  kib: number,
): { tail: string; bytes: number; keptBytes: number; cut: boolean } {
  const encoded = new TextEncoder().encode(text);
  const limit = kib * 1024;
  if (encoded.length <= limit) {
    return {
      tail: text,
      bytes: encoded.length,
      keptBytes: encoded.length,
      cut: false,
    };
  }
  let start = encoded.length - limit;
  const newline = encoded.indexOf(10, start);
  if (newline !== -1 && newline + 1 < encoded.length) start = newline + 1;
  const kept = encoded.subarray(start);
  return {
    tail: new TextDecoder().decode(kept),
    bytes: encoded.length,
    keptBytes: kept.length,
    cut: true,
  };
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/**
 * The path under which a pipeline's builds live. buildq serves a
 * repository's builds only under its pipeline: `/api/repos/` is gone, so an
 * instance named by owner and repo goes through `withPipeline` first.
 */
export function buildsPath(globalArgs: GlobalArgs): string {
  if (
    globalArgs.organization !== undefined && globalArgs.pipeline !== undefined
  ) {
    return `/api/v2/organizations/${
      encodeURIComponent(globalArgs.organization)
    }` +
      `/pipelines/${encodeURIComponent(globalArgs.pipeline)}/builds`;
  }
  throw new Error(
    "set the global organization and pipeline, or owner and repo to look " +
      "the pipeline up, to read a repository's builds",
  );
}

/**
 * The globals with `organization` and `pipeline` set: as given, or, for an
 * instance named by owner and repo, the pipeline buildq builds that
 * repository under (`GET /api/v2/pipelines?repository=<owner>/<repo>`,
 * which a read-scoped API token may call too).
 */
export async function withPipeline(
  globalArgs: GlobalArgs,
  signal?: AbortSignal,
): Promise<GlobalArgs> {
  if (
    (globalArgs.organization !== undefined &&
      globalArgs.pipeline !== undefined) ||
    globalArgs.owner === undefined ||
    globalArgs.repo === undefined
  ) {
    return globalArgs;
  }
  const repository = `${globalArgs.owner}/${globalArgs.repo}`;
  const answer = await request(
    globalArgs,
    { method: "GET", path: "/api/v2/pipelines", query: { repository } },
    signal,
  );
  const found = rowsOf(answer.body, "pipelines")[0];
  const organization = isRecord(found)
    ? asString(found.organization)
    : undefined;
  const pipeline = isRecord(found) ? asString(found.slug) : undefined;
  if (organization === undefined || pipeline === undefined) {
    throw new Error(
      `buildq names no pipeline for ${repository} that apiToken may see: ` +
        "set the global organization and pipeline, or use a token of the " +
        "organization that builds it",
    );
  }
  return { ...globalArgs, organization, pipeline };
}

/** The scope fields a repository resource records. */
function scopeOf(globalArgs: GlobalArgs): Record<string, string | undefined> {
  return compact({
    owner: globalArgs.owner,
    repo: globalArgs.repo,
    organization: globalArgs.organization,
    pipeline: globalArgs.pipeline,
  });
}

/**
 * Sends one request and returns its status and body. The Access headers go
 * on every request when set. Each request carries one credential: the forge
 * token when `authorize` is set (rebuild, cancel and unblock, the only
 * routes buildq takes it on), the API token as a bearer otherwise. Either
 * missing throws before anything is sent. Redirects are not followed: a
 * login page is reported, not read, and a coordinator that moved is named.
 *
 * Throws a BuildqError for a 3xx, 4xx or 5xx status not in `accept`, and for
 * a JSON answer that is not JSON.
 */
export async function request(
  globalArgs: GlobalArgs,
  options: RequestOptions,
  signal?: AbortSignal,
): Promise<Answer> {
  const url = new URL(globalArgs.host.replace(/\/+$/, "") + options.path);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const headers: Record<string, string> = {
    Accept: options.text ? "text/plain" : "application/json",
  };
  if (
    globalArgs.accessClientId !== undefined &&
    globalArgs.accessClientSecret !== undefined
  ) {
    headers[ACCESS_ID_HEADER] = globalArgs.accessClientId;
    headers[ACCESS_SECRET_HEADER] = globalArgs.accessClientSecret;
  }
  if (options.authorize) {
    if (globalArgs.token === undefined) {
      throw new Error(
        `${options.method} ${options.path} needs a forge token: set the global token`,
      );
    }
    headers.Authorization = `token ${globalArgs.token}`;
  } else {
    if (globalArgs.apiToken === undefined) {
      throw new Error(
        `${options.method} ${options.path} needs a buildq API token: set the ` +
          "global apiToken",
      );
    }
    headers.Authorization = `Bearer ${globalArgs.apiToken}`;
  }
  const body = options.body === undefined
    ? undefined
    : JSON.stringify(options.body);
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const response = await fetch(url, {
    method: options.method,
    headers,
    body,
    signal,
    redirect: "manual",
  });
  const text = await response.text();
  const label = `${options.method} ${options.path}`;

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("Location") ?? "elsewhere";
    const moved = movedTo(response.status, location, url);
    if (moved !== undefined) {
      throw new BuildqError(
        `${label}: ${response.status} moved to ${location} (buildq answers ` +
          `at ${moved} now: set the global host to it)`,
        response.status,
      );
    }
    throw new BuildqError(
      `${label}: ${response.status} redirected to ${location} (the host is ` +
        "behind a login: set accessClientId and accessClientSecret for " +
        "Cloudflare Access, or use the address the API answers at)",
      response.status,
    );
  }

  if (options.text) {
    if (!response.ok && !options.accept?.includes(response.status)) {
      throw new BuildqError(
        `${label}: ${response.status} ${detailOf(response, text, undefined)}`,
        response.status,
      );
    }
    return { status: response.status, body: text };
  }

  let parsed: unknown;
  try {
    parsed = text === "" ? undefined : JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (!response.ok && !options.accept?.includes(response.status)) {
    throw new BuildqError(
      `${label}: ${response.status} ${
        detailOf(response, text, messageOf(parsed))
      }`,
      response.status,
    );
  }
  if (parsed === undefined) {
    throw new BuildqError(`${label}: answer was not JSON`, response.status);
  }
  return { status: response.status, body: parsed };
}

/**
 * The origin a permanent redirect (301, 308) moved the coordinator to, when
 * it is another origin than the one asked: buildq's old hostname answers
 * every request with a 308 to its new one. Undefined for anything else.
 */
function movedTo(
  status: number,
  location: string,
  asked: URL,
): string | undefined {
  if (status !== 301 && status !== 308) return undefined;
  let target: URL;
  try {
    target = new URL(location, asked);
  } catch {
    return undefined;
  }
  return target.origin === asked.origin ? undefined : target.origin;
}

function detailOf(
  response: Response,
  text: string,
  message: string | undefined,
): string {
  const hint = STATUS_HINTS[response.status];
  return [
    message ?? (text === "" ? response.statusText : text.slice(0, 200)),
    hint === undefined ? undefined : `(${hint})`,
  ]
    .filter((part) => part !== undefined && part !== "")
    .join(" ");
}

/** Reads one build. */
async function fetchBuild(
  globalArgs: GlobalArgs,
  number: number,
  signal: AbortSignal,
): Promise<Build> {
  const answer = await request(
    globalArgs,
    { method: "GET", path: `${buildsPath(globalArgs)}/${number}` },
    signal,
  );
  return normalizeBuild(answer.body);
}

/** Writes `build-<number>` and `summary-<number>` for one build. */
async function writeBuild(
  context: Context,
  build: Build,
  fetchedAt: string,
): Promise<DataHandle[]> {
  const { globalArgs } = context;
  const buildHandle = await context.writeResource(
    "build",
    `build-${build.number}`,
    { fetchedAt, host: globalArgs.host, ...build },
  );
  const summaryHandle = await context.writeResource(
    "summary",
    `summary-${build.number}`,
    { fetchedAt, host: globalArgs.host, ...summarize(build) },
  );
  return [buildHandle, summaryHandle];
}

/** Throws before any request when a write has no forge token to send. */
function needForgeToken(globalArgs: GlobalArgs, method: string): void {
  if (globalArgs.token === undefined) {
    throw new Error(`${method} needs a forge token: set the global token`);
  }
}

/** Writes the build a write answered with, and logs its state. */
async function writeAnswered(
  context: Context,
  build: Build,
  verb: string,
): Promise<MethodResult> {
  const dataHandles = await writeBuild(
    context,
    build,
    new Date().toISOString(),
  );
  context.logger.info("{verb} build #{number}: it is now {state}", {
    verb,
    number: build.number,
    state: build.state,
  });
  return { dataHandles };
}

/** Lists builds under a path and writes them as one resource. */
async function listBuilds(
  globalArgs: GlobalArgs,
  path: string,
  query: Record<string, string | number | undefined>,
  signal: AbortSignal,
): Promise<Build[]> {
  const answer = await request(
    globalArgs,
    { method: "GET", path, query },
    signal,
  );
  return rowsOf(answer.body, "builds").map(normalizeBuild);
}

// ---------------------------------------------------------------------------
// Behavior
// ---------------------------------------------------------------------------

/**
 * The behavior definition Swamp registers. Global arguments are `host`, the
 * repository (`organization` and `pipeline`, or `owner` and `repo` to look
 * the pipeline up), `apiToken` (sensitive) for every read, an optional
 * `token` (sensitive) for writes, and an optional Cloudflare Access service
 * token; see the README for each method, the resource it writes and
 * the instance name it writes it under.
 */
export const behavior = {
  // String literals, not constants: the registry catalog reads them from the
  // source. The collective is provisional, rename it here.
  type: "@reset/buildq",
  version: "2026.10.24.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    builds: {
      description: "Builds of the repository, newest first, with the filters " +
        "the list was taken with",
      schema: BuildsResourceSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    build: {
      description: "One build with its jobs and their phases, written by " +
        "build, rebuild, cancel and unblock",
      schema: BuildResourceSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    summary: {
      description: "A build reduced to what a workflow asserts on: state, " +
        "blocked, job states, signal reasons, exit statuses and phase " +
        "durations. `newest` is the newest build of the last list.",
      schema: SummaryResourceSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    artifacts: {
      description: "What a build's jobs left in out/artifacts/, with URLs",
      schema: ArtifactsResourceSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    annotations: {
      description: "The notes a build's jobs left, errors first",
      schema: AnnotationsResourceSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    logtail: {
      description: "How much of a job's log the log file beside it keeps, " +
        "written by log",
      schema: LogTailResourceSchema,
      lifetime: "30d",
      garbageCollection: 5,
    },
    queue: {
      description: "Jobs agents hold and jobs waiting, with why each waits",
      schema: QueueResourceSchema,
      lifetime: "7d",
      garbageCollection: 20,
    },
    agents: {
      description: "Every agent the coordinator knows, with its tags, state " +
        "and the job it holds",
      schema: AgentsResourceSchema,
      lifetime: "7d",
      garbageCollection: 20,
    },
    orgbuilds: {
      description: "An organization's newest builds across its pipelines",
      schema: OrgBuildsResourceSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  files: {
    log: {
      description: "The last KiB of a job's log, cut to whole lines",
      contentType: "text/plain",
      lifetime: "30d",
      garbageCollection: 5,
    },
  },
  methods: {
    builds: {
      description: "List the repository's builds, newest first, filtered by " +
        "branch and commit prefix. Writes builds, and newest for the first " +
        "build listed.",
      arguments: BuildsArgsSchema,
      execute: async (
        args: BuildsArgs,
        context: Context,
      ): Promise<MethodResult> => {
        const { globalArgs, signal, logger } = context;
        const scoped = await withPipeline(globalArgs, signal);
        const path = buildsPath(scoped);
        const filters = compact({ branch: args.branch, commit: args.commit });
        logger.info(
          "Listing up to {limit} builds from {host}{path}, filters {filters}",
          {
            limit: args.limit,
            host: globalArgs.host,
            path,
            filters,
          },
        );
        const builds = await listBuilds(
          globalArgs,
          path,
          { ...filters, limit: args.limit },
          signal,
        );
        const fetchedAt = new Date().toISOString();
        const dataHandles = [
          await context.writeResource("builds", "builds", {
            fetchedAt,
            host: globalArgs.host,
            ...scopeOf(scoped),
            filters,
            limit: args.limit,
            count: builds.length,
            truncated: builds.length >= args.limit,
            builds,
          }),
        ];
        const newest = builds[0];
        if (newest !== undefined) {
          dataHandles.push(
            await context.writeResource("summary", "newest", {
              fetchedAt,
              host: globalArgs.host,
              ...summarize(newest),
            }),
          );
          logger.info(
            "Listed {count} builds; the newest, #{number}, is {state}",
            {
              count: builds.length,
              number: newest.number,
              state: newest.state,
            },
          );
        } else {
          logger.info("Listed no builds");
        }
        return { dataHandles };
      },
    },
    build: {
      description: "Read one build by number. Writes build-<number> and " +
        "summary-<number>.",
      arguments: BuildArgsSchema,
      execute: async (
        args: BuildArgs,
        context: Context,
      ): Promise<MethodResult> => {
        const { globalArgs, signal, logger } = context;
        const scoped = await withPipeline(globalArgs, signal);
        logger.info("Reading build #{number} from {host}", {
          number: args.number,
          host: globalArgs.host,
        });
        const build = await fetchBuild(scoped, args.number, signal);
        const dataHandles = await writeBuild(
          context,
          build,
          new Date().toISOString(),
        );
        logger.info("Read build #{number}: {state} ({subject})", {
          number: build.number,
          state: build.state,
          subject: build.subject,
        });
        return { dataHandles };
      },
    },
    log: {
      description: "Read a job's log and keep its last KiB as a file. " +
        "Writes the file log-<job> and logtail-<job>.",
      arguments: LogArgsSchema,
      execute: async (
        args: LogArgs,
        context: Context,
      ): Promise<MethodResult> => {
        const { globalArgs, signal, logger } = context;
        const scoped = await withPipeline(globalArgs, signal);
        const job = args.job ?? `${args.number}.1`;
        logger.info(
          "Reading the log of job {job} from {host}, keeping {kib} KiB",
          {
            job,
            host: globalArgs.host,
            kib: args.tailKiB,
          },
        );
        const answer = await request(
          globalArgs,
          {
            method: "GET",
            path: `${buildsPath(scoped)}/${args.number}/jobs/${
              encodeURIComponent(job)
            }/log`,
            text: true,
          },
          signal,
        );
        const { tail, bytes, keptBytes, cut } = tailOf(
          String(answer.body),
          args.tailKiB,
        );
        const fileHandle = await context
          .createFileWriter("log", `log-${job}`)
          .writeText(tail);
        const lines = tail === ""
          ? 0
          : tail.split("\n").length - (tail.endsWith("\n") ? 1 : 0);
        const handle = await context.writeResource(
          "logtail",
          `logtail-${job}`,
          {
            fetchedAt: new Date().toISOString(),
            host: globalArgs.host,
            ...scopeOf(scoped),
            number: args.number,
            job,
            bytes,
            keptBytes,
            truncated: cut,
            lines,
          },
        );
        logger.info(
          "Kept {kept} of {bytes} bytes ({lines} lines) of job {job}'s log (truncated={cut})",
          { kept: keptBytes, bytes, lines, job, cut },
        );
        return { dataHandles: [fileHandle, handle] };
      },
    },
    artifacts: {
      description: "List what a build's jobs kept. Writes artifacts-<number>.",
      arguments: BuildArgsSchema,
      execute: async (
        args: BuildArgs,
        context: Context,
      ): Promise<MethodResult> => {
        const { globalArgs, signal, logger } = context;
        const scoped = await withPipeline(globalArgs, signal);
        logger.info("Listing artifacts of build #{number} from {host}", {
          number: args.number,
          host: globalArgs.host,
        });
        const answer = await request(
          globalArgs,
          {
            method: "GET",
            path: `${buildsPath(scoped)}/${args.number}/artifacts`,
          },
          signal,
        );
        const artifacts = rowsOf(answer.body, "artifacts").map(
          normalizeArtifact,
        );
        const handle = await context.writeResource(
          "artifacts",
          `artifacts-${args.number}`,
          {
            fetchedAt: new Date().toISOString(),
            host: globalArgs.host,
            ...scopeOf(scoped),
            number: args.number,
            count: artifacts.length,
            artifacts,
          },
        );
        logger.info("Listed {count} artifacts of build #{number}", {
          count: artifacts.length,
          number: args.number,
        });
        return { dataHandles: [handle] };
      },
    },
    annotations: {
      description: "List the notes a build's jobs left, errors first. " +
        "Writes annotations-<number>.",
      arguments: BuildArgsSchema,
      execute: async (
        args: BuildArgs,
        context: Context,
      ): Promise<MethodResult> => {
        const { globalArgs, signal, logger } = context;
        const scoped = await withPipeline(globalArgs, signal);
        logger.info("Listing annotations of build #{number} from {host}", {
          number: args.number,
          host: globalArgs.host,
        });
        const answer = await request(
          globalArgs,
          {
            method: "GET",
            path: `${buildsPath(scoped)}/${args.number}/annotations`,
          },
          signal,
        );
        const annotations = rowsOf(answer.body, "annotations").map(
          normalizeAnnotation,
        );
        const errors = annotations.filter((a) => a.style === "error").length;
        const handle = await context.writeResource(
          "annotations",
          `annotations-${args.number}`,
          {
            fetchedAt: new Date().toISOString(),
            host: globalArgs.host,
            ...scopeOf(scoped),
            number: args.number,
            count: annotations.length,
            errors,
            annotations,
          },
        );
        logger.info(
          "Listed {count} annotations of build #{number}, {errors} errors",
          {
            count: annotations.length,
            number: args.number,
            errors,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    queue: {
      description: "Read the jobs agents hold and the jobs waiting, across " +
        "every repository. Writes queue.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: Context,
      ): Promise<MethodResult> => {
        const { globalArgs, signal, logger } = context;
        logger.info("Reading the queue from {host}", { host: globalArgs.host });
        const answer = await request(
          globalArgs,
          { method: "GET", path: "/api/queue" },
          signal,
        );
        const runningJobs = rowsOf(answer.body, "running").map(
          normalizeRunningJob,
        );
        const waitingJobs = rowsOf(answer.body, "waiting").map(
          normalizeWaitingJob,
        );
        const heldBack =
          waitingJobs.filter((j) => j.heldBack !== undefined).length;
        const handle = await context.writeResource("queue", "queue", {
          fetchedAt: new Date().toISOString(),
          host: globalArgs.host,
          running: runningJobs.length,
          waiting: waitingJobs.length,
          heldBack,
          runningJobs,
          waitingJobs,
        });
        logger.info(
          "{running} jobs running, {waiting} waiting, {heldBack} held back",
          {
            running: runningJobs.length,
            waiting: waitingJobs.length,
            heldBack,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    agents: {
      description: "Read every agent the coordinator knows, with its state " +
        "and the job it holds. Writes agents.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: Context,
      ): Promise<MethodResult> => {
        const { globalArgs, signal, logger } = context;
        logger.info("Reading the agents from {host}", {
          host: globalArgs.host,
        });
        const answer = await request(
          globalArgs,
          { method: "GET", path: "/api/agents" },
          signal,
        );
        const agents = rowsOf(answer.body, "agents").map(normalizeAgent);
        const connected =
          agents.filter((a) => a.connectionState === "connected").length;
        const busy = agents.filter((a) => a.busy).length;
        const handle = await context.writeResource("agents", "agents", {
          fetchedAt: new Date().toISOString(),
          host: globalArgs.host,
          count: agents.length,
          connected,
          busy,
          agents,
        });
        logger.info(
          "{count} agents known, {connected} connected, {busy} busy",
          {
            count: agents.length,
            connected,
            busy,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    "org-builds": {
      description: "List an organization's newest builds across its " +
        "pipelines. Writes orgbuilds-<organization>.",
      arguments: OrgBuildsArgsSchema,
      execute: async (
        args: OrgBuildsArgs,
        context: Context,
      ): Promise<MethodResult> => {
        const { globalArgs, signal, logger } = context;
        const organization = args.organization ?? globalArgs.organization;
        if (organization === undefined) {
          throw new Error(
            "org-builds needs an organization: pass the organization " +
              "argument or set the global organization",
          );
        }
        logger.info(
          "Listing up to {limit} builds of organization {organization} from {host}",
          {
            limit: args.limit,
            organization,
            host: globalArgs.host,
          },
        );
        const builds = await listBuilds(
          globalArgs,
          `/api/v2/organizations/${encodeURIComponent(organization)}/builds`,
          { limit: args.limit },
          signal,
        );
        const handle = await context.writeResource(
          "orgbuilds",
          `orgbuilds-${organization}`,
          {
            fetchedAt: new Date().toISOString(),
            host: globalArgs.host,
            organization,
            limit: args.limit,
            count: builds.length,
            truncated: builds.length >= args.limit,
            builds,
          },
        );
        logger.info("Listed {count} builds of organization {organization}", {
          count: builds.length,
          organization,
        });
        return { dataHandles: [handle] };
      },
    },
    rebuild: {
      description: "Rebuild a build: a new build with the next number. Needs " +
        "the forge token. Writes build-<new> and summary-<new> from the " +
        "answer.",
      arguments: BuildArgsSchema,
      execute: async (
        args: BuildArgs,
        context: Context,
      ): Promise<MethodResult> => {
        const { globalArgs, signal, logger } = context;
        needForgeToken(globalArgs, "rebuild");
        const scoped = await withPipeline(globalArgs, signal);
        logger.info("Rebuilding build #{number} on {host}", {
          number: args.number,
          host: globalArgs.host,
        });
        const answer = await request(
          globalArgs,
          {
            method: "POST",
            path: `${buildsPath(scoped)}/${args.number}/rebuild`,
            authorize: true,
          },
          signal,
        );
        // The answer is the new build in full, so nothing is read back: a
        // read that failed after the rebuild was made would hide it.
        return writeAnswered(
          context,
          normalizeBuild(answer.body),
          `Rebuilt #${args.number} as`,
        );
      },
    },
    cancel: {
      description: "Cancel a build. A build that has already ended is left " +
        "as it ended. Needs the forge token. Writes build-<number> and " +
        "summary-<number> from the answer.",
      arguments: BuildArgsSchema,
      execute: async (
        args: BuildArgs,
        context: Context,
      ): Promise<MethodResult> => {
        const { globalArgs, signal, logger } = context;
        needForgeToken(globalArgs, "cancel");
        const scoped = await withPipeline(globalArgs, signal);
        logger.info("Cancelling build #{number} on {host}", {
          number: args.number,
          host: globalArgs.host,
        });
        const answer = await request(
          globalArgs,
          {
            method: "POST",
            path: `${buildsPath(scoped)}/${args.number}/cancel`,
            authorize: true,
            accept: [409],
          },
          signal,
        );
        // 202 answers the build canceling, 409 the build as it ended: both
        // in full, so nothing is read back.
        const build = normalizeBuild(answer.body);
        if (answer.status === 409) {
          logger.warning(
            "Build #{number} had already ended {state}; nothing to cancel",
            { number: args.number, state: build.state },
          );
        }
        return writeAnswered(context, build, "Cancelled");
      },
    },
    unblock: {
      description: "Answer a build's block with a value per field. Needs the " +
        "forge token, with read:user, and apiToken to read the build back. " +
        "Writes build-<number> and summary-<number>.",
      arguments: UnblockArgsSchema,
      execute: async (
        args: UnblockArgs,
        context: Context,
      ): Promise<MethodResult> => {
        const { globalArgs, signal, logger } = context;
        needForgeToken(globalArgs, "unblock");
        if (globalArgs.apiToken === undefined) {
          throw new Error(
            "unblock reads the build back after answering: set the global " +
              "apiToken",
          );
        }
        const scoped = await withPipeline(globalArgs, signal);
        logger.info(
          "Answering block {job} of build #{number} on {host} with fields {keys}",
          {
            job: args.job,
            number: args.number,
            host: globalArgs.host,
            keys: Object.keys(args.fields),
          },
        );
        // buildq answers with the job alone, so the build is read back.
        await request(
          globalArgs,
          {
            method: "PUT",
            path: `${buildsPath(scoped)}/${args.number}/jobs/${
              encodeURIComponent(args.job)
            }/unblock`,
            body: { fields: args.fields },
            authorize: true,
          },
          signal,
        );
        let build: Build;
        try {
          build = await fetchBuild(scoped, args.number, signal);
        } catch (error) {
          // The block is answered and cannot be answered again: failing here
          // would read as if it had not been, and a retry would get a 409.
          logger.warning(
            "Answered block {job} of build #{number}, but reading the build " +
              "back failed: {error}. The answer stands; run build to read it.",
            {
              job: args.job,
              number: args.number,
              error: error instanceof Error ? error.message : String(error),
            },
          );
          return { dataHandles: [] };
        }
        return writeAnswered(context, build, `Unblocked ${args.job} of`);
      },
    },
  },
  upgrades: [
    {
      toVersion: "2026.10.24.1",
      description:
        "Write every argument where the registry reads it, so its catalog lists them with their descriptions. Add apiToken, sent as Authorization: Bearer on every read, which buildq needs; read a repository's builds under its pipeline, found from owner and repo when no organization and pipeline are set, since buildq no longer serves /api/repos/; count blocked and unblocked jobs; write rebuild and cancel from their answers. Existing arguments are kept as they are; an instance adds apiToken to read",
      upgradeAttributes: (old: Record<string, unknown>): Record<
        string,
        unknown
      > => old,
    },
  ],
};
