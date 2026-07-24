/**
 * THE canonical description of every environment variable in this repo.
 *
 * Three things read this file:
 *   1. `pnpm generate:secrets`  — builds a ready-to-paste production env block.
 *   2. `pnpm env:sync`          — regenerates `.env.example` and `apps/web/.env.example`.
 *   3. `pnpm env:check`         — CI gate for schema ↔ manifest ↔ example drift.
 *
 * ADDING A NEW ENVIRONMENT VARIABLE
 *   1. Declare it in the right `packages/env/src/*.ts` schema.
 *   2. Add an entry to `ENV_VARS` below.
 *   3. Run `pnpm env:sync` and commit the regenerated `.env.example` files.
 *
 * Scoped to WS Model Proxy only — no CMS, S3, video, Redis, worker, native, or
 * VAPID/push variables.
 */

// ---------------------------------------------------------------------------
// Deploy targets
// ---------------------------------------------------------------------------

export const DEPLOY_TARGETS = [
  {
    id: "render",
    label: "Render",
    doc: "README.md",
    injects: ["DATABASE_URL", "PORT"],
    note: "Render injects DATABASE_URL from managed Postgres and sets PORT. Leave both out of the env block you paste if the platform provides them.",
    alsoMints: ["BETTER_AUTH_SECRET"],
  },
  {
    id: "railway",
    label: "Railway",
    doc: "README.md",
    injects: ["DATABASE_URL", "PORT"],
    note: "Railway sets PORT; wire DATABASE_URL as a service reference to Postgres.",
  },
  {
    id: "vps",
    label: "VPS / Docker",
    doc: "README.md",
    injects: [],
    note: "You own Postgres, so you supply DATABASE_URL.",
  },
  {
    id: "azure",
    label: "Azure Container Apps",
    doc: "README.md",
    injects: [],
    note: "Supply DATABASE_URL from Azure Database for PostgreSQL.",
  },
  {
    id: "other",
    label: "Other / not sure",
    doc: "README.md",
    injects: [],
    note: "Prompting for every non-defaulted variable. Delete anything your platform injects for you.",
  },
] as const;

export type DeployTargetId = (typeof DEPLOY_TARGETS)[number]["id"];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EnvFile = "root" | "web" | "native";

interface EnvGroup {
  id: string;
  title: string;
  file?: EnvFile;
  always?: boolean;
  prompt?: string;
  default?: boolean;
  tuning?: boolean;
  requiredWhen?: { key: string; equals: string; because: string };
  reuseFromEnv?: boolean;
  comment?: string[];
}

