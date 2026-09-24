import { randomBytes } from "node:crypto";
import {
  FORWARDER_SLUG_MAX_LENGTH,
  slugifyForwarderSeed,
  validateForwarderSlug,
} from "@ws-model-proxy/config/forwarder-identifiers";
import prisma from "@ws-model-proxy/db";
import { env } from "@ws-model-proxy/env/server";
import {
  isEmailConfigured,
  renderTwoFactorOtp,
  renderVerifyEmail,
  sendEmail,
} from "@ws-model-proxy/mailer";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { admin, deviceAuthorization, twoFactor } from "better-auth/plugins";
import { z } from "zod";
import { sanitizedApiErrorLogLine } from "./api-error-logging";
import { resolveAuthLogCall } from "./auth-logger-bridge";
import {
  DISABLED_DEVICE_AUTHORIZATION_PATHS,
  requireCliDeviceLoginScope,
} from "./cli-device-login-scope";
import { resolveMcpPlugins } from "./mcp-plugins";
import { resolveSignupLocale } from "./signup-locale";
import { getSignupAccessState, resolveBootstrapAdminIdentity } from "./signup-policy";
import { resolveUserCreatePolicy, toUserCreatePolicyInput } from "./user-create-policy";
import { notifyUserDeleted } from "./user-deletion-listeners";
import { withVerificationCallback } from "./verification-callback";

const isCrossOrigin = !!env.CORS_ORIGIN;
/** Email/SMTP is optional; when configured, verification is required. */
const emailConfigured = isEmailConfigured();

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
  // Only the device-flow session endpoint; see DISABLED_DEVICE_AUTHORIZATION_PATHS.
  disabledPaths: [...DISABLED_DEVICE_AUTHORIZATION_PATHS],
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
    // OAuth 2.0 Device Authorization Grant (RFC 8628) for `wsmp login`. The
    // plugin handles the request and approval steps; the approved code is
    // redeemed only by `cliCredentials.exchangeDeviceCode` for one device
    // credential. Its session-minting `/device/token` is disabled above.
    // The plugin's options schema uses `z.custom(() => true)` for the
    // `schema` field without `.optional()`, so we have to pass it explicitly
    // (even as `undefined`) or zod rejects the call at startup.
    deviceAuthorization({
      expiresIn: "30m",
      interval: "5s",
      // Every request names the CLI slug it is for (`cli-slug:<slug>`); the
      // approval page shows it and the exchange mints for that slug only.
      onDeviceAuthRequest: requireCliDeviceLoginScope,
      // The adapter looks up `db.deviceCode` by the schema key `deviceCode`,
      // and the options-schema parser marks `schema` as nonoptional, so pass
      // the Prisma model mapping explicitly.
      schema: { deviceCode: { modelName: "deviceCode" } },
    }),
    // MCP/OAuth surface. Installed while WMP_MCP_ENABLED is true (the default):
    // jwt/mcp/cimd from Better Auth 1.7.3. The kill switch leaves this spread
    // empty, so the plugin list above is exactly admin, twoFactor, and
    // deviceAuthorization.
    ...resolveMcpPlugins({
      enabled: env.WMP_MCP_ENABLED,
      baseUrl: env.BETTER_AUTH_URL,
    }),
  ],
  databaseHooks: {
    user: {
      create: {
        before: async (user, context) => {
          const { signupEnabled, userCount } = await getSignupAccessState();
          const bootstrapAdminIdentity = resolveBootstrapAdminIdentity(user.email);
          const policy = resolveUserCreatePolicy(
            toUserCreatePolicyInput({
              signupEnabled,
              userCount,
              adminBootstrapAllowed: bootstrapAdminIdentity.allowed,
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
      },
      delete: {
        // Better Auth queues delete.after until its transaction commits
        // (admin remove-user and the self-service delete-user routes both go
        // through internalAdapter.deleteUser). Closes the deleted user's live
        // relay sessions in this process; see user-deletion-listeners.ts.
        after: async (user) => {
          await notifyUserDeleted(user.id);
        },
      },
    },
  },
});

export type Session = typeof auth.$Infer.Session;
