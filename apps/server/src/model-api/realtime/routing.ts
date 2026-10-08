import type { OpenAiCompatibleCapabilities } from "@ws-model-proxy/api/lib/openai-compatible-capabilities";
import {
  buildPoolRouteSequence,
  markTargetRelaySuccess,
  recordTargetRelayFailure,
  routeKey,
  type SmoothWeightedRoundRobinState,
} from "@ws-model-proxy/api/lib/pool-routing";
import prisma from "@ws-model-proxy/db";
import { userCredentialAccessBlocked } from "@ws-model-proxy/db/user-deletion-access";
import type { RelayFailure } from "../../relay/relay-failure.js";
import type { SttConfig } from "../../relay/stt-protocol.js";
import { realtimeTranscriptionCapability } from "../../relay/stt-relay.js";
import { resolveRequestedModelName } from "../external-route.js";
import {
  type ApiKeyIdentity,
  type CallablePool,
  listCallableTargetsForApiKey,
  listCallableTargetsForUser,
  type PoolRoute,
  poolRouteRow,
  poolRoutes,
  type RouteServedModel,
  type TestRoute,
  type TestTarget,
  testRoutes,
} from "../resolve.js";
import { servedModelCapabilities } from "../served-model-capabilities.js";
import { recheckRealtimePermission } from "./authorize.js";
import { checkDashboardSession } from "./dashboard-session.js";
import type { RealtimeCredentialRef, RealtimeTargetAccess } from "./requester.js";
import type {
  RealtimeCandidate,
  RealtimeRouteResult,
  RealtimeRouter,
} from "./transcription-session.js";

/**
 * Routing for live transcription (design §3): the caller's callable targets, then live-capable
 * routes, read from the database.
 *
 * A route (one served model on one runtime instance) is eligible only when all of these hold:
 * - the served model's transcription profile declares `realtime` (the runtime definition is
 *   the only source; the node's `stt.open` is checked against the same capability);
 * - the instance is READY, its head node is online here, the member (pools) is ACTIVE and the
 *   execution target is HEALTHY or not yet judged (UNKNOWN, as the HTTP path treats it: a
 *   fresh target has served nothing yet); a live session never takes the HTTP half-open trial;
 * - the served model's owner may use credentials;
 * - a vLLM adapter only when no language or prompt is set.
 *
 * Pool routes are ordered by the HTTP path's weighted round robin. Unknown and forbidden
 * models are both `model_not_found`. An API key sees pools only; the dashboard Chat Test also
 * sees the person's own served models (TEST targets).
 */

/**
 * The live-session capabilities of a served model, or null when it takes none: its request
 * capabilities (`servedModelCapabilities`, the same view HTTP routing and `/v1/models` use)
 * when they carry a live profile.
 */
export function liveCapabilities(model: RouteServedModel): OpenAiCompatibleCapabilities | null {
  const capabilities = servedModelCapabilities(model);
  return realtimeTranscriptionCapability(capabilities) ? capabilities : null;
}

function configNeedsOptions(config: SttConfig): boolean {
  return config.language !== undefined || config.prompt !== undefined;
}

/** Static eligibility of one route's served model (no health, no connection). */
function modelEligible(
  route: Pick<TestRoute, "model">,
  config: SttConfig,
): OpenAiCompatibleCapabilities | null {
  const capabilities = liveCapabilities(route.model);
  if (!capabilities) return null;
  const live = realtimeTranscriptionCapability(capabilities);
  if (live?.adapter === "vllm" && configNeedsOptions(config)) return null;
  return capabilities;
}

/** Ready instance on an online node, healthy (or not yet judged) target. */
function routeServes(route: TestRoute, onlineNodeIds: ReadonlySet<string>): boolean {
  return (
    route.instance.ready &&
    route.instance.nodeId !== null &&
    onlineNodeIds.has(route.instance.nodeId) &&
    (route.target.health === "HEALTHY" || route.target.health === "UNKNOWN")
  );
}

