import { createHash } from "node:crypto";
import { ORPCError } from "@orpc/server";
import { hasProvedEmail } from "@ws-model-proxy/auth/proved-email";
import prisma from "@ws-model-proxy/db";
import { contractProcedure, type SignedInContext } from "../contract-procedure";
import { agentRulesApply } from "../contracts/auth-context";
import { runtimesContract as c, runtimeSlugSchema } from "../contracts/runtimes";
import { callerActor } from "../lib/caller-actor";
import { canonicalJson } from "../lib/canonical-json";
import {
  graphDelete,
  graphWrite,
  instanceCapacityFences,
  runtimeCapacityFences,
} from "../lib/graph-write";
import { readLiveLoad } from "../lib/live-load";
import {
  isForeignKeyViolation,
  isUniqueViolation,
  notFound,
  refuse,
  refuseAbout,
} from "../lib/refuse";
import { jsonObject } from "../lib/registry-view";
import { type RequestCompat, storedRequestCompat } from "../lib/request-compat";
import { RUNTIME_PRESET_LIST } from "../lib/runtime-presets";
import {
  authoredRuntimeSpecSchema,
  type RuntimeSpec,
  runtimeSpecSchema,
  runtimeSpecWarnings,
} from "../lib/runtime-spec";
import {
  AUTOMATIC_LIMITS,
  applyAdvancedPatch,
  applyLimitsPatch,
  createVersion,
  derivedColumns,
  effectiveTrust,
  type LimitColumns,
  ownedNode,
  specIsInteractive,
  syncRuntimeModels,
  versionHashes,
} from "../lib/runtime-store";
import {
  INSTANCE_INCLUDE,
  instanceView,
  previousLaunchHashes,
  RUNTIME_SUMMARY_INCLUDE,
  type RuntimeSummaryRow,
  requestProfileView,
  runtimeSummary,
  storedSpec,
  VERSION_SELECT,
  versionDetail,
  versionSummary,
} from "../lib/runtime-views";
import { deliverInvite, writeInvite } from "../lib/share-invite-write";
import { latestStopChecks, stopCheckKey } from "../lib/stop-evidence";
import { normalizeBaseUrl, parseDetectedServers } from "../nodes/views";
import { runtimeStart, runtimeStop } from "./runtime-lifecycle";
import { runtimeReleaseRequests, runtimeReleaseUnproven } from "./runtime-release";
import { runtimeSteps } from "./runtime-steps";

function userIdOf(context: SignedInContext): string {
  return context.session.user.id;
}

/** Previous launch hashes of each runtime's current version (for `launchChanged`). */
async function previousHashesOf(rows: RuntimeSummaryRow[]): Promise<Map<string, string | null>> {
  const wanted = rows.flatMap((row) =>
    row.CurrentVersion && row.CurrentVersion.version > 1
      ? [{ runtimeId: row.id, version: row.CurrentVersion.version - 1 }]
      : [],
  );
  const result = new Map<string, string | null>();
  if (wanted.length === 0) return result;
  const previous = await prisma.runtimeVersion.findMany({
    where: { OR: wanted },
    select: { runtimeId: true, launchHash: true },
  });
  for (const row of previous) result.set(row.runtimeId, row.launchHash);
  return result;
}

async function summariesOf(rows: RuntimeSummaryRow[]) {
  const previous = await previousHashesOf(rows);
  return rows
    .filter((row) => row.CurrentVersion !== null)
    .map((row) => runtimeSummary(row, previous.get(row.id) ?? null));
}

async function summaryOf(userId: string, runtimeId: string) {
  const row = await prisma.runtime.findFirst({
    where: { id: runtimeId, userId },
    include: RUNTIME_SUMMARY_INCLUDE,
  });
  if (!row) throw notFound("That runtime does not exist.");
  const [summary] = await summariesOf([row]);
  if (!summary) throw notFound("That runtime does not exist.");
  return summary;
}

function assertKindMatchesSpec(kind: "ALWAYS_ON" | "STARTABLE", spec: RuntimeSpec): void {
  if ((kind === "STARTABLE") !== (spec.launch !== undefined))
    throw new ORPCError("BAD_REQUEST", {
      message: "A startable runtime has launch; an always-on one has address.",
    });
}

/** Agents act on a node only at Full control (`trust_relay`). */
function assertAgentMayUseNode(
  context: SignedInContext,
  node: { id: string; trust: "RELAY" | "FULL" | null; trustLowerRequestedAt: Date | null },
): void {
  if (agentRulesApply(context.auth) && effectiveTrust(node) !== "FULL")
    throw refuseAbout(
      "trust_relay",
      node.id,
      "Agents may only use nodes at Full control. A person can do this in the browser.",
    );
}

type CreateInput = {
  slug: string;
  name: string;
  kind: "ALWAYS_ON" | "STARTABLE";
  nodeId?: string;
  spec: RuntimeSpec;
  limits: LimitColumns;
  advanced: Record<string, unknown>;
  compat: RequestCompat;
  note: string | null;
  forkedFromVersionId?: string;
};

