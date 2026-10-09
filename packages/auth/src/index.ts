import { randomBytes } from "node:crypto";
import {
  FORWARDER_SLUG_MAX_LENGTH,
  slugifyForwarderSeed,
  validateForwarderSlug,
} from "@ws-model-proxy/config/forwarder-identifiers";
import {
  INVITE_IN_USE_CODE,
  shareInviteTokenFromHeaders,
} from "@ws-model-proxy/config/share-invite";
import prisma from "@ws-model-proxy/db";
import { deleteUserDurably } from "@ws-model-proxy/db/parent-deletion";
import { env } from "@ws-model-proxy/env/server";
import {
  isEmailConfigured,
  renderTwoFactorOtp,
  renderVerifyEmail,
  sendEmail,
} from "@ws-model-proxy/mailer";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { admin, twoFactor } from "better-auth/plugins";
import { z } from "zod";
import { sanitizedApiErrorLogLine } from "./api-error-logging";
import { resolveAuthLogCall } from "./auth-logger-bridge";
import { isUserBanned } from "./is-user-banned";
import { resolveMcpPlugins } from "./mcp-plugins";
import { recordProvedEmail } from "./proved-email";
import {
  acceptClaimedShareInviteToken,
  acceptShareInvitesForProvenEmail,
  claimShareInviteToken,
  isEmailVerificationPath,
  isPendingShareInviteToken,
} from "./share-invite-acceptance";
import { resolveSignupLocale } from "./signup-locale";
import {
  getSignupAccessState,
  resolveBootstrapAdminIdentity,
  SignupDisabledError,
} from "./signup-policy";
import { notifyUserBanned } from "./user-ban-listeners";
import {
  isAdminCreateUserPath,
  isPublicSignupPath,
  resolveUserCreatePolicy,
  toUserCreatePolicyInput,
} from "./user-create-policy";
import {
  mapSessionRefusalToForbidden,
  refuseAdminRestoreOfDeletingUser,
  refuseSessionForDeletingUser,
} from "./user-deletion-access-guard";
import { notifyUserDeleted, notifyUserDeletionMarked } from "./user-deletion-listeners";
import { refuseUndeletableUserBeforeCredentialDelete } from "./user-deletion-preflight";
import { withVerificationCallback } from "./verification-callback";

const isCrossOrigin = !!env.CORS_ORIGIN;
/** Email/SMTP is optional; when configured, verification is required. */
const emailConfigured = isEmailConfigured();

/** Invite acceptance never fails the sign-up or update that triggered it. */
async function acceptInvitesQuietly(user: unknown): Promise<void> {
  const row = user as { id?: unknown; email?: unknown; emailVerified?: unknown } | null;
  if (!row || typeof row.id !== "string" || typeof row.email !== "string") return;
  try {
    // Without SMTP every account is created "verified" without proof, so an e-mail match
    // counts only when verification is on (inviteAcceptance: otherwise the link is needed).
    await acceptShareInvitesForProvenEmail({
      id: row.id,
      email: row.email,
      emailVerified: emailConfigured && row.emailVerified === true,
    });
  } catch (error) {
    console.error("share invite acceptance failed", error instanceof Error ? error.name : "error");
  }
}

/**
 * A verify-email route verified this address: record it as proved. Without SMTP no verification
 * link reaches a mailbox, so nothing is proved. A failure leaves the address unproved (shares by
 * e-mail then go through an invite) and never fails the verification.
 */
async function recordProvedEmailQuietly(user: unknown): Promise<void> {
  const row = user as { id?: unknown; email?: unknown; emailVerified?: unknown } | null;
  if (!row || typeof row.id !== "string" || typeof row.email !== "string") return;
  if (!emailConfigured || row.emailVerified !== true) return;
  try {
    await recordProvedEmail({ id: row.id, email: row.email });
  } catch (error) {
    console.error("proved e-mail record failed", error instanceof Error ? error.name : "error");
  }
}

/**
 * The invite token of a public sign-up request (the `x-wsmp-invite` header the sign-up page
 * sends); null on every other route, so the header opens nothing else.
 */
function signupInviteToken(
  context: { path?: unknown; headers?: Headers; request?: Request } | null | undefined,
): string | null {
  if (!isPublicSignupPath(typeof context?.path === "string" ? context.path : null)) return null;
  return shareInviteTokenFromHeaders(context?.headers ?? context?.request?.headers);
}

/**
 * The invite token each sign-up claimed in the user-create `before` hook, for its `after` hook.
 * Better Auth hands both hooks the same endpoint context object.
 */
