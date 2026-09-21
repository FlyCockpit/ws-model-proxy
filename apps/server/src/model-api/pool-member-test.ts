import type { Session } from "@ws-model-proxy/auth";
import { Hono } from "hono";
import { runPoolMemberTest } from "./diagnostics.js";
import type { ModelApiConcurrencyLimiter } from "./limits.js";

type Variables = { session: Session | null };

export type PoolMemberTestDependencies = {
  manager?: Parameters<typeof runPoolMemberTest>[0]["manager"];
  concurrencyLimiter?: ModelApiConcurrencyLimiter;
};

/**
 * Hono routes for pool member diagnostics (Phase 5: a thin HTTP
 * adapter over the EXTRACTED core in model-api/diagnostics.ts — the same
 * typed, user-id-bound function the MCP `forwarder_pool_member_test` tool
 * calls). Response bodies and status codes are byte-identical to the
 * pre-extraction route (pinned by pool-member-test.test.ts).
 */
export function createPoolMemberTestRoutes({
  manager,
  concurrencyLimiter,
}: PoolMemberTestDependencies = {}) {
  const app = new Hono<{ Variables: Variables }>();

  app.post("/members/:memberId/test", async (c) => {
    const session = c.get("session");
    if (!session?.user) {
      return c.json({ ok: false, error: "Authentication is required." }, 401);
    }
    const result = await runPoolMemberTest({
      userId: session.user.id,
      memberId: c.req.param("memberId"),
      // G1: the HTTP request's own signal cancels the relay attempt on
      // client disconnect (same threading the MCP wrapper applies).
      signal: c.req.raw.signal,
      ...(manager !== undefined ? { manager } : {}),
      ...(concurrencyLimiter !== undefined ? { concurrencyLimiter } : {}),
    });
    switch (result.outcome) {
      case "not-found":
        return c.json({ ok: false, error: "Pool member not found." }, 404);
      case "not-relay-capable":
        return c.json({ ok: false, error: "Member execution target is not relay-capable." }, 409);
      case "unpublished":
        return c.json({ ok: false, error: "Member model is unpublished." }, 409);
      case "not-chat-capable":
        return c.json(
          { ok: false, error: "This test only probes chat completions for chat-capable members." },
          409,
        );
      case "cli-disconnected":
        return c.json({ ok: false, error: "Member CLI is disconnected." }, 503);
      case "rate-limited":
        return c.json({ ok: false, error: "Too many active model API requests." }, 429);
      case "ok":
        return c.json({ ok: true, status: result.status, latencyMs: result.latencyMs });
      case "probe-failed":
        return c.json({
          ok: false,
          status: result.status,
          latencyMs: result.latencyMs,
          error: result.reason,
        });
      case "probe-error":
        return c.json({
          ok: false,
          latencyMs: result.latencyMs,
          error: result.reason,
        });
    }
  });

  return app;
}
