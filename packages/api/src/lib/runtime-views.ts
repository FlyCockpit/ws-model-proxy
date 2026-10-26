/**
 * Row → view mapping for the runtimes router (`contracts/runtimes.ts`). Pure apart from the
 * Prisma include shapes, so the router and its tests share one definition of every view.
 */
import { RUNTIME_ADVANCED, RUNTIME_LIMIT_COLUMNS } from "@ws-model-proxy/config/runtime-defaults";
import type { Prisma } from "@ws-model-proxy/db";
import type { z } from "zod";
import type { runtimeAdvancedViewSchema, runtimeLimitsViewSchema } from "../contracts/advanced";
import type {
  instanceStepViewSchema,
  instanceViewSchema,
  runtimeSummarySchema,
  runtimeVersionDetailSchema,
  runtimeVersionSummarySchema,
} from "../contracts/runtimes";
import { rankCommands, renderStepCommand, type StepCommandPhase } from "./command-render";
import { type InstanceLiveLoad, NO_LIVE_LOAD } from "./live-load";
import { recordedGpuKeys } from "./placement";
import { jsonObject, registryView } from "./registry-view";
import {
  COMPAT_ENDPOINTS,
  readAcceptedProfile,
  readLearnedProfile,
  storedRequestCompat,
} from "./request-compat";
import {
  CURRENT_RESERVATION_WHERE,
  launchIdentity,
  reservationClaim,
  reservationMemoryGb,
} from "./reservations";
import { type RuntimeSpec, runtimeSpecSchema } from "./runtime-spec";
import { type StepIntent, stepIntentSchema, stepJobPlaceholders } from "./step-intent";
import { nodeConnectionView, type StopCheck, stopCheckKey } from "./stop-evidence";

export const VERSION_SELECT = {
  id: true,
  runtimeId: true,
  version: true,
  createdAt: true,
  editor: true,
  editorUserId: true,
  agentTokenId: true,
  note: true,
  launchHash: true,
  contentHash: true,
  spec: true,
  modelType: true,
  concurrencyLimit: true,
  contextLimit: true,
  kvBudgetTokens: true,
  kvFullThreshold: true,
  engineLoadGate: true,
  advanced: true,
  compat: true,
} as const satisfies Prisma.RuntimeVersionSelect;
export type VersionRow = Prisma.RuntimeVersionGetPayload<{ select: typeof VERSION_SELECT }>;

export const INSTANCE_INCLUDE = {
  Ranks: {
    include: {
      Node: {
        select: {
          slug: true,
          connection: true,
          lastConnectedAt: true,
          lastDisconnectedAt: true,
          lastHeartbeatAt: true,
        },
      },
      // An agent's pending request that a person release the claim (at most one).
      ReleaseRequests: {
        where: { state: "PENDING" },
        select: { id: true, expiresAt: true },
        take: 1,
      },
    },
    orderBy: { rank: "asc" },
  },
  // Memory held on other nodes (`launch.reservations`); their claim is the ranks' claim. Every
  // row: the current plan's (`reservations`) and those a restart superseded that still hold
  // (`supersededReservations`), so recovery shows everything a release ends.
  Reservations: {
    include: {
      Node: {
        select: {
          slug: true,
          connection: true,
          lastConnectedAt: true,
          lastDisconnectedAt: true,
          lastHeartbeatAt: true,
        },
      },
    },
    orderBy: [{ index: "asc" }, { supersededGeneration: "asc" }],
  },
  Steps: {
    where: { state: { in: ["PENDING", "RUNNING", "AWAITING_OPERATOR"] } },
    orderBy: { createdAt: "asc" },
  },
  Version: { select: { version: true, advanced: true } },
  LaunchVersion: { select: { spec: true, editor: true, launchHash: true } },
  // The head's fabric address, as dispatch resolves `{{head_addr}}`.
  Fabric: { select: { id: true, name: true, Members: { select: { nodeId: true, ip: true } } } },
} as const satisfies Prisma.RuntimeInstanceInclude;
export type InstanceRow = Prisma.RuntimeInstanceGetPayload<{ include: typeof INSTANCE_INCLUDE }>;