export interface EnvVar {
  key: string;
  group: string;
  source: "generate" | "prompt" | "confirm" | "enable" | "default" | "manual";
  generator?: "secret32" | "vapid-public" | "vapid-private";
  default?: string;
  defaultFrom?: "schema" | "app";
  choices?: Array<{ value: string; label?: string; description?: string }>;
  format?: "origin" | "push-subject";
  reusable?: boolean;
  blueprintExempt?: boolean;
  omittable?: boolean;
  required?: boolean;
  prompt?: string;
  confirmDefault?: boolean;
  hint?: string;
  example?: string;
  exampleSet?: boolean;
  secret?: boolean;
  file?: EnvFile;
  inSchema?: boolean;
  comment?: string[];
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

export const ENV_GROUPS: EnvGroup[] = [
  {
    id: "core",
    title: "Datastore",
    always: true,
  },
  {
    id: "runtime",
    title: "Runtime + schema sync",
    always: true,
    comment: [
      "APPLY_SCHEMA gates whether `prisma db push` runs at container start.",
      "Set it to `safe` on a schema-changing deploy, then flip it back to `off`.",
    ],
  },
  {
    id: "auth",
    title: "Auth",
    always: true,
  },
  {
    id: "admin",
    title: "Signup",
    always: true,
  },
  {
    id: "smtp",
    reuseFromEnv: true,
    title: "Email (SMTP)",
    prompt: "Configure outgoing email (SMTP)?",
    default: false,
    comment: [
      "OPTIONAL. Without SMTP the app is fully usable: email/password auth",
      "works and verification is not required. With SMTP configured, the",
      "server requires email verification and sends verification/reset/2FA mail.",
      "Local sink: docker run -d -p 1025:1025 -p 8025:8025 axllent/mailpit",
    ],
  },
  {
    id: "translation",
    reuseFromEnv: true,
    title: "Translation provider (i18n tooling)",
    prompt: "Configure locale-bundle translation API keys?",
    default: false,
    comment: ["Optional. Used only by `pnpm i18n:translate`. The app boots without these."],
  },
  {
    id: "media",
    reuseFromEnv: true,
    title: "Ephemeral media store",
    prompt: "Configure the ephemeral media store (image/audio/video uploads)?",
    default: false,
    comment: [
      "OPTIONAL. Upload is a DEPLOY CAPABILITY, not a UI toggle: it turns on only",
      "when MEDIA_STORAGE=local AND MEDIA_ROOT is a writable absolute path (mount",
      "a Docker volume there). When off, upload endpoints return a clear",
      '"media upload is not configured" error and clients fall back to base64 /',
      "external URLs. Signed GET URLs derive their HMAC key from",
      "BETTER_AUTH_SECRET — there is no separate media signing secret.",
    ],
  },
  {
    id: "ratelimit",
    title: "Rate limiting",
    tuning: true,
    comment: ["Optional tuning. Sensible defaults are built into packages/env."],
  },
  {
    id: "ssr",
    title: "SSR cache",
    tuning: true,
    comment: ["Anonymous SSR HTML cache for public locale pages."],
  },
  {
    id: "web",
    title: "Web app (build-time, public)",
    file: "web",
    always: true,
    comment: ["BUILD-TIME client vars — inlined into the browser bundle. Never put a secret here."],
  },
];

// ---------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------

export const ENV_VARS: EnvVar[] = [
  // --- core ----------------------------------------------------------------
  {
    key: "DATABASE_URL",
    group: "core",
    source: "prompt",
    required: true,
    omittable: true,
    secret: true,
    prompt: "PostgreSQL connection string",
    hint: "e.g. postgresql://user:password@host:5432/dbname — or leave blank if the platform injects it",
    example: "postgresql://postgres:password@localhost:5432/ws-model-proxy",
    exampleSet: true,
  },

  // --- runtime -------------------------------------------------------------
  {
    key: "NODE_ENV",
    group: "runtime",
    source: "default",
    default: "development",
    choices: [{ value: "production" }, { value: "development" }, { value: "test" }],
    example: "production",
    comment: [
      "Set to `production` on every deployed environment. Weak BETTER_AUTH_SECRET",
      "escalates from a warning to a hard boot failure when this is `production`.",
    ],
  },
  {
    key: "APPLY_SCHEMA",
    group: "runtime",
    source: "default",
    default: "off",
    choices: [{ value: "off" }, { value: "safe" }, { value: "dangerous" }],
    inSchema: false,
    example: "off",
    comment: [
      "off | safe | dangerous. Read by scripts/docker-entrypoint.sh, not by Zod.",
      "Keep `off` for a normal deploy.",
    ],
  },
  {
    key: "PORT",
    group: "runtime",
    blueprintExempt: true,
    source: "default",
    comment: ["Injected by most platforms. Leave unset unless you run the container by hand."],
  },
  {
    key: "SERVER_PORT",
    group: "runtime",
    blueprintExempt: true,
    source: "default",
    default: "3000",
    defaultFrom: "app",
    comment: [
      "Raw local runs (`pnpm dev:raw`) and container overrides only. Leave unset",
      "for the default portless dev flow.",
    ],
  },

  // --- auth ----------------------------------------------------------------
  {
    key: "BETTER_AUTH_SECRET",
    group: "auth",
    source: "generate",
    generator: "secret32",
    required: true,
    secret: true,
    comment: [
      "REQUIRED, minimum 32 characters. Rotating this invalidates every session",
      "and purpose-specific HMAC credentials derived from it (model API tokens,",
      "CLI tokens, device credentials, sticky-routing digests).",
      "",
      "Local: filled by `pnpm run setup`, or `pnpm generate:secret`.",
      "Production: prefer `pnpm generate:secrets`.",
    ],
  },
  {
    key: "BETTER_AUTH_URL",
    format: "origin",
    group: "auth",
    source: "prompt",
    required: true,
    prompt: "Public app origin (auth callbacks and SEO)",
    hint: "Origin only — no path, query, hash, or credentials. e.g. https://proxy.example.com",
    example: "https://ws-model-proxy.localhost",
    exampleSet: true,
  },
  {
    key: "CORS_ORIGIN",
    format: "origin",
    group: "auth",
    source: "manual",
    example: "https://app.example.com",
    comment: [
      "Optional. Set ONLY when the browser app runs on a different origin than",
      "the API. Leave unset for the default same-origin Docker deploy.",
    ],
  },
  {
    key: "TRUST_PROXY_HOPS",
    group: "auth",
    source: "manual",
    example: "1",
    comment: [
      "Reverse-proxy hop count for the anonymous rate-limit IP. Leave UNSET for",
      "auto-detect behind a private-network proxy. Set only when a proxy has a",
      "PUBLIC IP (e.g. Cloudflare). 0 disables X-Forwarded-For.",
    ],
  },

  // --- admin / signup ------------------------------------------------------
  {
    key: "SIGNUP_ENABLED",
    group: "admin",
    source: "confirm",
    confirmDefault: false,
    prompt: "Enable public signup after first-user bootstrap",
    hint: "The first account on an empty DB is always allowed and becomes admin. Later public signup requires this flag.",
    default: "false",
    example: "false",
    comment: [
      "DISABLED by default after the first-user bootstrap. The first signup on",
      "an empty instance is allowed and becomes admin; later public signup",
      "requires this set to true. SMTP is NOT required for signup — without",
      "SMTP, verification is off and accounts are marked verified at create.",
    ],
  },

  // --- smtp ----------------------------------------------------------------
  {
    key: "SMTP_HOST",
    group: "smtp",
    source: "prompt",
    required: true,
    prompt: "SMTP host",
    hint: "e.g. smtp.resend.com, email-smtp.us-east-1.amazonaws.com, localhost for mailpit",
    example: "localhost",
  },
  {
    key: "SMTP_PORT",
    group: "smtp",
    source: "prompt",
    required: true,
    prompt: "SMTP port",
    hint: "587 STARTTLS, 465 implicit TLS, 1025 local mailpit",
    example: "1025",
  },
  {
    key: "SMTP_USER",
    group: "smtp",
    source: "prompt",
    prompt: "SMTP username (blank if not required)",
    example: "",
  },
  {
    key: "SMTP_PASS",
    group: "smtp",
    source: "prompt",
    secret: true,
    prompt: "SMTP password / API key (blank if not required)",
    example: "",
  },
  {
    key: "SMTP_FROM",
    group: "smtp",
    source: "prompt",
    required: true,
    reusable: false,
    prompt: "From: address for outgoing mail",
    hint: 'e.g. "WS Model Proxy <no-reply@yourdomain.com>"',
    example: "noreply@example.com",
  },

  // --- translation ---------------------------------------------------------
  {
    key: "TRANSLATION_PROVIDER",
    group: "translation",
    source: "default",
    default: "openrouter",
    choices: [{ value: "openrouter" }, { value: "anthropic" }],
    example: "openrouter",
  },
  {
    key: "TRANSLATION_MODEL",
    group: "translation",
    source: "manual",
    example: "anthropic/claude-haiku-4-5",
    comment: ["Optional model override for the chosen provider."],
  },
  {
    key: "OPENROUTER_API_KEY",
    group: "translation",
    source: "prompt",
    secret: true,
    prompt: "OpenRouter API key (blank if using Anthropic only)",
    example: "",
  },
  {
    key: "ANTHROPIC_API_KEY",
    group: "translation",
    source: "prompt",
    secret: true,
    prompt: "Anthropic API key (blank if using OpenRouter only)",
    example: "",
  },
  {
    key: "PUBLIC_APP_URL",
    format: "origin",
    group: "translation",
    source: "manual",
    example: "https://ws-model-proxy.example.com",
    comment: ["Optional public origin metadata for some translation providers."],
  },

  // --- media ---------------------------------------------------------------
  {
    key: "MEDIA_STORAGE",
    group: "media",
    source: "default",
    default: "off",
    choices: [{ value: "off" }, { value: "local" }],
    example: "local",
    comment: [
      "off | local (future: s3). `local` requires MEDIA_ROOT below. Leave `off`",
      "to disable uploads entirely.",
    ],
  },
  {
    key: "MEDIA_ROOT",
    group: "media",
    source: "prompt",
    required: true,
    prompt: "Absolute path for the media object directory",
    hint: "Must be absolute and writable, e.g. a mounted volume: /var/lib/wmp/media",
    example: "/var/lib/wmp/media",
  },
  {
    key: "MEDIA_MAX_UPLOAD_BYTES",
    group: "media",
    source: "default",
    default: "26214400",
    example: "26214400",
    comment: [
      "Hard per-upload byte cap (default 25 MiB). The upload route enforces its",
      "own body limit at this size, independent of the global 10 MB limiter.",
    ],
  },
  {
    key: "MEDIA_PUBLIC_BASE_URL",
    format: "origin",
    group: "media",
    source: "manual",
    example: "https://proxy.example.com",
    comment: [
      "Public origin used to build signed media URLs. Defaults to BETTER_AUTH_URL",
      "when unset. Set only if media is served from a different origin.",
    ],
  },
  {
    key: "MEDIA_MAX_BYTES_PER_USER",
    group: "media",
    source: "default",
    default: "536870912",
    example: "536870912",
    comment: [
      "Per-user storage quota: total bytes one user may hold in unexpired media",
      "assets (default 512 MiB). A sha256 dedup hit adds no new bytes and is",
      "exempt. Set 0 to disable the quota.",
    ],
  },

  // --- rate limit tuning ---------------------------------------------------
  {
    key: "RATE_LIMIT_RPC_POINTS",
    group: "ratelimit",
    source: "default",
    default: "100",
  },
  {
    key: "RATE_LIMIT_RPC_DURATION",
    group: "ratelimit",
    source: "default",
    default: "60",
  },
  {
    key: "RATE_LIMIT_AUTH_POINTS",
    group: "ratelimit",
    source: "default",
    default: "10",
  },
  {
    key: "RATE_LIMIT_AUTH_DURATION",
    group: "ratelimit",
    source: "default",
    default: "60",
  },
  {
    key: "RATE_LIMIT_AUTH_BLOCK_DURATION",
    group: "ratelimit",
    source: "default",
    default: "900",
  },
  {
    key: "RATE_LIMIT_SIGNUP_POINTS",
    group: "ratelimit",
    source: "default",
    default: "3",
  },
  {
    key: "RATE_LIMIT_SIGNUP_DURATION",
    group: "ratelimit",
    source: "default",
    default: "3600",
  },
  {
    key: "RATE_LIMIT_SIGNUP_BLOCK_DURATION",
    group: "ratelimit",
    source: "default",
    default: "3600",
  },
  {
    key: "RATE_LIMIT_EMAIL_RECIPIENT_POINTS",
    group: "ratelimit",
    source: "default",
    default: "3",
    comment: [
      "Per-recipient cap on anonymous mail endpoints (verification resend,",
      "password reset). 0 disables. Keys on the email address, not IP.",
    ],
  },
  {
    key: "RATE_LIMIT_EMAIL_RECIPIENT_DURATION",
    group: "ratelimit",
    source: "default",
    default: "3600",
  },
  {
    key: "RATE_LIMIT_EMAIL_RECIPIENT_BLOCK_DURATION",
    group: "ratelimit",
    source: "default",
    default: "0",
    comment: ["Keep 0 so attacker-supplied addresses cannot lock out legitimate resets."],
  },
  {
    key: "RATE_LIMIT_SIGNUP_RECIPIENT_POINTS",
    group: "ratelimit",
    source: "default",
    default: "6",
    comment: ["Per-recipient cap on /api/auth/sign-up/email (separate from reset/resend)."],
  },

  // --- ssr -----------------------------------------------------------------
  {
    key: "SSR_CACHE_TTL_SECONDS",
    group: "ssr",
    source: "default",
    default: "60",
    comment: ["Anonymous SSR HTML cache TTL for public pages. 0 disables."],
  },

  // --- web -----------------------------------------------------------------
  {
    key: "VITE_APP_NAME",
    group: "web",
    file: "web",
    source: "default",
    default: "WS Model Proxy",
    defaultFrom: "app",
    example: "WS Model Proxy",
    comment: ["Used in the app shell title/header."],
  },
  {
    key: "VITE_SERVER_URL",
    group: "web",
    file: "web",
    source: "manual",
    example: "http://localhost:3000",
    comment: [
      "API origin. Defaults to window.location.origin at runtime — leave unset",
      "for the portless/Vite proxy flow.",
    ],
  },
  {
    key: "VITE_DEV_PORT",
    group: "web",
    file: "web",
    source: "manual",
    example: "3001",
    comment: ["Raw dev-server knobs. Leave unset with portless."],
  },
  {
    key: "VITE_DEV_SERVER_URL",
    group: "web",
    file: "web",
    source: "manual",
    example: "http://localhost:3000",
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function groupsForFile(file: EnvFile): EnvGroup[] {
  return ENV_GROUPS.filter((g) => (g.file ?? "root") === file);
}

export function varsInGroup(groupId: string): EnvVar[] {
  return ENV_VARS.filter((v) => v.group === groupId);
}
