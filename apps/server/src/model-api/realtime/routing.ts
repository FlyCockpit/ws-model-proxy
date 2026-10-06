import {
  listVisibleModelTargetsForUser,
  listVisibleModelTargetsWithExternalPermissionForToken,
  type VisibleDirectModelTarget,
  type VisibleModelPoolTarget,
} from "@ws-model-proxy/api/lib/model-api-token-access";
import {
  buildPoolRouteSequence,
  isPublishedEndpointExecutable,
  type PoolMemberRouteRow,
  recordPoolMemberRelayFailure,
  type SmoothWeightedRoundRobinState,
} from "@ws-model-proxy/api/lib/model-pool-routing";
import {
  type OpenAiCompatibleCapabilities,
  parseOpenAiCompatibleCapabilities,
  resolveEffectiveCapabilityMetadata,
} from "@ws-model-proxy/api/lib/openai-compatible-capabilities";
import prisma, { type Prisma } from "@ws-model-proxy/db";
import { userCredentialAccessBlocked } from "@ws-model-proxy/db/user-deletion-access";
import type { RelayFailure } from "../../relay/relay-failure.js";
import type { SttConfig } from "../../relay/stt-protocol.js";
import { realtimeTranscriptionCapability } from "../../relay/stt-relay.js";
import { resolveRequestedModelName } from "../external-route.js";
import { recheckRealtimePermission } from "./authorize.js";
import { checkDashboardSession } from "./dashboard-session.js";
import type { RealtimeCredentialRef, RealtimeTargetAccess } from "./requester.js";
import type {
  RealtimeCandidate,
  RealtimeRouteResult,
  RealtimeRouter,
} from "./transcription-session.js";

/**
 * Routing for live transcription (design §3): the token's visible targets,
 * then live-capable members, read from the database.
 *
 * A member is eligible only when all of these hold:
 * - its endpoint is **recipe-managed per the database**: the endpoint row
 *   links a deployment instance of the same owner and slug, whose rank-0 node
 *   on the endpoint's CLI holds its claim, desired and observed RUNNING (the
 *   same ownership rule registration applies). The slug is never trusted;
 * - the CLI-advertised endpoint capabilities and the effective (override
 *   aware) capabilities both carry `audio.transcriptions.realtime` with
 *   `supported: true` and the same adapter;
 * - model, endpoint and CLI are published, online and connected here; the
 *   member is ACTIVE, OPEN, HEALTHY, its contribution (if any) is active and
 *   its engine owner may use credentials;
 * - a vLLM adapter only when no language or prompt is set.
 *
 * Pools are ordered by the HTTP path's weighted round robin and health.
 * Unknown and forbidden models are both `model_not_found`.
 */

const endpointSelect = {
  id: true,
  userId: true,
  slug: true,
  published: true,
  cliDeviceId: true,
  status: true,
  capabilityMetadata: true,
  CliDevice: { select: { status: true } },
  DeploymentInstance: {
    select: {
      userId: true,
      endpointSlug: true,
      desiredState: true,
      observedState: true,
      Nodes: { where: { rank: 0, claimHeld: true }, select: { cliDeviceId: true } },
    },
  },
} satisfies Prisma.EndpointSelect;

const modelSelect = {
  id: true,
  userId: true,
  published: true,
  upstreamModelId: true,
  capabilityOverrideMode: true,
  capabilityOverrideMetadata: true,
  User: { select: { banned: true, banExpires: true, deletionRequestedAt: true } },
  Endpoint: { select: endpointSelect },
  ExecutionTarget: { select: { id: true, inferenceCapacityId: true } },
} satisfies Prisma.DiscoveredModelSelect;

const memberSelect = {
  id: true,
  poolId: true,
  weight: true,
  healthStatus: true,
  routingStatus: true,
  instanceGate: true,
  lastFailureClass: true,
  consecutiveRetryableFailures: true,
  lastFailureAt: true,
  nextRetryAt: true,
  halfOpenTrialStartedAt: true,
  inferenceContributionId: true,
  InferenceContribution: {
    select: { state: true, poolId: true, discoveredModelId: true, contributorUserId: true },
  },
  ModelPool: { select: { userId: true } },
  ExecutionTarget: {
    select: { id: true, inferenceCapacityId: true, DiscoveredModel: { select: modelSelect } },
  },
} satisfies Prisma.PoolMemberSelect;