export const RUNTIME_SUMMARY_INCLUDE = {
  CurrentVersion: { select: VERSION_SELECT },
  Models: {
    where: { retired: false },
    select: { upstreamModelId: true },
    orderBy: { createdAt: "asc" },
  },
  // Where it runs (`nodes`): an always-on runtime's node, the ranks of its live instances.
  Node: { select: { id: true, slug: true, userId: true } },
  Instances: {
    select: {
      phase: true,
      needsOperator: true,
      desiredState: true,
      // Ranks that hold (or may still hold) their node; a failed or stopped one has let go.
      Ranks: {
        where: { claim: { in: ["HELD", "HELD_UNKNOWN"] } },
        select: { nodeId: true, Node: { select: { slug: true, userId: true } } },
        orderBy: { rank: "asc" },
      },
    },
  },
} as const satisfies Prisma.RuntimeInclude;
export type RuntimeSummaryRow = Prisma.RuntimeGetPayload<{
  include: typeof RUNTIME_SUMMARY_INCLUDE;
}>;

type VersionSummary = z.infer<typeof runtimeVersionSummarySchema>;
type InstanceView = z.infer<typeof instanceViewSchema>;
type StepView = z.infer<typeof instanceStepViewSchema>;

/** The stored spec. Written only after `runtimeSpecSchema` passed, so a failure is a bug. */
export function storedSpec(value: unknown): RuntimeSpec {
  return runtimeSpecSchema.parse(value);
}

export function actorRef(row: {
  editor: "USER" | "AGENT" | "SYSTEM";
  editorUserId: string;
  agentTokenId: string | null;
}) {
  return {
    actor: row.editor,
    userId: row.editorUserId,
    agentTokenId: row.agentTokenId,
    label: null,
  };
}

/**
 * `previousLaunch`: the previous version's `launchIdentity` (null: the first version).
 * `launchChanged` says whether running instances must restart for this version: another launch
 * hash, or other reservations (server-only, so not in the hash).
 */
export function versionSummary(row: VersionRow, previousLaunch: string | null): VersionSummary {
  return {
    id: row.id,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    editor: actorRef(row),
    note: row.note,
    launchHash: row.launchHash,
    launchChanged: previousLaunch === null || previousLaunch !== launchIdentity(row),
  };
}

/** Engine facts of the instances running this version (the automatic limit sources). */
export type EngineFacts = {
  engineSlots: number | null;
  maxModelLen: number | null;
  observedKvBudgetTokens: number | null;
};

export function limitsView(
  row: Pick<
    VersionRow,
    "concurrencyLimit" | "contextLimit" | "kvBudgetTokens" | "kvFullThreshold" | "engineLoadGate"
  >,
  facts: EngineFacts | null = null,
): z.infer<typeof runtimeLimitsViewSchema> {
  return registryView(
    RUNTIME_LIMIT_COLUMNS,
    {
      concurrencyLimit: row.concurrencyLimit,
      contextLimit: row.contextLimit,
      kvBudgetTokens: row.kvBudgetTokens,
      kvFullThreshold: row.kvFullThreshold,
      // AUTO is the automatic value of the gate, not an override.
      engineLoadGate: row.engineLoadGate === "AUTO" ? null : row.engineLoadGate,
    },
    {
      concurrencyLimit: facts?.engineSlots ?? null,
      contextLimit: facts?.maxModelLen ?? null,
      kvBudgetTokens: facts?.observedKvBudgetTokens ?? null,
    },
  ) as z.infer<typeof runtimeLimitsViewSchema>;
}

export function advancedView(advanced: unknown): z.infer<typeof runtimeAdvancedViewSchema> {
  return registryView(RUNTIME_ADVANCED, jsonObject(advanced)) as z.infer<
    typeof runtimeAdvancedViewSchema
  >;
}

