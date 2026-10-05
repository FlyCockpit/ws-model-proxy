import { randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/server";
import { deploymentJobWireIssue } from "@ws-model-proxy/config/deployment-job-wire";
import {
  DEPLOYMENT_JOB_FRAME_MAX_BYTES,
  DEPLOYMENT_PROTOCOL_VERSION,
  type DeploymentJob,
  deploymentJobFrameBytes,
} from "@ws-model-proxy/config/deployment-protocol";
import prisma, { type Prisma } from "@ws-model-proxy/db";
import { acquireFences, fenceOwners, fences } from "@ws-model-proxy/db/capacity-lock-order";
import { userCredentialAccessBlocked } from "@ws-model-proxy/db/user-deletion-access";
import { z } from "zod";
import { deploymentDerivedIntents, originalDeploymentStopIntent } from "./deployment-job-intent";
import {
  type DeploymentNode,
  deploymentFingerprint,
  deploymentHeadAddress,
  deploymentPermission,
  type ExistingDeployment,
  planDeployment,
  renderDeploymentCommand,
} from "./deployment-planner";
import {
  type DeploymentVariant,
  deploymentClaimSchema,
  deploymentIdSchema,
  deploymentSpecSchema,
  rankValue,
  storedDeploymentSpecSchema,
  variantHasInteractiveCommands,
} from "./deployment-spec";
import { gpuBudgetKey, parseNodeInfo, resolveUsableBudgets } from "./node-inventory";

export type DeploymentRequester = { userId: string; id: string; kind: "USER" | "AGENT" };
type Tx = Prisma.TransactionClient;
async function assertDeploymentOwnerActive(tx: Tx, userId: string) {
  const owner = await tx.user.findUnique({
    where: { id: userId },
    select: { banned: true, banExpires: true, deletionRequestedAt: true },
  });
  if (!owner || userCredentialAccessBlocked(owner, new Date()))
    throw new ORPCError("FORBIDDEN", {
      message: "Inactive accounts cannot acquire deployment resources.",
    });
}
export async function lockDeploymentOwner(tx: Tx, userId: string) {
  await fenceOwners(tx, [userId]);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`deployment-owner:${userId}`}, 0))`;
}
export async function lockDeploymentNodes(tx: Tx, nodeIds: readonly string[]) {
  for (const id of [...new Set(nodeIds)].sort())
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`deployment-node:${id}`}, 0))`;
}
/**
 * Instances that hold claims or may still be restarted. A recipe with one cannot be detached
 * from or moved off its pool; every other instance is history only.
 */
