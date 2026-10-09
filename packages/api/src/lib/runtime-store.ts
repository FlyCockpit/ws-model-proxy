/**
 * Runtime writes shared by `runtimes.create`, `runtimes.detected.add`, `runtimes.fork` and
 * `runtimes.update`: version rows (derived columns, hashes), served-model sync and node trust.
 */

import { randomBytes } from "node:crypto";
import { RUNTIME_LIMIT_COLUMNS } from "@ws-model-proxy/config/runtime-defaults";
import prisma, { Prisma } from "@ws-model-proxy/db";
import type { z } from "zod";
import type { runtimeAdvancedPatchSchema, runtimeLimitsPatchSchema } from "../contracts/advanced";
import { type CallerActor } from "./caller-actor";
import { clearInstanceReleaseRequests } from "./claim-release";
import { refuseAbout } from "./refuse";
import { applyJsonPatch } from "./registry-view";
import type { RequestCompat } from "./request-compat";
import { runtimeContentHash, runtimeLaunchHash } from "./runtime-launch-hash";
import type { RuntimeSpec } from "./runtime-spec";

export type Tx = Prisma.TransactionClient;
type LimitsPatch = z.infer<typeof runtimeLimitsPatchSchema>;
type AdvancedPatch = z.infer<typeof runtimeAdvancedPatchSchema>;

export type LimitColumns = {
  concurrencyLimit: number | null;
  contextLimit: number | null;
  kvBudgetTokens: number | null;
  kvFullThreshold: number | null;
  engineLoadGate: "AUTO" | "ENFORCE" | "OBSERVE";
};

export const AUTOMATIC_LIMITS: LimitColumns = {
  concurrencyLimit: null,
  contextLimit: null,
  kvBudgetTokens: null,
  kvFullThreshold: null,
  engineLoadGate: "AUTO",
};

/** Applies a limits patch: absent keeps, null returns to automatic. */
export function applyLimitsPatch(
  current: LimitColumns,
  patch: LimitsPatch | undefined,
): LimitColumns {
  const next = { ...current };
  if (!patch) return next;
  for (const key of Object.keys(RUNTIME_LIMIT_COLUMNS) as Array<keyof LimitColumns>) {
    const value = patch[key];
    if (value === undefined) continue;
    if (key === "engineLoadGate")
      next.engineLoadGate = value === null ? "AUTO" : (value as LimitColumns["engineLoadGate"]);
    else next[key] = value as number | null;
  }
  return next;
}

export function applyAdvancedPatch(
  current: Record<string, unknown>,
  patch: AdvancedPatch | undefined,
): Record<string, unknown> {
  return applyJsonPatch(current, patch);
}

const API = { openai: "OPENAI", anthropic: "ANTHROPIC" } as const;
const ENGINE = {
  vllm: "VLLM",
  sglang: "SGLANG",
  llama_cpp: "LLAMA_CPP",
  ollama: "OLLAMA",
  lm_studio: "LM_STUDIO",
  other: "OTHER",
} as const;
export const MODEL_TYPE = {
  llm: "LLM",
  embeddings: "EMBEDDINGS",
  transcription: "TRANSCRIPTION",
} as const;
export const CAPABILITY = {
  text_generation: "TEXT_GENERATION",
  vision_input: "VISION_INPUT",
  video_input: "VIDEO_INPUT",
  embedding: "EMBEDDING",
  audio_input: "AUDIO_INPUT",
  audio_output: "AUDIO_OUTPUT",
  responses_api: "RESPONSES_API",
} as const;

/** `RuntimeVersion.api/engine/modelType` exactly as `runtime_version_derived_columns` checks. */
export function derivedColumns(spec: RuntimeSpec) {
  return {
    api: spec.api ? API[spec.api] : null,
    engine: spec.engine ? ENGINE[spec.engine] : null,
    modelType: spec.modelType ? MODEL_TYPE[spec.modelType] : null,
  };
}

export function versionHashes(
  spec: RuntimeSpec,
  limits: LimitColumns,
  advanced: Record<string, unknown>,
  compat: RequestCompat = {},
) {
  return {
    launchHash: runtimeLaunchHash(spec),
    contentHash: runtimeContentHash({ spec, limits, advanced, compat }),
  };
}

/** The trust the server acts on: a requested lowering counts as Relay only at once. */
export function effectiveTrust(node: {
  trust: "RELAY" | "FULL" | null;
  trustLowerRequestedAt: Date | null;
}): "RELAY" | "FULL" | null {
  return node.trustLowerRequestedAt ? "RELAY" : node.trust;
}

