import fs from "node:fs";
import path from "node:path";
import { createEnv } from "@t3-oss/env-core";
import { config as loadEnv } from "dotenv";
import { z } from "zod";
import { originUrl } from "./url.js";

// ---------------------------------------------------------------------------
// Shared environment.
//
// The server's full surface lives in ./server.ts, which `extends` this module
// and adds server-only variables. SMTP is included here because both auth and
// standalone mailer code can use it.
//
// dotenv loading and the strict-boolean helper live here (not in ./server.ts)
// so that exactly one module owns them regardless of which entrypoint loads
// first: ./server.ts imports this file, so this runs before server validation.
// ---------------------------------------------------------------------------

export const strictBooleanFlag = (defaultValue: boolean = false) =>
  z
    .enum(["true", "false"])
    .default(defaultValue ? "true" : "false")
    .transform((value) => value === "true");

// Loaded once at module import. Path is resolved relative to this file, not CWD,
// so it works from any working directory and any build output location.
loadEnv({ path: path.resolve(import.meta.dirname, "../../../.env") });

// ---------------------------------------------------------------------------
// Warn if a stale per-app .env exists — the canonical location is repo root.
// ---------------------------------------------------------------------------
const staleEnvPath = path.resolve(import.meta.dirname, "../../../apps/server/.env");
if (fs.existsSync(staleEnvPath)) {
  console.warn(
    "[env] Found apps/server/.env — this file is no longer read. " +
      "The canonical .env location is the repository root. " +
      "Move its contents to the root .env and delete apps/server/.env to silence this warning.",
  );
}

export const env = createEnv({
  server: {
    DATABASE_URL: z.string().min(1),
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    // ---- Translation provider (optional). Kept for locale-bundle translation
    // tooling. The validator keeps both API keys optional so the rest of the
    // app boots without them; the provider factory throws at first use if the
    // key for the chosen provider is missing.
    //
    // Default provider is `openrouter` because it's the cheapest path to
    // claude-haiku-4-5 + gives a single account multi-model access for A/B
    // experiments. Set TRANSLATION_PROVIDER=anthropic to call the Anthropic
    // API directly with ANTHROPIC_API_KEY.
    OPENROUTER_API_KEY: z.string().min(1).optional(),
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    TRANSLATION_PROVIDER: z.enum(["openrouter", "anthropic"]).default("openrouter"),
    // Optional public origin metadata for translation providers such as
    // OpenRouter. This is not used for auth.
    PUBLIC_APP_URL: originUrl("PUBLIC_APP_URL").optional(),
    // ---- Email transport (optional). Shared because both auth and standalone
    // mailer code use @ws-model-proxy/mailer.
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().positive().optional(),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    SMTP_FROM: z.string().optional(),
    // Per-call model override. Falls through to the provider's default
    // (`anthropic/claude-haiku-4-5` for OpenRouter, `claude-haiku-4-5` for
    // direct Anthropic) when unset.
    TRANSLATION_MODEL: z.string().min(1).optional(),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