export const liveDeploymentInstanceWhere: Prisma.DeploymentInstanceWhereInput = {
  OR: [
    { Nodes: { some: { claimHeld: true } } },
    { desiredState: "RUNNING", observedState: { not: "FAILED" } },
  ],
};
/** A live instance: `nodes` are its held claims, `rankNodeIds` every rank's device. */
type LiveDeployment = ExistingDeployment & { rankNodeIds: string[] };
/** Lock order: owner, sorted nodes; deployments never acquire request capacity locks. */
export async function loadDeploymentState(tx: Tx, userId: string) {
  const rawNodes = await tx.cliDevice.findMany({ where: { userId }, orderBy: { id: "asc" } });
  const nodes: DeploymentNode[] = rawNodes.map((n) => {
    const info = parseNodeInfo(n.nodeInfo) ?? {};
    const raw = z
      .object({ executionMechanism: z.string().optional() })
      .passthrough()
      .safeParse(n.nodeInfo);
    return {
      id: n.id,
      online: n.status === "CONNECTED",
      protocolVersion: n.relayProtocolVersion,
      allowDeployments: n.allowDeployments,
      reportedDeployments: n.reportedDeployments,
      mode: n.mcpCommandMode,
      localMode: n.reportedMcpCommandMode,
      execution: raw.success ? (raw.data.executionMechanism ?? "unsupported") : "unsupported",
      labels: n.labels,
      info,
      budgets: resolveUsableBudgets(info, n),
      portStart: n.deploymentPortStart,
      portEnd: n.deploymentPortEnd,
    };
  });
  // Live instances without held claims (a pending restart) contribute no resources, but the
  // owner can still stop them, which is what releases their pool and recipe.
  const rows = await tx.deploymentInstance.findMany({
    where: { userId, ...liveDeploymentInstanceWhere },
    include: { Nodes: { orderBy: { rank: "asc" } } },
    orderBy: { id: "asc" },
  });
  const existing: LiveDeployment[] = rows.map((i) => ({
    id: i.id,
    startedBy: i.startedBy,
    agentsMayPreempt: i.agentsMayPreempt,
    // Every rank's device, claimed or not: stopping is governed by all of them.
    rankNodeIds: [...new Set(i.Nodes.map((n) => n.cliDeviceId))].sort(),
    nodes: i.Nodes.filter((n) => n.claimHeld).map((n) => ({
      nodeId: n.cliDeviceId,
      resources: deploymentClaimSchema.parse(n.resources),
      port: n.port,
      distPort: n.distPort,
      blockedBy: n.blockedBy,
    })),
  }));
  return { nodes, existing, fingerprint: deploymentFingerprint({ nodes, existing }) };
}
/** Caller holds owner, all affected node, policy and device generation locks. */
export async function deploymentExecutionAllowed(
  tx: Tx,
  userId: string,
  instanceId: string,
  runId: string,
) {
  const owner = await tx.user.findUnique({
    where: { id: userId },
    select: { banned: true, banExpires: true, deletionRequestedAt: true },
  });
  if (!owner || userCredentialAccessBlocked(owner, new Date())) return false;
  const plan = await tx.deploymentPlan.findFirst({ where: { Run: { id: runId }, userId } });
  const affected = z
    .object({ affectedNodeIds: z.array(z.string()).max(4096) })
    .safeParse(plan?.contents);
  if (!plan || !affected.success) return false;
  const state = await loadDeploymentState(tx, userId);
  const affectedNodes = affected.data.affectedNodeIds.map((id) =>
    state.nodes.find((node) => node.id === id),
  );
  if (affectedNodes.some((node) => !node)) return false;
  for (const node of affectedNodes) {
    if (
      !node?.allowDeployments ||
      !node.reportedDeployments ||
      node.protocolVersion !== DEPLOYMENT_PROTOCOL_VERSION ||
      !["systemd+linger", "macos"].includes(node.execution)
    )
      return false;
    if (
      deploymentCommandActor(plan) === "AGENT" &&
      (node.mode === "OFF" ||
        !node.localMode ||
        node.localMode === "OFF" ||
        (!plan.confirmedAt && (node.mode !== "UNSUPERVISED" || node.localMode !== "UNSUPERVISED")))
    )
      return false;
  }
  const ranks = await tx.deploymentInstanceNode.findMany({ where: { instanceId } });
  for (const rank of ranks) {
    const node = state.nodes.find((n) => n.id === rank.cliDeviceId);
    if (!node?.online || !affected.data.affectedNodeIds.includes(node.id)) return false;
    const own = deploymentClaimSchema.safeParse(rank.resources);
    if (!own.success || own.data.kind !== node.info.nodeKind) return false;
    const others = state.existing
      .filter((i) => i.id !== instanceId)
      .flatMap((i) => i.nodes.filter((n) => n.nodeId === node.id));
    const claims = [own.data, ...others.map((n) => n.resources)];
    if (
      claims.reduce((sum, c) => sum + c.memoryGb, 0) >
        Math.min(node.budgets.usableMemoryGb ?? 0, (node.info.memoryTotalMiB ?? 0) / 1024) ||
      claims.reduce((sum, c) => sum + c.ramGb, 0) >
        Math.min(node.budgets.usableRamGb ?? 0, (node.info.memoryTotalMiB ?? 0) / 1024)
    )
      return false;
    for (const gpu of own.data.gpus) {
      if (
        !node.info.gpus?.some((g) => gpuBudgetKey(g) === gpu.key && g.index === gpu.index) ||
        claims
          .flatMap((c) => c.gpus)
          .filter((g) => g.key === gpu.key)
          .reduce((sum, g) => sum + g.vramGb, 0) >
          Math.min(
            node.budgets.usableVramGb[gpu.key] ?? 0,
            (node.info.gpus?.find((g) => gpuBudgetKey(g) === gpu.key)?.vramTotalMiB ?? 0) / 1024,
          )
      )
        return false;
    }
    for (const port of [rank.port, rank.distPort].filter((port): port is number => port !== null)) {
      if (
        port < node.portStart ||
        port > node.portEnd ||
        others.some((n) => n.port === port || n.distPort === port)
      )
        return false;
    }
  }
  return ranks.length > 0;
}
/**
 * Every command text a variant runs: each rank's start, stop and optional phases. A command's
 * interactive flag is deliberately not part of the match: an agent revision that flips a
 * person's interactive command to automatic (or the reverse) still holds that text, so the
 * flipped command counts as agent-written, and a person flipping the flag of an agent-written
 * command does not launder it.
 */
