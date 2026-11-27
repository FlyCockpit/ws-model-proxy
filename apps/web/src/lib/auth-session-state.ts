export type AuthSessionData = {
  user: {
    id: string;
    name: string;
    email: string;
    emailVerified?: boolean;
    role?: string | null;
    twoFactorEnabled?: boolean | null;
    locale?: string | null;
  };
  /**
   * The Better Auth session record. The session hook (see
   * `use-auth-session.ts`) receives data carrying BOTH `user` and `session`
   * at runtime; the id is load-bearing for MCP grant-generation identity (the
   * reference is HMAC(sessionId, clientId)), so it is part of the typed
   * surface (Part H pass 3). Optional because the narrow projection
   * historically omitted it — absent means type drift, and consumers must
   * fail closed rather than substitute the user id.
   */
  session?: {
    id: string;
    expiresAt?: string | Date;
  };
};

type AuthSessionActions = {
  refetch: () => unknown;
  retry: () => unknown;
};

export type AuthSessionState =
  | {
      state: { status: "pending"; session: null };
      actions: AuthSessionActions;
      meta: AuthSessionMeta;
    }
  | {
      state: { status: "authenticated"; session: AuthSessionData };
      actions: AuthSessionActions;
      meta: AuthSessionMeta;
    }
  | {
      state: { status: "anonymous"; session: null };
      actions: AuthSessionActions;
      meta: AuthSessionMeta;
    }
  | {
      state: { status: "error"; session: AuthSessionData | null; error: unknown };
      actions: AuthSessionActions;
      meta: AuthSessionMeta;
    };

type AuthSessionMeta = {
  isRefetching: boolean;
  isOffline: boolean;
  isDegraded: boolean;
};

export type ClassifyAuthSessionInput = {
  data: AuthSessionData | null | undefined;
  confirmedSession?: AuthSessionData | null;
  isPending?: boolean;
  isRefetching?: boolean;
  error?: unknown;
  isOffline?: boolean;
  /**
   * An earlier snapshot in this document already settled anonymous (see
   * {@link rememberConfirmedAnonymous}). Better Auth marks every refetch of an empty session
   * `isPending` again (each request sets `isPending: data === null`), so a refocus looks exactly
   * like the first load; only this memory tells them apart.
   */
  confirmedAnonymous?: boolean;
  actions: AuthSessionActions;
};

function errorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const record = error as Record<string, unknown>;
  const candidates = [record.status, record.statusCode, record.code];
  for (const value of candidates) {
    if (typeof value === "number") return value;
    if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  }
  return null;
}

export function isExplicitNoSessionResult({
  data,
  error,
  isPending,
}: Pick<ClassifyAuthSessionInput, "data" | "error" | "isPending">): boolean {
  if (isPending === true) return false;
  if (data) return false;
  if (!error) return true;
  return errorStatus(error) === 401;
}

export function nextConfirmedAuthSession(
  current: AuthSessionData | null,
  input: Pick<ClassifyAuthSessionInput, "data" | "error" | "isPending">,
): AuthSessionData | null {
  if (input.data) return input.data;
  if (isExplicitNoSessionResult(input)) return null;
  return current;
}

export function classifyAuthSession(input: ClassifyAuthSessionInput): AuthSessionState {
  const isPending = input.isPending === true;
  const isOffline = input.isOffline === true;
  const explicitNoSession = isExplicitNoSessionResult(input);
  const confirmedSession = input.data ?? input.confirmedSession ?? null;
  const isRefetching =
    input.isRefetching === true || (isPending && Boolean(input.confirmedSession));
  const baseMeta = {
    isRefetching,
    isOffline,
    isDegraded: Boolean(input.error) && errorStatus(input.error) !== 401,
  };

  if (input.data) {
    return {
      state: { status: "authenticated", session: input.data },
      actions: input.actions,
      meta: baseMeta,
    };
  }

  if (isPending) {
    if (input.confirmedSession) {
      return {
        state: { status: "authenticated", session: input.confirmedSession },
        actions: input.actions,
        meta: { ...baseMeta, isDegraded: isOffline },
      };
    }
    // A visitor already confirmed anonymous stays anonymous while Better Auth revalidates
    // (window focus, another tab's announcement). Only the first load waits: otherwise every
    // refocus would unmount whatever the anonymous state renders (the sign-in form and its
    // typed values) into its skeleton.
    if (input.confirmedAnonymous === true) {
      return {
        state: { status: "anonymous", session: null },
        actions: input.actions,
        meta: { ...baseMeta, isRefetching: true },
      };
    }
    return {
      state: { status: "pending", session: null },
      actions: input.actions,
      meta: baseMeta,
    };
  }

  if (explicitNoSession || !input.error) {
    return {
      state: { status: "anonymous", session: null },
      actions: input.actions,
      meta: baseMeta,
    };
  }

  if (confirmedSession) {
    return {
      state: { status: "authenticated", session: confirmedSession },
      actions: input.actions,
      meta: { ...baseMeta, isDegraded: true },
    };
  }

  // A failed revalidation after the document settled anonymous keeps it anonymous, just as a
  // confirmed session survives one above: the form stays, not an unable-to-connect card.
  if (input.confirmedAnonymous === true) {
    return {
      state: { status: "anonymous", session: null },
      actions: input.actions,
      meta: { ...baseMeta, isDegraded: true },
    };
  }

  return {
    state: { status: "error", session: null, error: input.error },
    actions: input.actions,
    meta: { ...baseMeta, isDegraded: true },
  };
}

/**
 * The memory {@link ClassifyAuthSessionInput.confirmedAnonymous} reads: true once a snapshot
 * settled anonymous, false again once one is authenticated, and unchanged by pending and error
 * snapshots.
 */
export function rememberConfirmedAnonymous(previous: boolean, state: AuthSessionState): boolean {
  if (state.state.status === "anonymous") return true;
  if (state.state.status === "authenticated") return false;
  return previous;
}