/** Creates a runtime with version 1, its served models, and an always-on runtime's instance. */
async function createRuntime(context: SignedInContext, input: CreateInput) {
  const userId = userIdOf(context);
  const actor = callerActor(context.auth, userId);
  assertKindMatchesSpec(input.kind, input.spec);
  if ((input.kind === "ALWAYS_ON") !== (input.nodeId !== undefined))
    throw new ORPCError("BAD_REQUEST", {
      message: "An always-on runtime names its node; a startable one does not.",
    });
  if (input.nodeId) assertAgentMayUseNode(context, await ownedNode(userId, input.nodeId));
  let created: { runtimeId: string };
  try {
    created = await graphWrite([userId], async (tx) => {
      const runtime = await tx.runtime.create({
        data: {
          userId,
          slug: input.slug,
          name: input.name,
          kind: input.kind,
          origin: "SERVER",
          nodeId: input.nodeId ?? null,
          forkedFromVersionId: input.forkedFromVersionId ?? null,
        },
        select: { id: true },
      });
      const version = await createVersion(tx, {
        runtimeId: runtime.id,
        version: 1,
        actor,
        spec: input.spec,
        limits: input.limits,
        advanced: input.advanced,
        compat: input.compat,
        note: input.note,
      });
      await tx.runtime.update({
        where: { id: runtime.id },
        data: { currentVersionId: version.id },
      });
      await syncRuntimeModels(tx, { userId, runtimeId: runtime.id, spec: input.spec });
      if (input.kind === "ALWAYS_ON")
        await tx.runtimeInstance.create({
          data: {
            userId,
            runtimeId: runtime.id,
            versionId: version.id,
            launchVersionId: version.id,
            handle: input.slug,
            startedBy: actor.actor,
            desiredState: null,
            // Reachable once its node reports it (inventory / probe).
            phase: "UNAVAILABLE",
            phaseReason: "awaiting_node",
          },
        });
      return { runtimeId: runtime.id };
    });
  } catch (error) {
    if (isUniqueViolation(error))
      throw refuse("slug_taken", "You already have a runtime with this slug.");
    throw error;
  }
  const define =
    (await context.services?.pushRuntimeDefinitions?.({ userId, runtimeId: created.runtimeId })) ??
    [];
  const runtime = await summaryOf(userId, created.runtimeId);
  return { runtime, define, warnings: runtimeSpecWarnings(input.spec) };
}

async function ownedRuntimeModelView(userId: string, runtimeModelId: string) {
  const model = await prisma.runtimeModel.findFirst({
    where: { id: runtimeModelId, userId },
    include: {
      Members: {
        select: {
          poolId: true,
          shareId: true,
          Pool: { select: { slug: true, User: { select: { slug: true } } } },
        },
      },
    },
  });
  if (!model) throw notFound("That served model does not exist.");
  return runtimeModelView(model);
}

type RuntimeModelRow = {
  id: string;
  upstreamModelId: string;
  type: "LLM" | "EMBEDDINGS" | "TRANSCRIPTION";
  detectedCapabilities: Array<
    | "TEXT_GENERATION"
    | "VISION_INPUT"
    | "VIDEO_INPUT"
    | "EMBEDDING"
    | "AUDIO_INPUT"
    | "AUDIO_OUTPUT"
    | "RESPONSES_API"
  >;
  capabilities: RuntimeModelRow["detectedCapabilities"];
  capabilitiesOverridden: boolean;
  retired: boolean;
  Members: Array<{
    poolId: string;
    shareId: string | null;
    Pool: { slug: string; User: { slug: string } };
  }>;
};

function runtimeModelView(model: RuntimeModelRow) {
  return {
    id: model.id,
    upstreamModelId: model.upstreamModelId,
    type: model.type,
    detectedCapabilities: model.detectedCapabilities,
    capabilities: model.capabilitiesOverridden ? model.capabilities : model.detectedCapabilities,
    capabilitiesOverridden: model.capabilitiesOverridden,
    retired: model.retired,
    pools: model.Members.map((member) => ({
      poolId: member.poolId,
      callableId: `${member.Pool.User.slug}/${member.Pool.slug}`,
      contributed: member.shareId !== null,
    })),
  };
}

/** A version the caller may read: of their own runtime, or of one shared with them. */
/** Grantees see whether a person or an agent edited a version, never the owner's ids. */
function redactedEditor(editor: ReturnType<typeof versionSummary>["editor"]) {
  return { actor: editor.actor, userId: null, agentTokenId: null, label: null };
}

async function readableVersion(userId: string, versionId: string) {
  const version = await prisma.runtimeVersion.findFirst({
    where: {
      id: versionId,
      Runtime: { OR: [{ userId }, { Shares: { some: { granteeUserId: userId } } }] },
    },
    select: VERSION_SELECT,
  });
  if (!version) throw notFound("That version does not exist.");
  return version;
}

async function previousLaunchHashOf(runtimeId: string, version: number): Promise<string | null> {
  if (version <= 1) return null;
  const previous = await prisma.runtimeVersion.findFirst({
    where: { runtimeId, version: version - 1 },
    select: { launchHash: true },
  });
  return previous?.launchHash ?? null;
}

const ACTIVE_INSTANCE = {
  OR: [{ desiredState: "RUNNING" as const }, { desiredState: null }],
};

/**
 * Why there is nothing to mark stopped. A rank already marked stopped (HELD_UNKNOWN) is not
 * waiting for a person: the node is asked to prove its stop every 5 minutes while it is online,
 * and the first proof frees its resources. The message says so, with the last check's result.
 */