const inviteClaims = new WeakMap<object, string>();

/** A slug change through Better Auth's update routes (see `databaseHooks.user.update`). */
function slugChangeRefused(): APIError {
  return new APIError("BAD_REQUEST", {
    message: "Change the account slug in the settings (settings.update), not here.",
    code: "SLUG_CHANGE_UNSUPPORTED",
  });
}

/** A second sign-up with an invite link another e-mail's sign-up holds right now. */
function inviteInUseError(): APIError {
  return new APIError("CONFLICT", {
    code: INVITE_IN_USE_CODE,
    message: "This invite link is in use. Try again shortly.",
  });
}

/**
 * The invite link acceptance never fails the sign-up that carried it. A failure is logged with
 * the user id and the error class (never the token). The claim stays with this account's
 * e-mail, so the person can still accept the invite signed in (`auth.acceptInvite`).
 */
async function acceptClaimedInviteQuietly(user: unknown, token: string): Promise<void> {
  const row = user as { id?: unknown; email?: unknown } | null;
  if (!row || typeof row.id !== "string" || typeof row.email !== "string") return;
  try {
    const accepted = await acceptClaimedShareInviteToken({ id: row.id, email: row.email }, token);
    if (!accepted) console.error("share invite link acceptance refused", `user=${row.id}`);
  } catch (error) {
    console.error(
      "share invite link acceptance failed",
      `user=${row.id}`,
      error instanceof Error ? error.name : "error",
    );
  }
}

const userSlugInputSchema = z
  .string()
  .trim()
  .superRefine((value, ctx) => {
    const result = validateForwarderSlug(value);
    if (!result.ok) {
      ctx.addIssue({ code: "custom", message: `forwarderSlug.${result.reason}` });
    }
  });

function slugWithRandomSuffix(base: string): string {
  const suffix = randomBytes(4).toString("hex");
  const maxBaseLength = FORWARDER_SLUG_MAX_LENGTH - suffix.length - 1;
  return `${base.slice(0, maxBaseLength).replace(/-$/g, "")}-${suffix}`;
}

async function resolveUniqueUserSlug({
  requestedSlug,
  name,
  email,
}: {
  requestedSlug: string | undefined;
  name: string | undefined;
  email: string | undefined;
}): Promise<string> {
  if (requestedSlug) {
    const result = validateForwarderSlug(requestedSlug);
    if (!result.ok) {
      throw new Error(`forwarderSlug.${result.reason}`);
    }
    const existing = await prisma.user.findUnique({
      where: { slug: requestedSlug },
      select: { id: true },
    });
    if (existing) {
      throw new Error("forwarderSlug.taken");
    }
    return requestedSlug;
  }

  const seed = email?.split("@")[0] || name || "user";
  const fallback = `user-${randomBytes(4).toString("hex")}`;
  const base = slugifyForwarderSeed(seed, fallback);

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = attempt === 0 ? base : slugWithRandomSuffix(base);
    const existing = await prisma.user.findUnique({
      where: { slug: candidate },
      select: { id: true },
    });
    if (!existing) return candidate;
  }

  return slugWithRandomSuffix("user");
}

