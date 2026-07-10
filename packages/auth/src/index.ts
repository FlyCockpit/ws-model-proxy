import { randomBytes } from "node:crypto";
import {
  FORWARDER_SLUG_MAX_LENGTH,
  slugifyForwarderSeed,
  validateForwarderSlug,
} from "@ws-model-proxy/config/forwarder-identifiers";
import prisma from "@ws-model-proxy/db";
import { env } from "@ws-model-proxy/env/server";
import { renderTwoFactorOtp, renderVerifyEmail, sendEmail } from "@ws-model-proxy/mailer";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { admin, deviceAuthorization, twoFactor } from "better-auth/plugins";
import { z } from "zod";
import { getSignupAccessState, SIGNUP_DISABLED_MESSAGE } from "./signup-policy";

const isCrossOrigin = !!env.CORS_ORIGIN;

// Better-Auth emits "user input failed validation" cases (wrong password, unknown
// email, unverified email, etc.) at level=error. Those are normal end-user mistakes,
// not server faults — downgrade them to warn so production error dashboards stay
// signal-y. Anything we don't recognize keeps its original level.
const USER_INPUT_ERROR_PATTERN =
  /invalid (password|email|credentials|token|otp|two[- ]?factor)|user not found|email not verified|password is incorrect|account not found|failed to verify|already exists|too many (requests|attempts)/i;

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
  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),

  logger: {
    log(level, message, ...args) {
      const effective =
        level === "error" && USER_INPUT_ERROR_PATTERN.test(message) ? "warn" : level;
      if (effective === "error") console.error(`[auth] ${message}`, ...args);
      else if (effective === "warn") console.warn(`[auth] ${message}`, ...args);
      else if (effective === "info") console.info(`[auth] ${message}`, ...args);
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
    requireEmailVerification: false,
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
        url,
        locale: row?.locale ?? "en-US",
      });
      await sendEmail({
        to: user.email,
        subject,
        html,
      });
    },
    sendOnSignUp: Boolean(env.SMTP_HOST),
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
    // OAuth 2.0 Device Authorization Grant (RFC 8628). Lets CLI clients that
    // can't paste a static token bootstrap an admin session via /device. We do
    // not enable `oauthProvider` here — device flow alone is enough for MVP.
    // The plugin's options schema uses `z.custom(() => true)` for the
    // `schema` field without `.optional()`, so we have to pass it explicitly
    // (even as `undefined`) or zod rejects the call at startup.
    deviceAuthorization({
      expiresIn: "30m",
      interval: "5s",
      // The adapter looks up `db.deviceCode` by the schema key `deviceCode`,
      // and the options-schema parser marks `schema` as nonoptional, so pass
      // the Prisma model mapping explicitly.
      schema: { deviceCode: { modelName: "deviceCode" } },
    }),
  ],
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          const { signupEnabled, userCount } = await getSignupAccessState();
          const isFirstUser = userCount === 0;
          if (!signupEnabled && !isFirstUser) {
            throw new Error(SIGNUP_DISABLED_MESSAGE);
          }
          const slug = await resolveUniqueUserSlug({
            requestedSlug: typeof user.slug === "string" ? user.slug.trim() : undefined,
            name: typeof user.name === "string" ? user.name : undefined,
            email: typeof user.email === "string" ? user.email : undefined,
          });
          return {
            data: {
              ...user,
              slug,
              emailVerified: true,
              role: isFirstUser ? "admin" : "user",
            },
          };
        },
      },
    },
  },
});

export type Session = typeof auth.$Infer.Session;