async function markStoppedConflict(
  tx: Parameters<typeof latestStopChecks>[0],
  instance: {
    id: string;
    phase: string;
    phaseChangedAt: Date;
    Ranks: ReadonlyArray<{
      rank: number;
      claim: string;
      markedStoppedAt: Date | null;
      Node: { id: string } | null;
    }>;
  },
  nodeNumber: number | undefined,
): Promise<string> {
  const marked = instance.Ranks.filter(
    (rank) =>
      rank.claim === "HELD_UNKNOWN" && (nodeNumber === undefined || rank.rank === nodeNumber - 1),
  );
  if (marked.length === 0) return "Nothing of this instance waits for a stop to be proven.";
  const checks = await latestStopChecks(tx, [{ ...instance, Ranks: marked }]);
  const results = marked.map((rank) => {
    const check = checks.get(stopCheckKey(instance.id, rank.rank));
    const result = !rank.Node
      ? "its node was removed, so no check can run"
      : !check
        ? "no check has finished yet"
        : check.proven
          ? `proven at ${check.at}`
          : `not proven at ${check.at} (${check.errorCode ?? "not_stopped"})`;
    return `node ${rank.rank + 1}: ${result}`;
  });
  return `Already marked stopped. While its node is online, wsmp checks every 5 minutes whether the stop is proven and then frees the resources. Last check, ${results.join("; ")}.`;
}

