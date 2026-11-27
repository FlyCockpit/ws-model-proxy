import { APIError } from "better-auth/api";
import { getAdminInviteLocale } from "./admin-invite-locale";
import { SignupDisabledError } from "./signup-policy";

const DEFAULT_ROLE = "user";
const FIRST_USER_ROLE = "admin";
/** Exact Better Auth admin-plugin endpoint path (HTTP and `auth.api.createUser`). */
const ADMIN_CREATE_USER_PATH = "/admin/create-user";
/** Exact Better Auth e-mail sign-up endpoint path. */
const PUBLIC_SIGNUP_PATH = "/sign-up/email";

export type UserCreatePolicyInput = {
  signupEnabled: boolean;
  userCount: number;
  /** Whether this submitted address is authorized for a production bootstrap. */
  adminBootstrapAllowed?: boolean;
  /**
   * Whether the request carries the token of a pending share invite (the `x-wsmp-invite`
   * header). It opens only the public sign-up route while open sign-up is off.
   */
  inviteTokenPending?: boolean;
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
  adminBootstrapAllowed?: boolean;
  inviteTokenPending?: boolean;
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

/** The public e-mail sign-up route (exact, like {@link isAdminCreateUserPath}). */
export function isPublicSignupPath(path: string | null | undefined): boolean {
  return typeof path === "string" && stripBenignPathDecorators(path) === PUBLIC_SIGNUP_PATH;
}

/**
 * Map Better Auth `user.create.before` hook args onto the pure policy input.
 * Missing / non-string paths stay `undefined` so the policy fails closed.
 */
export function toUserCreatePolicyInput(input: UserCreateHookMappingInput): UserCreatePolicyInput {
  return {
    signupEnabled: input.signupEnabled,
    userCount: input.userCount,
    adminBootstrapAllowed: input.adminBootstrapAllowed,
    inviteTokenPending: input.inviteTokenPending,
    emailConfigured: input.emailConfigured,
    requestedRole: "role" in input.user ? input.user.role : undefined,
    contextPath: typeof input.context?.path === "string" ? input.context.path : undefined,
  };
}

/**
 * Two rules for every user row Better Auth creates (`databaseHooks.user.create.before`, first):
 *
 * - `/admin/create-user` runs only inside `users.invite` (packages/api), which creates the
 *   account under `runWithAdminInviteLocale` (./admin-invite-locale.ts) with a random unusable
 *   password and sends a set-password link. An HTTP call to Better Auth's own route (an admin
 *   session reaches `/api/auth/admin/*`) could choose the password, so it is refused: the
 *   AsyncLocalStorage scope can never come from a request.
 * - No caller creates a user verified: `emailVerified: true` in the incoming row (an admin's
 *   `data`) is refused. WMP has no identity-provider sign-in whose claim it would trust. The
 *   no-SMTP verification of public sign-ups ({@link resolveUserCreatePolicy}) is the policy's own
 *   decision, applied after this check.
 */
export function refuseUnprovedUserCreation(
  user: { emailVerified?: unknown },
  context: { path?: unknown } | null | undefined,
): void {
  const path = typeof context?.path === "string" ? context.path : null;
  if (isAdminCreateUserPath(path) && getAdminInviteLocale() === undefined) {
    throw new APIError("FORBIDDEN", {
      message: "Invite users from the admin dashboard.",
      code: "ADMIN_CREATE_USER_UNSUPPORTED",
    });
  }
  if (user.emailVerified === true) {
    throw new APIError("BAD_REQUEST", {
      message: "An e-mail address is verified only through the link mailed to it.",
      code: "EMAIL_VERIFICATION_BY_MAIL_ONLY",
    });
  }
}

export function resolveUserCreatePolicy(input: UserCreatePolicyInput): UserCreatePolicyResult {
  const isFirstUser = input.userCount === 0;
  const isAdminCreate = isAdminCreateUserPath(input.contextPath);
  // The hook must explicitly attest the address. An omitted value is a
  // denial, so a future creation path cannot accidentally recreate the public
  // production bootstrap bypass by forgetting this field.
  const mayBootstrapAdmin = isFirstUser && input.adminBootstrapAllowed === true;
  // An invite link is the invitation: it opens the public sign-up route only, with the
  // default role (resolveCreateRole), never another creation path.
  const mayInviteSignup =
    input.inviteTokenPending === true && isPublicSignupPath(input.contextPath);

  if (!input.signupEnabled && !mayBootstrapAdmin && !isAdminCreate && !mayInviteSignup) {
    throw new SignupDisabledError();
  }

  return {
    role: resolveCreateRole({
      isFirstUser,
      mayBootstrapAdmin,
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
  mayBootstrapAdmin,
  isAdminCreate,
  requestedRole,
}: {
  isFirstUser: boolean;
  mayBootstrapAdmin: boolean;
  isAdminCreate: boolean;
  requestedRole: unknown;
}): string {
  if (isFirstUser && mayBootstrapAdmin) return FIRST_USER_ROLE;
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
  // Admin invites stay unverified (pending) until their set-password link is
  // spent, which activates them (no mailbox proof). Public sign-up still follows SMTP.
  return !isAdminCreate && !emailConfigured;
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
