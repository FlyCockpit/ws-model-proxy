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
import { jsonObject, registryView } from "./registry-view";
import { type RuntimeSpec, runtimeSpecSchema } from "./runtime-spec";
import { type StepIntent, stepIntentSchema, stepJobPlaceholders } from "./step-intent";

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
} as const satisfies Prisma.RuntimeVersionSelect;
export type VersionRow = Prisma.RuntimeVersionGetPayload<{ select: typeof VERSION_SELECT }>;

export const INSTANCE_INCLUDE = {
  Ranks: { include: { Node: { select: { slug: true } } }, orderBy: { rank: "asc" } },
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
  Instances: { select: { phase: true, needsOperator: true, desiredState: true } },
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

export function versionSummary(row: VersionRow, previousLaunchHash: string | null): VersionSummary {
  return {
    id: row.id,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    editor: actorRef(row),
    note: row.note,
    launchHash: row.launchHash,
    launchChanged: previousLaunchHash === null || previousLaunchHash !== row.launchHash,
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
  previousLaunchHash: string | null,
  facts: EngineFacts | null = null,
): z.infer<typeof runtimeVersionDetailSchema> {
  return {
    ...versionSummary(row, previousLaunchHash),
    runtimeId: row.runtimeId,
    contentHash: row.contentHash,
    spec: storedSpec(row.spec),
    limits: limitsView(row, facts),
    advanced: advancedView(row.advanced),
  };
}

export function runtimeSummary(
  row: RuntimeSummaryRow,
  previousLaunchHash: string | null,
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
    currentVersion: versionSummary(current, previousLaunchHash),
    models: row.Models.map((model) => model.upstreamModelId),
    instances: counts,
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

/** What a step view needs of its instance to show the command as the node renders it. */
export type StepViewContext = {
  /** The instance's launch version (its spec, null when unreadable). */
  spec: RuntimeSpec | null;
  /** `sha256(canonicalJson(spec))`: the identity the node renders by. */
  launchHash: string;
  author: "USER" | "AGENT" | "SYSTEM";
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
>;

/** The step's command rendered from the values its job sends, or why it is not shown. */
function renderedView(
  intent: StepIntent | null,
  phase: StepCommandPhase,
  context: StepViewContext,
): Pick<StepView, "rendered" | "headAddr"> {
  const unavailable = (reason: "intent" | "version" | "head_addr") => ({
    rendered: { state: "unavailable" as const, reason },
    headAddr: null,
  });
  if (!intent) return unavailable("intent");
  // The node renders the spec whose hash the job names; only that one is rendered here.
  if (!context.spec || intent.launchHash !== context.launchHash) return unavailable("version");
  // As dispatch resolves it: the head rank's member address on the step's fabric.
  let headAddr: string | null = null;
  if (intent.nnodes > 1) {
    const fabric = context.fabric?.id === intent.fabricId ? context.fabric : null;
    headAddr = fabric?.Members.find((member) => member.nodeId === context.headNodeId)?.ip ?? null;
    if (!headAddr) return unavailable("head_addr");
  }
  const rendered = renderStepCommand({
    spec: context.spec,
    phase,
    intent,
    placeholders: stepJobPlaceholders(intent, headAddr),
    fabricName: context.fabric?.name ?? null,
  });
  return { rendered, headAddr };
}

export function stepView(step: StepRow, context: StepViewContext): StepView {
  const parsed = stepIntentSchema.safeParse(step.intent);
  const intent = parsed.success && parsed.data.rank === step.rank ? parsed.data : null;
  // Without the step's intent, or for another launch spec than the instance's, the text here
  // would not be known to be what runs: no command is shown.
  const known = intent !== null && intent.launchHash === context.launchHash;
  const launch = context.spec?.launch;
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
  const { author } = context;
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
      ? renderedView(intent, step.phase, context)
      : { rendered: null, headAddr: null }),
    terminalOpen: step.operatorTerminalId !== null,
    updatedAt: step.updatedAt.toISOString(),
  };
}

/** The step-view context of an instance (`INSTANCE_INCLUDE`). */
export function stepViewContext(
  row: Pick<InstanceRow, "LaunchVersion" | "Fabric"> & {
    Ranks: ReadonlyArray<{ rank: number; nodeId: string | null }>;
  },
): StepViewContext {
  return {
    spec: safeSpec(row.LaunchVersion.spec),
    launchHash: row.LaunchVersion.launchHash,
    author: row.LaunchVersion.editor,
    fabric: row.Fabric,
    headNodeId: row.Ranks.find((rank) => rank.rank === 0)?.nodeId ?? null,
  };
}

function safeSpec(value: unknown): RuntimeSpec | null {
  const parsed = runtimeSpecSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function instanceView(row: InstanceRow): InstanceView {
  const advanced = advancedView(row.Version.advanced);
  const context = stepViewContext(row);
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
      reserved: rank.claim,
      unitName: rank.unitName,
    })),
    openSteps: row.Steps.map((step) => stepView(step, context)),
    // TODO(lane A, hot path): live load comes from the relay's in-memory engine-load cache.
    live: {
      running: null,
      waiting: null,
      kvUsage: null,
      slots: row.engineSlots,
      at: row.factsAt?.toISOString() ?? null,
    },
  };
}

/** The previous version's launch hash for each version number (for `launchChanged`). */
export function previousLaunchHashes(
  versions: ReadonlyArray<{ version: number; launchHash: string }>,
): Map<number, string | null> {
  const sorted = [...versions].sort((a, b) => a.version - b.version);
  const result = new Map<number, string | null>();
  let previous: string | null = null;
  for (const version of sorted) {
    result.set(version.version, previous);
    previous = version.launchHash;
  }
  return result;
}
