import { ORPCError } from "@orpc/server";
import prisma from "@ws-model-proxy/db";
import { z } from "zod";
import type { Context } from "../context";
import { humanProcedure, protectedProcedure } from "../index";
import { deploymentFingerprint } from "../lib/deployment-planner";
import {
  AGENT_EDITED_REVISION,
  applyDeploymentPlan,
  createDeploymentPlan,
  type DeploymentRequester,
  deploymentPlanContentsSchema,
  deploymentStartInputSchema,
  liveDeploymentInstanceWhere,
  loadDeploymentState,
  lockDeploymentOwner,
} from "../lib/deployment-service";
import {
  deploymentIdSchema,
  deploymentSpecSchema,
  deploymentTextSchema,
} from "../lib/deployment-spec";

function requester(context: Context): DeploymentRequester {
  const agent = context.services?.deploymentActor;
  return {
    userId: context.session?.user.id ?? "",
    id: agent?.id ?? context.session?.user.id ?? "",
    kind: agent ? "AGENT" : "USER",
  };
}
function human(context: Context) {
  if (context.services?.deploymentActor)
    throw new ORPCError("FORBIDDEN", { message: "Human confirmation required" });
}
async function assertRecipeWrite(userId: string, kind: "USER" | "AGENT") {
  if (kind === "USER") return;
  const permitted = await prisma.cliDevice.count({
    where: {
      userId,
      mcpCommandMode: { in: ["SUPERVISED", "UNSUPERVISED"] },
      reportedMcpCommandMode: { in: ["SUPERVISED", "UNSUPERVISED"] },
    },
  });
  if (!permitted)
    throw new ORPCError("FORBIDDEN", {
      message: "Deployment recipe editing requires an enabled command node",
    });
}
const recipeName = deploymentTextSchema(128).refine(
  (value) => value.trim().length > 0,
  "Name must not be blank.",
);
const idInput = z.object({ id: deploymentIdSchema }).strict();
const pageInput = z
  .object({
    cursor: deploymentIdSchema.optional(),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict()
  .default({ limit: 50 });
function deploymentPage<T extends { id: string }>(rows: T[], limit: number) {
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null };
}
const storedSpecShape = z.object({
  variants: z.array(z.looseObject({ key: z.string(), commands: z.unknown() })),
});
function storedVariant(spec: unknown, key: string) {
  const parsed = storedSpecShape.safeParse(spec);
  return parsed.success ? (parsed.data.variants.find((v) => v.key === key) ?? null) : null;
}
async function previewPlan(userId: string, raw: unknown) {
  const contents = deploymentPlanContentsSchema.parse(raw);
  if (contents.stopIds.length > 256) throw new ORPCError("CONFLICT");
  const revision = contents.start
    ? await prisma.deploymentConfigRevision.findFirst({
        where: { id: contents.start.revisionId, Config: { userId } },
        select: { id: true, spec: true },
      })
    : null;
  const stopped = contents.stopIds.length
    ? await prisma.deploymentInstance.findMany({
        where: { userId, id: { in: contents.stopIds } },
        include: { Revision: true, Nodes: { take: 64, orderBy: { rank: "asc" } } },
        take: 256,
      })
    : [];
  const startSpec = revision ? deploymentSpecSchema.safeParse(revision.spec) : null;
  const start = startSpec?.success
    ? startSpec.data.variants.find((v) => v.key === contents.start?.variantKey)
    : undefined;
  if ((contents.start && !start) || stopped.length !== contents.stopIds.length)
    throw new ORPCError("CONFLICT", {
      message: "Immutable plan preview is unavailable; compute a new plan",
    });
  return {
    start: start ?? null,
    // An agent wrote the commands being started: a person reviews them first.
    agentEdited: contents.warnings.includes(AGENT_EDITED_REVISION),
    stopped: stopped.map((instance) => ({
      id: instance.id,
      endpointSlug: instance.endpointSlug,
      nodes: instance.Nodes,
      // Shown for review only (a stop replays persisted intents), so a revision
      // saved before the current rules is read leniently instead of refused.
      variant: storedVariant(instance.Revision.spec, instance.variantKey),
    })),
  };
}
export const deploymentsRouter = {
  listConfigs: protectedProcedure.input(pageInput).handler(async ({ context, input }) =>
    deploymentPage(
      await prisma.deploymentConfig.findMany({
        where: {
          userId: context.session.user.id,
          ...(input.cursor ? { id: { gt: input.cursor } } : {}),
        },
        include: { Revisions: { orderBy: { revision: "desc" }, take: 1 } },
        orderBy: { id: "asc" },
        take: input.limit + 1,
      }),
      input.limit,
    ),
  ),
  getConfig: protectedProcedure.input(idInput).handler(async ({ context, input }) => {
    const config = await prisma.deploymentConfig.findFirst({
      where: { id: input.id, userId: context.session.user.id },
      include: { Revisions: { orderBy: { revision: "desc" }, take: 1 } },
    });
    if (!config) throw new ORPCError("NOT_FOUND");
    return config;
  }),
  createConfig: protectedProcedure
    .input(
      z
        .object({
          slug: z.string().regex(/^[a-z][a-z0-9-]{0,40}$/),
          name: recipeName,
          poolId: deploymentIdSchema,
          spec: deploymentSpecSchema,
        })
        .strict(),
    )
    .handler(async ({ context, input }) => {
      const actor = requester(context);
      await assertRecipeWrite(actor.userId, actor.kind);
      return prisma.$transaction(
        async (tx) => {
          await lockDeploymentOwner(tx, actor.userId);
          const pool = await tx.modelPool.findFirst({
            where: { id: input.poolId, userId: actor.userId },
          });
          if (!pool) throw new ORPCError("NOT_FOUND", { message: "Target pool not found" });
          if (input.spec.variants.some((v) => v.attachment.poolId !== pool.id))
            throw new ORPCError("BAD_REQUEST", {
              message: "All variants must attach to the config target pool",
            });
          return tx.deploymentConfig.create({
            data: {
              userId: actor.userId,
              poolId: pool.id,
              slug: input.slug,
              name: input.name,
              Revisions: {
                create: {
                  revision: 1,
                  editorId: actor.id,
                  editorKind: actor.kind,
                  spec: input.spec,
                  contentHash: deploymentFingerprint(input.spec),
                },
              },
            },
            include: { Revisions: true },
          });
        },
        { isolationLevel: "ReadCommitted" },
      );
    }),
  updateConfig: protectedProcedure
    .input(
      z
        .object({
          id: deploymentIdSchema,
          expectedRevision: z.number().int().positive(),
          name: recipeName.optional(),
          /** Moves the recipe to another pool; required for a recipe whose pool was deleted. */
          poolId: deploymentIdSchema.optional(),
          spec: deploymentSpecSchema,
        })
        .strict(),
    )
    .handler(async ({ context, input }) => {
      const actor = requester(context);
      await assertRecipeWrite(actor.userId, actor.kind);
      return prisma.$transaction(
        async (tx) => {
          await lockDeploymentOwner(tx, actor.userId);
          // Pool rows lock before recipe rows, matching pool deletion.
          if (input.poolId) {
            const pool = await tx.$queryRaw<Array<{ id: string }>>`
              SELECT id FROM model_pool WHERE id = ${input.poolId} AND "userId" = ${actor.userId} FOR KEY SHARE`;
            if (pool.length !== 1)
              throw new ORPCError("NOT_FOUND", { message: "Target pool not found" });
          }
          const locked = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT id FROM deployment_config WHERE id = ${input.id} AND "userId" = ${actor.userId} FOR UPDATE`;
          if (locked.length !== 1) throw new ORPCError("NOT_FOUND");
          const config = await tx.deploymentConfig.findUniqueOrThrow({
            where: { id: input.id },
            include: { Revisions: { orderBy: { revision: "desc" }, take: 1 } },
          });
          if (config.Revisions[0]?.revision !== input.expectedRevision)
            throw new ORPCError("CONFLICT", { message: "Recipe revision changed" });
          const poolId = input.poolId ?? config.poolId;
          if (!poolId)
            throw new ORPCError("BAD_REQUEST", {
              message: "This recipe's pool was deleted; choose a new pool for it",
            });
          if (poolId !== config.poolId) {
            const live = await tx.deploymentInstance.count({
              where: { configId: config.id, ...liveDeploymentInstanceWhere },
            });
            if (live)
              throw new ORPCError("CONFLICT", {
                message: "Stop this recipe's deployments before moving it to another pool",
                data: { reason: "deployments_running" },
              });
          }
          if (input.spec.variants.some((v) => v.attachment.poolId !== poolId))
            throw new ORPCError("BAD_REQUEST", {
              message: "All variants must attach to the config target pool",
            });
          if (input.name || poolId !== config.poolId)
            await tx.deploymentConfig.update({
              where: { id: config.id },
              data: {
                ...(input.name ? { name: input.name } : {}),
                ...(poolId !== config.poolId ? { poolId } : {}),
              },
            });
          return tx.deploymentConfigRevision.create({
            data: {
              configId: config.id,
              revision: input.expectedRevision + 1,
              editorId: actor.id,
              editorKind: actor.kind,
              spec: input.spec,
              contentHash: deploymentFingerprint(input.spec),
            },
          });
        },
        { isolationLevel: "ReadCommitted" },
      );
    }),
  /** Removes a recipe that never started an instance. Recipes with history are kept. */
  deleteConfig: humanProcedure.input(idInput).handler(async ({ context, input }) => {
    human(context);
    const userId = context.session.user.id;
    return prisma.$transaction(
      async (tx) => {
        await lockDeploymentOwner(tx, userId);
        const config = await tx.deploymentConfig.findFirst({
          where: { id: input.id, userId },
          select: { id: true, _count: { select: { Instances: true } } },
        });
        if (!config) throw new ORPCError("NOT_FOUND");
        if (config._count.Instances > 0)
          throw new ORPCError("CONFLICT", {
            message: "This recipe has deployment history and cannot be deleted",
            data: { reason: "deployment_history" },
          });
        await tx.deploymentConfig.delete({ where: { id: config.id } });
        return { deleted: true as const };
      },
      { isolationLevel: "ReadCommitted" },
    );
  }),
  listInstances: protectedProcedure.input(pageInput).handler(async ({ context, input }) =>
    deploymentPage(
      await prisma.deploymentInstance.findMany({
        where: {
          userId: context.session.user.id,
          ...(input.cursor ? { id: { gt: input.cursor } } : {}),
        },
        include: { Nodes: { take: 64, orderBy: { rank: "asc" } } },
        orderBy: { id: "asc" },
        take: input.limit + 1,
      }),
      input.limit,
    ),
  ),
  getInstance: protectedProcedure.input(idInput).handler(async ({ context, input }) => {
    const instance = await prisma.deploymentInstance.findFirst({
      where: { id: input.id, userId: context.session.user.id },
      include: {
        Nodes: { take: 64, orderBy: { rank: "asc" } },
        Steps: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 100 },
        _count: { select: { Steps: true } },
        Revision: true,
      },
    });
    if (!instance) throw new ORPCError("NOT_FOUND");
    return { ...instance, stepsTruncated: instance._count.Steps > instance.Steps.length };
  }),
  planStart: protectedProcedure
    .input(deploymentStartInputSchema)
    .handler(({ context, input }) => createDeploymentPlan(requester(context), { start: input })),
  planStop: protectedProcedure
    .input(z.object({ instanceId: deploymentIdSchema }).strict())
    .handler(({ context, input }) =>
      createDeploymentPlan(requester(context), { stopInstanceId: input.instanceId }),
    ),
  applyPlan: protectedProcedure
    .input(z.object({ planId: deploymentIdSchema }).strict())
    .handler(({ context, input }) => applyDeploymentPlan(requester(context), input.planId, false)),
  confirmPlan: humanProcedure
    .input(z.object({ planId: deploymentIdSchema }).strict())
    .handler(({ context, input }) => {
      human(context);
      return applyDeploymentPlan(requester(context), input.planId, true);
    }),
  planStatus: protectedProcedure.input(idInput).handler(async ({ context, input }) => {
    const plan = await prisma.deploymentPlan.findFirst({
      where: { id: input.id, userId: context.session.user.id },
      include: {
        Run: {
          include: {
            Instances: { take: 256 },
            Steps: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 100 },
            _count: { select: { Steps: true } },
          },
        },
      },
    });
    if (!plan) throw new ORPCError("NOT_FOUND");
    return {
      ...plan,
      stepsTruncated: plan.Run ? plan.Run._count.Steps > plan.Run.Steps.length : false,
      preview: await previewPlan(context.session.user.id, plan.contents),
    };
  }),
  pendingPlans: protectedProcedure.input(pageInput).handler(async ({ context, input }) => {
    human(context);
    return deploymentPage(
      await prisma.deploymentPlan.findMany({
        where: {
          userId: context.session.user.id,
          state: "AWAITING_CONFIRMATION",
          expiresAt: { gt: new Date() },
          ...(input.cursor ? { id: { gt: input.cursor } } : {}),
        },
        orderBy: { id: "asc" },
        take: input.limit + 1,
      }),
      input.limit,
    );
  }),
  setNodeGrant: humanProcedure
    .input(
      z
        .object({
          nodeId: deploymentIdSchema,
          allow: z.boolean(),
          portStart: z.number().int().min(1024).max(65535).optional(),
          portEnd: z.number().int().min(1024).max(65535).optional(),
        })
        .strict(),
    )
    .handler(async ({ context, input }) => {
      human(context);
      return prisma.$transaction(
        async (tx) => {
          await lockDeploymentOwner(tx, context.session.user.id);
          const state = await loadDeploymentState(tx, context.session.user.id);
          const node = state.nodes.find((n) => n.id === input.nodeId);
          if (!node) throw new ORPCError("NOT_FOUND");
          const portStart = input.portStart ?? node.portStart,
            portEnd = input.portEnd ?? node.portEnd;
          if (portEnd < portStart)
            throw new ORPCError("BAD_REQUEST", { message: "Invalid deployment port range" });
          if (
            state.existing.some((i) =>
              i.nodes.some(
                (n) =>
                  n.nodeId === node.id &&
                  (n.port < portStart ||
                    n.port > portEnd ||
                    (n.distPort !== null && (n.distPort < portStart || n.distPort > portEnd))),
              ),
            )
          )
            throw new ORPCError("CONFLICT", {
              message: "Port range contains active deployment claims",
            });
          // Stops are dispatched only to granted nodes, so revoking while any
          // live instance has a rank here (claim held or not) would leave its
          // automatic stops waiting until the node is granted again.
          if (
            !input.allow &&
            node.allowDeployments &&
            state.existing.some((i) => i.rankNodeIds.includes(node.id))
          )
            throw new ORPCError("CONFLICT", {
              message: "Stop the deployments running on this node before revoking its grant",
              data: { reason: "deployment_claims_held" },
            });
          return tx.cliDevice.update({
            where: { id: node.id },
            data: {
              allowDeployments: input.allow,
              deploymentPortStart: portStart,
              deploymentPortEnd: portEnd,
            },
            select: {
              id: true,
              allowDeployments: true,
              deploymentPortStart: true,
              deploymentPortEnd: true,
            },
          });
        },
        { isolationLevel: "ReadCommitted" },
      );
    }),
  setAgentsMayPreempt: humanProcedure
    .input(z.object({ instanceId: deploymentIdSchema, allow: z.boolean() }).strict())
    .handler(async ({ context, input }) => {
      human(context);
      return prisma.$transaction(
        async (tx) => {
          await lockDeploymentOwner(tx, context.session.user.id);
          const row = await tx.deploymentInstance.findFirst({
            where: { id: input.instanceId, userId: context.session.user.id },
          });
          if (!row) throw new ORPCError("NOT_FOUND");
          return tx.deploymentInstance.update({
            where: { id: row.id },
            data: { agentsMayPreempt: input.allow },
          });
        },
        { isolationLevel: "ReadCommitted" },
      );
    }),
};