export function versionDetail(
  row: VersionRow,
  previousLaunch: string | null,
  facts: EngineFacts | null = null,
): z.infer<typeof runtimeVersionDetailSchema> {
  return {
    ...versionSummary(row, previousLaunch),
    runtimeId: row.runtimeId,
    contentHash: row.contentHash,
    spec: storedSpec(row.spec),
    limits: limitsView(row, facts),
    advanced: advancedView(row.advanced),
    compat: storedRequestCompat(row.compat),
  };
}

/** The request profile row of the current launch, as `runtimes.get` shows it. */
export function requestProfileView(row: {
  source: "LEARNED" | "OPENAPI" | "CATALOG";
  engineFingerprint: string | null;
  probedAt: Date | null;
  accepted: unknown;
  learned: unknown;
}) {
  const accepted = readAcceptedProfile(row.accepted);
  const learned = readLearnedProfile(row.learned);
  return {
    source: row.source,
    engine: row.engineFingerprint,
    probedAt: row.probedAt?.toISOString() ?? null,
    described: COMPAT_ENDPOINTS.filter((endpoint) => accepted?.endpoints[endpoint] !== undefined),
    learned: COMPAT_ENDPOINTS.flatMap((endpoint) =>
      (learned.fixes[endpoint] ?? []).map((fix) =>
        fix.kind === "mapRole"
          ? `${endpoint} mapRole ${fix.from}>${fix.to}`
          : fix.kind === "rename"
            ? `${endpoint} rename ${fix.path}>${fix.to}`
            : `${endpoint} drop ${fix.path}`,
      ),
    ),
    stripHeaders: learned.stripHeaders,
  };
}

/**
 * The owner's nodes a runtime is on: an always-on runtime's node, then the nodes of its
 * instances that are not stopped (in rank order, each once). Another user's node never shows.
 */
function runtimeNodes(row: RuntimeSummaryRow): Array<{ id: string; slug: string }> {
  const nodes = new Map<string, { id: string; slug: string }>();
  if (row.Node && row.Node.userId === row.userId)
    nodes.set(row.Node.id, { id: row.Node.id, slug: row.Node.slug });
  for (const instance of row.Instances) {
    if (instance.phase === "STOPPED") continue;
    for (const rank of instance.Ranks) {
      if (!rank.nodeId || !rank.Node || rank.Node.userId !== row.userId) continue;
      if (!nodes.has(rank.nodeId))
        nodes.set(rank.nodeId, { id: rank.nodeId, slug: rank.Node.slug });
    }
  }
  return [...nodes.values()];
}

export function runtimeSummary(
  row: RuntimeSummaryRow,
  previousLaunch: string | null,
): z.infer<typeof runtimeSummarySchema> {
  const current = row.CurrentVersion;
  if (!current) throw new Error(`runtime ${row.id} has no current version`);
  const counts = { running: 0, starting: 0, failed: 0, needsYou: 0 };
  for (const instance of row.Instances) {
    if (instance.phase === "READY") counts.running += 1;
    else if (instance.phase === "STARTING") counts.starting += 1;
    else if (instance.phase === "FAILED") counts.failed += 1;
    if (instance.needsOperator) counts.needsYou += 1;
  }
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    kind: row.kind,
    origin: row.origin,
    nodeId: row.nodeId,
    modelType: current.modelType,
    service: current.modelType === null,
    currentVersion: versionSummary(current, previousLaunch),
    models: row.Models.map((model) => model.upstreamModelId),
    instances: counts,
    nodes: runtimeNodes(row),
    forkedFromVersionId: row.forkedFromVersionId,
  };
}

const STEP_COMMAND = {
  PREPARE: "prepare",
  START: "start",
  AFTER_JOIN: "afterJoin",
  STOP: "stop",
  STATUS: "status",
  HEALTH: "health",
  READINESS: null,
} as const;

