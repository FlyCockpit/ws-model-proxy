/**
 * Always-on runtimes from a node's complete `runtime.inventory` (spec §3.7, §4.3).
 *
 * - Node-origin entries (`wsmp runtime add`) carry their `spec`. The server creates the Runtime
 *   (ALWAYS_ON, origin NODE, on this node) with version 1, its served models and its one
 *   instance, or adds a version when the spec's launch hash changed (limits and advanced
 *   settings carry over). Only the node changes a node-origin definition: the server refuses
 *   launch edits to it (`launch_change_on_node_origin`) because it never pushes one back. A
 *   node-origin runtime this node no longer reports is removed with its instance (removing the
 *   runtime removes the instance, §3.7); one a profile pins is kept, UNAVAILABLE `node_removed`.
 * - Served models discovery reports are retired only when the entry is the whole served set
 *   (not truncated, server online): a server that is down lists nothing.
 * - Every always-on entry (either origin) then updates its instance: served models a spec
 *   without `models` leaves to discovery, the execution targets of those models, the observed
 *   engine facts, and the phase from the node's status.
 *
 * Slug rule: the node routes an always-on runtime by its slug, which is also the instance handle
 * (unique per user). A node-origin slug that another runtime or instance of the user already has
 * (a server-origin runtime, or a node-origin runtime of another node) is skipped with a log;
 * suffixing cannot work because the node would still route by the original name. The person
 * renames it on the node (`wsmp runtime remove` then `add --slug`).
 *
 * Writes run under the owner fence (graph rows) and the capacity fences of the runtime's
 * instances (the admission version and the observed facts change).
 */
import { canonicalJson } from "@ws-model-proxy/api/lib/canonical-json";
import {
  mergeEngineFacts,
  type StoredInstanceFacts,
  sameStoredInstanceFacts,
  storedInstanceFacts,
} from "@ws-model-proxy/api/lib/engine-facts";
import {
  graphDelete,
  graphWrite,
  runtimeCapacityFences,
} from "@ws-model-proxy/api/lib/graph-write";
import { storedRequestCompat } from "@ws-model-proxy/api/lib/request-compat";
import { runtimeLaunchHash } from "@ws-model-proxy/api/lib/runtime-launch-hash";
import {
  READER_SIGNALS,
  type ReaderSignal,
  RUNTIME_DEFINITIONS_MAX,
  type RuntimeSpec,
  runtimeSpecSchema,
} from "@ws-model-proxy/api/lib/runtime-spec";
import {
  AUTOMATIC_LIMITS,
  CAPABILITY,
  createVersion,
  syncRuntimeModels,
  type VersionEditor,
} from "@ws-model-proxy/api/lib/runtime-store";
import prisma, { type Prisma } from "@ws-model-proxy/db";
import type { AlwaysOnInventory } from "../relay/frames.js";
import type { NodeSessionRef } from "../relay/session-manager.js";

type Tx = Prisma.TransactionClient;
type Phase = "READY" | "UNHEALTHY" | "UNAVAILABLE";
type ModelType = "LLM" | "EMBEDDINGS" | "TRANSCRIPTION";

/** The always-on instance phase a node status means (§3.7). */
export function alwaysOnPhase(status: AlwaysOnInventory["status"]): Phase {
  if (status === "online") return "READY";
  if (status === "degraded") return "UNHEALTHY";
  return "UNAVAILABLE";
}

/** Why a node-origin entry is not taken (logged; the entry is left as the server has it). */
export type NodeOriginRefusal = "not_always_on" | "hash_mismatch" | "invalid";

/**
 * The spec of a node-origin entry, checked again on the server: a valid always-on spec whose
 * launch hash is the one the node reported.
 */