type ModelRow = Prisma.DiscoveredModelGetPayload<{ select: typeof modelSelect }>;
type MemberRow = Prisma.PoolMemberGetPayload<{ select: typeof memberSelect }>;

/** The recipe-managed ownership rule, on database rows only. */
export function endpointIsRecipeManaged(endpoint: ModelRow["Endpoint"]): boolean {
  const instance = endpoint.DeploymentInstance;
  return (
    instance !== null &&
    instance.userId === endpoint.userId &&
    instance.endpointSlug === endpoint.slug &&
    instance.desiredState === "RUNNING" &&
    instance.observedState === "RUNNING" &&
    instance.Nodes.some((node) => node.cliDeviceId === endpoint.cliDeviceId)
  );
}

/**
 * The capabilities a live session is routed by: the CLI's own advertisement
 * (what `stt.open` is checked against), only when the effective capabilities
 * agree that the model takes live sessions with the same adapter.
 */
export function liveCapabilities(model: ModelRow): OpenAiCompatibleCapabilities | null {
  const advertised = parseOpenAiCompatibleCapabilities(model.Endpoint.capabilityMetadata);
  const effective = resolveEffectiveCapabilityMetadata({
    capabilityOverrideMode: model.capabilityOverrideMode,
    capabilityOverrideMetadata: model.capabilityOverrideMetadata,
    endpointCapabilityMetadata: model.Endpoint.capabilityMetadata,
  });
  const live = realtimeTranscriptionCapability(advertised);
  const allowed = realtimeTranscriptionCapability(effective);
  if (!live || !allowed || live.adapter !== allowed.adapter) return null;
  return advertised;
}

function configNeedsOptions(config: SttConfig): boolean {
  return config.language !== undefined || config.prompt !== undefined;
}

/** Static eligibility of one model row (no health, no connection). */
function modelEligible(
  model: ModelRow,
  config: SttConfig,
  now: Date,
): OpenAiCompatibleCapabilities | null {
  if (!endpointIsRecipeManaged(model.Endpoint)) return null;
  if (model.User && userCredentialAccessBlocked(model.User, now)) return null;
  const capabilities = liveCapabilities(model);
  if (!capabilities) return null;
  const live = realtimeTranscriptionCapability(capabilities);
  if (live?.adapter === "vllm" && configNeedsOptions(config)) return null;
  return capabilities;
}

function memberContributionValid(row: MemberRow, model: ModelRow, poolId: string): boolean {
  const contribution = row.InferenceContribution;
  if (
    row.inferenceContributionId &&
    (contribution?.state !== "ACTIVE" ||
      contribution.poolId !== poolId ||
      contribution.discoveredModelId !== model.id ||
      contribution.contributorUserId !== model.userId)
  ) {
    return false;
  }
  return !(
    row.ModelPool?.userId &&
    model.userId !== row.ModelPool.userId &&
    !row.inferenceContributionId
  );
}

function candidateFor(
  model: ModelRow,
  capabilities: OpenAiCompatibleCapabilities,
  route: NonNullable<RealtimeCandidate["route"]>,
): RealtimeCandidate {
  return {
    cliDeviceId: model.Endpoint.cliDeviceId,
    endpointSlug: model.Endpoint.slug,
    upstreamModel: model.upstreamModelId,
    capabilities,
    // From the deployment ownership rows above, never from the slug.
    deploymentManaged: true,
    memberId: route.poolMemberId,
    route,
  };
}

async function poolMembers(poolId: string): Promise<MemberRow[]> {
  return prisma.poolMember.findMany({
    where: {
      poolId,
      tier: "PRIMARY",
      instanceGate: "OPEN",
      ExecutionTarget: { DiscoveredModel: { isNot: null } },
    },
    orderBy: { id: "asc" },
    select: memberSelect,
  });
}

/** Round-robin state per pool, bounded. */
const ROUND_ROBIN_POOLS_MAX = 1024;
const roundRobin = new Map<string, SmoothWeightedRoundRobinState>();

function rememberRoundRobin(poolId: string, state: SmoothWeightedRoundRobinState) {
  roundRobin.delete(poolId);
  roundRobin.set(poolId, state);
  if (roundRobin.size > ROUND_ROBIN_POOLS_MAX) {
    const oldest = roundRobin.keys().next().value;
    if (oldest !== undefined) roundRobin.delete(oldest);
  }
}

