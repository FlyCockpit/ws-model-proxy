/**
 * The plain HTTP endpoints a node uses before it has a relay session (contracts/http.ts):
 *
 * - `GET /.well-known/wsmp`: what `wsmp login <url>` checks and pins (canonical origin,
 *   protocol, where to enroll).
 * - `GET /install.sh`: installs the `wsmp` CLI. Until signed release builds of 0.4.0 exist it
 *   builds the CLI from source with cargo (the repository and ref below).
 * - `POST /api/node/enroll`: exchanges an enrollment code for the node credential
 *   (`@ws-model-proxy/api/nodes/enroll-exchange`). Unauthenticated by design (the code is the
 *   credential): no cookies, no CSRF, rate-limited per client IP before any lookup and per code
 *   owner after it.
 */

import {
  nodeEnrollRequestSchema,
  RELAY_PROTOCOL,
  wellKnownWsmpSchema,
} from "@ws-model-proxy/api/contracts";
import {
  exchangeEnrollmentCode,
  findEnrollmentCodeOwner,
  type NodeEnrollRequest,
} from "@ws-model-proxy/api/nodes/enroll-exchange";
import { env } from "@ws-model-proxy/env/server";
import type { Context, Env, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { RateLimiterMemory } from "rate-limiter-flexible";
import { resolveClientIp } from "./client-ip.js";
import {
  consumeEnrollmentExchange,
  enrollmentExchangeIpLimiter,
  enrollmentExchangeUserLimiter,
  type RateLimiter,
  refundEnrollmentExchange,
} from "./rate-limit.js";

/**
 * Where `install.sh` builds the CLI from until release builds of 0.4.0 are published. A
 * deployment pins an exact commit with `WMP_CLI_SOURCE_REV` (recommended: a branch moves);
 * without it the installer follows the branch.
 */
export const CLI_SOURCE = {
  repository: "https://github.com/FlyCockpit/ws-model-proxy",
  ref: "redesign-0.4.0",
} as const;

function cargoSourceArgs(rev: string | undefined): string {
  return rev ? `--rev '${rev}'` : `--branch '${CLI_SOURCE.ref}'`;
}

export const NODE_ENROLL_PATH = "/api/node/enroll";
export const NODE_ENROLL_MAX_BODY_BYTES = 16 * 1024;

function canonicalOrigin(): string {
  return new URL(env.BETTER_AUTH_URL).origin;
}

/** The POSIX installer: checks for cargo, then builds and installs `wsmp` from source. */
export function installScript(origin: string, rev: string | undefined = undefined): string {
  return `#!/bin/sh
# WS Model Proxy node CLI (wsmp) installer for ${origin}
# Builds wsmp ${CLI_SOURCE.ref} from source with cargo (release builds of 0.4.0 are not published yet).
set -eu
if ! command -v cargo >/dev/null 2>&1; then
  # A non-interactive SSH shell skips the profile that puts rustup's cargo on PATH.
  for cargo_env in "\${CARGO_HOME:-}/env" "\${HOME:-}/.cargo/env"; do
    if [ "$cargo_env" != "/env" ] && [ "$cargo_env" != "/.cargo/env" ] && [ -f "$cargo_env" ]; then
      set +eu
      . "$cargo_env"
      set -eu
      command -v cargo >/dev/null 2>&1 && break
    fi
  done
fi
if ! command -v cargo >/dev/null 2>&1; then
  echo "wsmp: cargo is not installed. Install Rust from https://rustup.rs, then run this again." >&2
  exit 1
fi
echo "wsmp: building ${rev ?? CLI_SOURCE.ref} from ${CLI_SOURCE.repository} (this takes a few minutes)..."
cargo install --git '${CLI_SOURCE.repository}' ${cargoSourceArgs(rev)} --locked --force wsmp
echo "wsmp: installed $(command -v wsmp || echo "$HOME/.cargo/bin/wsmp")."
echo "wsmp: if 'wsmp' is not found, add \\"$HOME/.cargo/bin\\" to your PATH."
`;
}

type Refusal = { ok: false; error: "rate_limited"; retryAfterSec: number };

function rateLimited(retryAfterMs: number): Refusal {
  return {
    ok: false,
    error: "rate_limited",
    retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)),
  };
}