export function nodeOriginSpec(
  entry: AlwaysOnInventory,
): { ok: true; spec: RuntimeSpec; launchHash: string } | { ok: false; reason: NodeOriginRefusal } {
  const parsed = runtimeSpecSchema.safeParse(entry.spec);
  if (!parsed.success) return { ok: false, reason: "invalid" };
  const spec = parsed.data;
  if (!spec.address || spec.launch) return { ok: false, reason: "not_always_on" };
  const launchHash = runtimeLaunchHash(spec);
  if (launchHash !== entry.launchHash) return { ok: false, reason: "hash_mismatch" };
  return { ok: true, spec, launchHash };
}

export type DiscoveredModel = {
  upstreamModelId: string;
  detectedCapabilities: Array<(typeof CAPABILITY)[keyof typeof CAPABILITY]>;
  embeddingContract: Prisma.InputJsonValue | undefined;
  transcriptionProfile: Prisma.InputJsonValue | undefined;
};

/**
 * The served models discovery reports, or null when the spec lists its models (those follow
 * the spec, `syncRuntimeModels`). Duplicate ids keep the first.
 */
export function discoveredModels(
  spec: RuntimeSpec,
  entry: AlwaysOnInventory,
): DiscoveredModel[] | null {
  if (spec.models) return null;
  const seen = new Set<string>();
  const models: DiscoveredModel[] = [];
  for (const model of entry.models) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    models.push({
      upstreamModelId: model.id,
      detectedCapabilities: model.capabilities.map((capability) => CAPABILITY[capability]),
      embeddingContract: model.embeddingContract as Prisma.InputJsonValue | undefined,
      transcriptionProfile: model.transcription as Prisma.InputJsonValue | undefined,
    });
  }
  return models;
}

/**
 * The instance's observed engine facts: the runtime-level facts, with the served model's own
 * on top when it serves exactly one (one instance row holds one set of facts).
 */
export function alwaysOnFacts(entry: AlwaysOnInventory) {
  const only = entry.models.length === 1 ? entry.models[0] : undefined;
  return storedInstanceFacts(mergeEngineFacts(entry.engineFacts, only?.engineFacts));
}

const READER_SIGNAL_SET: ReadonlySet<string> = new Set(READER_SIGNALS);
function isReaderSignal(signal: string): signal is ReaderSignal {
  return READER_SIGNAL_SET.has(signal);
}

/** The fact columns an instance row holds now, as {@link storedInstanceFacts} spells them. */
export function instanceStoredFacts(row: {
  engineSlots: number | null;
  observedKvBudgetTokens: number | null;
  maxModelLen: number | null;
  countContext: StoredInstanceFacts["countContext"];
  loadSignals: readonly string[];
}): StoredInstanceFacts {
  return {
    engineSlots: row.engineSlots,
    observedKvBudgetTokens: row.observedKvBudgetTokens,
    maxModelLen: row.maxModelLen,
    countContext: row.countContext,
    loadSignals: row.loadSignals.filter(isReaderSignal),
  };
}

/** Equal JSON values, independent of key order. */
function sameJson(stored: Prisma.JsonValue, reported: Prisma.InputJsonValue): boolean {
  return canonicalJson(stored) === canonicalJson(reported);
}