const INTERACTIVE_KEY = {
  PREPARE: "prepare",
  START: "start",
  AFTER_JOIN: "afterJoin",
  STOP: "stop",
} as const;

/** A version a step may name: what its command is rendered from, and who wrote it. */
export type StepVersion = {
  /** Its spec, null when unreadable. */
  spec: RuntimeSpec | null;
  /** `sha256(canonicalJson(spec))`: the identity the node renders by. */
  launchHash: string;
  author: "USER" | "AGENT" | "SYSTEM";
};

/**
 * What an instance's steps name besides the instance's own launch version and fabric
 * (`loadStepRefs`): a stop or status probe of a restart's earlier launch names that launch's
 * version and fabric.
 */
export type StepRefs = {
  /** Other versions, by id. */
  versions: ReadonlyMap<string, StepVersion>;
  /** Other fabrics' names, by id. */
  fabricNames: ReadonlyMap<string, string>;
};

export const NO_STEP_REFS: StepRefs = { versions: new Map(), fabricNames: new Map() };

/** What a step view needs of its instance to show the command as the node renders it. */
export type StepViewContext = StepVersion &
  StepRefs & {
    /** The instance's launch version (`spec`, `launchHash`, `author` are its). */
    launchVersionId: string;
    /*
     * `versions`: other versions its steps name (`loadStepRefs`). A step naming a version not
     * there shows no command: never the successor's text or author. `fabricNames`: other fabrics
     * its steps name: a step renders with its own fabric's name, never the successor's.
     */
    /** The instance's fabric and its members' addresses (multi-node only). */
    fabric: {
      id: string;
      name: string;
      Members: ReadonlyArray<{ nodeId: string; ip: string }>;
    } | null;
    /** The node of rank 0 (the head). */
    headNodeId: string | null;
  };

export type StepRow = Pick<
  InstanceRow["Steps"][number],
  | "id"
  | "rank"
  | "phase"
  | "state"
  | "attempts"
  | "errorCode"
  | "intent"
  | "operatorTerminalId"
  | "updatedAt"
  | "headAddr"
>;

/**
 * The version a step names: the instance's launch version, or another one its steps name
 * (`context.versions`). Null when that version is not known here.
 */
function stepVersionOf(intent: StepIntent | null, context: StepViewContext): StepVersion | null {
  if (!intent || intent.launchVersionId === context.launchVersionId) return context;
  return context.versions.get(intent.launchVersionId) ?? null;
}

/** The step's command rendered from the values its job sends, or why it is not shown. */
function renderedView(
  step: Pick<StepRow, "headAddr">,
  intent: StepIntent | null,
  phase: StepCommandPhase,
  version: StepVersion | null,
  context: StepViewContext,
): Pick<StepView, "rendered" | "headAddr"> {
  const unavailable = (reason: "intent" | "version" | "head_addr") => ({
    rendered: { state: "unavailable" as const, reason },
    headAddr: null,
  });
  if (!intent) return unavailable("intent");
  // The node renders the spec whose hash the job names; only that one is rendered here.
  if (!version?.spec || intent.launchHash !== version.launchHash) return unavailable("version");
  // As dispatch resolves it: a stop or status probe names the head address its launch was
  // dispatched with (stored on the step); otherwise the head rank's member address on the
  // step's fabric.
  let headAddr: string | null = null;
  if (intent.nnodes > 1) {
    if (phase === "STOP" || phase === "STATUS") headAddr = step.headAddr ?? null;
    const fabric = context.fabric?.id === intent.fabricId ? context.fabric : null;
    headAddr ??= fabric?.Members.find((member) => member.nodeId === context.headNodeId)?.ip ?? null;
    if (!headAddr) return unavailable("head_addr");
  }
  // The name of the fabric the job names (`intent.fabricId`), as the node checks it. A stop or
  // status probe runs the rank's recorded launch, never re-rendered: the node does not check
  // the fabric again (it may have been renamed or deleted since), so neither does the preview.
  const fabricId = intent.nnodes > 1 ? intent.fabricId : null;
  const recorded = phase === "STOP" || phase === "STATUS";
  const fabricName =
    fabricId === null
      ? null
      : recorded
        ? (version.spec.launch?.fabric ?? null)
        : context.fabric?.id === fabricId
          ? context.fabric.name
          : (context.fabricNames.get(fabricId) ?? null);
  const rendered = renderStepCommand({
    spec: version.spec,
    phase,
    intent,
    placeholders: stepJobPlaceholders(intent, headAddr),
    fabricName,
  });
  return { rendered, headAddr };
}