export async function poolCandidates({
  pool,
  config,
  activeCliDeviceIds,
  now = new Date(),
}: {
  pool: Pick<VisibleModelPoolTarget, "id" | "ownerUserId" | "accessGrantId">;
  config: SttConfig;
  activeCliDeviceIds: readonly string[];
  now?: Date;
}): Promise<RealtimeCandidate[]> {
  const rows = await poolMembers(pool.id);
  const eligible = new Map<
    string,
    { row: MemberRow; model: ModelRow; capabilities: OpenAiCompatibleCapabilities }
  >();
  const routeRows: PoolMemberRouteRow[] = [];
  for (const row of rows) {
    const model = row.ExecutionTarget?.DiscoveredModel;
    if (!model || !memberContributionValid(row, model, pool.id)) continue;
    const capabilities = modelEligible(model, config, now);
    if (!capabilities) continue;
    eligible.set(row.id, { row, model, capabilities });
    routeRows.push({
      id: row.id,
      poolId: row.poolId,
      discoveredModelId: model.id,
      weight: row.weight,
      healthStatus: row.healthStatus,
      routingStatus: row.routingStatus,
      lastFailureClass: row.lastFailureClass,
      consecutiveRetryableFailures: row.consecutiveRetryableFailures,
      lastFailureAt: row.lastFailureAt,
      nextRetryAt: row.nextRetryAt,
      halfOpenTrialStartedAt: row.halfOpenTrialStartedAt,
      DiscoveredModel: {
        published: model.published,
        upstreamModelId: model.upstreamModelId,
        Endpoint: {
          id: model.Endpoint.id,
          slug: model.Endpoint.slug,
          published: model.Endpoint.published,
          cliDeviceId: model.Endpoint.cliDeviceId,
          status: model.Endpoint.status,
          CliDevice: model.Endpoint.CliDevice,
        },
      },
    });
  }
  if (routeRows.length === 0) return [];
  const sequence = buildPoolRouteSequence({
    members: routeRows,
    activeCliDeviceIds,
    now,
    state: roundRobin.get(pool.id) ?? {},
  });
  if (!sequence.ok) return [];
  rememberRoundRobin(pool.id, sequence.state);
  const candidates: RealtimeCandidate[] = [];
  for (const route of sequence.candidates) {
    // A half-open member's single trial belongs to the HTTP path's claim
    // protocol; a 30-minute live session never takes it.
    if (route.healthStatus !== "HEALTHY") continue;
    const entry = eligible.get(route.poolMemberId);
    if (!entry) continue;
    candidates.push(
      candidateFor(entry.model, entry.capabilities, {
        kind: "pool",
        poolId: pool.id,
        poolMemberId: route.poolMemberId,
        discoveredModelId: entry.model.id,
        endpointId: entry.model.Endpoint.id,
        executionTargetId: entry.row.ExecutionTarget?.id ?? null,
        capacityId: entry.row.ExecutionTarget?.inferenceCapacityId ?? null,
        ownerUserId: pool.ownerUserId,
        engineOwnerUserId: entry.model.userId,
        accessGrantId: pool.accessGrantId,
        contributionId: entry.row.inferenceContributionId,
      }),
    );
  }
  return candidates;
}

export async function directCandidates({
  target,
  config,
  activeCliDeviceIds,
  now = new Date(),
}: {
  target: Pick<VisibleDirectModelTarget, "id">;
  config: SttConfig;
  activeCliDeviceIds: readonly string[];
  now?: Date;
}): Promise<RealtimeCandidate[]> {
  const model = await prisma.discoveredModel.findUnique({
    where: { id: target.id },
    select: modelSelect,
  });
  if (!model) return [];
  const capabilities = modelEligible(model, config, now);
  if (!capabilities) return [];
  if (
    !isPublishedEndpointExecutable({
      modelPublished: model.published,
      endpointPublished: model.Endpoint.published,
      endpointStatus: model.Endpoint.status,
      cliDeviceId: model.Endpoint.cliDeviceId,
      cliDeviceStatus: model.Endpoint.CliDevice?.status,
      activeCliDeviceIds: new Set(activeCliDeviceIds),
    })
  ) {
    return [];
  }
  return [
    candidateFor(model, capabilities, {
      kind: "direct",
      poolId: null,
      poolMemberId: null,
      discoveredModelId: model.id,
      endpointId: model.Endpoint.id,
      executionTargetId: model.ExecutionTarget?.id ?? null,
      capacityId: model.ExecutionTarget?.inferenceCapacityId ?? null,
      ownerUserId: model.userId,
      engineOwnerUserId: model.userId,
      accessGrantId: null,
      contributionId: null,
    }),
  ];
}