function variantCommandTexts(commands: readonly Record<string, unknown>[]): string[] {
  return commands.flatMap((rank) =>
    (["start", "stop", "prepare", "afterJoin", "status", "health"] as const).flatMap((field) =>
      typeof rank[field] === "string" ? [rank[field] as string] : [],
    ),
  );
}
/**
 * Whether an agent wrote any command this variant runs, in this or an earlier
 * revision of the recipe. Compared per command text, so a person editing one
 * field (a port in `start`) does not launder an agent-written `prepare` or
 * `health` beside it, and a rename that keeps the commands keeps the mark.
 */
async function agentWroteCommands(
  tx: Tx,
  revision: { configId: string; revision: number; editorKind: string },
  variant: Pick<DeploymentVariant, "commands">,
) {
  if (revision.editorKind === "AGENT") return true;
  const texts = new Set(variantCommandTexts(variant.commands));
  if (texts.size === 0) return false;
  const agentRevisions = await tx.deploymentConfigRevision.findMany({
    where: {
      configId: revision.configId,
      editorKind: "AGENT",
      revision: { lt: revision.revision },
    },
    orderBy: { revision: "desc" },
    take: 1024,
    select: { spec: true },
  });
  return agentRevisions.some((agentRevision) => {
    const spec = storedDeploymentSpecSchema.safeParse(agentRevision.spec);
    return (
      spec.success &&
      spec.data.variants.some((candidate) =>
        variantCommandTexts(candidate.commands).some((text) => texts.has(text)),
      )
    );
  });
}
/** Plan warning recorded when a person starts commands an agent wrote. */
export const AGENT_EDITED_REVISION = "agent_edited_revision";
/**
 * Whose authority a plan's jobs run under: whoever requested it. A person's
 * dashboard start or stop runs as theirs whatever the nodes' MCP command
 * modes (those govern agents only); an agent-written recipe a person starts is
 * shown for review first (`AGENT_EDITED_REVISION`), not run as the agent's.
 */
export function deploymentCommandActor(plan: { requesterKind: string }): "AGENT" | "USER" {
  return plan.requesterKind === "AGENT" ? "AGENT" : "USER";
}
export const deploymentStartInputSchema = z
  .object({
    revisionId: deploymentIdSchema,
    variantKey: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
    nodeIds: z.array(deploymentIdSchema).min(1).max(256).optional(),
    groupCount: z.number().int().min(1).max(64).default(1),
  })
  .strict();
