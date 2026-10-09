import { ORPCError } from "@orpc/server";
import { POOL_ADVANCED_OVERRIDES } from "@ws-model-proxy/config/pool-defaults";
import prisma from "@ws-model-proxy/db";
import { env } from "@ws-model-proxy/env/server";
import type { ModelTestKind, ModelTestServiceTarget } from "../context";
import { contractProcedure } from "../contract-procedure";
import { type AnonymousAuth, agentRulesApply, type CallerAuth } from "../contracts/auth-context";
import type { MODEL_CAPABILITY, MODEL_TYPE } from "../contracts/common";
import { modelsContract as c, type TEST_SURFACES } from "../contracts/models";
import { callableIdOf } from "../lib/access-views";
import { cloudEgressEnabled } from "../lib/cloud-egress";
import { type SessionNames, sessionNames } from "../lib/model-names";
import { callableIdsFor, MEMBER_INCLUDE, poolStatus } from "../lib/pool-views";
import { notFound, refuse } from "../lib/refuse";
import { transcriptionProfileSchema } from "../lib/transcription-profile";

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

/** POOL_SELECT plus what the Test page needs: advanced overrides and member capabilities. */
const TEST_POOL_SELECT = {
  ...POOL_SELECT,
  Advanced: { select: { overrides: true } },
  Members: {
    include: {
      ...MEMBER_INCLUDE,
      RuntimeModel: {
        select: {
          ...MEMBER_INCLUDE.RuntimeModel.select,
          type: true,
          detectedCapabilities: true,
          capabilities: true,
          capabilitiesOverridden: true,
          transcriptionProfile: true,
        },
      },
    },
  },
} as const;

/** Own pools and pools shared with the caller with can use. */
function usablePoolsWhere(userId: string) {
  return { OR: [{ userId }, { Shares: { some: { granteeUserId: userId, canUse: true } } }] };
}

/** Own pools first, then shared ones. */
function ownFirst<T extends { userId: string }>(pools: T[], userId: string): T[] {
  return [
    ...pools.filter((pool) => pool.userId === userId),
    ...pools.filter((pool) => pool.userId !== userId),
  ];
}

/**
 * Per-pool entries in `pools` order, where a callable ID an alias of the person hides becomes that
 * name's entry for the pool the alias reaches (the alias wins, as on the request path), or
 * nothing when no alias of theirs for every key reaches a pool they may use. `entries(pool)[0]`
 * is the plain callable ID's entry.
 */
function withAliasesWinning<P extends { id: string; slug: string; User: { slug: string } }, E>(
  pools: readonly P[],
  names: SessionNames,
  entries: (pool: P) => E[],
  rename: (entry: E, name: string) => E,
): E[] {
  const byId = new Map(pools.map((pool) => [pool.id, pool]));
  return pools.flatMap((pool) => {
    const name = callableIdOf(pool.User.slug, pool.slug);
    if (!names.hides(name, pool.id)) return entries(pool);
    const target = byId.get(names.aliasPool(name) ?? "");
    const plain = target ? entries(target)[0] : undefined;
    return plain ? [rename(plain, name)] : [];
  });
}