function candidateFor(
  route: TestRoute,
  capabilities: OpenAiCompatibleCapabilities,
  identity: NonNullable<RealtimeCandidate["route"]>,
): RealtimeCandidate | null {
  const nodeId = route.instance.nodeId;
  if (!nodeId) return null;
  return {
    nodeId,
    handle: route.instance.handle,
    upstreamModel: route.model.upstreamModelId,
    capabilities,
    memberId: identity.poolMemberId,
    route: identity,
  };
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

function poolIdentity(
  pool: Pick<CallablePool, "id" | "ownerUserId" | "shareId">,
  route: PoolRoute,
): NonNullable<RealtimeCandidate["route"]> {
  return {
    kind: "pool",
    poolId: pool.id,
    poolMemberId: route.member.id,
    runtimeModelId: route.model.id,
    executionTargetId: route.target.id,
    instanceId: route.instance.id,
    ownerUserId: pool.ownerUserId,
    engineOwnerUserId: route.model.userId,
    shareId: pool.shareId,
    contributedShareId: route.member.shareId,
  };
}

/** The live-eligible routes of a pool (active members, healthy, served, capable). */
async function eligiblePoolRoutes(
  poolId: string,
  config: SttConfig,
  onlineNodeIds: ReadonlySet<string>,
  now: Date,
  routes: (poolId: string, now?: Date) => Promise<PoolRoute[]> = poolRoutes,
): Promise<Array<{ route: PoolRoute; capabilities: OpenAiCompatibleCapabilities }>> {
  const eligible: Array<{ route: PoolRoute; capabilities: OpenAiCompatibleCapabilities }> = [];
  for (const route of await routes(poolId, now)) {
    if (!route.member.active || !routeServes(route, onlineNodeIds)) continue;
    const capabilities = modelEligible(route, config);
    if (capabilities) eligible.push({ route, capabilities });
  }
  return eligible;
}

export async function poolCandidates({
  pool,
  config,
  onlineNodeIds,
  now = new Date(),
  routes = poolRoutes,
}: {
  pool: Pick<CallablePool, "id" | "ownerUserId" | "shareId">;
  config: SttConfig;
  onlineNodeIds: readonly string[];
  now?: Date;
  routes?: (poolId: string, now?: Date) => Promise<PoolRoute[]>;
}): Promise<RealtimeCandidate[]> {
  const online = new Set(onlineNodeIds);
  const eligible = await eligiblePoolRoutes(pool.id, config, online, now, routes);
  if (eligible.length === 0) return [];
  const byKey = new Map(eligible.map((entry) => [routeKey(poolRouteRow(entry.route)), entry]));
  const sequence = buildPoolRouteSequence({
    routes: eligible.map((entry) => poolRouteRow(entry.route)),
    onlineNodeIds: online,
    now,
    state: roundRobin.get(pool.id) ?? {},
  });
  if (!sequence.ok) return [];
  rememberRoundRobin(pool.id, sequence.state);
  const candidates: Array<{ candidate: RealtimeCandidate; judged: boolean }> = [];
  for (const routed of sequence.candidates) {
    if (routed.health !== "HEALTHY") continue;
    const entry = byKey.get(routeKey(routed));
    if (!entry) continue;
    const candidate = candidateFor(
      entry.route,
      entry.capabilities,
      poolIdentity(pool, entry.route),
    );
    if (candidate) candidates.push({ candidate, judged: entry.route.target.health === "HEALTHY" });
  }
  return provenFirst(candidates);
}

/**
 * Targets that served before go first, in their routing order, then targets nothing has
 * judged yet: an open that fails for a configuration reason leaves a target unjudged, and it
 * must not take every session's first attempt.
 */
function provenFirst(
  candidates: ReadonlyArray<{ candidate: RealtimeCandidate; judged: boolean }>,
): RealtimeCandidate[] {
  return [
    ...candidates.filter((entry) => entry.judged),
    ...candidates.filter((entry) => !entry.judged),
  ].map((entry) => entry.candidate);
}

function testIdentity(
  target: Pick<TestTarget, "id" | "ownerUserId">,
  route: TestRoute,
): NonNullable<RealtimeCandidate["route"]> {
  return {
    kind: "test",
    poolId: null,
    poolMemberId: null,
    runtimeModelId: target.id,
    executionTargetId: route.target.id,
    instanceId: route.instance.id,
    ownerUserId: target.ownerUserId,
    engineOwnerUserId: route.model.userId,
    shareId: null,
    contributedShareId: null,
  };
}

/** The live-eligible routes of one of the caller's own served models (dashboard only). */
export async function testCandidates({
  target,
  config,
  onlineNodeIds,
  now = new Date(),
  routes = testRoutes,
}: {
  target: Pick<TestTarget, "id" | "ownerUserId">;
  config: SttConfig;
  onlineNodeIds: readonly string[];
  now?: Date;
  routes?: (runtimeModelId: string, ownerUserId: string, now?: Date) => Promise<TestRoute[]>;
}): Promise<RealtimeCandidate[]> {
  const online = new Set(onlineNodeIds);
  const candidates: Array<{ candidate: RealtimeCandidate; judged: boolean }> = [];
  for (const route of await routes(target.id, target.ownerUserId, now)) {
    if (!routeServes(route, online)) continue;
    const capabilities = modelEligible(route, config);
    if (!capabilities) continue;
    const candidate = candidateFor(route, capabilities, testIdentity(target, route));
    if (candidate) candidates.push({ candidate, judged: route.target.health === "HEALTHY" });
  }
  return provenFirst(candidates);
}

/** Which callable target a model name names, for routing and rechecks. */
export type RealtimeResolvedTarget =
  | { kind: "pool"; target: CallablePool }
  | { kind: "test"; target: TestTarget };

export async function resolveRealtimeModel(
  access: RealtimeTargetAccess,
  model: string,
): Promise<RealtimeResolvedTarget | { error: "model_not_found" | "external_variant_unsupported" }> {
  // An API key calls its pools; Chat Test also calls the person's own served models.
  const targets =
    access.kind === "token"
      ? await listCallableTargetsForApiKey(access.token)
      : await listCallableTargetsForUser(access.userId);
  const resolution = resolveRequestedModelName(targets, model);
  if (resolution.kind === "not_found" || resolution.kind === "error") {
    return { error: "model_not_found" };
  }
  if (resolution.kind === "pool") {
    // Live audio stays local (design D4): `:external` is refused for every caller.
    if (resolution.externalRequested) return { error: "external_variant_unsupported" };
    return { kind: "pool", target: resolution.target };
  }
  return { kind: "test", target: resolution.target };
}

/** The production router for one session. */
export function createRealtimeRouter({
  access,
  onlineNodeIds,
  onResolved,
}: {
  access: RealtimeTargetAccess;
  onlineNodeIds: () => readonly string[];
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
          ? await poolCandidates({ pool: resolved.target, config, onlineNodeIds: onlineNodeIds() })
          : await testCandidates({
              target: resolved.target,
              config,
              onlineNodeIds: onlineNodeIds(),
            });
      if (candidates.length === 0) return { ok: false, code: "no_live_member" };
      return { ok: true, candidates };
    },
    memberMisconfigured(candidate: RealtimeCandidate, failure: RelayFailure) {
      // A runtime that claims live transcription its engine does not serve: reported for the
      // operator, never written to the shared target health.
      console.warn("[realtime] member refused live sessions (configuration)", {
        poolMemberId: candidate.route?.poolMemberId ?? null,
        instanceHandle: candidate.handle,
        failure,
      });
    },
    memberOpened(candidate: RealtimeCandidate) {
      const executionTargetId = candidate.route?.executionTargetId;
      if (!executionTargetId) return;
      void markTargetRelaySuccess(executionTargetId, { trialStartedAt: null }).catch(
        (error: unknown) => {
          console.error(
            "[realtime] target health write failed",
            error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error,
          );
        },
      );
    },
    memberOpenFailed(candidate: RealtimeCandidate, failure: RelayFailure) {
      const executionTargetId = candidate.route?.executionTargetId;
      if (!executionTargetId) return;
      void recordTargetRelayFailure({ executionTargetId, failure, trialStartedAt: null }).catch(
        (error: unknown) => {
          console.error(
            "[realtime] target health write failed",
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
 * The 60 s recheck of an open (or routing) session (release decision 6): the API key is still
 * valid and its owner may use credentials (for Chat Test: the dashboard session still exists
 * for an unblocked, 2FA-compliant user, {@link checkDashboardSession}); the model still
 * resolves to the same target through the same share; and the route the session opened on is
 * still a live-capable route of it (health is not rechecked: a degraded member keeps its
 * session). A missing row is a denial; a read that throws propagates (the registry skips that
 * sweep, as the terminal rechecks do).
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
  routes = { pool: poolRoutes, test: testRoutes },
}: {
  credential: RealtimeCredentialRef;
  /** The session's user (an API key's own user is read from its row). */
  userId: string;
  model: string | null;
  resolved: RealtimeResolvedTarget | null;
  candidate: RealtimeCandidate | null;
  config: SttConfig;
  now?: Date;
  /** The HTTP send claim's permission check, without a send (review 6b M1). */
  permission?: typeof recheckRealtimePermission;
  dashboardSession?: typeof checkDashboardSession;
  routes?: {
    pool: (poolId: string, now?: Date) => Promise<PoolRoute[]>;
    test: (runtimeModelId: string, ownerUserId: string, now?: Date) => Promise<TestRoute[]>;
  };
}): Promise<RealtimeAccessVerdict> {
  const requester = await recheckCredential(credential, userId, now, dashboardSession);
  if (!requester) return { ok: false, reason: "credential" };
  if (!model || !resolved) return { ok: true };
  const current = await resolveRealtimeModel(requester.access, model);
  if (
    "error" in current ||
    current.kind !== resolved.kind ||
    current.target.id !== resolved.target.id ||
    current.target.ownerUserId !== resolved.target.ownerUserId ||
    (current.kind === "pool" &&
      resolved.kind === "pool" &&
      current.target.shareId !== resolved.target.shareId)
  ) {
    return { ok: false, reason: "model" };
  }
  const route = candidate?.route;
  if (!candidate || !route) return { ok: true };
  if (!(await routeStillServes(candidate, route, config, now, routes))) {
    return { ok: false, reason: "member" };
  }
  // The same locked permission check an HTTP send takes: the head node connected and the
  // model owner's, the key's pool access (none for Chat Test), the share row, every user active.
  const denied = await permission(
    { tokenId: requester.tokenId, userId: requester.userId },
    candidate,
  );
  if (denied === "requester") return { ok: false, reason: "credential" };
  if (denied === "access") return { ok: false, reason: "model" };
  if (denied === "member") return { ok: false, reason: "member" };
  return { ok: true };
}

/** The route the session opened on is still a member's served model on that instance. */
async function routeStillServes(
  candidate: RealtimeCandidate,
  route: NonNullable<RealtimeCandidate["route"]>,
  config: SttConfig,
  now: Date,
  routes: {
    pool: (poolId: string, now?: Date) => Promise<PoolRoute[]>;
    test: (runtimeModelId: string, ownerUserId: string, now?: Date) => Promise<TestRoute[]>;
  },
): Promise<boolean> {
  const current: TestRoute | undefined =
    route.kind === "pool" && route.poolId
      ? (await routes.pool(route.poolId, now)).find(
          (entry) =>
            entry.member.id === route.poolMemberId &&
            entry.member.active &&
            entry.member.shareId === route.contributedShareId &&
            entry.target.id === route.executionTargetId,
        )
      : (await routes.test(route.runtimeModelId, route.ownerUserId, now)).find(
          (entry) => entry.target.id === route.executionTargetId,
        );
  return (
    current !== undefined &&
    current.instance.id === route.instanceId &&
    current.instance.handle === candidate.handle &&
    current.instance.nodeId === candidate.nodeId &&
    current.model.id === route.runtimeModelId &&
    modelEligible(current, config) !== null
  );
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
  const key = await prisma.apiKey.findUnique({
    where: { id: credential.tokenId },
    select: {
      id: true,
      userId: true,
      scope: true,
      lookupPrefix: true,
      expiresAt: true,
      lastUsedAt: true,
      revokedAt: true,
      User: { select: { banned: true, banExpires: true, deletionRequestedAt: true } },
    },
  });
  if (
    !key ||
    key.revokedAt ||
    (key.expiresAt && key.expiresAt <= now) ||
    !key.User ||
    userCredentialAccessBlocked(key.User, now)
  ) {
    return null;
  }
  const token: ApiKeyIdentity = {
    id: key.id,
    userId: key.userId,
    scope: key.scope,
    lookupPrefix: key.lookupPrefix,
    expiresAt: key.expiresAt,
    lastUsedAt: key.lastUsedAt,
  };
  return { userId: key.userId, tokenId: key.id, access: { kind: "token", token } };
}