/** Which visible target a model name names, for routing and rechecks. */
export type RealtimeResolvedTarget =
  | { kind: "pool"; target: VisibleModelPoolTarget }
  | { kind: "direct"; target: VisibleDirectModelTarget };

export async function resolveRealtimeModel(
  access: RealtimeTargetAccess,
  model: string,
): Promise<RealtimeResolvedTarget | { error: "model_not_found" | "external_variant_unsupported" }> {
  // A token sees its allowlist; Chat Test sees every model the user can see,
  // as HTTP Chat Test does.
  const targets =
    access.kind === "token"
      ? (await listVisibleModelTargetsWithExternalPermissionForToken(access.token)).targets
      : await listVisibleModelTargetsForUser(access.userId);
  const resolution = resolveRequestedModelName(targets, model);
  if (resolution.kind === "not_found" || resolution.kind === "error") {
    return { error: "model_not_found" };
  }
  if (resolution.kind === "pool") {
    // Live audio stays local (design D4): `:external` is refused for every caller.
    if (resolution.externalRequested) return { error: "external_variant_unsupported" };
    return { kind: "pool", target: resolution.target };
  }
  return { kind: "direct", target: resolution.target };
}

/** The production router for one session. */
export function createRealtimeRouter({
  access,
  activeCliDeviceIds,
  onResolved,
}: {
  access: RealtimeTargetAccess;
  activeCliDeviceIds: () => readonly string[];
  /** The target the model resolved to (for the access rechecks). */
  onResolved?: (resolved: RealtimeResolvedTarget, model: string) => void;
}): RealtimeRouter {
  return {
    async candidates({ model, config }): Promise<RealtimeRouteResult> {
      const resolved = await resolveRealtimeModel(access, model);
      if ("error" in resolved) return { ok: false, code: resolved.error };
      onResolved?.(resolved, model);
      const candidates =
        resolved.kind === "pool"
          ? await poolCandidates({
              pool: resolved.target,
              config,
              activeCliDeviceIds: activeCliDeviceIds(),
            })
          : await directCandidates({
              target: resolved.target,
              config,
              activeCliDeviceIds: activeCliDeviceIds(),
            });
      if (candidates.length === 0) return { ok: false, code: "no_live_member" };
      return { ok: true, candidates };
    },
    memberMisconfigured(candidate: RealtimeCandidate, failure: RelayFailure) {
      // A recipe that claims live transcription its engine does not serve:
      // reported for the operator, never written to the shared member health.
      console.warn("[realtime] member refused live sessions (configuration)", {
        poolMemberId: candidate.route?.poolMemberId ?? null,
        endpointSlug: candidate.endpointSlug,
        failure,
      });
    },
    memberOpenFailed(candidate: RealtimeCandidate, failure: RelayFailure) {
      const poolMemberId = candidate.route?.poolMemberId;
      if (!poolMemberId) return;
      void recordPoolMemberRelayFailure({ poolMemberId, failure, trialStartedAt: null }).catch(
        (error: unknown) => {
          console.error(
            "[realtime] member health write failed",
            error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error,
          );
        },
      );
    },
  };
}

export type RealtimeAccessVerdict =
  | { ok: true }
  | { ok: false; reason: "credential" | "model" | "member" };

/**
 * The 60 s recheck of an open (or routing) session (release decision 6):
 * the token is still valid and its owner may use credentials (for Chat Test:
 * the dashboard session still exists for an unblocked, 2FA-compliant user,
 * {@link checkDashboardSession}); the model
 * still resolves to the same target with the same access; and the member the
 * session opened on is still a recipe-managed, live-capable, published
 * member of it. Health is not rechecked: a degraded member keeps its session.
 * A missing row is a denial; a read that throws propagates (the registry
 * skips that sweep, as the terminal rechecks do).
 */
