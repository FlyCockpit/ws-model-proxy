import { ORPCError } from "@orpc/server";
import prisma from "@ws-model-proxy/db";
import { contractProcedure, type SignedInContext, stub } from "../contract-procedure";
import { agentRulesApply } from "../contracts/auth-context";
import { runtimesContract as c, runtimeSlugSchema } from "../contracts/runtimes";
import {
  callerActor,
  isForeignKeyViolation,
  isUniqueViolation,
  notFound,
  refusal,
} from "../lib/caller-actor";
import { graphDelete, graphWrite, runtimeCapacityFences } from "../lib/graph-write";
import { jsonObject } from "../lib/registry-view";
import { RUNTIME_PRESET_LIST } from "../lib/runtime-presets";
import { type RuntimeSpec, runtimeSpecSchema, runtimeSpecWarnings } from "../lib/runtime-spec";
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
  runtimeSummary,
  storedSpec,
  VERSION_SELECT,
  versionDetail,
  versionSummary,
} from "../lib/runtime-views";
import { runtimeStart, runtimeStop } from "./runtime-lifecycle";

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
    throw refusal(
      "trust_relay",
      "Agents may only use nodes at Full control. A person can do this in the browser.",
      node.id,
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
      throw refusal("slug_taken", "You already have a runtime with this slug.");
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
    const [current, models, instances, shares, nodes] = await Promise.all([
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
          NOT: { desiredState: "STOPPED", phase: "STOPPED" },
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
    ]);
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
      servedModels: models.map(runtimeModelView),
      instanceList: instances.map(instanceView),
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
    const hashes = versionHashes(spec, limits, advanced);
    const warnings = runtimeSpecWarnings(spec);
    const previousOfCurrent = await previousLaunchHashOf(runtime.id, current.version);

    if (hashes.contentHash === current.contentHash) {
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
    if (launchChanged && runtime.Node && effectiveTrust(runtime.Node) !== "FULL")
      throw refusal(
        "launch_change_on_relay_only",
        "This node is Relay only, so its always-on definition is frozen. Change it on the node, or raise trust with `wsmp trust full`.",
        runtime.Node.id,
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
        throw refusal(
          "model_type_mismatch",
          "This runtime's models are in pools of another type. Remove them from those pools first.",
        );
    }

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
      throw refusal("instances_running", "Stop this runtime's instances before deleting it.");
    const pinned = await prisma.profileItem.count({ where: { runtimeId: runtime.id } });
    if (pinned > 0)
      throw refusal(
        "pinned_by_profile",
        "A profile pins this runtime. Remove it from the profile first.",
      );
    const members = await prisma.poolMember.findMany({
      where: { RuntimeModel: { runtimeId: runtime.id } },
      select: { id: true },
    });
    try {
      await graphDelete({ userId, runtimeIds: [runtime.id] }, async (tx) => {
        await tx.runtimeInstance.deleteMany({ where: { runtimeId: runtime.id } });
        await tx.runtime.update({ where: { id: runtime.id }, data: { currentVersionId: null } });
        await tx.runtime.delete({ where: { id: runtime.id } });
      });
    } catch (error) {
      if (isForeignKeyViolation(error))
        throw refusal(
          "pinned_by_profile",
          "A profile pins this runtime. Remove it from the profile first.",
        );
      throw error;
    }
    return { deleted: true as const, removedMembers: members.map((member) => member.id) };
  }),

  start: runtimeStart,
  stop: runtimeStop,

  // TODO(server): operator terminals (attach tickets), step re-runs and Forget belong to the
  // server's lifecycle engine; they stay NOT_IMPLEMENTED until it exposes a hook.
  steps: {
    attach: stub(c.steps.attach),
    reopen: stub(c.steps.reopen),
    cancel: stub(c.steps.cancel),
  },
  instances: {
    forget: stub(c.instances.forget),
  },

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
      const servers = Array.isArray(detected.detectedServers) ? detected.detectedServers : [];
      const match = servers.map(jsonObject).find((server) => server.baseUrl === input.baseUrl);
      if (!match) throw notFound("This node did not report a server at that address.");
      const engine = typeof match.engine === "string" ? match.engine.toLowerCase() : "other";
      const api = match.api === "ANTHROPIC" ? "anthropic" : "openai";
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
            Runtime: { select: { name: true, CurrentVersion: { select: VERSION_SELECT } } },
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
    create: contractProcedure(c.shares.create).handler(async ({ input, context }) => {
      const userId = userIdOf(context);
      const runtime = await prisma.runtime.findFirst({
        where: { id: input.runtimeId, userId },
        select: { id: true },
      });
      if (!runtime) throw notFound("That runtime does not exist.");
      const grantee = await prisma.user.findFirst({
        where: { email: input.email },
        select: { id: true },
      });
      if (!grantee || grantee.id === userId)
        throw notFound("No other account uses that e-mail address.");
      const share = await graphWrite([userId, grantee.id], (tx) =>
        tx.runtimeShare.upsert({
          where: {
            runtimeId_granteeUserId: { runtimeId: runtime.id, granteeUserId: grantee.id },
          },
          create: { runtimeId: runtime.id, ownerUserId: userId, granteeUserId: grantee.id },
          update: {},
          select: { id: true },
        }),
      );
      return { id: share.id };
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
    const result = await createRuntime(context, {
      slug: input.slug,
      name: input.name,
      kind: share.Runtime.kind,
      nodeId: input.nodeId,
      spec: storedSpec(version.spec),
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
      note: input.note ?? null,
      forkedFromVersionId: version.id,
    });
    return { ...result, version: result.runtime.currentVersion };
  }),
};