export type NodeEnrollDeps = {
  ipLimiter?: RateLimiter & Pick<RateLimiterMemory, "reward">;
  userLimiter?: RateLimiter;
  exchange?: typeof exchangeEnrollmentCode;
  findOwner?: typeof findEnrollmentCodeOwner;
  /** Close the relay sessions of credentials the exchange revoked (a re-login or Replace). */
  closeRevokedSessions?: (credentialIds: readonly string[]) => Promise<unknown>;
};

/** `POST /api/node/enroll`. Status 200 when enrolled, 429 when rate-limited, 400 otherwise. */
export function nodeEnrollHandler(deps: NodeEnrollDeps = {}) {
  const ipLimiter = deps.ipLimiter ?? enrollmentExchangeIpLimiter;
  const userLimiter = deps.userLimiter ?? enrollmentExchangeUserLimiter;
  const exchange = deps.exchange ?? exchangeEnrollmentCode;
  const findOwner = deps.findOwner ?? findEnrollmentCodeOwner;
  return async (c: Context) => {
    // Every attempt counts, before parsing or any lookup (code guessing spends the IP budget);
    // a successful enrollment gives its point back, so a fleet behind one address can use a
    // multi-use code.
    const ipKey = `ip:${resolveClientIp(c)}`;
    const byIp = await consumeEnrollmentExchange(ipLimiter, ipKey);
    if (!byIp.allowed) return c.json(rateLimited(byIp.retryAfterMs), 429);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: "invalid_code" }, 400);
    }
    const parsed = nodeEnrollRequestSchema.safeParse(body);
    // A malformed request is answered without naming the field (the code may be in it).
    if (!parsed.success) return c.json({ ok: false, error: "invalid_code" }, 400);
    const request: NodeEnrollRequest = parsed.data;
    const owner = await findOwner(request.code);
    if ("refusal" in owner) return c.json(owner.refusal, 400);
    const byUser = await consumeEnrollmentExchange(userLimiter, `user:${owner.ownerUserId}`);
    if (!byUser.allowed) return c.json(rateLimited(byUser.retryAfterMs), 429);
    const outcome = await exchange(request);
    if (outcome.revokedCredentialIds.length > 0 && deps.closeRevokedSessions) {
      try {
        await deps.closeRevokedSessions(outcome.revokedCredentialIds);
      } catch {
        // Revoked rows refuse the next authentication; the old socket ends at its recheck.
      }
    }
    if (outcome.response.ok) {
      await refundEnrollmentExchange(ipLimiter, ipKey);
      // The credential is in this body: never cached.
      return c.json(outcome.response, 200, { "cache-control": "no-store" });
    }
    return c.json(outcome.response, outcome.response.error === "rate_limited" ? 429 : 400);
  };
}

export function registerNodeHttpRoutes<E extends Env>(
  app: Hono<E>,
  deps: NodeEnrollDeps = {},
): void {
  app.get("/.well-known/wsmp", (c) =>
    c.json(
      wellKnownWsmpSchema.parse({
        serverVersion: "0.4.0",
        protocolVersion: RELAY_PROTOCOL,
        origin: canonicalOrigin(),
        installScript: "/install.sh",
        enrollPath: NODE_ENROLL_PATH,
      }),
    ),
  );
  app.get("/install.sh", (c) =>
    c.body(installScript(canonicalOrigin(), env.WMP_CLI_SOURCE_REV), 200, {
      "content-type": "text/x-shellscript; charset=utf-8",
      "cache-control": "no-store",
    }),
  );
  app.use(
    NODE_ENROLL_PATH,
    bodyLimit({
      maxSize: NODE_ENROLL_MAX_BODY_BYTES,
      onError: (c) => c.json({ ok: false, error: "invalid_code" }, 413),
    }),
  );
  app.post(NODE_ENROLL_PATH, nodeEnrollHandler(deps));
}
