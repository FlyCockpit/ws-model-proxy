import type { ModelApiTokenIdentity } from "@ws-model-proxy/api/lib/model-api-token-access";

/**
 * Who a live transcription session acts for. `/v1/realtime` sessions carry a
 * model API token; Chat Test sessions (`/api/internal/chat-test/realtime`)
 * carry the person's dashboard session and are attributed exactly as HTTP
 * Chat Test requests are: the user, source `CHAT_TEST`, no token, every
 * model the user can see, and `chat-test:<userId>` as the per-credential key.
 */
export type RealtimeCredential =
  | { kind: "token"; token: ModelApiTokenIdentity }
  | { kind: "dashboard"; sessionId: string };

export type RealtimeRequester = {
  userId: string;
  /** The per-credential session cap's key: the token id, or `chat-test:<userId>`. */
  limitKey: string;
  credential: RealtimeCredential;
};

/** What the registry keeps to recheck a session's credential. */
export type RealtimeCredentialRef =
  | { kind: "token"; tokenId: string }
  | { kind: "dashboard"; sessionId: string };

/** The visible-model scope: a token's (allowlist, external consent) or the user's own. */
export type RealtimeTargetAccess =
  | {
      kind: "token";
      token: Pick<ModelApiTokenIdentity, "id" | "userId" | "scopeMode" | "allowExternal">;
    }
  | { kind: "dashboard"; userId: string };

/** The HTTP Chat Test limit key (`requesterFromChatTestUser`). */
export function chatTestLimitKey(userId: string): string {
  return `chat-test:${userId}`;
}

export function tokenRequester(token: ModelApiTokenIdentity): RealtimeRequester {
  return { userId: token.userId, limitKey: token.id, credential: { kind: "token", token } };
}

export function dashboardRequester(userId: string, sessionId: string): RealtimeRequester {
  return {
    userId,
    limitKey: chatTestLimitKey(userId),
    credential: { kind: "dashboard", sessionId },
  };
}

/** The token id the send claim binds (null for Chat Test, as on HTTP). */
export function requesterTokenId(requester: RealtimeRequester): string | null {
  return requester.credential.kind === "token" ? requester.credential.token.id : null;
}

export function credentialRef(requester: RealtimeRequester): RealtimeCredentialRef {
  return requester.credential.kind === "token"
    ? { kind: "token", tokenId: requester.credential.token.id }
    : { kind: "dashboard", sessionId: requester.credential.sessionId };
}

export function targetAccess(requester: RealtimeRequester): RealtimeTargetAccess {
  return requester.credential.kind === "token"
    ? { kind: "token", token: requester.credential.token }
    : { kind: "dashboard", userId: requester.userId };
}

/** The client error for a credential that is no longer valid. */
export function credentialEndedError(kind: RealtimeCredential["kind"]): {
  code: string;
  message: string;
} {
  return kind === "token"
    ? { code: "invalid_api_key", message: "The API key is no longer valid." }
    : { code: "dashboard_session_ended", message: "Your dashboard session ended. Sign in again." };
}