function sameCapabilities(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Discovered models: new ones created, changed ones updated, unreported ones retired. */
async function syncDiscoveredModels(
  tx: Tx,
  input: {
    userId: string;
    runtimeId: string;
    type: ModelType;
    models: readonly DiscoveredModel[];
    /**
     * The list is the server's whole served set: false when the node cut the entry down, or
     * the server is not online (a server that is down lists nothing); then nothing is retired.
     */
    complete: boolean;
    now: Date;
  },
): Promise<void> {
  const existing = await tx.runtimeModel.findMany({
    where: { runtimeId: input.runtimeId, userId: input.userId },
    select: {
      upstreamModelId: true,
      type: true,
      detectedCapabilities: true,
      embeddingContract: true,
      transcriptionProfile: true,
      retired: true,
    },
  });
  const known = new Map(existing.map((model) => [model.upstreamModelId, model]));
  for (const model of input.models) {
    const row = known.get(model.upstreamModelId);
    if (!row) {
      await tx.runtimeModel.create({
        data: {
          userId: input.userId,
          runtimeId: input.runtimeId,
          upstreamModelId: model.upstreamModelId,
          type: input.type,
          detectedCapabilities: model.detectedCapabilities,
          embeddingContract: model.embeddingContract,
          transcriptionProfile: model.transcriptionProfile,
          lastSeenAt: input.now,
        },
      });
      continue;
    }
    if (
      row.type === input.type &&
      !row.retired &&
      sameCapabilities(row.detectedCapabilities, model.detectedCapabilities) &&
      (model.embeddingContract === undefined ||
        sameJson(row.embeddingContract, model.embeddingContract)) &&
      (model.transcriptionProfile === undefined ||
        sameJson(row.transcriptionProfile, model.transcriptionProfile))
    )
      continue;
    await tx.runtimeModel.update({
      where: {
        runtimeId_upstreamModelId: {
          runtimeId: input.runtimeId,
          upstreamModelId: model.upstreamModelId,
        },
      },
      data: {
        type: input.type,
        detectedCapabilities: model.detectedCapabilities,
        retired: false,
        ...(model.embeddingContract !== undefined
          ? { embeddingContract: model.embeddingContract }
          : {}),
        ...(model.transcriptionProfile !== undefined
          ? { transcriptionProfile: model.transcriptionProfile }
          : {}),
      },
    });
  }
  const reported = input.models.map((model) => model.upstreamModelId);
  if (reported.length > 0)
    await tx.runtimeModel.updateMany({
      where: { runtimeId: input.runtimeId, upstreamModelId: { in: reported } },
      data: { lastSeenAt: input.now },
    });
  if (!input.complete) return;
  // Kept while pools reference them (retired, not deleted).
  await tx.runtimeModel.updateMany({
    where: { runtimeId: input.runtimeId, upstreamModelId: { notIn: reported }, retired: false },
    data: { retired: true },
  });
}

/** Execution targets of the instance: one per served model (retired ones are never routed). */
async function registerTargets(
  tx: Tx,
  instance: { id: string; userId: string; runtimeId: string },
) {
  const models = await tx.runtimeModel.findMany({
    where: { runtimeId: instance.runtimeId, userId: instance.userId, retired: false },
    select: { id: true },
  });
  if (models.length === 0) return;
  await tx.executionTarget.createMany({
    data: models.map((model) => ({
      userId: instance.userId,
      kind: "INSTANCE_MODEL" as const,
      instanceId: instance.id,
      runtimeModelId: model.id,
    })),
    skipDuplicates: true,
  });
}

const SYSTEM_EDITOR = (userId: string): VersionEditor => ({
  actor: "SYSTEM",
  actorUserId: userId,
  agentTokenId: null,
  mcpGrantId: null,
});

const CURRENT_VERSION_SELECT = {
  id: true,
  version: true,
  editor: true,
  launchHash: true,
  spec: true,
  modelType: true,
  concurrencyLimit: true,
  contextLimit: true,
  kvBudgetTokens: true,
  kvFullThreshold: true,
  engineLoadGate: true,
  advanced: true,
  compat: true,
} as const;

function jsonObject(value: Prisma.JsonValue): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

type Logger = (message: string) => void;

/**
 * Creates or versions a node-origin runtime. Returns the runtime id, or null when the entry is
 * skipped (logged).
 */
async function upsertNodeOrigin(
  tx: Tx,
  ref: NodeSessionRef,
  entry: AlwaysOnInventory,
  checked: { spec: RuntimeSpec; launchHash: string },
  log: Logger,
): Promise<string | null> {
  const { userId, nodeId } = ref;
  const runtime = await tx.runtime.findUnique({
    where: { userId_slug: { userId, slug: entry.slug } },
    select: {
      id: true,
      kind: true,
      origin: true,
      nodeId: true,
      CurrentVersion: { select: CURRENT_VERSION_SELECT },
    },
  });
  if (
    runtime &&
    (runtime.origin !== "NODE" || runtime.kind !== "ALWAYS_ON" || runtime.nodeId !== nodeId)
  ) {
    log(`slug "${entry.slug}" is taken by another runtime of this user; skipped`);
    return null;
  }
  const editor = SYSTEM_EDITOR(userId);
  if (!runtime) {
    // The handle is the slug: an instance of another runtime may already route by it.
    const handleTaken = await tx.runtimeInstance.count({ where: { userId, handle: entry.slug } });
    if (handleTaken > 0) {
      log(`slug "${entry.slug}" is taken by another instance of this user; skipped`);
      return null;
    }
    const count = await tx.runtime.count({ where: { userId, nodeId, origin: "NODE" } });
    if (count >= RUNTIME_DEFINITIONS_MAX) {
      log(`more than ${RUNTIME_DEFINITIONS_MAX} node-origin runtimes; "${entry.slug}" skipped`);
      return null;
    }
    const created = await tx.runtime.create({
      data: {
        userId,
        slug: entry.slug,
        name: entry.slug,
        kind: "ALWAYS_ON",
        origin: "NODE",
        nodeId,
      },
      select: { id: true },
    });
    const version = await createVersion(tx, {
      runtimeId: created.id,
      version: 1,
      actor: editor,
      spec: checked.spec,
      limits: AUTOMATIC_LIMITS,
      advanced: {},
      note: "Added on the node",
    });
    await tx.runtime.update({ where: { id: created.id }, data: { currentVersionId: version.id } });
    await syncRuntimeModels(tx, { userId, runtimeId: created.id, spec: checked.spec });
    await tx.runtimeInstance.create({
      data: {
        userId,
        runtimeId: created.id,
        versionId: version.id,
        launchVersionId: version.id,
        handle: entry.slug,
        startedBy: "SYSTEM",
        desiredState: null,
        phase: alwaysOnPhase(entry.status),
        phaseReason: entry.status === "online" ? null : `node_${entry.status}`,
      },
    });
    return created.id;
  }
  const current = runtime.CurrentVersion;
  if (current?.launchHash === checked.launchHash) return runtime.id;
  // The node's definition changed. It alone changes a node-origin definition (the server
  // refuses launch edits, `launch_change_on_node_origin`): a new version; limits and advanced
  // settings, which people and agents may edit here, carry over.
  const latest = await tx.runtimeVersion.aggregate({
    where: { runtimeId: runtime.id },
    _max: { version: true },
  });
  const version = await createVersion(tx, {
    runtimeId: runtime.id,
    version: (latest._max.version ?? 0) + 1,
    actor: editor,
    spec: checked.spec,
    limits: current
      ? {
          concurrencyLimit: current.concurrencyLimit,
          contextLimit: current.contextLimit,
          kvBudgetTokens: current.kvBudgetTokens,
          kvFullThreshold: current.kvFullThreshold,
          engineLoadGate: current.engineLoadGate,
        }
      : AUTOMATIC_LIMITS,
    advanced: current ? jsonObject(current.advanced) : {},
    compat: current ? storedRequestCompat(current.compat) : {},
    note: "Changed on the node",
  });
  await tx.runtime.update({ where: { id: runtime.id }, data: { currentVersionId: version.id } });
  await syncRuntimeModels(tx, { userId, runtimeId: runtime.id, spec: checked.spec });
  // The always-on instance follows its runtime's current version (§3.4).
  await tx.runtimeInstance.updateMany({
    where: { runtimeId: runtime.id, userId, desiredState: null },
    data: { versionId: version.id, launchVersionId: version.id },
  });
  return runtime.id;
}

/** Models, targets, facts and phase of one always-on runtime's instance. */
async function observeInstance(
  tx: Tx,
  ref: NodeSessionRef,
  runtimeId: string,
  entry: AlwaysOnInventory,
  now: Date,
): Promise<void> {
  const runtime = await tx.runtime.findFirst({
    where: { id: runtimeId, userId: ref.userId, nodeId: ref.nodeId, kind: "ALWAYS_ON" },
    select: { slug: true, CurrentVersion: { select: { id: true, spec: true, modelType: true } } },
  });
  if (!runtime?.CurrentVersion) return;
  const select = {
    id: true,
    userId: true,
    runtimeId: true,
    phase: true,
    engineSlots: true,
    observedKvBudgetTokens: true,
    maxModelLen: true,
    countContext: true,
    loadSignals: true,
  } as const;
  let instance = await tx.runtimeInstance.findFirst({
    where: { runtimeId, userId: ref.userId, desiredState: null },
    select,
  });
  // An always-on runtime has exactly one instance; one that lost it gets it back (its handle
  // is the slug, unless something else took it meanwhile).
  if (!instance) {
    const taken = await tx.runtimeInstance.count({
      where: { userId: ref.userId, handle: runtime.slug },
    });
    if (taken > 0) return;
    instance = await tx.runtimeInstance.create({
      data: {
        userId: ref.userId,
        runtimeId,
        versionId: runtime.CurrentVersion.id,
        launchVersionId: runtime.CurrentVersion.id,
        handle: runtime.slug,
        startedBy: "SYSTEM",
        desiredState: null,
        phase: alwaysOnPhase(entry.status),
        phaseReason: entry.status === "online" ? null : `node_${entry.status}`,
      },
      select,
    });
  }
  const spec = runtimeSpecSchema.safeParse(runtime.CurrentVersion.spec);
  const type = runtime.CurrentVersion.modelType;
  if (spec.success && type) {
    const models = discoveredModels(spec.data, entry);
    if (models)
      await syncDiscoveredModels(tx, {
        userId: ref.userId,
        runtimeId,
        type,
        models,
        complete: entry.truncated !== true && entry.status === "online",
        now,
      });
  }
  await registerTargets(tx, instance);
  const facts = alwaysOnFacts(entry);
  if (facts && !sameStoredInstanceFacts(facts, instanceStoredFacts(instance)))
    await tx.runtimeInstance.update({
      where: { id: instance.id },
      data: { ...facts, factsAt: now },
    });
  const phase = alwaysOnPhase(entry.status);
  if (instance.phase !== phase)
    await tx.runtimeInstance.update({
      where: { id: instance.id },
      data: {
        phase,
        phaseChangedAt: now,
        phaseReason: phase === "READY" ? null : `node_${entry.status}`,
      },
    });
}

/**
 * Applies the always-on part of a complete inventory. Entries are independent: one that fails
 * is logged and the others still apply.
 */
export async function applyAlwaysOnInventory(
  ref: NodeSessionRef,
  entries: readonly AlwaysOnInventory[],
  now: Date,
): Promise<void> {
  const log: Logger = (message) => console.warn(`[always-on] node ${ref.nodeId}: ${message}`);
  // The node's own server-origin always-on runtimes, read once: an entry naming another runtime
  // costs nothing.
  const serverOwned = new Set(
    (
      await prisma.runtime.findMany({
        where: { userId: ref.userId, nodeId: ref.nodeId, kind: "ALWAYS_ON", origin: "SERVER" },
        select: { id: true },
      })
    ).map((runtime) => runtime.id),
  );
  const nodeSlugs = new Set<string>();
  const seen = new Set<string>();
  // A node holds at most RUNTIME_DEFINITIONS_MAX definitions of each origin; more node-origin
  // entries than that are not taken (the cap inside also counts existing ones).
  let nodeOriginWork = 0;
  for (const entry of entries) {
    // One entry per slug (the node's store keeps slugs unique; a repeat is ignored).
    if (seen.has(entry.slug)) continue;
    seen.add(entry.slug);
    if (entry.origin === "node") nodeSlugs.add(entry.slug);
    try {
      if (entry.origin === "server") {
        const runtimeId = entry.runtimeId;
        if (!runtimeId || !serverOwned.has(runtimeId)) continue;
        await graphWrite(
          [ref.userId],
          (tx) => observeInstance(tx, ref, runtimeId, entry, now),
          (tx) => runtimeCapacityFences(tx, runtimeId),
        );
        continue;
      }
      const checked = nodeOriginSpec(entry);
      if (!checked.ok) {
        log(`node-origin runtime "${entry.slug}" refused (${checked.reason})`);
        continue;
      }
      nodeOriginWork += 1;
      if (nodeOriginWork > RUNTIME_DEFINITIONS_MAX) {
        if (nodeOriginWork === RUNTIME_DEFINITIONS_MAX + 1)
          log(
            `more than ${RUNTIME_DEFINITIONS_MAX} node-origin runtimes reported; the rest skipped`,
          );
        continue;
      }
      await graphWrite(
        [ref.userId],
        async (tx) => {
          const runtimeId = await upsertNodeOrigin(tx, ref, entry, checked, log);
          if (runtimeId) await observeInstance(tx, ref, runtimeId, entry, now);
        },
        // Under the owner fence: the instances of the runtime this slug names now.
        async (tx) => {
          const existing = await tx.runtime.findUnique({
            where: { userId_slug: { userId: ref.userId, slug: entry.slug } },
            select: { id: true },
          });
          return existing ? runtimeCapacityFences(tx, existing.id) : [];
        },
      );
    } catch (error) {
      log(`always-on runtime "${entry.slug}" failed (${errorName(error)})`);
    }
  }
  await removeUnreported(ref, nodeSlugs, log);
}

const NODE_REMOVED = "node_removed";

/** Node-origin runtimes of this node it no longer reports: removed with their instance. */
async function removeUnreported(ref: NodeSessionRef, reported: ReadonlySet<string>, log: Logger) {
  const stale = await prisma.runtime.findMany({
    where: {
      userId: ref.userId,
      nodeId: ref.nodeId,
      origin: "NODE",
      kind: "ALWAYS_ON",
      slug: { notIn: [...reported] },
    },
    select: { id: true, slug: true },
  });
  for (const runtime of stale) {
    // A profile pin keeps the runtime (as `runtimes.delete` refuses it): the instance stops
    // being routed to (UNAVAILABLE) until the node reports it again or the pin goes.
    const pinned = await prisma.profileItem.count({ where: { runtimeId: runtime.id } });
    if (pinned > 0) {
      const marked = await prisma.runtimeInstance.updateMany({
        where: {
          runtimeId: runtime.id,
          userId: ref.userId,
          desiredState: null,
          OR: [
            { phase: { not: "UNAVAILABLE" } },
            { phaseReason: null },
            { phaseReason: { not: NODE_REMOVED } },
          ],
        },
        data: { phase: "UNAVAILABLE", phaseReason: NODE_REMOVED, phaseChangedAt: new Date() },
      });
      if (marked.count > 0)
        log(`node-origin runtime "${runtime.slug}" is no longer reported but a profile pins it`);
      continue;
    }
    try {
      await graphDelete({ userId: ref.userId, runtimeIds: [runtime.id] }, async (tx) => {
        // Again under the fences: still this node's node-origin runtime.
        const row = await tx.runtime.findFirst({
          where: { id: runtime.id, userId: ref.userId, nodeId: ref.nodeId, origin: "NODE" },
          select: { id: true },
        });
        if (!row) return;
        await tx.runtimeInstance.deleteMany({ where: { runtimeId: row.id } });
        await tx.runtime.update({ where: { id: row.id }, data: { currentVersionId: null } });
        await tx.runtime.delete({ where: { id: row.id } });
      });
    } catch (error) {
      // A pin added since the check refuses the delete (FK): handled on the next inventory.
      log(`removing node-origin runtime "${runtime.slug}" failed (${errorName(error)})`);
    }
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error;
}