export const auth = betterAuth({
  database: prismaAdapter(
    // The shared client from @ws-model-proxy/db is ALREADY wrapped by the
    // db-seam shutdown fence (Part G pass 2, G1): the fence now covers BOTH
    // better-auth's adapter operations AND the direct procedure/diagnostic
    // calls every other consumer of the ONE shared client makes. Once the
    // MCP shutdown gate closes (apps/server/src/app.ts wires the gate's
    // onClosed into armAuthDbShutdownFence — a thin delegation to
    // armDbShutdownFence), any NEW database operation initiated by any
    // continuation of this auth instance (including the un-cancellable
    // requireMcpAuth verifier continuations doing DPoP replay
    // reservations) rejects immediately. See
    // @ws-model-proxy/db/shutdown-fence for the full rationale. There is
    // deliberately NO second wrapper here (no double-wrapping).
    prisma,
    {
      provider: "postgresql",
    },
  ),

  logger: {
    // Sanitizing bridge choke point (invariant 10 / L19, pass 9 —
    // TERMINAL policy v3: structure-triggered WHOLE-MESSAGE redaction):
    // non-string first args emit only `[auth] <level> (<ctor|typeof>)`;
    // string firsts containing ANY structural character (`://`, `//`,
    // `\`, `=`, control chars) emit exactly
    // `[auth] <level> [message-redacted: untrusted structure]` — the
    // message NEVER appears; clean static messages pass verbatim
    // (200-char final-safety truncation) with `(Error: <ctor>)` markers
    // at error/warn only. info drops rest args; debug logs nothing.
    // Decision table + rationale in ./auth-logger-bridge.ts.
    log(level, message, ...args) {
      const call = resolveAuthLogCall(level, message, args);
      if (call) console[call.method](...call.args);
    },
  },

  // Sanitized API-error sink (invariant 10 / L19): providing onError
  // REPLACES Better Auth's default error logging (which logs e.message
  // wholesale for Prisma-shaped errors). See api-error-logging.ts.
  onAPIError: {
    onError: (error: unknown) => {
      // DEL-STATE commit point: the session trigger's refusal answers 403
      // like the session.create.before hook (./user-deletion-access-guard.ts).
      mapSessionRefusalToForbidden(error);
      const line = sanitizedApiErrorLogLine(error);
      if (line !== null) console.error(line);
    },
  },

  trustedOrigins: isCrossOrigin ? [env.CORS_ORIGIN!, env.BETTER_AUTH_URL] : [env.BETTER_AUTH_URL],
  user: {
    additionalFields: {
      // Surface the Prisma `User.locale` column on the typed session so the
      // web app can read `session.user.locale` (and the i18n hook can sync it
      // into i18next). Default mirrors the Prisma `@default("en-US")` so a
      // pre-existing user that hasn't picked a locale yet reads as en-US.
      locale: {
        type: "string",
        required: false,
        defaultValue: "en-US",
        input: false, // not settable via signUp/updateUser; goes through the dedicated procedure
      },
      operationalAlerts: {
        type: "boolean",
        required: false,
        defaultValue: true,
        input: false,
      },
      slug: {
        type: "string",
        required: false,
        input: true,
        validator: {
          input: userSlugInputSchema,
        },
      },
    },
  },
  emailAndPassword: {
    enabled: true,
    // Product policy: keep the creation/reset minimum at eight characters.
    minPasswordLength: 8,
    // When SMTP is unset the app is fully usable without mail. When SMTP is
    // configured, require a verified address for email/password sign-in.
    requireEmailVerification: emailConfigured,
  },
  emailVerification: {
    sendVerificationEmail: async ({ user, url }) => {
      // Better-Auth's `additionalFields` are present at runtime but the
      // sendVerificationEmail callback's `user` is typed against the base
      // user shape — `locale` isn't on it. Fetch the row via Prisma so the
      // recipient's preferred locale routes through to the renderer (which
      // falls back to en-US for any unsupported / missing value).
      const row = await prisma.user.findUnique({
        where: { id: user.id },
        select: { locale: true },
      });
      const { subject, html } = renderVerifyEmail({
        // Rewrite callbackURL to the locale-prefixed verify-email page with a
        // safe open-redirect guard. CORS_ORIGIN is the web origin on
        // split-origin deploys so the absolute callback lands on the app.
        url: withVerificationCallback(url, row?.locale, env.CORS_ORIGIN),
        locale: row?.locale ?? "en-US",
      });
      await sendEmail({
        to: user.email,
        subject,
        html,
      });
    },
    sendOnSignUp: emailConfigured,
    // Re-send when an unverified user tries to sign in (only meaningful with
    // requireEmailVerification). Without SMTP this stays off.
    sendOnSignIn: emailConfigured,
  },
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  session: {
    // Deliberately do not enable Better Auth cookieCache. Session revocation,
    // bans, and role changes must take effect on the next request rather than
    // after a cached-cookie freshness window.
    // session:30d, refresh every 1d
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
  },
  advanced: {
    // Native joins (bucket C of the L19 TERMINAL log policy, pass 6): the
    // installed @better-auth/prisma-adapter implements native joins when
    // this flag is set (core factory.mjs passes the join clause through to
    // findOne/findMany at :561/:609 and transformOutput reads the joined
    // key from the adapter row instead of triggering handleFallbackJoin),
    // which removes the session→user fallback-join (a separate user query
    // whose rejection used to reach the console as a raw Error) at the
    // root. The console shim (bucket B, apps/server better-call-error-log-
    // shim) remains the terminal guarantee: factory.mjs:191-195 still
    // reaches handleFallbackJoin whenever a joined key is absent from the
    // returned row.
    database: { joins: true },
    defaultCookieAttributes: isCrossOrigin
      ? { sameSite: "none", secure: true, httpOnly: true }
      : { httpOnly: true, secure: env.NODE_ENV === "production" },
  },
  plugins: [
    admin({
      defaultRole: "user",
    }),
    twoFactor({
      issuer: "WS Model Proxy",
      // Email OTP as a second factor — only wired when SMTP is configured.
      // TOTP + backup codes always remain available regardless.
      //
      // Caveat (documented, mitigated elsewhere): Better-Auth's send-otp
      // endpoint catches a thrown/rejected sendOTP and still returns
      // { status: true } (otp/index.ts) — it will NOT surface an SMTP failure to
      // the caller. The login challenge therefore preflights SMTP reachability
      // via `auth.verifyEmailTransport` (→ mailer `verifyTransport()`) before
      // claiming a code was sent. Here we just do the real send and let a
      // failure throw so it is logged server-side.
      ...(env.SMTP_HOST
        ? {
            otpOptions: {
              // Hash codes at rest rather than storing them in plaintext
              // (Better-Auth's default).
              storeOTP: "hashed" as const,
              sendOTP: async ({
                user,
                otp,
              }: {
                user: { id: string; email: string };
                otp: string;
              }) => {
                // additionalFields like `locale` aren't on the callback's typed
                // user shape — fetch the row so the code email is localized
                // (renderer falls back to en-US for missing/unsupported values).
                const row = await prisma.user.findUnique({
                  where: { id: user.id },
                  select: { locale: true },
                });
                const { subject, html } = renderTwoFactorOtp({
                  otp,
                  locale: row?.locale ?? "en-US",
                });
                await sendEmail({ to: user.email, subject, html });
              },
            },
          }
        : {}),
    }),
    // Nodes enroll with a one-time code minted in the browser (`nodes.enrollmentCodes`,
    // plain-HTTP exchange); there is no device-authorization flow in 0.4.0.
    // MCP/OAuth surface. Installed while WMP_MCP_ENABLED is true (the default):
    // jwt/mcp/cimd from Better Auth 1.7.3. The kill switch leaves this spread
    // empty, so the plugin list above is exactly admin and twoFactor.
    ...resolveMcpPlugins({
      enabled: env.WMP_MCP_ENABLED,
      baseUrl: env.BETTER_AUTH_URL,
    }),
  ],
  hooks: {
    // Defense in depth for the pending-deletion restore contract
    // (./user-deletion-access-guard.ts); consumers enforce the marker.
    before: createAuthMiddleware(async (ctx) => {
      await refuseAdminRestoreOfDeletingUser(ctx);
    }),
  },
  databaseHooks: {
    // On a user-delete route, Better Auth deletes sessions and accounts
    // before the user. These hooks refuse a delete that retained history
    // would fail before the first of them is removed
    // (./user-deletion-preflight.ts).
    session: {
      // A pending deletion refuses every new session whatever the ban fields
      // hold (./user-deletion-access-guard.ts).
      create: {
        before: async (session) => {
          await refuseSessionForDeletingUser(session);
        },
      },
      delete: {
        before: async (session, context) => {
          await refuseUndeletableUserBeforeCredentialDelete(session, context);
        },
      },
    },
    account: {
      delete: {
        before: async (account, context) => {
          await refuseUndeletableUserBeforeCredentialDelete(account, context);
        },
      },
    },
    user: {
      create: {
        before: async (user, context) => {
          const { signupEnabled, userCount } = await getSignupAccessState();
          const bootstrapAdminIdentity = resolveBootstrapAdminIdentity(user.email);
          // An invite link (the `x-wsmp-invite` header, public sign-up route only). With open
          // sign-up off it is what lets this sign-up through, so it must be pending here and
          // reserved below.
          const inviteToken = signupInviteToken(context);
          const reliesOnInvite =
            !signupEnabled && !(userCount === 0 && bootstrapAdminIdentity.allowed);
          const inviteTokenPending =
            !signupEnabled &&
            inviteToken !== null &&
            (await isPendingShareInviteToken(inviteToken));
          const policy = resolveUserCreatePolicy(
            toUserCreatePolicyInput({
              signupEnabled,
              userCount,
              adminBootstrapAllowed: bootstrapAdminIdentity.allowed,
              inviteTokenPending,
              emailConfigured,
              user,
              context,
            }),
          );
          const slug = await resolveUniqueUserSlug({
            requestedSlug: typeof user.slug === "string" ? user.slug.trim() : undefined,
            name: typeof user.name === "string" ? user.name : undefined,
            email: typeof user.email === "string" ? user.email : undefined,
          });
          // Reserve the invite for this sign-up's e-mail (compare-and-swap), after every other
          // refusal so a refused request does not hold it. The claim is written outside the
          // sign-up transaction: if the insert rolls back, the same e-mail can retry at once.
          // Another e-mail inside the claim window gets "in use"; an invite that is no longer
          // available refuses the sign-up only when the invite is what admits it.
          if (inviteToken !== null && context && typeof user.email === "string") {
            const claim = await claimShareInviteToken(inviteToken, user.email);
            if (claim === "claimed") inviteClaims.set(context, inviteToken);
            else if (claim === "in_use") throw inviteInUseError();
            else if (reliesOnInvite) throw new SignupDisabledError();
          }
          const locale = resolveSignupLocale(context?.headers);
          return {
            data: {
              ...user,
              // The create hook runs before the adapter's Prisma insert. For
              // production bootstrap requests, write the configured canonical
              // identity so concurrent case/whitespace variants collide on
              // User.@@unique([email]) and only one request can win.
              email: bootstrapAdminIdentity.canonicalEmail ?? user.email,
              slug,
              locale,
              ...(policy.emailVerified ? { emailVerified: true } : {}),
              role: policy.role,
            },
          };
        },
        // The invite link the person signed up through becomes a share (the token is the
        // proof); pending share invites to this e-mail become shares once the e-mail is proven.
        after: async (user, context) => {
          // An admin-created account's e-mail is marked verified without proof (the admin
          // knows its temporary password), so its invites wait for the invite link.
          if (isAdminCreateUserPath(typeof context?.path === "string" ? context.path : null)) {
            return;
          }
          const claimedToken = context ? inviteClaims.get(context) : undefined;
          if (context && claimedToken) {
            inviteClaims.delete(context);
            await acceptClaimedInviteQuietly(user, claimedToken);
          }
          await acceptInvitesQuietly(user);
        },
      },
      update: {
        // The account slug is the first half of every callable ID of the person's pools, in
        // their share holders' namespaces too: it changes only through `settings.update`, which
        // claims the renamed IDs under everyone's owner fences (packages/api lib/model-names.ts).
        // Better Auth's update routes (`/update-user`, `/admin/update-user`) cannot take them.
        before: async (data) => {
          if ((data as { slug?: unknown }).slug !== undefined) throw slugChangeRefused();
        },
        // A user row that now carries an ACTIVE ban (`/admin/ban-user`, or an
        // `/admin/update-user` that sets `banned`) ends the user's in-flight
        // relay work. Better Auth runs `after` once the update's transaction
        // committed. Any later update of a still-banned user notifies again;
        // the cancel is idempotent. An unban or an expired ban notifies nothing.
        after: async (user, context) => {
          if (!user) return;
          // Verifying the e-mail proves it (for direct shares) and accepts the invites sent to
          // it — only on the verification routes: an admin-created account is "verified"
          // without proof.
          if (isEmailVerificationPath(context?.path)) {
            await recordProvedEmailQuietly(user);
            await acceptInvitesQuietly(user);
          }
          const row = user as { id: string; banned?: unknown; banExpires?: unknown };
          if (
            isUserBanned(
              {
                banned: row.banned === true,
                banExpires: row.banExpires instanceof Date ? row.banExpires : null,
              },
              new Date(),
            )
          ) {
            await notifyUserBanned(row.id);
          }
        },
      },
      delete: {
        // Admin remove-user (and the self-service delete-user route, which is
        // not enabled) reach internalAdapter.deleteUser after deleting the
        // user's sessions and accounts. Its plain adapter DELETE would bypass
        // the owner fences every graph write takes (DL-1 writer class M; the
        // graph-write fence trigger refuses it) and the history drain. The
        // hook performs the durable, bounded delete itself
        // (@ws-model-proxy/db/parent-deletion: preflight, deletion marker and
        // ban, history drain in short batches, then the graph delete under
        // owner fences) and returns false so Better Auth skips its own
        // DELETE. Retained history was already refused before sessions and
        // accounts were touched (./user-deletion-preflight.ts). If completion
        // fails transiently the marker stays and the deletion sweeper finishes
        // the user, so the route still reports success. After the delete
        // commits, close the deleted user's live relay sessions in this
        // process (see user-deletion-listeners.ts); Better Auth runs no
        // delete.after for a delete the before hook declined.
        before: async (user) => {
          const result = await deleteUserDurably(prisma, user.id, {
            onMarked: notifyUserDeletionMarked,
            onTransientFailure: (error) =>
              console.error(
                "[auth] user delete incomplete, the deletion sweeper will finish it:",
                error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error,
              ),
          });
          if (result === "deleted") await notifyUserDeleted(user.id);
          return false;
        },
      },
    },
  },
});

export type Session = typeof auth.$Infer.Session;