export const deploymentPlanContentsSchema = z.object({
  action: z.enum(["start", "stop"]),
  start: deploymentStartInputSchema.optional(),
  stopInstanceId: z.string().optional(),
  affectedNodeIds: z.array(z.string()),
  stopIds: z.array(z.string()),
  placements: z.array(
    z.object({
      nodeId: z.string(),
      rank: z.number().int(),
      group: z.number().int(),
      resources: deploymentClaimSchema,
      port: z.number().int(),
      distPort: z.number().int().nullable(),
    }),
  ),
  requiresConfirmation: z.boolean(),
  effectiveMode: z.enum(["OFF", "SUPERVISED", "UNSUPERVISED"]),
  headAddr: z.string(),
  warnings: z.array(z.string()),
});
export type DeploymentPlanContents = z.infer<typeof deploymentPlanContentsSchema>;
async function getVariant(tx: Tx, userId: string, revisionId: string, key: string) {
  const revision = await tx.deploymentConfigRevision.findFirst({
    where: { id: revisionId, Config: { userId } },
    include: { Config: true },
  });
  if (!revision) throw new ORPCError("NOT_FOUND", { message: "Deployment revision not found" });
  const spec = deploymentSpecSchema.safeParse(revision.spec);
  // A revision saved before the current validation rules cannot be started.
  if (!spec.success)
    throw new ORPCError("CONFLICT", {
      message: "This recipe revision is no longer valid; edit and save the recipe first",
    });
  const variant = spec.data.variants.find((v) => v.key === key);
  if (!variant) throw new ORPCError("NOT_FOUND", { message: "Deployment variant not found" });
  const poolId = revision.Config.poolId;
  if (!poolId)
    throw new ORPCError("CONFLICT", {
      message: "This recipe's pool was deleted; choose a new pool for the recipe first",
    });
  if (variant.attachment.poolId !== poolId)
    throw new ORPCError("CONFLICT", {
      message:
        "This recipe revision targets a pool the recipe no longer uses; use the latest revision",
    });
  // Pool deletion holds this row FOR UPDATE while it checks for live instances and detaches
  // recipes, so an instance is never created for a pool that is being deleted.
  const pool = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM model_pool WHERE id = ${poolId} AND "userId" = ${userId} FOR KEY SHARE`;
  if (pool.length !== 1)
    throw new ORPCError("CONFLICT", {
      message: "This recipe's pool was deleted; choose a new pool for the recipe first",
    });
  return { revision, variant };
}
export async function createDeploymentPlan(
  requester: DeploymentRequester,
  input: { start: z.infer<typeof deploymentStartInputSchema> } | { stopInstanceId: string },
) {
  return prisma.$transaction(
    async (tx) => {
      await lockDeploymentOwner(tx, requester.userId);
      await assertDeploymentOwnerActive(tx, requester.userId);
      if (requester.kind === "AGENT") {
        const recent = await tx.deploymentPlan.count({
          where: {
            userId: requester.userId,
            requesterKind: "AGENT",
            createdAt: { gte: new Date(Date.now() - 60_000) },
          },
        });
        if (recent >= 10)
          throw new ORPCError("TOO_MANY_REQUESTS", {
            message: "Deployment plan rate limit reached",
          });
      }
      const state = await loadDeploymentState(tx, requester.userId);
      let contents: DeploymentPlanContents;
      if ("start" in input) {
        const { revision, variant } = await getVariant(
          tx,
          requester.userId,
          input.start.revisionId,
          input.start.variantKey,
        );
        assertInteractiveCommandsSupported(variant);
        const plan = planDeployment({ ...state, variant, ...input.start, actor: requester.kind });
        // Refuse undeliverable jobs now rather than after confirmation. Apply re-renders with
        // the real identities, whose lengths these placeholders match.
        for (let group = 0; group < input.start.groupCount; group++)
          renderDeploymentGroup(
            variant,
            {
              id: "0".repeat(32),
              revisionId: revision.id,
              endpointSlug: `inst-${revision.Config.slug}-${"0".repeat(12)}`,
            },
            plan.placements.filter((p) => p.group === group),
            state.nodes,
          );
        // Commands an agent wrote are shown to a person for review before that
        // person starts them; once confirmed the jobs run as the person's, also
        // where agent commands have since been turned off.
        const agentAuthored =
          requester.kind === "USER" && (await agentWroteCommands(tx, revision, variant));
        contents = {
          ...plan,
          action: "start",
          start: input.start,
          requiresConfirmation: plan.requiresConfirmation || agentAuthored,
          warnings: agentAuthored ? [...plan.warnings, AGENT_EDITED_REVISION] : plan.warnings,
        };
      } else {
        const instance = state.existing.find((i) => i.id === input.stopInstanceId);
        if (!instance)
          throw new ORPCError("NOT_FOUND", { message: "Running deployment instance not found" });
        // Only ranks that hold a claim run a stop, so only they are gated, locked and
        // dispatched to. Command modes and confirmation cover every rank, so an agent cannot
        // cancel a pending restart (no claims) on nodes where its commands are off.
        const affectedNodeIds = [...new Set(instance.nodes.map((n) => n.nodeId))].sort();
        const permission = deploymentPermission(
          state.nodes.filter((n) => affectedNodeIds.includes(n.id)),
          [instance],
          requester.kind,
          new Set(affectedNodeIds),
          state.nodes.filter((n) => instance.rankNodeIds.includes(n.id)),
        );
        contents = {
          action: "stop",
          stopInstanceId: instance.id,
          affectedNodeIds,
          stopIds: [instance.id],
          placements: [],
          ...permission,
          headAddr: "",
          warnings: [],
        };
      }
      const plan = await tx.deploymentPlan.create({
        data: {
          userId: requester.userId,
          requesterId: requester.id,
          requesterKind: requester.kind,
          state: contents.requiresConfirmation ? "AWAITING_CONFIRMATION" : "PENDING",
          expiresAt: new Date(Date.now() + 900_000),
          fingerprint: state.fingerprint,
          contents,
        },
      });
      return { ...plan, contents };
    },
    { isolationLevel: "ReadCommitted", timeout: 30_000 },
  );
}
/**
 * Until operator terminals ship, no job a person must run is ever dispatched: a CLI that does
 * not know the interactive fields would refuse the job, and one that ignored them would run the
 * command unattended. Saving such a recipe is allowed; starting it is not.
 */
function assertInteractiveCommandsSupported(variant: DeploymentVariant) {
  if (variantHasInteractiveCommands(variant))
    throw new ORPCError("BAD_REQUEST", {
      message: "Interactive recipe commands are not supported yet",
    });
}
/** The recipe command a phase runs, which decides whether that phase is interactive. */
type DeploymentPhaseSource = "start" | "prepare" | "afterJoin" | null;
function jobIntent(
  variant: DeploymentVariant,
  instance: { id: string; revisionId: string; endpointSlug: string },
  p: DeploymentPlanContents["placements"][number],
  phase: DeploymentJob["action"],
  source: DeploymentPhaseSource,
  command: string,
): Omit<DeploymentJob, "stepId" | "intentHash" | "ownerEpoch" | "actor" | "humanApproved"> {
  const rankCommands = rankValue(variant.commands, p.rank);
  return {
    type: "deployment.job",
    attachment: variant.attachment.type,
    engine: variant.engine,
    management: rankCommands.management,
    // Present only when true, so intents without interactive commands hash as before.
    ...(source && rankCommands.interactive?.[source] ? { interactive: true as const } : {}),
    ...(rankCommands.interactive?.stop ? { stopInteractive: true as const } : {}),
    ...(variant.attachment.embeddingContract
      ? { embeddingContract: variant.attachment.embeddingContract }
      : {}),
    ...(variant.attachment.transcription
      ? { transcriptionProfile: variant.attachment.transcription }
      : {}),
    revisionId: instance.revisionId,
    instanceId: instance.id,
    rank: p.rank,
    action: phase,
    command,
    timeoutMs:
      phase === "stop"
        ? 300_000
        : phase === "health" || phase === "status"
          ? 30_000
          : variant.readiness.timeoutMs,
    unitName: `wsmp-i-${instance.id}-r${p.rank}`,
    port: p.port,
    endpointSlug: instance.endpointSlug,
    models: variant.models,
    contextWindow: variant.contextWindow,
    readiness: variant.readiness,
    health: variant.health,
  };
}
/**
 * Rejects an intent unless it and every job later derived from it (stop, health, restart
 * copies) fit one relay control frame. Runs inside admission, so claims never commit for an
 * undeliverable deployment.
 */
function assertDeploymentJobsDeliverable(intent: unknown) {
  for (const job of deploymentDerivedIntents(intent)) {
    // The CLI refuses a job breaking its own rules as `bad_job`, and a refused stop would hold
    // the instance's claims, so nothing it would refuse is ever admitted.
    const issue = deploymentJobWireIssue(deploymentDispatchShape(job));
    // Only a recipe slug saved before the current slug rule renders an invalid endpoint slug.
    if (issue === "endpoint slug")
      throw new ORPCError("BAD_REQUEST", {
        message:
          "This recipe's slug is not valid on nodes (it ends with or repeats '-'). Rename the recipe while none of its deployments are running, then start it again.",
        data: { reason: "invalid_recipe_slug" },
      });
    if (issue)
      throw new ORPCError("BAD_REQUEST", {
        message: `Rendered ${job.action} job for rank ${job.rank} would be refused by the node (${issue}). Fix the recipe.`,
      });
    const bytes = deploymentJobFrameBytes(job);
    if (bytes === null)
      throw new ORPCError("BAD_REQUEST", {
        message: "Rendered deployment commands must be well-formed Unicode text.",
      });
    if (bytes > DEPLOYMENT_JOB_FRAME_MAX_BYTES)
      throw new ORPCError("BAD_REQUEST", {
        message: `Rendered ${job.action} job for rank ${job.rank} is ${bytes} bytes; deployment jobs must fit ${DEPLOYMENT_JOB_FRAME_MAX_BYTES} bytes. Shorten the recipe commands.`,
      });
  }
}
/**
 * A durable intent framed as the reconciler dispatches it, with well-formed stand-ins for the
 * per-dispatch fields (their real values always pass the CLI's identity rules).
 */
export function deploymentDispatchShape(
  intent: Omit<
    DeploymentJob,
    "stepId" | "intentHash" | "ownerEpoch" | "actor" | "humanApproved" | "operator"
  >,
  dispatch: Partial<
    Pick<DeploymentJob, "stepId" | "ownerEpoch" | "actor" | "humanApproved" | "operator">
  > = {},
): DeploymentJob {
  return {
    ...intent,
    stepId: dispatch.stepId ?? "s".repeat(24),
    intentHash: deploymentFingerprint(intent),
    ownerEpoch: dispatch.ownerEpoch ?? `${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}:1`,
    actor: dispatch.actor ?? "USER",
    humanApproved: dispatch.humanApproved ?? true,
    ...(intent.interactive
      ? { operator: dispatch.operator ?? { terminalId: "A".repeat(22) } }
      : {}),
  };
}
type DeploymentPlacement = DeploymentPlanContents["placements"][number];
/**
 * Every durable step of one group exactly as admission persists it, each checked deliverable.
 * Plan creation renders with placeholder identities of the same lengths, so an undeliverable
 * recipe is refused before it is sent for confirmation.
 */
export function renderDeploymentGroup(
  variant: DeploymentVariant,
  instance: { id: string; revisionId: string; endpointSlug: string },
  placements: DeploymentPlacement[],
  nodes: DeploymentNode[],
) {
  const head = placements.find((p) => p.rank === 0);
  const headNode = nodes.find((n) => n.id === head?.nodeId);
  const headAddr =
    variant.groupSize === 1
      ? "127.0.0.1"
      : deploymentHeadAddress(headNode?.info.interfaces, variant.iface);
  if (!head || !headNode) throw new Error("Missing deployment head placement");
  if (!headAddr)
    throw new ORPCError("BAD_REQUEST", {
      message: `The head node has no IPv4 address on interface ${variant.iface ?? ""}`,
    });
  return placements.map((p) => {
    const node = nodes.find((n) => n.id === p.nodeId);
    if (!node) throw new Error("Missing placement node");
    const rankCommands = rankValue(variant.commands, p.rank);
    const memory =
      p.resources.kind === "unified"
        ? p.resources.memoryGb
        : p.resources.kind === "cpu"
          ? p.resources.ramGb
          : (p.resources.gpus[0]?.vramGb ?? 0);
    const totalMemory =
      p.resources.kind === "discrete"
        ? (node.info.gpus?.find((g) => g.index === p.resources.gpus[0]?.index)?.vramTotalMiB ?? 0) /
          1024
        : (node.info.memoryTotalMiB ?? 0) / 1024;
    const values = {
      node_rank: p.rank,
      nnodes: variant.groupSize,
      port: p.port,
      dist_port: head.distPort ?? head.port,
      memory_gb: memory,
      gpu_ids: p.resources.gpus.map((g) => g.index).join(","),
      vram_gb: p.resources.gpus[0]?.vramGb ?? 0,
      memory_fraction: totalMemory > 0 ? memory / totalMemory : 1,
      iface: variant.iface ?? "",
      head_addr: headAddr,
    };
    const stopCommand = renderDeploymentCommand(rankCommands.stop, values);
    const phases: Array<{
      phase: DeploymentJob["action"];
      sequence: number;
      source: DeploymentPhaseSource;
      command: string;
    }> = [];
    if (variant.groupSize === 1)
      phases.push({ phase: "start", sequence: 0, source: "start", command: rankCommands.start });
    else if (p.rank === 0) {
      if (rankCommands.prepare)
        phases.push({
          phase: "prepare",
          sequence: 0,
          source: "prepare",
          command: rankCommands.prepare,
        });
      phases.push(
        rankCommands.afterJoin
          ? { phase: "start", sequence: 2, source: "afterJoin", command: rankCommands.afterJoin }
          : { phase: "start", sequence: 2, source: "start", command: rankCommands.start },
      );
    } else
      phases.push({ phase: "start", sequence: 1, source: "start", command: rankCommands.start });
    if (p.rank === 0) phases.push({ phase: "readiness", sequence: 3, source: null, command: "" });
    const steps = phases.map((phase) => {
      const intent = {
        ...jobIntent(
          variant,
          instance,
          p,
          phase.phase,
          phase.source,
          renderDeploymentCommand(phase.command, values),
        ),
        stopCommand,
        statusCommand: rankCommands.status
          ? renderDeploymentCommand(rankCommands.status, values)
          : null,
        healthCommand: rankCommands.health
          ? renderDeploymentCommand(rankCommands.health, values)
          : null,
      };
      assertDeploymentJobsDeliverable(intent);
      return { phase: phase.phase, sequence: phase.sequence, intent };
    });
    return { placement: p, steps };
  });
}
/** Durable steps are committed before any external dispatch. Reconciler owns dispatch. */
export async function applyDeploymentPlan(
  requester: DeploymentRequester,
  planId: string,
  confirm: boolean,
) {
  return prisma.$transaction(
    async (tx) => {
      await lockDeploymentOwner(tx, requester.userId);
      await assertDeploymentOwnerActive(tx, requester.userId);
      const plan = await tx.deploymentPlan.findFirst({
        where: { id: planId, userId: requester.userId },
      });
      if (!plan) throw new ORPCError("NOT_FOUND");
      if (plan.state === "APPLIED")
        return tx.deploymentRun.findUniqueOrThrow({ where: { planId } });
      if (plan.expiresAt.getTime() <= Date.now())
        throw new ORPCError("CONFLICT", { message: "Deployment plan expired; compute a new plan" });
      if (requester.kind === "AGENT" && (confirm || plan.requesterId !== requester.id))
        throw new ORPCError("FORBIDDEN");
      const contents = deploymentPlanContentsSchema.parse(plan.contents);
      if (contents.requiresConfirmation && (!confirm || requester.kind !== "USER"))
        return { status: "awaiting_confirmation" as const, planId };
      await lockDeploymentNodes(tx, contents.affectedNodeIds);
      const state = await loadDeploymentState(tx, requester.userId);
      if (state.fingerprint !== plan.fingerprint)
        throw new ORPCError("CONFLICT", {
          message: "Node or deployment state changed; compute a new plan",
        });
      // Re-run permission policy while locks are held, including every stopped rank.
      const stopped = state.existing.filter((i) => contents.stopIds.includes(i.id));
      const stoppedClaims = new Set(stopped.flatMap((i) => i.nodes.map((n) => n.nodeId)));
      const modeNodeIds = new Set([
        ...contents.affectedNodeIds,
        ...stopped.flatMap((i) => i.rankNodeIds),
      ]);
      deploymentPermission(
        state.nodes.filter((n) => contents.affectedNodeIds.includes(n.id)),
        stopped,
        plan.requesterKind,
        stoppedClaims,
        state.nodes.filter((n) => modeNodeIds.has(n.id)),
      );
      const stoppedTargets = await tx.executionTarget.findMany({
        where: {
          DiscoveredModel: { Endpoint: { deploymentInstanceId: { in: contents.stopIds } } },
        },
        select: { id: true, inferenceCapacityId: true },
      });
      await acquireFences(
        tx,
        stoppedTargets.flatMap((t) => [
          fences.capacityPolicy(t.id),
          ...(t.inferenceCapacityId ? [fences.capacity(t.inferenceCapacityId)] : []),
        ]),
      );
      const run = await tx.deploymentRun.create({ data: { planId } });
      for (const stopId of contents.stopIds) {
        const instance = await tx.deploymentInstance.findUniqueOrThrow({
          where: { id: stopId },
          include: { Nodes: { where: { claimHeld: true } } },
        });
        // A stop replays the persisted start intents, never the recipe: an
        // instance stays stoppable even if its revision no longer validates.
        await tx.deploymentInstance.update({
          where: { id: stopId },
          data: { desiredState: "STOPPED", observedState: "STOPPING" },
        });
        await tx.poolMember.updateMany({
          where: {
            OR: [
              { DiscoveredModel: { Endpoint: { deploymentInstanceId: stopId } } },
              {
                ExecutionTarget: {
                  DiscoveredModel: { Endpoint: { deploymentInstanceId: stopId } },
                },
              },
            ],
          },
          data: { instanceGate: "CLOSED", routingStatus: "DRAINING" },
        });
        await tx.endpoint.updateMany({
          where: { deploymentInstanceId: stopId },
          data: { published: false, unpublishedAt: new Date() },
        });
        for (const n of instance.Nodes) {
          const previous = await tx.deploymentStep.findFirst({
            where: { instanceId: instance.id, rank: n.rank, phase: "start" },
            orderBy: { createdAt: "desc" },
          });
          if (!previous) throw new Error("Persisted original deployment intent missing");
          const intent = originalDeploymentStopIntent(previous.intent);
          if (
            intent.instanceId !== instance.id ||
            intent.revisionId !== instance.revisionId ||
            intent.rank !== n.rank ||
            intent.port !== n.port ||
            intent.endpointSlug !== instance.endpointSlug
          )
            throw new Error("Persisted deployment identity mismatch");
          await tx.deploymentStep.create({
            data: {
              runId: run.id,
              instanceId: instance.id,
              cliDeviceId: n.cliDeviceId,
              rank: n.rank,
              phase: "stop",
              sequence: 0,
              intent,
              intentHash: deploymentFingerprint(intent),
              notBefore: new Date(Date.now() + 60_000),
            },
          });
        }
      }
      if (contents.start) {
        const { revision, variant } = await getVariant(
          tx,
          requester.userId,
          contents.start.revisionId,
          contents.start.variantKey,
        );
        assertInteractiveCommandsSupported(variant);
        for (let group = 0; group < contents.start.groupCount; group++) {
          const id = randomUUID().replaceAll("-", "");
          const identity = {
            id,
            revisionId: revision.id,
            endpointSlug: `inst-${revision.Config.slug}-${id.slice(0, 12)}`,
          };
          // Rendered and checked before any write of this group.
          const ranks = renderDeploymentGroup(
            variant,
            identity,
            contents.placements.filter((p) => p.group === group),
            state.nodes,
          );
          await tx.deploymentInstance.create({
            data: {
              ...identity,
              userId: requester.userId,
              configId: revision.configId,
              runId: run.id,
              variantKey: variant.key,
              startedBy: plan.requesterKind,
            },
          });
          for (const { placement: p, steps } of ranks) {
            const blockedBy = state.existing
              .filter(
                (i) =>
                  contents.stopIds.includes(i.id) && i.nodes.some((n) => n.nodeId === p.nodeId),
              )
              .map((i) => i.id);
            await tx.deploymentInstanceNode.create({
              data: {
                instanceId: id,
                cliDeviceId: p.nodeId,
                rank: p.rank,
                resources: p.resources,
                port: p.port,
                distPort: p.distPort,
                blockedBy,
              },
            });
            for (const step of steps)
              await tx.deploymentStep.create({
                data: {
                  runId: run.id,
                  instanceId: id,
                  cliDeviceId: p.nodeId,
                  rank: p.rank,
                  phase: step.phase,
                  sequence: step.sequence,
                  intent: step.intent,
                  intentHash: deploymentFingerprint(step.intent),
                },
              });
          }
        }
      }
      await tx.deploymentPlan.update({
        where: { id: planId },
        data: {
          state: "APPLIED",
          ...(confirm ? { confirmedBy: requester.id, confirmedAt: new Date() } : {}),
        },
      });
      return run;
    },
    { isolationLevel: "ReadCommitted", timeout: 30_000 },
  );
}
