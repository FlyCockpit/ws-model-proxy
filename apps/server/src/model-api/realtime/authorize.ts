import {
  checkLocalSendPermission,
  type LocalSendBinding,
  type LocalSendDenial,
  LocalSendRefused,
  withAuthorizedLocalSend,
} from "../local-send.js";
import type { RealtimeAuthorizeResult, RealtimeCandidate } from "./transcription-session.js";

/**
 * The live transcription side of the shared local send claim (review 6b M1):
 * `stt.open` is sent inside the same locked permission transaction as an HTTP
 * relay request (`withAuthorizedLocalSend`), so a management write that
 * commits first (a revoked token or grant, a ban, an allowlist edit, an
 * unpublished model, a CLI that is no longer connected or no longer the
 * model owner's) is never followed by an open. The 60 s recheck uses the same
 * check without a send (`checkLocalSendPermission`).
 */

/** The exact destination of an open, as the HTTP send binds it. */
export function realtimeLocalSendBinding(
  requester: { tokenId: string | null; userId: string },
  candidate: RealtimeCandidate,
): LocalSendBinding | null {
  const route = candidate.route;
  if (!route?.executionTargetId || !route.capacityId) return null;
  return {
    requesterUserId: requester.userId,
    modelApiTokenId: requester.tokenId,
    engineOwnerUserId: route.engineOwnerUserId,
    discoveredModelId: route.discoveredModelId,
    executionTargetId: route.executionTargetId,
    capacityId: route.capacityId,
    endpointId: route.endpointId,
    cliDeviceId: candidate.cliDeviceId,
    endpointSlug: candidate.endpointSlug,
    upstreamModelId: candidate.upstreamModel,
    ...(route.kind === "pool" && route.poolId
      ? {
          pool: {
            id: route.poolId,
            ownerUserId: route.ownerUserId,
            accessGrantId: route.accessGrantId,
            memberId: route.poolMemberId,
            contributionId: route.contributionId,
          },
        }
      : {}),
  };
}

export function realtimeDenial(
  denial: LocalSendDenial,
): "requester" | "access" | "member" | "check_failed" {
  switch (denial) {
    case "REQUESTER_BLOCKED":
      return "requester";
    case "ACCESS_REVOKED":
      return "access";
    case "OWNER_INACTIVE":
    case "MEMBER_UNAVAILABLE":
      return "member";
    case "CHECK_FAILED":
      return "check_failed";
  }
}

type Claim = typeof withAuthorizedLocalSend;

/** The `authorizeOpen` hook for one token's sessions. */
export function createRealtimeAuthorizer(
  requester: { tokenId: string | null; userId: string },
  claim: Claim = withAuthorizedLocalSend,
) {
  return async (
    candidate: RealtimeCandidate,
    open: () => void,
    abort: () => void,
  ): Promise<RealtimeAuthorizeResult> => {
    const binding = realtimeLocalSendBinding(requester, candidate);
    if (!binding) return { ok: false, denial: "member" };
    try {
      await claim(binding, open, { onCommitFailure: abort });
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        denial: error instanceof LocalSendRefused ? realtimeDenial(error.denial) : "check_failed",
      };
    }
  };
}

/** The recheck form: null when still authorized. A failed transaction throws. */
export async function recheckRealtimePermission(
  requester: { tokenId: string | null; userId: string },
  candidate: RealtimeCandidate,
  check: typeof checkLocalSendPermission = checkLocalSendPermission,
): Promise<"requester" | "access" | "member" | null> {
  const binding = realtimeLocalSendBinding(requester, candidate);
  if (!binding) return "member";
  const denial = await check(binding);
  if (denial === null) return null;
  const mapped = realtimeDenial(denial);
  if (mapped === "check_failed") throw new LocalSendRefused("CHECK_FAILED");
  return mapped;
}