export async function recheckRealtimeAccess({
  credential,
  userId,
  model,
  resolved,
  candidate,
  config,
  now = new Date(),
  permission = recheckRealtimePermission,
  dashboardSession = checkDashboardSession,
}: {
  credential: RealtimeCredentialRef;
  /** The session's user (a token's own user is read from its row). */
  userId: string;
  model: string | null;
  resolved: RealtimeResolvedTarget | null;
  candidate: RealtimeCandidate | null;
  config: SttConfig;
  now?: Date;
  /** The HTTP send claim's permission check, without a send (review 6b M1). */
  permission?: typeof recheckRealtimePermission;
  dashboardSession?: typeof checkDashboardSession;
}): Promise<RealtimeAccessVerdict> {
  const requester = await recheckCredential(credential, userId, now, dashboardSession);
  if (!requester) return { ok: false, reason: "credential" };
  if (!model || !resolved) return { ok: true };
  const current = await resolveRealtimeModel(requester.access, model);
  if (
    "error" in current ||
    current.kind !== resolved.kind ||
    current.target.id !== resolved.target.id ||
    (current.kind === "pool" &&
      resolved.kind === "pool" &&
      (current.target.accessGrantId !== resolved.target.accessGrantId ||
        current.target.ownerUserId !== resolved.target.ownerUserId))
  ) {
    return { ok: false, reason: "model" };
  }
  const route = candidate?.route;
  if (!candidate || !route) return { ok: true };
  if (route.kind === "pool" && route.poolMemberId && route.poolId) {
    const row = await prisma.poolMember.findFirst({
      where: {
        id: route.poolMemberId,
        poolId: route.poolId,
        tier: "PRIMARY",
        instanceGate: "OPEN",
      },
      select: memberSelect,
    });
    const model_ = row?.ExecutionTarget?.DiscoveredModel;
    if (
      !row ||
      !model_ ||
      row.routingStatus === "DISABLED" ||
      model_.id !== route.discoveredModelId ||
      !memberContributionValid(row, model_, route.poolId) ||
      !memberStillServes(model_, candidate, config, now)
    ) {
      return { ok: false, reason: "member" };
    }
  } else {
    const direct = await prisma.discoveredModel.findUnique({
      where: { id: route.discoveredModelId },
      select: modelSelect,
    });
    if (!direct || !memberStillServes(direct, candidate, config, now)) {
      return { ok: false, reason: "member" };
    }
  }
  // The same locked permission check an HTTP send takes: CLI device of the
  // model owner and connected, the token's allowlist entry for this exact
  // target (none for Chat Test), the grant row, every user active.
  const denied = await permission(
    { tokenId: requester.tokenId, userId: requester.userId },
    candidate,
  );
  if (denied === "requester") return { ok: false, reason: "credential" };
  if (denied === "access") return { ok: false, reason: "model" };
  if (denied === "member") return { ok: false, reason: "member" };
  return { ok: true };
}

/** The credential's current state; null when it no longer authorizes the session. */
async function recheckCredential(
  credential: RealtimeCredentialRef,
  userId: string,
  now: Date,
  dashboardSession: typeof checkDashboardSession,
): Promise<{ userId: string; tokenId: string | null; access: RealtimeTargetAccess } | null> {
  if (credential.kind === "dashboard") {
    const verdict = await dashboardSession({ sessionId: credential.sessionId, userId, now });
    if (verdict !== "ok") return null;
    return { userId, tokenId: null, access: { kind: "dashboard", userId } };
  }
  const token = await prisma.modelApiToken.findUnique({
    where: { id: credential.tokenId },
    select: {
      id: true,
      userId: true,
      scopeMode: true,
      allowExternal: true,
      revokedAt: true,
      expiresAt: true,
      User: { select: { banned: true, banExpires: true, deletionRequestedAt: true } },
    },
  });
  if (
    !token ||
    token.revokedAt ||
    (token.expiresAt && token.expiresAt <= now) ||
    !token.User ||
    userCredentialAccessBlocked(token.User, now)
  ) {
    return null;
  }
  return {
    userId: token.userId,
    tokenId: token.id,
    access: {
      kind: "token",
      token: {
        id: token.id,
        userId: token.userId,
        scopeMode: token.scopeMode,
        allowExternal: token.allowExternal === true,
      },
    },
  };
}

function memberStillServes(
  model: ModelRow,
  candidate: RealtimeCandidate,
  config: SttConfig,
  now: Date,
): boolean {
  return (
    model.published &&
    model.Endpoint.published &&
    model.Endpoint.slug === candidate.endpointSlug &&
    model.Endpoint.cliDeviceId === candidate.cliDeviceId &&
    modelEligible(model, config, now) !== null
  );
}
