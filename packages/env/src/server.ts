import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";
import { env as sharedEnv, strictBooleanFlag } from "./shared.js";
import { originUrl } from "./url.js";

// ---------------------------------------------------------------------------
// Full server environment.
//
// `extends: [sharedEnv]` merges in everything ./shared.ts already validated
// (database, SMTP, translation tooling) so server-side code keeps seeing a
// single `env` with every field. This module adds only the server-only
// variables and the startup guards that depend on them.
//
// Disjointness contract: no key declared here may also appear in
// ./shared.ts — `extends` merges, it does not allow overriding.
// ---------------------------------------------------------------------------

export const env = createEnv({
  extends: [sharedEnv],
  server: {
    // Optional process port override. Portless and production platforms inject
    // `PORT`; `SERVER_PORT` is only for raw local runs or container overrides.
    PORT: z.coerce.number().int().min(1).max(65_535).optional(),
    SERVER_PORT: z.coerce.number().int().min(1).max(65_535).optional(),
    BETTER_AUTH_SECRET: z.string().min(32),
    BETTER_AUTH_URL: originUrl("BETTER_AUTH_URL"),
    CORS_ORIGIN: originUrl("CORS_ORIGIN").optional(),
    SIGNUP_ENABLED: strictBooleanFlag(),
    RATE_LIMIT_RPC_POINTS: z.coerce.number().int().positive().default(100),
    RATE_LIMIT_RPC_DURATION: z.coerce.number().int().positive().default(60),
    RATE_LIMIT_AUTH_POINTS: z.coerce.number().int().positive().default(10),
    RATE_LIMIT_AUTH_DURATION: z.coerce.number().int().positive().default(60),
    RATE_LIMIT_AUTH_BLOCK_DURATION: z.coerce.number().int().positive().default(900),
    RATE_LIMIT_SIGNUP_POINTS: z.coerce.number().int().positive().default(3),
    RATE_LIMIT_SIGNUP_DURATION: z.coerce.number().int().positive().default(3600),
    RATE_LIMIT_SIGNUP_BLOCK_DURATION: z.coerce.number().int().positive().default(3600),
    SSR_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).default(60),
    // Number of reverse-proxy hops in front of the app, for deriving the real
    // client IP used as the anonymous rate-limit key.
    //
    // Leave UNSET (the default) for zero-config behaviour that is correct for
    // every deploy target in our docs (reverse proxy, managed container hosts,
    // Container Apps): the app trusts the client IP that a proxy on a
    // private/loopback network forwarded, and otherwise (bare deployment, local
    // dev) keys on the real socket peer. See apps/server/src/client-ip.ts.
    //
    // Set this only when a proxy in front of the app has a PUBLIC IP (e.g.
    // Cloudflare, a public load balancer) or your topology is fixed: it is the
    // exact number of proxies between the client and the app. 0 disables
    // X-Forwarded-For entirely and always keys on the socket peer.
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).optional(),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});

export const SIGNUP_ENABLED: boolean = env.SIGNUP_ENABLED;

// ---------------------------------------------------------------------------
// BETTER_AUTH_SECRET entropy check — catch weak/placeholder secrets early.
// ---------------------------------------------------------------------------
const WEAK_PLACEHOLDERS = [
  "changeme",
  "secret",
  "password",
  "your-secret-here",
  "replace-me",
  "placeholder",
];

function isWeakSecret(secret: string): string | null {
  // All-same-character strings (e.g. "aaaaaaaaaa…")
  if (new Set(secret).size === 1) {
    return "all characters are identical";
  }
  // Repeating hex-like patterns (e.g. "xxxxxxxx…", "00000000…")
  if (/^(.)\1+$/.test(secret) || /^(..)\1+$/.test(secret)) {
    return "repeating pattern detected";
  }
  // Known placeholder words (case-insensitive)
  const lower = secret.toLowerCase();
  for (const placeholder of WEAK_PLACEHOLDERS) {
    if (lower === placeholder || lower.includes(placeholder)) {
      return `contains placeholder word "${placeholder}"`;
    }
  }
  // Fewer than 10 distinct characters → low entropy
  if (new Set(secret).size < 10) {
    return `only ${new Set(secret).size} distinct characters (need at least 10)`;
  }
  return null;
}

const weakReason = isWeakSecret(env.BETTER_AUTH_SECRET);
if (weakReason) {
  const msg =
    `[env] BETTER_AUTH_SECRET is weak: ${weakReason}. ` +
    "Generate a strong secret with: pnpm generate:secret";
  if (env.NODE_ENV === "production") {
    throw new Error(msg);
  }
  console.warn(msg);
}
