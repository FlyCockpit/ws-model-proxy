import { SIGNUP_DISABLED_MESSAGE } from "./signup-policy";

const DEFAULT_ROLE = "user";
const FIRST_USER_ROLE = "admin";
/** Exact Better Auth admin-plugin endpoint path (HTTP and `auth.api.createUser`). */
const ADMIN_CREATE_USER_PATH = "/admin/create-user";

export type UserCreatePolicyInput = {
  signupEnabled: boolean;
  userCount: number;
  emailConfigured: boolean;
  requestedRole?: unknown;
  contextPath?: string | null;
};

export type UserCreatePolicyResult = {
  role: string;
  /** Present only when the hook should force verification on the new row. */
  emailVerified?: true;
};

export type UserCreateHookMappingInput = {
  signupEnabled: boolean;
  userCount: number;
  emailConfigured: boolean;
  user: object;
  context?: { path?: unknown } | null;
};

/**
 * Better Auth 1.6.26 sets hook `context.path` to the registered endpoint
 * `/admin/create-user` for both HTTP and sessionless `auth.api.createUser`.
 * Prefixed, case-variant, and missing paths are public (fail closed).
 */
export function isAdminCreateUserPath(path: string | null | undefined): boolean {
  if (typeof path !== "string") return false;
  return stripBenignPathDecorators(path) === ADMIN_CREATE_USER_PATH;
}

/**
 * Map Better Auth `user.create.before` hook args onto the pure policy input.
 * Missing / non-string paths stay `undefined` so the policy fails closed.
 */
export function toUserCreatePolicyInput(input: UserCreateHookMappingInput): UserCreatePolicyInput {
  return {
    signupEnabled: input.signupEnabled,
    userCount: input.userCount,
    emailConfigured: input.emailConfigured,
    requestedRole: "role" in input.user ? input.user.role : undefined,
    contextPath: typeof input.context?.path === "string" ? input.context.path : undefined,
  };
}

export function resolveUserCreatePolicy(input: UserCreatePolicyInput): UserCreatePolicyResult {
  const isFirstUser = input.userCount === 0;
  const isAdminCreate = isAdminCreateUserPath(input.contextPath);

  if (!input.signupEnabled && !isFirstUser && !isAdminCreate) {
    throw new Error(SIGNUP_DISABLED_MESSAGE);
  }

  return {
    role: resolveCreateRole({
      isFirstUser,
      isAdminCreate,
      requestedRole: input.requestedRole,
    }),
    ...(shouldForceEmailVerified({ isAdminCreate, emailConfigured: input.emailConfigured })
      ? { emailVerified: true as const }
      : {}),
  };
}

function resolveCreateRole({
  isFirstUser,
  isAdminCreate,
  requestedRole,
}: {
  isFirstUser: boolean;
  isAdminCreate: boolean;
  requestedRole: unknown;
}): string {
  if (isFirstUser) return FIRST_USER_ROLE;
  if (isAdminCreate) return preserveRequestedRole(requestedRole);
  return DEFAULT_ROLE;
}

function shouldForceEmailVerified({
  isAdminCreate,
  emailConfigured,
}: {
  isAdminCreate: boolean;
  emailConfigured: boolean;
}): boolean {
  // Invites must be usable via the revealed temp password even when SMTP
  // turns on requireEmailVerification. Public sign-up still follows SMTP.
  return isAdminCreate || !emailConfigured;
}

function preserveRequestedRole(requestedRole: unknown): string {
  if (typeof requestedRole === "string") {
    const trimmed = requestedRole.trim();
    return trimmed.length > 0 ? trimmed : DEFAULT_ROLE;
  }
  if (Array.isArray(requestedRole)) {
    const roles = requestedRole
      .filter((role): role is string => typeof role === "string")
      .map((role) => role.trim())
      .filter((role) => role.length > 0);
    return roles.length > 0 ? roles.join(",") : DEFAULT_ROLE;
  }
  return DEFAULT_ROLE;
}

/** Strip query/hash and a single trailing slash. Case and prefixes stay intact. */
function stripBenignPathDecorators(path: string): string {
  const withoutQueryOrHash = path.split(/[?#]/, 1)[0] ?? "";
  if (withoutQueryOrHash.length > 1 && withoutQueryOrHash.endsWith("/")) {
    return withoutQueryOrHash.slice(0, -1);
  }
  return withoutQueryOrHash;
}