export function stepView(step: StepRow, context: StepViewContext): StepView {
  const parsed = stepIntentSchema.safeParse(step.intent);
  const intent = parsed.success && parsed.data.rank === step.rank ? parsed.data : null;
  // The version the step names (a restart's earlier launch for its stop), never its successor.
  const version = stepVersionOf(intent, context);
  // Without the step's intent, its version, or for another launch spec than that version's, the
  // text here would not be known to be what runs: no command is shown.
  const known = intent !== null && version !== null && intent.launchHash === version.launchHash;
  const launch = (version ?? context).spec?.launch;
  const commands = launch ? rankCommands(launch, step.rank) : undefined;
  const commandKey = STEP_COMMAND[step.phase];
  const interactiveKey =
    step.phase in INTERACTIVE_KEY
      ? INTERACTIVE_KEY[step.phase as keyof typeof INTERACTIVE_KEY]
      : null;
  const command = known && commandKey && commands ? (commands[commandKey] ?? null) : null;
  // Dispatch opens a terminal from the intent's flag; the spec's flag only when it is unreadable.
  const interactive =
    intent?.interactive ??
    (interactiveKey ? commands?.interactive?.[interactiveKey] === true : false);
  const author = version?.author ?? null;
  return {
    id: step.id,
    nodeNumber: step.rank + 1,
    phase: step.phase,
    state: step.state,
    attempts: step.attempts,
    errorCode: step.errorCode,
    interactive,
    command,
    commandAuthor:
      command === null
        ? null
        : author === "AGENT"
          ? "agent"
          : author === "USER"
            ? "user"
            : "unknown",
    // Interactive steps only: a person authorizes those (and views stay small for agents).
    ...(interactive && step.phase !== "READINESS"
      ? renderedView(step, intent, step.phase, version, context)
      : { rendered: null, headAddr: null }),
    terminalOpen: step.operatorTerminalId !== null,
    updatedAt: step.updatedAt.toISOString(),
  };
}

/** The step-view context of an instance (`INSTANCE_INCLUDE`), with `loadStepRefs`' refs. */
export function stepViewContext(
  row: Pick<InstanceRow, "launchVersionId" | "LaunchVersion" | "Fabric"> & {
    Ranks: ReadonlyArray<{ rank: number; nodeId: string | null }>;
  },
  refs: StepRefs = NO_STEP_REFS,
): StepViewContext {
  return {
    launchVersionId: row.launchVersionId,
    spec: safeSpec(row.LaunchVersion.spec),
    launchHash: row.LaunchVersion.launchHash,
    author: row.LaunchVersion.editor,
    versions: refs.versions,
    fabricNames: refs.fabricNames,
    fabric: row.Fabric,
    headNodeId: row.Ranks.find((rank) => rank.rank === 0)?.nodeId ?? null,
  };
}

function safeSpec(value: unknown): RuntimeSpec | null {
  const parsed = runtimeSpecSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * What these instances' steps name besides their own launch version and fabric (a stop or status
 * probe of a restart's earlier launch), read under the owner: one query each for versions and
 * fabrics, none when every step names its instance's own. One not found is left out (a step
 * naming another version then shows no command; another fabric, no fabric name).
 */
