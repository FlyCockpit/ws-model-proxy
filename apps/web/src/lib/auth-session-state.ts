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
  error?: unknown;
  isOffline?: boolean;
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
  const isRefetching = isPending && Boolean(input.confirmedSession);
  const baseMeta = {
    isRefetching,
    isOffline,
    isDegraded: false,
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

  return {
    state: { status: "error", session: null, error: input.error },
    actions: input.actions,
    meta: { ...baseMeta, isDegraded: true },
  };
}
