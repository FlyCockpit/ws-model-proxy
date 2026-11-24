import { validateForwarderSlug } from "@ws-model-proxy/config/forwarder-identifiers";
import prisma from "@ws-model-proxy/db";
import { BASE_ERROR_CODES } from "better-auth";
import { APIError, isAPIError } from "better-auth/api";
import { releaseShareInviteToken } from "./share-invite-acceptance";
import { isPublicSignupPath } from "./user-create-policy";

// The one body `/sign-up/email` answers with on success while e-mail verification is required.
// No client reads it: the web sign-up form reads only `error`, and with
// `requireEmailVerification` there is never a session to hand back.
const NEUTRAL_SIGN_UP_RESPONSE = { token: null, user: null } as const;

type InviteClaim = { token: string; email: string; claimedAt: Date };

/**
 * The user-create hook ran in this request, keyed on the request's auth context object (Better
 * Auth hands the database hooks the endpoint context whose `context` the after hooks also get).
 * `noAccountsYet`: the hook saw zero users, so the request cannot be about a registered address.
 * `claim`: the invite claim the hook made, released if no account comes of it.
 */
const userCreateAttempts = new WeakMap<
  object,
  { noAccountsYet: boolean; claim: InviteClaim | null }
>();

function authContextOf(hookContext: unknown): object | null {
  const inner = (hookContext as { context?: unknown } | null | undefined)?.context;
  return typeof inner === "object" && inner !== null ? inner : null;
}

function attemptOf(hookContext: unknown) {
  const key = authContextOf(hookContext);
  if (!key) return null;
  const attempt = userCreateAttempts.get(key) ?? { noAccountsYet: false, claim: null };
  userCreateAttempts.set(key, attempt);
  return attempt;
}

/**
 * Called by `databaseHooks.user.create.before` before anything that can refuse: this request got
 * past Better Auth's address lookup with a free address. Pass `userCount` once it is known.
 */
export function noteUserCreateAttempt(hookContext: unknown, userCount?: number): void {
  const attempt = attemptOf(hookContext);
  if (attempt && userCount === 0) attempt.noAccountsYet = true;
}

/** The user-create hook reserved an invite for this sign-up. */
export function noteInviteClaim(hookContext: unknown, claim: InviteClaim): void {
  const attempt = attemptOf(hookContext);
  if (attempt) attempt.claim = claim;
}

/**
 * After-hook for `/sign-up/email`: a sign-up that reserved an invite but did not create its
 * account releases the reservation, so the invite reads as if the request never ran. Otherwise a
 * free address's failed sign-up (a registered one never claims) would leave a claim that another
 * account could see as "in use". A failed release is logged; the claim then expires as before.
 */
export async function releaseClaimOfFailedSignUp(ctx: SignUpHookContext): Promise<void> {
  if (!isPublicSignupPath(ctx.path) || !isAPIError(ctx.context.returned)) return;
  const attempt = userCreateAttempts.get(ctx.context);
  if (!attempt?.claim) return;
  const { token, email, claimedAt } = attempt.claim;
  attempt.claim = null;
  try {
    await releaseShareInviteToken(token, email, claimedAt);
  } catch (error) {
    console.error(
      "share invite claim release failed",
      error instanceof Error ? error.name : "error",
    );
  }
}

type SignUpHookContext = {
  path?: string;
  context: object & { returned?: unknown };
  json: (body: typeof NEUTRAL_SIGN_UP_RESPONSE) => unknown;
};

/**
 * After-hook for `/sign-up/email`: while e-mail verification is required, the answer does not
 * depend on whether the address already has an account.
 *
 * Better Auth answers a registered address with a synthetic "pretend it worked" 200 before it
 * creates anything. That user lacks every value the user-create hook and plugin defaults fill in
 * (`role` and `slug` are null for it), so every success body becomes `{"token":null,"user":null}`
 * instead of patching the synthetic user (any later field would reopen the oracle).
 *
 * A free address goes on to user creation, where more can refuse it: the user-create hook
 * (invite claim in use or no longer available, slug race, sign-up policy), the database (a
 * constraint or an outage), the adapter. A registered address never gets there, so
 * any such refusal would tell the two apart. It therefore gets the same neutral 200 (no account
 * was created and no mail sent). The one exception is a request that saw no account at all (the
 * first-admin bootstrap): there is no registered address to reveal, so its refusal stands.
 * Refusals before the address lookup (input validation, the slug check below) are the same for
 * every address and pass through. The answer is a `Response` because Better Auth keeps the
 * handler's error status for a plain body returned from an after hook.
 *
 * Without SMTP there is nothing to hide: verification is off, a free address is signed in at once
 * (the body is the person's own new account), and a registered one is told it is taken (422),
 * which is the product's intended no-mail flow.
 */
export function neutralizeSignUpResponse(
  ctx: SignUpHookContext,
  opts: { requireEmailVerification: boolean },
) {
  if (!opts.requireEmailVerification || !isPublicSignupPath(ctx.path)) return;
  if (!isAPIError(ctx.context.returned)) return ctx.json(NEUTRAL_SIGN_UP_RESPONSE);
  const attempt = userCreateAttempts.get(ctx.context);
  if (!attempt || attempt.noAccountsYet) return;
  return Response.json(NEUTRAL_SIGN_UP_RESPONSE);
}

/** Stored sign-up fields: a NUL byte in one is refused by Postgres (text), not by Better Auth. */
const STORED_SIGN_UP_FIELDS = ["name", "image", "slug"] as const;

/**
 * Before-hook for `/sign-up/email`: refusals that must happen before Better Auth looks the
 * address up, so they are the same for every address (each pays the same work).
 *
 * - A stored field with a NUL byte: Postgres would refuse only a free address's insert (a
 *   registered one never gets there). 400 for every address instead.
 * - A requested slug another account holds: the 422 the user-create hook's own refusal gives.
 *   Without this a taken slug would only surface in the user-create hook, which answers the
 *   neutral 200 above, and the person would never learn why no mail came. A malformed slug is
 *   left to the field validator (the same 400 for every address).
 */
export async function refuseSignUpInputBeforeLookup(ctx: { path?: string; body?: unknown }) {
  if (!isPublicSignupPath(ctx.path)) return;
  const body = (ctx.body ?? {}) as Partial<Record<(typeof STORED_SIGN_UP_FIELDS)[number], unknown>>;
  if (
    STORED_SIGN_UP_FIELDS.some((field) => {
      const value = body[field];
      return typeof value === "string" && value.includes("\u0000");
    })
  ) {
    throw APIError.from("BAD_REQUEST", { code: "INVALID_INPUT", message: "Invalid input" });
  }
  const requested = body.slug;
  if (typeof requested !== "string") return;
  const slug = requested.trim();
  if (slug.length === 0 || !validateForwarderSlug(slug).ok) return;
  const holder = await prisma.user.findUnique({ where: { slug }, select: { id: true } });
  if (holder) throw APIError.from("UNPROCESSABLE_ENTITY", BASE_ERROR_CODES.FAILED_TO_CREATE_USER);
}
