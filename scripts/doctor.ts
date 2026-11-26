/**
 * Environment health-check. Validates env vars and tests connectivity to
 * Postgres and (optionally) SMTP. Does NOT mutate any state.
 *
 * Exit code: 0 if all required checks pass, 1 otherwise.
 *
 * Run: `pnpm doctor:app`
 */

import "@ws-model-proxy/env/load-dotenv";

import { spawnSync } from "node:child_process";
import { connect } from "node:net";
import { resolve } from "node:path";
import { isEnvConfigError } from "@ws-model-proxy/env/config-error";

import { PasswordPepperKeyError, pepperFingerprint } from "../packages/auth/src/password-pepper.js";

const ROOT = resolve(import.meta.dirname!, "..");

/**
 * Runs a tiny inline Node script inside a workspace package so we can use
 * dependencies (`@ws-model-proxy/db`) that live in that package without
 * adding them to the root package.json.
 */
function runInPackage(
  filter: string,
  script: string,
  extraEnv: Record<string, string> = {},
): { ok: boolean; output: string } {
  const result = spawnSync(
    "pnpm",
    ["--silent", "-F", filter, "exec", "node", "--input-type=module", "-e", script],
    {
      cwd: ROOT,
      encoding: "utf-8",
      env: {
        ...process.env,
        BETTER_AUTH_SECRET: undefined,
        BETTER_AUTH_SECRET_PREVIOUS: undefined,
        ...extraEnv,
      },
      shell: process.platform === "win32",
    },
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return { ok: result.status === 0, output };
}

type CheckStatus = "ok" | "fail" | "warn" | "skip";

interface CheckResult {
  name: string;
  status: CheckStatus;
  detail?: string;
  hint?: string;
  required: boolean;
}

const results: CheckResult[] = [];

function record(result: CheckResult) {
  results.push(result);
}

function isLocalDatabaseHost(host: string): boolean {
  return (
    host === "localhost" ||
    host === "postgres" ||
    host === "db" ||
    host === "database" ||
    host === "host.docker.internal" ||
    host.startsWith("127.") ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
}

// ---------------------------------------------------------------------------
// 1. Portless CLI (global dev prerequisite)
// ---------------------------------------------------------------------------
function checkPortless() {
  const result = spawnSync("portless", ["--version"], {
    cwd: ROOT,
    encoding: "utf-8",
    shell: process.platform === "win32",
  });
  if (result.status === 0) {
    const version = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    record({
      name: "portless CLI",
      status: "ok",
      detail: version || "installed",
      required: true,
    });
    return;
  }
  record({
    name: "portless CLI",
    status: "warn",
    detail: "portless is not available on PATH",
    hint: "Install it globally with `npm install -g portless`, then run `portless trust` if the CLI asks you to trust its local CA. Use `pnpm dev:raw` only as a fallback.",
    required: false,
  });
}

// ---------------------------------------------------------------------------
// 2. Env validation via @ws-model-proxy/env (zod)
// ---------------------------------------------------------------------------
async function checkEnv() {
  try {
    await import("@ws-model-proxy/env/server");
    record({ name: "env (zod schema)", status: "ok", required: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    record({
      name: "env (zod schema)",
      status: "fail",
      detail: message,
      // An EnvConfigError (e.g. the MCP origin guard) names its variables and fixes itself.
      hint: isEnvConfigError(err)
        ? "Change the environment as the message above says; the server refuses to start until then."
        : "Open .env at the repo root and fix the variables called out above.",
      required: true,
    });
  }
}

// ---------------------------------------------------------------------------
// 3. Database connection (uses `pg` from @ws-model-proxy/db's deps via workspace exec)
// ---------------------------------------------------------------------------
function checkDatabase() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    record({
      name: "database",
      status: "fail",
      detail: "DATABASE_URL is not set",
      hint: "Set DATABASE_URL in .env or run `pnpm setup:app`.",
      required: true,
    });
    return;
  }
  try {
    const host = new URL(url).hostname;
    if (!isLocalDatabaseHost(host)) {
      record({
        name: "database target",
        status: "warn",
        detail: `DATABASE_URL points at non-local host ${host}`,
        hint: "Use read-only tools for production inspection. Destructive schema commands are intended for local Postgres only.",
        required: false,
      });
    }
  } catch {
    // Env validation will report the malformed URL; avoid duplicate noise here.
  }
  // Inline script runs inside @ws-model-proxy/db so it can resolve `pg`.
  const script = `
    import pg from "pg";
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 3000 });
    try {
      await client.connect();
      await client.query("SELECT 1");
      console.log("ok");
      await client.end();
      process.exit(0);
    } catch (err) {
      console.error(err && err.message ? err.message : String(err));
      process.exit(1);
    }
  `;
  const { ok, output } = runInPackage("@ws-model-proxy/db", script);
  if (ok) {
    record({ name: "database", status: "ok", detail: "connected", required: true });
  } else {
    record({
      name: "database",
      status: "fail",
      detail: output || "connection failed",
      hint:
        "Is the Postgres container running? Try `pnpm db:start`, then `pnpm db:worktree` and `pnpm db:migrate:apply`. " +
        "Verify DATABASE_URL host/port/credentials.",
      required: true,
    });
  }
}

// ---------------------------------------------------------------------------
// Password pepper: read-only inventory, with only fingerprints sent to pg.
// ---------------------------------------------------------------------------
function checkPasswordPepper() {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    record({
      name: "password pepper",
      status: "fail",
      detail: "BETTER_AUTH_SECRET is not set",
      hint: "Restore this environment's BETTER_AUTH_SECRET; losing it means every password must be reset.",
      required: true,
    });
    return;
  }
  const fingerprint = pepperFingerprint(secret);
  const previous = process.env.BETTER_AUTH_SECRET_PREVIOUS;
  const previousFingerprint = previous ? pepperFingerprint(previous) : "";
  if (results.find((r) => r.name === "database")?.status !== "ok") {
    record({
      name: "password pepper",
      status: "skip",
      detail: `key fp ${fingerprint}; database is not reachable`,
      hint: "Fix the database check, then run pnpm doctor:app again.",
      required: true,
    });
    return;
  }
  // Unpadded base64url needs ceil(bytes * 8 / 6) characters. Require at
  // least one ciphertext byte beyond the 12-byte nonce and 16-byte GCM tag.
  const minPayloadLength = Math.ceil(((12 + 16 + 1) * 8) / 6);
  const envelopePattern = `^pw1:[0-9a-f]{16}:[A-Za-z0-9_-]{${minPayloadLength},}$`;
  const script = `
    import pg from "pg";
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 3000,
      statement_timeout: 10000 });
    try {
      await client.connect();
      const { rows } = await client.query(\`
        SELECT kind, fingerprint, count(*)::int AS count FROM (
          SELECT CASE
            WHEN password ~ '${envelopePattern}' THEN CASE
              WHEN split_part(password, ':', 2) = $1 THEN 'current'
              WHEN split_part(password, ':', 2) = $2 THEN 'previous'
              ELSE 'unknown-key' END
            WHEN password LIKE 'pw1:%' THEN 'invalid-envelope'
            WHEN password ~ '^[0-9a-f]{32}:[0-9a-f]{128}$' THEN 'legacy'
            ELSE 'malformed' END AS kind,
            CASE WHEN password ~ '${envelopePattern}'
              THEN split_part(password, ':', 2) ELSE '' END AS fingerprint
          FROM account WHERE password IS NOT NULL
        ) AS passwords GROUP BY kind, fingerprint
      \`, [process.env.PEPPER_CURRENT_FP, process.env.PEPPER_PREVIOUS_FP]);
      console.log(JSON.stringify(rows));
    } catch {
      console.error("Could not count stored password hashes; check database access and migrations.");
      process.exitCode = 1;
    } finally { await client.end(); }
  `;
  const { ok, output } = runInPackage("@ws-model-proxy/db", script, {
    PEPPER_CURRENT_FP: fingerprint,
    PEPPER_PREVIOUS_FP: previousFingerprint,
  });
  if (!ok) {
    record({
      name: "password pepper",
      status: "fail",
      detail: "could not count stored password hashes",
      hint: "Check database access and apply pending migrations, then run pnpm doctor:app again.",
      required: true,
    });
    return;
  }
  const counts = {
    current: 0,
    previous: 0,
    legacy: 0,
    malformed: 0,
    "invalid-envelope": 0,
    "unknown-key": 0,
  };
  const unknown: string[] = [];
  try {
    const rows: unknown = JSON.parse(output);
    if (!Array.isArray(rows)) throw new Error("invalid counts");
    for (const row of rows) {
      if (
        typeof row !== "object" ||
        row === null ||
        !Object.hasOwn(counts, row.kind) ||
        !Number.isInteger(row.count) ||
        row.count < 0 ||
        typeof row.fingerprint !== "string"
      )
        throw new Error("invalid count");
      const kind = row.kind as keyof typeof counts;
      counts[kind] += row.count;
      if (kind === "unknown-key") {
        if (!/^[0-9a-f]{16}$/.test(row.fingerprint)) throw new Error("invalid fingerprint");
        unknown.push(row.fingerprint);
      }
    }
  } catch {
    record({
      name: "password pepper",
      status: "fail",
      detail: "could not read password hash counts",
      hint: "Check database access and migrations, then run pnpm doctor:app again.",
      required: true,
    });
    return;
  }
  const detail = `ok (key fp ${fingerprint}); current ${counts.current}, previous ${counts.previous}, legacy ${counts.legacy}, malformed ${counts.malformed}, unknown ${counts["unknown-key"]}, invalid envelopes ${counts["invalid-envelope"]}; authenticity is checked at server start`;
  if (counts["unknown-key"] > 0) {
    const error = new PasswordPepperKeyError(counts["unknown-key"], unknown.sort(), [
      fingerprint,
      ...(previousFingerprint ? [previousFingerprint] : []),
    ]);
    record({
      name: "password pepper",
      status: "fail",
      detail: error.message,
      hint: "Restore the original secret, or configure it as BETTER_AUTH_SECRET_PREVIOUS while rotating. If lost, those passwords must be reset.",
      required: true,
    });
    return;
  }
  const hints: string[] = [];
  if (counts.previous > 0)
    hints.push(
      `${counts.previous} hashes still under previous key ${previousFingerprint}; keep BETTER_AUTH_SECRET_PREVIOUS set and restart all servers to re-wrap`,
    );
  if (counts.legacy > 0)
    hints.push(`${counts.legacy} hashes not yet sealed; the next server start seals them`);
  if (counts.malformed > 0)
    hints.push(
      `${counts.malformed} malformed password values; run pnpm auth:pepper:reset-unusable`,
    );
  if (counts["invalid-envelope"] > 0)
    hints.push(
      `${counts["invalid-envelope"]} structurally invalid password envelopes; run pnpm auth:pepper:reset-unusable`,
    );
  record({
    name: "password pepper",
    status: hints.length ? "warn" : "ok",
    detail,
    ...(hints.length ? { hint: hints.join("; ") } : {}),
    required: true,
  });
}

// ---------------------------------------------------------------------------
// 3b. Client IP topology (production only — warn-only)
// ---------------------------------------------------------------------------
function checkTrustProxyHops() {
  if (process.env.NODE_ENV !== "production") return;
  const hops = process.env.TRUST_PROXY_HOPS?.trim();
  // Unset or malformed: the env check above already fails and says why.
  if (!hops || !/^\d{1,2}$/.test(hops)) return;
  if (Number(hops) === 0) {
    record({
      name: "TRUST_PROXY_HOPS",
      status: "warn",
      detail: "0 in production: X-Forwarded-For is ignored and the client IP is the socket peer",
      hint: "Behind any reverse proxy or tunnel every client then shares the proxy's rate-limit bucket. Set the number of proxies in front of the app: 1 for one proxy or cloudflared straight to the app, 2 for cloudflared in front of Traefik/Caddy/nginx. Keep 0 only when clients connect to the app directly.",
      required: false,
    });
    return;
  }
  record({
    name: "TRUST_PROXY_HOPS",
    status: "ok",
    detail: `${hops} proxy hop(s)`,
    required: false,
  });
}

// ---------------------------------------------------------------------------
// 4. SMTP connectivity (optional — warn-only)
// ---------------------------------------------------------------------------
function checkSmtp(): Promise<void> {
  return new Promise((done) => {
    const host = process.env.SMTP_HOST;
    const portStr = process.env.SMTP_PORT;
    if (!host || !portStr) {
      // Email is optional: without SMTP the app is fully usable and
      // verification is not required. With SMTP, auth enables require +
      // send-on-signup. Signup can still be open without mail.
      record({
        name: "smtp",
        status: "skip",
        detail: "SMTP_HOST/SMTP_PORT not set — email is optional (verification off)",
        required: false,
      });
      done();
      return;
    }
    const port = Number(portStr);
    if (!Number.isFinite(port) || port <= 0) {
      record({
        name: "smtp",
        status: "warn",
        detail: `SMTP_PORT is not a valid number: ${portStr}`,
        required: false,
      });
      done();
      return;
    }
    const socket = connect({ host, port });
    let settled = false;
    const finish = (status: CheckStatus, detail: string, hint?: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      record({ name: "smtp", status, detail, hint, required: false });
      done();
    };
    socket.setTimeout(3000);
    socket.once("connect", () => finish("ok", `connected to ${host}:${port}`));
    socket.once("timeout", () =>
      finish(
        "warn",
        `timed out connecting to ${host}:${port}`,
        "Email sends will fail until SMTP is reachable.",
      ),
    );
    socket.once("error", (err) =>
      finish(
        "warn",
        `could not connect to ${host}:${port}: ${err.message}`,
        "Email sends will fail until SMTP is reachable.",
      ),
    );
  });
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------
function statusLabel(status: CheckStatus): string {
  switch (status) {
    case "ok":
      return "OK  ";
    case "fail":
      return "FAIL";
    case "warn":
      return "WARN";
    case "skip":
      return "SKIP";
  }
}

function printSummary() {
  console.log("");
  console.log("=== doctor: summary ===");
  for (const r of results) {
    const tag = statusLabel(r.status);
    const detail = r.detail ? ` — ${r.detail}` : "";
    console.log(`[${tag}] ${r.name}${detail}`);
    if (r.hint && (r.status === "fail" || r.status === "warn")) {
      console.log(`        hint: ${r.hint}`);
    }
  }
  console.log("");
}

async function main() {
  checkPortless();
  await checkEnv();
  checkTrustProxyHops();
  // Stop further checks if env failed — they would all fail with confusing
  // messages and the user needs to fix env first.
  const envOk = results.find((r) => r.name === "env (zod schema)")?.status === "ok";
  if (envOk) {
    checkDatabase();
    checkPasswordPepper();
    await checkSmtp();
  } else {
    record({
      name: "database",
      status: "skip",
      detail: "skipped because env validation failed",
      required: true,
    });
    record({
      name: "smtp",
      status: "skip",
      detail: "skipped because env validation failed",
      required: false,
    });
  }

  if (!envOk) checkPasswordPepper();
  printSummary();

  const requiredFailed = results.some(
    (r) => r.required && (r.status === "fail" || r.status === "skip"),
  );
  if (requiredFailed) {
    console.log("doctor: one or more required checks failed.");
    process.exit(1);
  }
  console.log("doctor: all required checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