export async function loadStepRefs(
  db: Pick<Prisma.TransactionClient, "runtimeVersion" | "fabric">,
  userId: string,
  rows: ReadonlyArray<{
    launchVersionId: string;
    Fabric: { id: string } | null;
    Steps: ReadonlyArray<{ intent: Prisma.JsonValue }>;
  }>,
): Promise<StepRefs> {
  const versionIds = new Set<string>();
  const fabricIds = new Set<string>();
  for (const row of rows)
    for (const step of row.Steps) {
      const intent = stepIntentSchema.safeParse(step.intent);
      if (!intent.success) continue;
      if (intent.data.launchVersionId !== row.launchVersionId)
        versionIds.add(intent.data.launchVersionId);
      const fabricId = intent.data.nnodes > 1 ? intent.data.fabricId : null;
      if (fabricId !== null && fabricId !== row.Fabric?.id) fabricIds.add(fabricId);
    }
  if (versionIds.size === 0 && fabricIds.size === 0) return NO_STEP_REFS;
  const [versions, fabrics] = await Promise.all([
    versionIds.size === 0
      ? []
      : db.runtimeVersion.findMany({
          where: { id: { in: [...versionIds] }, Runtime: { userId } },
          select: { id: true, spec: true, launchHash: true, editor: true },
        }),
    fabricIds.size === 0
      ? []
      : db.fabric.findMany({
          where: { id: { in: [...fabricIds] }, userId },
          select: { id: true, name: true },
        }),
  ]);
  return {
    versions: new Map(
      versions.map((version) => [
        version.id,
        { spec: safeSpec(version.spec), launchHash: version.launchHash, author: version.editor },
      ]),
    ),
    fabricNames: new Map(fabrics.map((fabric) => [fabric.id, fabric.name])),
  };
}

/**
 * The pending release request of a claim marked stopped, unless it expired (the sweep settles it
 * soon). Rows read without the include (older callers' fixtures) have none.
 */
function pendingReleaseRequest(
  rank: { claim: string; ReleaseRequests?: ReadonlyArray<{ id: string; expiresAt: Date }> },
  now: Date,
): string | null {
  if (rank.claim !== "HELD_UNKNOWN") return null;
  const request = rank.ReleaseRequests?.[0];
  return request && request.expiresAt > now ? request.id : null;
}

/** A reservation row of the current plan (`CURRENT_RESERVATION_WHERE`), not a replaced run's. */
function isCurrentReservation(row: { supersededGeneration: number | null }): boolean {
  return row.supersededGeneration === CURRENT_RESERVATION_WHERE.supersededGeneration;
}

/** A rank's claim of the run a restart replaced (`prev*`), while it still holds. */
function previousClaimView(rank: {
  claim: string;
  prevPort: number | null;
  prevDistPort: number | null;
  prevResources: Prisma.JsonValue | null;
}): InstanceView["ranks"][number]["previousClaim"] {
  if (rank.claim === "RELEASED" || rank.prevPort === null) return null;
  return {
    port: rank.prevPort,
    distPort: rank.prevDistPort,
    memoryGb: reservationMemoryGb(rank.prevResources),
    gpus: recordedGpuKeys(rank.prevResources) ?? [],
  };
}

/**
 * `stopChecks` (`latestStopChecks`): the last finished status probe per rank of STOPPING
 * instances, for callers that show why a stop is not confirmed; others pass none and report null.
 */