export const runtimesRouter = {
  list: contractProcedure(c.list).handler(async ({ context }) => {
    const rows = await prisma.runtime.findMany({
      where: { userId: userIdOf(context) },
      include: RUNTIME_SUMMARY_INCLUDE,
      orderBy: { createdAt: "asc" },
    });
    return { runtimes: await summariesOf(rows) };
  }),

  get: contractProcedure(c.get).handler(async ({ input, context }) => {
    const userId = userIdOf(context);
    const summary = await summaryOf(userId, input.runtimeId);
    const [current, models, instances, shares, nodes, profile] = await Promise.all([
      prisma.runtimeVersion.findFirstOrThrow({
        where: { id: summary.currentVersion.id },
        select: VERSION_SELECT,
      }),
      prisma.runtimeModel.findMany({
        where: { runtimeId: input.runtimeId, userId },
        include: {
          Members: {
            select: {
              id: true,
              poolId: true,
              shareId: true,
              Pool: { select: { slug: true, User: { select: { slug: true } } } },
            },
          },
        },
        orderBy: { createdAt: "asc" },
      }),
      prisma.runtimeInstance.findMany({
        where: {
          runtimeId: input.runtimeId,
          userId,
          // A stopped instance is listed while it still holds resources (a rank marked
          // stopped whose stop is not proven yet), so its reserved state and last stop check
          // stay visible.
          OR: [
            { NOT: { desiredState: "STOPPED", phase: "STOPPED" } },
            { Ranks: { some: { claim: { in: ["HELD", "HELD_UNKNOWN"] } } } },
          ],
        },
        include: INSTANCE_INCLUDE,
        orderBy: { createdAt: "asc" },
      }),
      prisma.runtimeShare.findMany({
        where: { runtimeId: input.runtimeId, ownerUserId: userId },
        select: { id: true, Grantee: { select: { email: true } } },
      }),
      prisma.node.findMany({
        where: { userId, OR: [{ trust: "RELAY" }, { trustLowerRequestedAt: { not: null } }] },
        select: { id: true, heldDefinitions: true },
      }),
      prisma.runtimeRequestProfile.findFirst({
        where: {
          runtimeId: input.runtimeId,
          userId,
          launchHash: summary.currentVersion.launchHash,
        },
        select: {
          source: true,
          engineFingerprint: true,
          probedAt: true,
          accepted: true,
          learned: true,
        },
      }),
    ]);
    const stopChecks = await latestStopChecks(prisma, instances);
    const liveLoad = readLiveLoad(
      context.services?.liveLoad,
      instances.map((row) => row.id),
    );
    const factsFrom = instances.find((instance) => instance.phase === "READY") ?? null;
    const previous = summary.currentVersion.launchChanged
      ? await previousLaunchHashOf(input.runtimeId, current.version)
      : current.launchHash;
    const frozenOn = nodes.flatMap((node) => {
      const held = Array.isArray(node.heldDefinitions) ? node.heldDefinitions : [];
      return held.flatMap((entry) => {
        const record = jsonObject(entry);
        return record.runtimeId === input.runtimeId &&
          typeof record.versionId === "string" &&
          record.versionId !== current.id
          ? [{ nodeId: node.id, versionId: record.versionId }]
          : [];
      });
    });
    return {
      ...summary,
      current: versionDetail(current, previous, factsFrom),
      requestProfile: profile ? requestProfileView(profile) : null,
      servedModels: models.map(runtimeModelView),
      instanceList: instances.map((row) => instanceView(row, stopChecks, liveLoad)),
      shares: shares.map((share) => ({ id: share.id, email: share.Grantee.email })),
      contributions: models.flatMap((model) =>
        model.Members.filter((member) => member.shareId !== null).map((member) => ({
          poolId: member.poolId,
          callableId: `${member.Pool.User.slug}/${member.Pool.slug}`,
          memberId: member.id,
        })),
      ),
      frozenOn,
    };
  }),

  versions: {
    list: contractProcedure(c.versions.list).handler(async ({ input, context }) => {
      const userId = userIdOf(context);
      const runtime = await prisma.runtime.findFirst({
        where: {
          id: input.runtimeId,
          OR: [{ userId }, { Shares: { some: { granteeUserId: userId } } }],
        },
        select: { id: true, userId: true },
      });
      if (!runtime) throw notFound("That runtime does not exist.");
      const forGrantee = runtime.userId !== userId;
      const before = input.cursor ? Number.parseInt(input.cursor, 10) : null;
      const rows = await prisma.runtimeVersion.findMany({
        where: {
          runtimeId: input.runtimeId,
          ...(before !== null && Number.isSafeInteger(before) ? { version: { lt: before } } : {}),
        },
        select: VERSION_SELECT,
        orderBy: { version: "desc" },
        // One more than the page, to know the previous version's launch hash.
        take: input.limit + 1,
      });
      const page = rows.slice(0, input.limit);
      const extra = rows[input.limit];
      // `rows` holds one version past the page, so every item's predecessor is in it (or the
      // item is version 1).
      const hashes = previousLaunchHashes(rows);
      const items = page.map((row) => {
        const summary = versionSummary(row, hashes.get(row.version) ?? null);
        return forGrantee ? { ...summary, editor: redactedEditor(summary.editor) } : summary;
      });
      const last = page.at(-1);
      return {
        items,
        nextCursor: extra && last ? String(last.version) : null,
      };
    }),
    get: contractProcedure(c.versions.get).handler(async ({ input, context }) => {
      const userId = userIdOf(context);
      const version = await readableVersion(userId, input.versionId);
      const detail = versionDetail(
        version,
        await previousLaunchHashOf(version.runtimeId, version.version),
      );
      const owned = await prisma.runtime.count({ where: { id: version.runtimeId, userId } });
      return owned > 0 ? detail : { ...detail, editor: redactedEditor(detail.editor) };
    }),
  },

  presets: {
    list: contractProcedure(c.presets.list).handler(async () => ({
      presets: RUNTIME_PRESET_LIST.map((preset) => ({
        id: preset.id,
        kind: preset.kind,
        spec: preset.spec,
        fill: [...preset.fill],
      })),
    })),
  },

  create: contractProcedure(c.create).handler(async ({ input, context }) => {
    const result = await createRuntime(context, {
      slug: input.slug,
      name: input.name,
      kind: input.kind,
      nodeId: input.nodeId,
      spec: input.spec,
      limits: applyLimitsPatch(AUTOMATIC_LIMITS, input.limits),
      advanced: applyAdvancedPatch({}, input.advanced),
      compat: input.compat ?? {},
      note: input.note ?? null,
    });
    return { ...result, version: result.runtime.currentVersion };
  }),

  update: contractProcedure(c.update).handler(async ({ input, context }) => {
    const userId = userIdOf(context);
    const actor = callerActor(context.auth, userId);
    const runtime = await prisma.runtime.findFirst({
      where: { id: input.runtimeId, userId },
      select: {
        id: true,
        kind: true,
        origin: true,
        Node: { select: { id: true, trust: true, trustLowerRequestedAt: true } },
        CurrentVersion: { select: VERSION_SELECT },
      },
    });
    if (!runtime?.CurrentVersion) throw notFound("That runtime does not exist.");
    const current = runtime.CurrentVersion;
    const spec = input.spec ?? storedSpec(current.spec);
    assertKindMatchesSpec(runtime.kind, spec);
    const limits = applyLimitsPatch(
      {
        concurrencyLimit: current.concurrencyLimit,
        contextLimit: current.contextLimit,
        kvBudgetTokens: current.kvBudgetTokens,
        kvFullThreshold: current.kvFullThreshold,
        engineLoadGate: current.engineLoadGate,
      },
      input.limits,
    );
    const advanced = applyAdvancedPatch(jsonObject(current.advanced), input.advanced);
    // `compat` replaces the whole setting (null: automatic); absent keeps it.
    const compat =
      input.compat === undefined ? storedRequestCompat(current.compat) : (input.compat ?? {});
    const hashes = versionHashes(spec, limits, advanced, compat);
    const warnings = runtimeSpecWarnings(spec);
    const previousOfCurrent = await previousLaunchHashOf(runtime.id, current.version);

    // Forgetting is no version change: the engine is unchanged, only what was learned goes
    // (servers drop their cached copy within seconds). Done once the update is known valid.
    const forgetLearned = async () => {
      if (input.relearn)
        await prisma.runtimeRequestProfile.deleteMany({ where: { runtimeId: runtime.id, userId } });
    };
    if (hashes.contentHash === current.contentHash) {
      await forgetLearned();
      if (input.name !== undefined)
        await prisma.runtime.update({ where: { id: runtime.id }, data: { name: input.name } });
      return {
        version: versionSummary(current, previousOfCurrent),
        adoptedLive: [],
        needsRestart: [],
        restarted: [],
        define: [],
        warnings,
      };
    }

    const launchChanged = hashes.launchHash !== current.launchHash;
    // A node-origin runtime's definition lives in the node's runtimes.json and comes back with
    // every inventory; the server never pushes it, so only the node can change it.
    if (launchChanged && runtime.origin === "NODE")
      throw refuseAbout(
        "launch_change_on_node_origin",
        runtime.id,
        "This runtime is defined on its node: edit its definition there. Limits and advanced settings can be changed here.",
      );
    if (launchChanged && runtime.Node && effectiveTrust(runtime.Node) !== "FULL")
      throw refuseAbout(
        "launch_change_on_relay_only",
        runtime.Node.id,
        "This node is Relay only, so its always-on definition is frozen. Change it on the node, or raise trust with `wsmp trust full`.",
      );
    // A served model that moves to another type would break the pools it is in.
    const nextType = derivedColumns(spec).modelType;
    if (nextType !== current.modelType) {
      const conflicting = await prisma.poolMember.count({
        where: {
          RuntimeModel: { runtimeId: runtime.id },
          ...(nextType ? { Pool: { NOT: { modelType: nextType } } } : {}),
        },
      });
      if (conflicting > 0)
        throw refuse(
          "model_type_mismatch",
          "This runtime's models are in pools of another type. Remove them from those pools first.",
        );
    }

    await forgetLearned();
    const agent = agentRulesApply(context.auth);
    const adoptedLive: string[] = [];
    const restarted: string[] = [];
    const needsRestart: Array<{
      instanceId: string;
      reason: "launch_changed" | "trust_relay" | "interactive_needs_person";
    }> = [];
    const { version, operationId } = await graphWrite(
      [userId],
      async (tx) => {
        // Read and classify under the owner fence (a trust change waits for it).
        adoptedLive.length = 0;
        restarted.length = 0;
        needsRestart.length = 0;
        const instances = await tx.runtimeInstance.findMany({
          where: { runtimeId: runtime.id, userId, ...ACTIVE_INSTANCE },
          select: {
            id: true,
            desiredState: true,
            LaunchVersion: { select: { launchHash: true } },
            Ranks: {
              select: {
                claim: true,
                Node: { select: { id: true, trust: true, trustLowerRequestedAt: true } },
              },
            },
          },
        });
        for (const instance of instances) {
          // Always-on: the address is the launch; nothing to restart. A started instance adopts
          // live only when what it launched has the new launch hash (an earlier launch change it
          // was never restarted for still needs a restart).
          if (
            instance.desiredState === null ||
            instance.LaunchVersion.launchHash === hashes.launchHash
          )
            adoptedLive.push(instance.id);
          else if (
            !input.restartRunning ||
            // Released claims (failed, stopped ranks) are re-placed by a start, not here.
            instance.Ranks.some((rank) => rank.claim !== "HELD")
          )
            needsRestart.push({ instanceId: instance.id, reason: "launch_changed" });
          else if (
            agent &&
            instance.Ranks.some((rank) => !rank.Node || effectiveTrust(rank.Node) !== "FULL")
          )
            needsRestart.push({ instanceId: instance.id, reason: "trust_relay" });
          else if (agent && specIsInteractive(spec))
            needsRestart.push({ instanceId: instance.id, reason: "interactive_needs_person" });
          else restarted.push(instance.id);
        }

        const created = await createVersion(tx, {
          runtimeId: runtime.id,
          version: current.version + 1,
          actor,
          spec,
          limits,
          advanced,
          compat,
          note: input.note ?? null,
        });
        await tx.runtime.update({
          where: { id: runtime.id },
          data: {
            currentVersionId: created.id,
            ...(input.name !== undefined ? { name: input.name } : {}),
          },
        });
        await syncRuntimeModels(tx, { userId, runtimeId: runtime.id, spec });
        if (adoptedLive.length > 0) {
          const alwaysOn = instances
            .filter(
              (instance) => instance.desiredState === null && adoptedLive.includes(instance.id),
            )
            .map((instance) => instance.id);
          await tx.runtimeInstance.updateMany({
            where: { id: { in: adoptedLive.filter((id) => !alwaysOn.includes(id)) } },
            data: { versionId: created.id },
          });
          if (alwaysOn.length > 0)
            await tx.runtimeInstance.updateMany({
              where: { id: { in: alwaysOn } },
              data: { versionId: created.id, launchVersionId: created.id },
            });
        }
        let restartOperationId: string | null = null;
        if (restarted.length > 0) {
          const operation = await tx.runtimeOperation.create({
            data: {
              userId,
              kind: "RESTART",
              actor: actor.actor,
              actorUserId: actor.actorUserId,
              agentTokenId: actor.agentTokenId,
              mcpGrantId: actor.mcpGrantId,
              summary: { restarts: restarted, versionId: created.id },
              fingerprint: hashes.contentHash,
            },
            select: { id: true },
          });
          restartOperationId = operation.id;
          await tx.runtimeInstance.updateMany({
            where: { id: { in: restarted } },
            data: {
              versionId: created.id,
              launchVersionId: created.id,
              operationId: operation.id,
              desiredState: "RUNNING",
              phase: "STARTING",
              phaseChangedAt: new Date(),
              phaseReason: "definition_changed",
              needsOperator: null,
              needsOperatorSince: null,
              restartsInWindow: 0,
              restartWindowStartedAt: null,
              nextRestartAt: null,
            },
          });
        }
        const row = await tx.runtimeVersion.findUniqueOrThrow({
          where: { id: created.id },
          select: VERSION_SELECT,
        });
        return { version: row, operationId: restartOperationId };
      },
      // The current version and the adopting instances' versions change admission views.
      (tx) => runtimeCapacityFences(tx, runtime.id),
    );
    if (operationId) await context.services?.dispatchRuntimeOperation?.({ userId, operationId });
    const define =
      (await context.services?.pushRuntimeDefinitions?.({ userId, runtimeId: runtime.id })) ?? [];
    return {
      version: versionSummary(version, current.launchHash),
      adoptedLive,
      needsRestart,
      restarted,
      define,
      warnings,
    };
  }),

  delete: contractProcedure(c.delete).handler(async ({ input, context }) => {
    const userId = userIdOf(context);
    callerActor(context.auth, userId);
    const runtime = await prisma.runtime.findFirst({
      where: { id: input.runtimeId, userId },
      select: { id: true },
    });
    if (!runtime) throw notFound("That runtime does not exist.");
    const busy = await prisma.runtimeInstance.count({
      where: {
        runtimeId: runtime.id,
        OR: [
          { desiredState: "RUNNING" },
          { Ranks: { some: { claim: { in: ["HELD", "HELD_UNKNOWN"] } } } },
        ],
      },
    });
    if (busy > 0)
      throw refuse("instances_running", "Stop this runtime's instances before deleting it.");
    const pinned = await prisma.profileItem.count({ where: { runtimeId: runtime.id } });
    if (pinned > 0)
      throw refuse(
        "pinned_by_profile",
        "A profile pins this runtime. Remove it from the profile first.",
      );
    const members = await prisma.poolMember.findMany({
      where: { RuntimeModel: { runtimeId: runtime.id } },
      select: { id: true },
    });
    try {
      await graphDelete({ userId, runtimeIds: [runtime.id] }, async (tx) => {
        // Its invites go with it (the cascade would too): no link opens a deleted runtime.
        await tx.shareInvite.deleteMany({ where: { runtimeId: runtime.id, ownerUserId: userId } });
        await tx.runtimeInstance.deleteMany({ where: { runtimeId: runtime.id } });
        await tx.runtime.update({ where: { id: runtime.id }, data: { currentVersionId: null } });
        await tx.runtime.delete({ where: { id: runtime.id } });
      });
    } catch (error) {
      if (isForeignKeyViolation(error))
        throw refuse(
          "pinned_by_profile",
          "A profile pins this runtime. Remove it from the profile first.",
        );
      throw error;
    }
    // Nodes drop the deleted versions with their next complete define (not awaited: the answer
    // does not change this result).
    void context.services
      ?.pushRuntimeDefinitions?.({ userId, runtimeId: runtime.id })
      .catch(() => undefined);
    return { deleted: true as const, removedMembers: members.map((member) => member.id) };
  }),

  start: runtimeStart,
  stop: runtimeStop,

  steps: runtimeSteps,
  instances: {
    /**
     * A person (or a Full agent, on Full-control nodes: recovery like deleting an offline
     * node) marks stopped an instance whose stop cannot be proven (node gone or unable to prove it): the rank's claim
     * becomes HELD_UNKNOWN. Placement keeps counting its resources and port until a status
     * probe proves the stop; the instance settles STOPPED (spec §3.5). Audited as a MARK_STOPPED
     * operation and a `marked_stopped` node activity row per rank marked stopped.
     */
    markStopped: contractProcedure(c.instances.markStopped).handler(async ({ input, context }) => {
      const userId = userIdOf(context);
      const actor = callerActor(context.auth, userId);
      const agent = agentRulesApply(context.auth);
      if (agent && input.confirm !== "MARK_STOPPED")
        throw new ORPCError("BAD_REQUEST", {
          message: 'Marking an instance stopped is recovery: repeat confirm: "MARK_STOPPED".',
        });
      const now = new Date();
      const operationId = await graphWrite(
        [userId],
        async (tx) => {
          const instance = await tx.runtimeInstance.findFirst({
            where: { id: input.instanceId, userId },
            select: {
              id: true,
              phase: true,
              phaseChangedAt: true,
              Ranks: {
                select: {
                  id: true,
                  rank: true,
                  claim: true,
                  markedStoppedAt: true,
                  Node: { select: { id: true, trust: true, trustLowerRequestedAt: true } },
                },
              },
            },
          });
          if (!instance) throw notFound("That instance does not exist.");
          const ranks = instance.Ranks.filter(
            (rank) =>
              rank.claim === "HELD" &&
              (input.nodeNumber === undefined || rank.rank === input.nodeNumber - 1),
          );
          if (instance.phase !== "STOPPING" || ranks.length === 0)
            throw new ORPCError("CONFLICT", {
              message: await markStoppedConflict(tx, instance, input.nodeNumber),
            });
          // Agents mark stopped only on Full-control nodes (a node that left counts as not Full).
          if (agent)
            for (const rank of ranks)
              if (!rank.Node || effectiveTrust(rank.Node) !== "FULL")
                throw refuseAbout(
                  "trust_relay",
                  rank.Node?.id ?? instance.id,
                  "Agents may only mark instances stopped on nodes at Full control. A person can do this in the browser.",
                );
          const marked = ranks.map((rank) => rank.rank);
          const operation = await tx.runtimeOperation.create({
            data: {
              userId,
              kind: "MARK_STOPPED",
              actor: actor.actor,
              actorUserId: actor.actorUserId,
              agentTokenId: actor.agentTokenId,
              mcpGrantId: actor.mcpGrantId,
              summary: { instanceId: instance.id, ranks: marked },
              fingerprint: createHash("sha256")
                .update(canonicalJson({ markStopped: instance.id, ranks: marked }), "utf8")
                .digest("hex"),
            },
            select: { id: true },
          });
          await tx.instanceRank.updateMany({
            where: { id: { in: ranks.map((rank) => rank.id) }, claim: "HELD" },
            data: {
              claim: "HELD_UNKNOWN",
              claimChangedAt: now,
              markedStoppedAt: now,
              markedStoppedBy: userId,
              lastStopCheckAt: null,
            },
          });
          for (const rank of ranks)
            if (rank.Node)
              await tx.nodeAuditEvent.create({
                data: {
                  userId,
                  nodeId: rank.Node.id,
                  actor: actor.actor,
                  agentTokenId: actor.agentTokenId,
                  mcpGrantId: actor.mcpGrantId,
                  kind: "marked_stopped",
                  subject: `instance:${instance.id} rank:${rank.rank}`,
                  instanceId: instance.id,
                  rank: rank.rank,
                  outcome: "completed",
                  reason: input.note ?? null,
                  startedAt: now,
                  finishedAt: now,
                },
              });
          // Stops not yet sent for those ranks are not needed any more.
          await tx.instanceStep.updateMany({
            where: {
              instanceId: instance.id,
              rank: { in: marked },
              phase: "STOP",
              state: "PENDING",
              attempts: 0,
            },
            data: { state: "CANCELLED", operatorHold: null },
          });
          // The engine recomputes the instance's need (and settles it) on its next pass.
          return operation.id;
        },
        async () => instanceCapacityFences([input.instanceId]),
      );
      await context.services?.dispatchRuntimeOperation?.({ userId, operationId });
      const row = await prisma.runtimeInstance.findFirst({
        where: { id: input.instanceId, userId },
        include: INSTANCE_INCLUDE,
      });
      if (!row) throw notFound("That instance does not exist.");
      return instanceView(
        row,
        await latestStopChecks(prisma, [row]),
        readLiveLoad(context.services?.liveLoad, [row.id]),
      );
    }),
    releaseUnproven: runtimeReleaseUnproven,
  },
  releaseRequests: runtimeReleaseRequests,

  models: {
    setCapabilities: contractProcedure(c.models.setCapabilities).handler(
      async ({ input, context }) => {
        const userId = userIdOf(context);
        callerActor(context.auth, userId);
        const updated = await prisma.runtimeModel.updateMany({
          where: { id: input.runtimeModelId, userId },
          data:
            input.capabilities === null
              ? { capabilities: [], capabilitiesOverridden: false }
              : { capabilities: input.capabilities, capabilitiesOverridden: true },
        });
        if (updated.count === 0) throw notFound("That served model does not exist.");
        return ownedRuntimeModelView(userId, input.runtimeModelId);
      },
    ),
  },

  detected: {
    add: contractProcedure(c.detected.add).handler(async ({ input, context }) => {
      const userId = userIdOf(context);
      const node = await ownedNode(userId, input.nodeId);
      const detected = await prisma.node.findUniqueOrThrow({
        where: { id: node.id },
        select: { detectedServers: true },
      });
      // The column holds the node's wire values (`runtime.detected`); `/v1` and the bare
      // address name the same server.
      const wanted = normalizeBaseUrl(input.baseUrl);
      const match = parseDetectedServers(detected.detectedServers).find(
        (server) => normalizeBaseUrl(server.baseUrl) === wanted,
      );
      if (!match) throw notFound("This node did not report a server at that address.");
      const engine = match.engine;
      const api = match.api;
      const parsed = runtimeSpecSchema.safeParse({
        api,
        engine,
        modelType: "llm",
        address: { baseUrl: input.baseUrl },
      });
      if (!parsed.success)
        throw new ORPCError("BAD_REQUEST", { message: "This address cannot be used as is." });
      const suggested = `${node.slug}-${engine.replaceAll("_", "-")}`
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^[^a-z]+/, "")
        .slice(0, 41)
        .replace(/-+$/, "");
      const slug =
        input.slug ?? (runtimeSlugSchema.safeParse(suggested).success ? suggested : "server");
      const result = await createRuntime(context, {
        slug,
        name: input.name ?? `${engine} on ${node.slug}`,
        kind: "ALWAYS_ON",
        nodeId: node.id,
        spec: parsed.data,
        limits: AUTOMATIC_LIMITS,
        advanced: {},
        compat: {},
        note: null,
      });
      return result.runtime;
    }),
  },

  shares: {
    list: contractProcedure(c.shares.list).handler(async ({ input, context }) => {
      const userId = userIdOf(context);
      const [mine, received] = await Promise.all([
        prisma.runtimeShare.findMany({
          where: {
            ownerUserId: userId,
            ...(input.runtimeId ? { runtimeId: input.runtimeId } : {}),
          },
          select: {
            id: true,
            runtimeId: true,
            createdAt: true,
            Grantee: { select: { email: true } },
          },
          orderBy: { createdAt: "asc" },
        }),
        prisma.runtimeShare.findMany({
          where: {
            granteeUserId: userId,
            ...(input.runtimeId ? { runtimeId: input.runtimeId } : {}),
          },
          select: {
            id: true,
            runtimeId: true,
            Owner: { select: { email: true } },
            Runtime: {
              select: { name: true, kind: true, CurrentVersion: { select: VERSION_SELECT } },
            },
          },
          orderBy: { createdAt: "asc" },
        }),
      ]);
      return {
        sharedByMe: mine.map((share) => ({
          id: share.id,
          runtimeId: share.runtimeId,
          email: share.Grantee.email,
          createdAt: share.createdAt.toISOString(),
        })),
        sharedWithMe: received.flatMap((share) => {
          const current = share.Runtime.CurrentVersion;
          if (!current) return [];
          return [
            {
              id: share.id,
              runtimeId: share.runtimeId,
              ownerEmail: share.Owner.email,
              name: share.Runtime.name,
              kind: share.Runtime.kind,
              // The grantee sees the definition, not who on the owner's side edited it.
              currentVersion: (() => {
                const summary = versionSummary(current, null);
                return { ...summary, editor: redactedEditor(summary.editor) };
              })(),
            },
          ];
        }),
      };
    }),
    /**
     * The pool rule (`access.shares.create`): a direct share only with an account whose mailbox
     * the verify-email flow proved; anyone else, an unknown e-mail included, gets an invite that
     * needs its link, with the same answer shape, so the answer tells nothing about accounts.
     */
    create: contractProcedure(c.shares.create).handler(async ({ input, context }) => {
      const userId = userIdOf(context);
      const runtime = await prisma.runtime.findFirst({
        where: { id: input.runtimeId, userId },
        select: { id: true, User: { select: { name: true, locale: true } } },
      });
      if (!runtime) throw notFound("That runtime does not exist.");
      const email = input.email;
      if (email === context.session.user.email.trim().toLowerCase())
        throw new ORPCError("BAD_REQUEST", { message: "You already own this runtime." });
      const account = await prisma.user.findFirst({
        where: { email: { equals: email, mode: "insensitive" } },
        select: { id: true, email: true, provedEmail: true },
      });
      const grantee = account && hasProvedEmail(account) ? account : null;
      if (!grantee) {
        const written = await writeInvite({
          mode: "create",
          ownerUserId: userId,
          target: { kind: "runtime", runtimeId: runtime.id },
          email,
        });
        const delivered = await deliverInvite({
          ...written,
          owner: { name: runtime.User.name, locale: runtime.User.locale },
        });
        return { kind: "invite" as const, ...delivered };
      }
      if (grantee.id === userId)
        throw new ORPCError("BAD_REQUEST", { message: "You already own this runtime." });
      const share = await graphWrite([userId, grantee.id], async (tx) => {
        // The share replaces a pending invite to this address: its link stops working.
        await tx.shareInvite.updateMany({
          where: {
            runtimeId: runtime.id,
            email,
            ownerUserId: userId,
            acceptedAt: null,
            revokedAt: null,
          },
          data: { revokedAt: new Date() },
        });
        return tx.runtimeShare.upsert({
          where: {
            runtimeId_granteeUserId: { runtimeId: runtime.id, granteeUserId: grantee.id },
          },
          create: { runtimeId: runtime.id, ownerUserId: userId, granteeUserId: grantee.id },
          update: {},
          select: { id: true, runtimeId: true, createdAt: true },
        });
      });
      return {
        kind: "share" as const,
        share: {
          id: share.id,
          runtimeId: share.runtimeId,
          email: grantee.email,
          createdAt: share.createdAt.toISOString(),
        },
      };
    }),
    delete: contractProcedure(c.shares.delete).handler(async ({ input, context }) => {
      const userId = userIdOf(context);
      const share = await prisma.runtimeShare.findFirst({
        where: { id: input.shareId, ownerUserId: userId },
        select: { id: true, granteeUserId: true },
      });
      if (!share) throw notFound("That share does not exist.");
      await graphWrite([userId, share.granteeUserId], (tx) =>
        tx.runtimeShare.deleteMany({ where: { id: share.id, ownerUserId: userId } }),
      );
      return { ok: true as const };
    }),
  },

  fork: contractProcedure(c.fork).handler(async ({ input, context }) => {
    const userId = userIdOf(context);
    const share = await prisma.runtimeShare.findFirst({
      where: { runtimeId: input.runtimeId, granteeUserId: userId },
      select: {
        Runtime: {
          select: {
            id: true,
            kind: true,
            currentVersionId: true,
          },
        },
      },
    });
    if (!share) throw notFound("No runtime with that id is shared with you.");
    const versionId = input.versionId ?? share.Runtime.currentVersionId;
    if (!versionId) throw notFound("That version does not exist.");
    const version = await prisma.runtimeVersion.findFirst({
      where: { id: versionId, runtimeId: share.Runtime.id },
      select: VERSION_SELECT,
    });
    if (!version) throw notFound("That version does not exist.");
    // A copy is a new definition: it meets today's rules (a version saved before a rule, such as
    // a status command that can never say stopped, is refused here with that rule's issue).
    const authored = authoredRuntimeSpecSchema.safeParse(storedSpec(version.spec));
    if (!authored.success)
      throw new ORPCError("BAD_REQUEST", {
        message: authored.error.issues
          .map((issue) => `${["spec", ...issue.path].join(".")}: ${issue.message}`)
          .join(" "),
      });
    const result = await createRuntime(context, {
      slug: input.slug,
      name: input.name,
      kind: share.Runtime.kind,
      nodeId: input.nodeId,
      spec: authored.data,
      limits: applyLimitsPatch(
        {
          concurrencyLimit: version.concurrencyLimit,
          contextLimit: version.contextLimit,
          kvBudgetTokens: version.kvBudgetTokens,
          kvFullThreshold: version.kvFullThreshold,
          engineLoadGate: version.engineLoadGate,
        },
        input.limits,
      ),
      advanced: applyAdvancedPatch(jsonObject(version.advanced), input.advanced),
      compat:
        input.compat === undefined ? storedRequestCompat(version.compat) : (input.compat ?? {}),
      note: input.note ?? null,
      forkedFromVersionId: version.id,
    });
    return { ...result, version: result.runtime.currentVersion };
  }),
};
