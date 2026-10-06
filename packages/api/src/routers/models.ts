import { ORPCError } from "@orpc/server";
import prisma from "@ws-model-proxy/db";
import { env } from "@ws-model-proxy/env/server";
import type { ModelTestKind, ModelTestServiceTarget } from "../context";
import { contractProcedure } from "../contract-procedure";
import { type AnonymousAuth, agentRulesApply, type CallerAuth } from "../contracts/auth-context";
import type { MODEL_TYPE } from "../contracts/common";
import { modelsContract as c } from "../contracts/models";
import { cloudEgressEnabled } from "../lib/cloud-egress";
import { callableIdsFor, MEMBER_INCLUDE, poolStatus } from "../lib/pool-views";
import { notFound, refuse } from "../lib/refuse";

const POOL_SELECT = {
  id: true,
  slug: true,
  userId: true,
  modelType: true,
  User: { select: { slug: true, email: true } },
  Fallback: { select: { mode: true } },
  Routing: { select: { ownHardwareOnly: true } },
  Members: { include: MEMBER_INCLUDE },
} as const;

export const modelsRouter = {
  /**
   * Every callable ID the person may use: own pools and pools shared with them with can use.
   * Served models (direct `runtime:<id>:<model>`) are web-test only and never listed here.
   */
  list: contractProcedure(c.list).handler(async ({ context }) => {
    const userId = context.session.user.id;
    const cloudEnabled = cloudEgressEnabled();
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
        const local = poolStatus(pool.Members, pool.Routing?.ownHardwareOnly ?? false);
        const hasCloud = pool.Members.some(
          (member) => member.kind === "CLOUD" && member.state === "ACTIVE",
        );
        return callableIdsFor({
          ownerSlug: pool.User.slug,
          poolSlug: pool.slug,
          mode: pool.Fallback?.mode ?? "OFF",
          callerIsOwner: you,
          cloudEnabled,
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
  /**
   * Send a test (or a bench) to a callable ID or one of the caller's runtimes. This procedure
   * checks the caller and the target; `services.modelTest` (apps/server) sends it through the
   * production admission and routing path as source `AGENT_TEST`.
   */
  test: contractProcedure(c.test).handler(async ({ input, context, signal }) => {
    const auth = context.auth;
    assertMayTest(auth);
    const run = context.services?.modelTest;
    if (!run) {
      throw new ORPCError("SERVICE_UNAVAILABLE", {
        message: "Model tests are not available on this server yet.",
      });
    }
    if ("pool" in input.target && input.target.pool.endsWith(EXTERNAL_SUFFIX)) {
      // Cloud egress needs the caller's consent, which a test has no channel for.
      throw new ORPCError("BAD_REQUEST", {
        message: `:external cannot be tested; test ${input.target.pool.slice(0, -EXTERNAL_SUFFIX.length)} instead.`,
      });
    }
    if (
      input.bench &&
      input.bench.repeat * (input.bench.promptTokens ?? 0) > MODEL_TEST_BENCH_PROMPT_TOKENS_MAX
    ) {
      throw new ORPCError("BAD_REQUEST", {
        message: `A bench sends at most ${MODEL_TEST_BENCH_PROMPT_TOKENS_MAX.toLocaleString("en-US")} prompt tokens in all (repeat × promptTokens).`,
      });
    }
    const userId = context.session.user.id;
    const resolved =
      "pool" in input.target
        ? await resolvePoolTarget(userId, input.target.pool)
        : await resolveRuntimeTarget(userId, input.target);
    if (input.bench && !resolved.ownedByCaller) {
      throw refuse(
        "own_hardware_only",
        "Benches run only on your own pools and runtimes; send a single test to a shared pool.",
        "FORBIDDEN",
      );
    }
    const kind = input.kind ?? KIND_FOR_TYPE[resolved.modelType];
    if (KIND_FOR_TYPE[resolved.modelType] !== kind) {
      throw refuse(
        "model_type_mismatch",
        `This target serves ${resolved.modelType} models; test it with kind "${KIND_FOR_TYPE[resolved.modelType]}".`,
      );
    }
    const signals = [signal, context.services?.signal].filter(
      (entry): entry is AbortSignal => entry !== undefined,
    );
    return run({
      userId,
      auth,
      target: resolved.target,
      kind,
      ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
      ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
      ...(input.bench !== undefined ? { bench: input.bench } : {}),
      ...(signals.length > 0 ? { signal: AbortSignal.any(signals) } : {}),
    });
  }),
};

const KIND_FOR_TYPE: Record<(typeof MODEL_TYPE)[number], ModelTestKind> = {
  LLM: "chat",
  EMBEDDINGS: "embeddings",
  TRANSCRIPTION: "transcription",
};

const EXTERNAL_SUFFIX = ":external";
/** Most prompt tokens one bench may send in all (repeat × promptTokens). */
export const MODEL_TEST_BENCH_PROMPT_TOKENS_MAX = 1_000_000;

type ResolvedTarget = {
  target: ModelTestServiceTarget;
  modelType: (typeof MODEL_TYPE)[number];
  /** The caller owns the pool or runtime (a can-use share is not ownership). */
  ownedByCaller: boolean;
};

/**
 * A test sends real requests to someone's hardware (or spends cloud credit), so it is a write:
 * a browser call must carry the verified CSRF header (a cookie without it is not a person,
 * `agentRulesApply`) and agents need a Full token (MCP lists `model_test` as a Full tool).
 */
function assertMayTest(auth: CallerAuth | AnonymousAuth): asserts auth is CallerAuth {
  if (auth.kind === "anonymous" || auth.kind === "api_key") {
    throw new ORPCError("UNAUTHORIZED", { message: "Sign in to send a model test." });
  }
  if (agentRulesApply(auth) && auth.kind === "cookie_session") {
    throw new ORPCError("FORBIDDEN", { message: "This request is missing its CSRF header." });
  }
  if (
    (auth.kind === "agent_token" || auth.kind === "oauth_access_token") &&
    auth.level !== "FULL"
  ) {
    throw new ORPCError("FORBIDDEN", { message: "This needs a Full agent token." });
  }
}

/** A pool the caller owns or holds a can-use share of, by callable ID (never `:external`). */
async function resolvePoolTarget(userId: string, callableId: string): Promise<ResolvedTarget> {
  const [ownerSlug, poolSlug] = callableId.split("/");
  const missing = notFound(`No pool you can use is called ${callableId}.`);
  if (!ownerSlug || !poolSlug) throw missing;
  const pool = await prisma.pool.findFirst({
    where: {
      slug: poolSlug,
      User: { slug: ownerSlug },
      OR: [{ userId }, { Shares: { some: { granteeUserId: userId, canUse: true } } }],
    },
    select: { id: true, userId: true, modelType: true },
  });
  if (!pool) throw missing;
  return {
    target: { kind: "pool", poolId: pool.id, callableId },
    modelType: pool.modelType,
    ownedByCaller: pool.userId === userId,
  };
}

/** One of the caller's runtimes, its served model (default the first) and optional instance. */
async function resolveRuntimeTarget(
  userId: string,
  target: { runtimeId: string; model?: string; instanceId?: string },
): Promise<ResolvedTarget> {
  const runtime = await prisma.runtime.findFirst({
    where: { id: target.runtimeId, userId },
    select: { id: true },
  });
  if (!runtime) throw notFound("No runtime of yours has this id.");
  const model = await prisma.runtimeModel.findFirst({
    where: {
      runtimeId: runtime.id,
      userId,
      retired: false,
      ...(target.model !== undefined ? { upstreamModelId: target.model } : {}),
    },
    select: { id: true, upstreamModelId: true, type: true },
    orderBy: [{ createdAt: "asc" }, { upstreamModelId: "asc" }],
  });
  if (!model) {
    throw notFound(
      target.model !== undefined
        ? "This runtime does not serve that model."
        : "This runtime does not serve a model yet; start it first.",
    );
  }
  let instanceId: string | null = null;
  if (target.instanceId !== undefined) {
    const instance = await prisma.runtimeInstance.findFirst({
      where: { id: target.instanceId, runtimeId: runtime.id, userId },
      select: { id: true },
    });
    if (!instance) throw notFound("This runtime has no instance with this id.");
    instanceId = instance.id;
  }
  return {
    target: {
      kind: "runtime",
      runtimeId: runtime.id,
      runtimeModelId: model.id,
      model: model.upstreamModelId,
      instanceId,
    },
    modelType: model.type,
    ownedByCaller: true,
  };
}