export function instanceView(
  row: InstanceRow,
  stopChecks: ReadonlyMap<string, StopCheck> = new Map(),
  liveLoad: ReadonlyMap<string, InstanceLiveLoad> = NO_LIVE_LOAD,
  /** `loadStepRefs` of the row: without it, steps of another version show no command. */
  stepRefs: StepRefs = NO_STEP_REFS,
): InstanceView {
  const now = new Date();
  const load = liveLoad.get(row.id) ?? null;
  const advanced = advancedView(row.Version.advanced);
  const context = stepViewContext(row, stepRefs);
  // Rows read without the include (older callers' fixtures) have none.
  const reservations = row.Reservations ?? [];
  const reserved = reservationClaim(row.Ranks);
  const reservationView = (reservation: InstanceRow["Reservations"][number]) => ({
    index: reservation.index,
    nodeId: reservation.nodeId,
    nodeSlug: reservation.Node?.slug ?? null,
    labels: reservation.labels,
    memoryGb: reservationMemoryGb(reservation.resources),
    gpus: recordedGpuKeys(reservation.resources) ?? [],
    reserved,
    nodeConnection: nodeConnectionView(reservation.Node),
  });
  return {
    id: row.id,
    runtimeId: row.runtimeId,
    handle: row.handle,
    versionId: row.versionId,
    launchVersionId: row.launchVersionId,
    versionNumber: row.Version.version,
    desiredState: row.desiredState,
    phase: row.phase,
    phaseReason: row.phaseReason,
    phaseChangedAt: row.phaseChangedAt.toISOString(),
    // Shown only while it explains the phase (a stopped run keeps its last value).
    healthDetail: row.phase === "UNHEALTHY" ? row.healthDetail : null,
    needsOperator: row.needsOperator,
    startedBy: row.startedBy,
    restartWindow: {
      used: row.restartsInWindow,
      budget: Number(advanced.restartBudget.effective ?? 0),
      windowMin: Number(advanced.restartWindowMin.effective ?? 0),
      nextRestartAt: row.nextRestartAt?.toISOString() ?? null,
    },
    ranks: row.Ranks.map((rank) => ({
      nodeNumber: rank.rank + 1,
      nodeId: rank.nodeId,
      nodeSlug: rank.Node?.slug ?? null,
      port: rank.port,
      distPort: rank.distPort,
      gpus: recordedGpuKeys(rank.resources) ?? [],
      reserved: rank.claim,
      unitName: rank.unitName,
      nodeConnection: nodeConnectionView(rank.Node),
      lastStopCheck:
        row.phase === "STOPPING" || rank.claim === "HELD_UNKNOWN"
          ? (stopChecks.get(stopCheckKey(row.id, rank.rank)) ?? null)
          : null,
      releasedUnproven:
        rank.claim === "RELEASED" && rank.releasedUnprovenAt
          ? {
              at: rank.releasedUnprovenAt.toISOString(),
              reason: rank.releasedUnprovenReason ?? "unknown",
            }
          : null,
      releaseRequestId: pendingReleaseRequest(rank, now),
      previousClaim: previousClaimView(rank),
    })),
    reservations: reservations
      .filter((reservation) => isCurrentReservation(reservation))
      .map(reservationView),
    // A replaced run's rows hold only while a rank does (`reservationClaim`).
    supersededReservations:
      reserved === "RELEASED"
        ? []
        : reservations
            .filter((reservation) => !isCurrentReservation(reservation))
            .map(reservationView),
    openSteps: row.Steps.map((step) => stepView(step, context)),
    // Load from the relay's in-memory cache (null: unknown here); `at` is the reading's time,
    // or the engine facts' while no reading is known.
    live: {
      running: load?.running ?? null,
      waiting: load?.waiting ?? null,
      kvUsage: load?.kvUsage ?? null,
      slots: row.engineSlots,
      at: (load?.at ?? row.factsAt)?.toISOString() ?? null,
    },
  };
}

/** The previous version's `launchIdentity` for each version number (for `launchChanged`). */
export function previousLaunchHashes(
  versions: ReadonlyArray<{ version: number; launchHash: string; spec: unknown }>,
): Map<number, string | null> {
  const sorted = [...versions].sort((a, b) => a.version - b.version);
  const result = new Map<number, string | null>();
  let previous: string | null = null;
  for (const version of sorted) {
    result.set(version.version, previous);
    previous = launchIdentity(version);
  }
  return result;
}
