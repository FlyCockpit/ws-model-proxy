import prisma from "@ws-model-proxy/db";
import { env } from "@ws-model-proxy/env/server";
import { contractProcedure, stub } from "../contract-procedure";
import { modelsContract as c } from "../contracts/models";
import { callableIdsFor, MEMBER_INCLUDE, poolStatus } from "../lib/pool-views";

const POOL_SELECT = {
  id: true,
  slug: true,
  userId: true,
  modelType: true,
  User: { select: { slug: true, email: true } },
  Fallback: { select: { mode: true } },
  Members: { include: MEMBER_INCLUDE },
} as const;

export const modelsRouter = {
  /**
   * Every callable ID the person may use: own pools and pools shared with them with can use.
   * Served models (direct `runtime:<id>:<model>`) are web-test only and never listed here.
   */
  list: contractProcedure(c.list).handler(async ({ context }) => {
    const userId = context.session.user.id;
    const pools = await prisma.pool.findMany({
      where: {
        OR: [{ userId }, { Shares: { some: { granteeUserId: userId, canUse: true } } }],
      },
      select: POOL_SELECT,
      orderBy: [{ createdAt: "asc" }],
    });
    // Own pools first, then shared ones.
    const ordered = [
      ...pools.filter((pool) => pool.userId === userId),
      ...pools.filter((pool) => pool.userId !== userId),
    ];
    return {
      baseUrl: `${env.BETTER_AUTH_URL.replace(/\/+$/, "")}/v1`,
      models: ordered.flatMap((pool) => {
        const you = pool.userId === userId;
        const local = poolStatus(pool.Members);
        const hasCloud = pool.Members.some(
          (member) => member.kind === "CLOUD" && member.state === "ACTIVE",
        );
        return callableIdsFor({
          ownerSlug: pool.User.slug,
          poolSlug: pool.slug,
          mode: pool.Fallback?.mode ?? "OFF",
          callerIsOwner: you,
        }).map((callableId) => {
          const external = callableId.endsWith(":external");
          return {
            callableId,
            poolId: pool.id,
            external,
            type: pool.modelType,
            owner: { slug: pool.User.slug, you, email: you ? null : pool.User.email },
            status: external && hasCloud && local === "unavailable" ? ("serving" as const) : local,
          };
        });
      }),
    };
  }),
  // TODO(server): sending a test needs the relay's admission path (a ContextServices hook).
  test: stub(c.test),
};