export function specIsInteractive(spec: RuntimeSpec): boolean {
  return (spec.launch?.commands ?? []).some(
    (commands) => !!commands.interactive && Object.values(commands.interactive).some(Boolean),
  );
}

/**
 * Who wrote a version: a caller, or SYSTEM for a definition the server took from a node's
 * inventory (`wsmp runtime add`: written on the node, by nobody the server saw).
 */
export type VersionEditor = Omit<CallerActor, "actor"> & {
  actor: CallerActor["actor"] | "SYSTEM";
};

export async function createVersion(
  tx: Tx,
  input: {
    runtimeId: string;
    version: number;
    actor: VersionEditor;
    spec: RuntimeSpec;
    limits: LimitColumns;
    advanced: Record<string, unknown>;
    /** Request compatibility (absent: automatic). */
    compat?: RequestCompat;
    note: string | null;
  },
) {
  const compat = input.compat ?? {};
  const hashes = versionHashes(input.spec, input.limits, input.advanced, compat);
  return tx.runtimeVersion.create({
    data: {
      runtimeId: input.runtimeId,
      version: input.version,
      editor: input.actor.actor,
      editorUserId: input.actor.actorUserId,
      agentTokenId: input.actor.agentTokenId,
      mcpGrantId: input.actor.mcpGrantId,
      note: input.note,
      spec: input.spec as Prisma.InputJsonValue,
      ...derivedColumns(input.spec),
      ...input.limits,
      advanced: input.advanced as Prisma.InputJsonValue,
      compat: compat as Prisma.InputJsonValue,
      ...hashes,
    },
    select: { id: true, launchHash: true, contentHash: true },
  });
}

/**
 * Served models follow the spec: listed ids are (re)activated with the spec's type and declared
 * capabilities; others are retired (kept while pools reference them). An always-on runtime
 * without `models` keeps what discovery found.
 */
export async function syncRuntimeModels(
  tx: Tx,
  input: { userId: string; runtimeId: string; spec: RuntimeSpec },
): Promise<void> {
  const { spec } = input;
  if (spec.address && !spec.models) return;
  const type = spec.modelType ? MODEL_TYPE[spec.modelType] : null;
  const listed = spec.models ?? [];
  for (const model of listed) {
    if (!type) break;
    const detectedCapabilities = (model.capabilities ?? []).map(
      (capability) => CAPABILITY[capability],
    );
    await tx.runtimeModel.upsert({
      where: {
        runtimeId_upstreamModelId: { runtimeId: input.runtimeId, upstreamModelId: model.id },
      },
      create: {
        userId: input.userId,
        runtimeId: input.runtimeId,
        upstreamModelId: model.id,
        type,
        detectedCapabilities,
        embeddingContract: (model.embeddingContract ?? undefined) as
          | Prisma.InputJsonValue
          | undefined,
        transcriptionProfile: (model.transcription ?? undefined) as
          | Prisma.InputJsonValue
          | undefined,
      },
      // The definition is the only source of both: a new version replaces or clears them.
      update: {
        type,
        detectedCapabilities,
        retired: false,
        embeddingContract: (model.embeddingContract ?? Prisma.DbNull) as
          | Prisma.InputJsonValue
          | typeof Prisma.DbNull,
        transcriptionProfile: (model.transcription ?? Prisma.DbNull) as
          | Prisma.InputJsonValue
          | typeof Prisma.DbNull,
      },
    });
  }
  await tx.runtimeModel.updateMany({
    where: {
      runtimeId: input.runtimeId,
      upstreamModelId: { notIn: listed.map((model) => model.id) },
      retired: false,
    },
    data: { retired: true },
  });
}

/** The caller's node, with what trust checks need; `unknown_node` otherwise. */
export async function ownedNode(userId: string, nodeId: string) {
  const node = await prisma.node.findFirst({
    where: { id: nodeId, userId },
    select: { id: true, slug: true, trust: true, trustLowerRequestedAt: true },
  });
  if (!node) throw refuseAbout("unknown_node", nodeId, "That node does not exist.");
  return node;
}

/** Why an instance is told to stop (`RuntimeInstance.phaseReason`). */
export type StopReason = "stop_requested" | "preempted" | "profile_apply";

/**
 * The one write that tells running instances to stop (people's and agents' stops, and a start's
 * preemption): desired STOPPED, phase STOPPING, under `operationId`. Dispatch reads these rows.
 * Callers hold the owner fence and the capacity fences of `instanceIds`. Returns how many rows
 * changed (an instance that stopped meanwhile is left alone).
 */