export const modelsRouter = {
  /**
   * Every callable ID the person may use: own pools and pools shared with them with can use.
   * Served models (direct `runtime:<id>:<model>`) are web-test only and never listed here.
   */
  list: contractProcedure(c.list).handler(async ({ context }) => {
    const userId = context.session.user.id;
    const cloudEnabled = cloudEgressEnabled();
    const [pools, names] = await Promise.all([
      prisma.pool.findMany({
        where: usablePoolsWhere(userId),
        select: POOL_SELECT,
        orderBy: [{ createdAt: "asc" }],
      }),
      sessionNames(prisma, userId),
    ]);
    return {
      baseUrl: `${env.BETTER_AUTH_URL.replace(/\/+$/, "")}/v1`,
      models: withAliasesWinning(
        ownFirst(pools, userId),
        names,
        (pool) => {
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
              status:
                external && hasCloud && local === "unavailable" ? ("serving" as const) : local,
            };
          });
        },
        (entry, name) => ({ ...entry, callableId: name }),
      ),
    };
  }),
  /**
   * The web Test page's targets: every callable ID (as `models.list`) and the caller's own
   * runtimes' served models, with what each can do. Capabilities are hints for the page; the
   * request path decides.
   */
  testTargets: contractProcedure(c.testTargets).handler(async ({ context }) => {
    const userId = context.session.user.id;
    const cloudEnabled = cloudEgressEnabled();
    const [pools, runtimes, names] = await Promise.all([
      prisma.pool
        .findMany({
          where: usablePoolsWhere(userId),
          select: TEST_POOL_SELECT,
          orderBy: [{ createdAt: "asc" }],
        })
        .then((rows) => ownFirst(rows, userId)),
      prisma.runtime.findMany({
        where: { userId },
        select: {
          id: true,
          name: true,
          Models: {
            where: { retired: false },
            select: {
              upstreamModelId: true,
              type: true,
              detectedCapabilities: true,
              capabilities: true,
              capabilitiesOverridden: true,
              transcriptionProfile: true,
            },
            orderBy: [{ upstreamModelId: "asc" }],
          },
          Instances: {
            where: { OR: [{ desiredState: "RUNNING" }, { desiredState: null }] },
            select: { phase: true },
          },
        },
        orderBy: [{ createdAt: "asc" }],
      }),
      sessionNames(prisma, userId),
    ]);
    // The Test page sends the name: one an alias of the person hides reaches the alias's pool.
    const poolTargets = withAliasesWinning(
      pools,
      names,
      (pool) => {
        const you = pool.userId === userId;
        const local = poolStatus(pool.Members, pool.Routing?.ownHardwareOnly ?? false);
        const hasCloud = pool.Members.some(
          (member) => member.kind === "CLOUD" && member.state === "ACTIVE",
        );
        const localModels = pool.Members.flatMap((member) =>
          member.kind === "LOCAL" &&
          member.state === "ACTIVE" &&
          member.RuntimeModel &&
          !member.RuntimeModel.retired &&
          !(pool.Routing?.ownHardwareOnly && member.shareId)
            ? [member.RuntimeModel]
            : [],
        );
        const capabilities = unionCapabilities(localModels.map(effectiveCapabilities));
        const overrides = advancedOverrides(pool.Advanced?.overrides);
        const adaptation =
          typeof overrides.protocolAdaptation === "boolean"
            ? overrides.protocolAdaptation
            : POOL_ADVANCED_OVERRIDES.protocolAdaptation.auto.default;
        const surfaces = testSurfaces(pool.modelType, capabilities, adaptation);
        const live =
          pool.modelType === "TRANSCRIPTION" &&
          localModels.some((model) => declaresLiveTranscription(model.transcriptionProfile));
        return callableIdsFor({
          ownerSlug: pool.User.slug,
          poolSlug: pool.slug,
          mode: pool.Fallback?.mode ?? "OFF",
          callerIsOwner: you,
          cloudEnabled,
        }).map((callableId) => {
          const external = callableId.endsWith(":external");
          return {
            model: callableId,
            source: "pool" as const,
            label: callableId,
            servedModel: null,
            runtimeId: null,
            type: pool.modelType,
            status: external && hasCloud && local === "unavailable" ? ("serving" as const) : local,
            external,
            capabilities,
            surfaces,
            recommendedSurface: recommendedSurface(surfaces, overrides.recommendedSurface),
            // Live sessions run on local members only.
            liveTranscription: live && !external,
            maxAttachmentBytes:
              typeof overrides.maxAttachmentBytes === "number"
                ? overrides.maxAttachmentBytes
                : null,
          };
        });
      },
      (entry, name) => ({ ...entry, model: name, label: name }),
    );
    const runtimeTargets = runtimes.flatMap((runtime) => {
      const phases = runtime.Instances.map((instance) => instance.phase);
      // As a pool member's status (pool-views memberStatus).
      const status = phases.includes("READY")
        ? ("serving" as const)
        : phases.includes("STARTING")
          ? ("starting" as const)
          : ("unavailable" as const);
      return runtime.Models.map((model) => {
        const capabilities = effectiveCapabilities(model);
        // A direct test is never adapted: it answers the APIs its engine serves.
        const surfaces = testSurfaces(model.type, capabilities, false);
        return {
          model: `runtime:${runtime.id}:${model.upstreamModelId}`,
          source: "runtime" as const,
          label: runtime.name,
          servedModel: model.upstreamModelId,
          runtimeId: runtime.id,
          type: model.type,
          status,
          external: false,
          capabilities,
          surfaces,
          recommendedSurface: recommendedSurface(surfaces, undefined),
          liveTranscription:
            model.type === "TRANSCRIPTION" && declaresLiveTranscription(model.transcriptionProfile),
          maxAttachmentBytes: null,
        };
      });
    });
    return { targets: [...poolTargets, ...runtimeTargets] };
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

type Capability = (typeof MODEL_CAPABILITY)[number];
type TestSurface = (typeof TEST_SURFACES)[number];

function effectiveCapabilities(model: {
  detectedCapabilities: Capability[];
  capabilities: Capability[];
  capabilitiesOverridden: boolean;
}): Capability[] {
  return model.capabilitiesOverridden ? model.capabilities : model.detectedCapabilities;
}

function unionCapabilities(lists: Capability[][]): Capability[] {
  return [...new Set(lists.flat())].sort();
}

function advancedOverrides(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Chat Completions always; Responses natively or adapted; Messages only adapted. */
function testSurfaces(
  type: (typeof MODEL_TYPE)[number],
  capabilities: readonly Capability[],
  adaptation: boolean,
): TestSurface[] {
  if (type !== "LLM") return [];
  return [
    "OPENAI_CHAT_COMPLETIONS",
    ...(adaptation || capabilities.includes("RESPONSES_API")
      ? (["OPENAI_RESPONSES"] as const)
      : []),
    ...(adaptation ? (["ANTHROPIC_MESSAGES"] as const) : []),
  ];
}

const SURFACE_OVERRIDE: Record<string, TestSurface> = {
  openai_chat_completions: "OPENAI_CHAT_COMPLETIONS",
  openai_responses: "OPENAI_RESPONSES",
  anthropic_messages: "ANTHROPIC_MESSAGES",
};

/** The pool's recommended surface when it can answer it, else the first one. */
function recommendedSurface(surfaces: TestSurface[], override: unknown): TestSurface | null {
  const preferred = typeof override === "string" ? SURFACE_OVERRIDE[override] : undefined;
  return preferred && surfaces.includes(preferred) ? preferred : (surfaces[0] ?? null);
}

function declaresLiveTranscription(profile: unknown): boolean {
  const parsed = transcriptionProfileSchema.safeParse(profile);
  return parsed.success && parsed.data.realtime !== undefined;
}

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
  // As the request path resolves the name: the person's alias for every key wins.
  const names = await sessionNames(prisma, userId);
  const aliasPool = names.aliasPool(callableId);
  const pool = await prisma.pool.findFirst({
    where: {
      ...(aliasPool ? { id: aliasPool } : { slug: poolSlug, User: { slug: ownerSlug } }),
      ...usablePoolsWhere(userId),
    },
    select: { id: true, userId: true, modelType: true },
  });
  if (!pool) throw missing;
  // Hidden by an alias the request path would not use here (another key's).
  if (!aliasPool && names.hides(callableId, pool.id)) throw missing;
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