export async function markInstancesStopping(
  tx: Tx,
  /** The owner: only their instances are marked (the operation is theirs too). */
  userId: string,
  instanceIds: readonly string[],
  operationId: string,
  reason: StopReason,
): Promise<number> {
  if (instanceIds.length === 0) return 0;
  const result = await tx.runtimeInstance.updateMany({
    where: { id: { in: [...instanceIds] }, userId, desiredState: "RUNNING" },
    data: {
      desiredState: "STOPPED",
      phase: "STOPPING",
      phaseChangedAt: new Date(),
      phaseReason: reason,
      needsOperator: null,
      needsOperatorSince: null,
      operationId,
    },
  });
  return result.count;
}

/** A cuid2-shaped id (lower-case, starts with a letter) so the handle can be derived from it. */
export function newInstanceId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(24);
  let id = "c";
  for (let index = 1; index < 24; index++) id += alphabet[(bytes[index] ?? 0) % alphabet.length];
  return id;
}

export type PlannedStartWrite = {
  runtimeId: string;
  versionId: string;
  /** A restart of this instance; null: a new instance. */
  instanceId: string | null;
  placements: ReadonlyArray<{
    nodeId: string;
    nodeNumber: number;
    port: number;
    resources: Record<string, unknown>;
  }>;
  fabric: { fabricId: string } | null;
  distPort: number | null;
};

/**
 * The one write of planned starts (runtime start/restart and profile apply): instances STARTING
 * under `operationId` with their claims (port, dist port, resources with the GPUs the planner
 * picked, the fabric, the instances each start waits for). The lifecycle engine creates the
 * steps. Callers hold the owner fence and the capacity fences of restarted instances.
 */
export async function writePlannedStarts(
  tx: Tx,
  input: {
    userId: string;
    operationId: string;
    startedBy: "USER" | "AGENT";
    starts: readonly PlannedStartWrite[];
    /** Per start (same order): the stopping instances its new ranks wait for. */
    blockedBy: ReadonlyArray<readonly string[]>;
  },
): Promise<string[]> {
  const now = new Date();
  const ids: string[] = [];
  for (const [index, start] of input.starts.entries()) {
    const blockedBy = [...(input.blockedBy[index] ?? [])];
    if (start.instanceId) {
      await tx.runtimeInstance.update({
        where: { id: start.instanceId },
        data: {
          versionId: start.versionId,
          launchVersionId: start.versionId,
          operationId: input.operationId,
          startedBy: input.startedBy,
          desiredState: "RUNNING",
          phase: "STARTING",
          phaseChangedAt: now,
          phaseReason: "restart_requested",
          needsOperator: null,
          needsOperatorSince: null,
          restartsInWindow: 0,
          restartWindowStartedAt: null,
          nextRestartAt: null,
          fabricId: start.fabric?.fabricId ?? null,
        },
      });
      // Each rank takes the new version's resources (and the GPUs the plan picked).
      for (const placement of start.placements)
        await tx.instanceRank.update({
          where: {
            instanceId_rank: { instanceId: start.instanceId, rank: placement.nodeNumber - 1 },
          },
          data: {
            claim: "HELD",
            claimChangedAt: now,
            stoppedAt: null,
            lastStopCheckAt: null,
            releasedUnprovenAt: null,
            releasedUnprovenBy: null,
            releasedUnprovenReason: null,
            port: placement.port,
            distPort: start.distPort,
            resources: placement.resources as Prisma.InputJsonObject,
            blockedBy,
          },
        });
      // The claims are held by the new run: a request to release the old one has nothing left.
      await clearInstanceReleaseRequests(tx, start.instanceId, now);
      ids.push(start.instanceId);
      continue;
    }
    const id = newInstanceId();
    const handle = `i-${id.slice(0, 12)}`;
    await tx.runtimeInstance.create({
      data: {
        id,
        userId: input.userId,
        runtimeId: start.runtimeId,
        versionId: start.versionId,
        launchVersionId: start.versionId,
        handle,
        operationId: input.operationId,
        startedBy: input.startedBy,
        desiredState: "RUNNING",
        phase: "STARTING",
        fabricId: start.fabric?.fabricId ?? null,
        Ranks: {
          create: start.placements.map((placement) => ({
            nodeId: placement.nodeId,
            rank: placement.nodeNumber - 1,
            unitName: `wsmp-${handle}-r${placement.nodeNumber - 1}`,
            port: placement.port,
            distPort: start.distPort,
            portFixed: false,
            resources: placement.resources as Prisma.InputJsonObject,
            blockedBy,
          })),
        },
      },
    });
    ids.push(id);
  }
  return ids;
}
