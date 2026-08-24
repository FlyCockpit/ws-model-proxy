import { markPoolMemberRelaySuccess } from "@ws-model-proxy/api/lib/model-pool-routing";
import {
  resolveEffectiveCapabilityMetadata,
  supportsChatCompletions,
} from "@ws-model-proxy/api/lib/openai-compatible-capabilities";
import type { Session } from "@ws-model-proxy/auth";
import prisma from "@ws-model-proxy/db";
import { Hono } from "hono";
import { type RelaySessionManager, relaySessionManager } from "../relay/session-manager.js";
import {
  type ModelApiConcurrencyLimiter,
  ModelApiLimitError,
  type ModelApiLimitLease,
  modelApiConcurrencyLimiter,
} from "./limits.js";
import { extractAssistantTextFromChatCompletion, readResponseUtf8 } from "./media-transform.js";
import { startRelayAttempt } from "./relay-executor.js";

type Variables = { session: Session | null };

const TEST_TIMEOUT_MS = 20_000;
const EXPECTED_PROBE_WORD = /\bpong\b/i;

export function isSuccessfulChatProbeReply(status: number, rawText: string): boolean {
  if (status !== 200) return false;
  try {
    const parsed: unknown = JSON.parse(rawText);
    const text = extractAssistantTextFromChatCompletion(parsed);
    return Boolean(text && EXPECTED_PROBE_WORD.test(text));
  } catch {
    return false;
  }
}

type PoolMemberTestDependencies = {
  manager?: Pick<
    RelaySessionManager,
    | "getActiveCliDeviceIds"
    | "registerRelayResponseHandlers"
    | "sendRelayRequest"
    | "cancelRelayRequest"
    | "completeRelayRequest"
  >;
  concurrencyLimiter?: ModelApiConcurrencyLimiter;
};

export function createPoolMemberTestRoutes({
  manager = relaySessionManager,
  concurrencyLimiter = modelApiConcurrencyLimiter,
}: PoolMemberTestDependencies = {}) {
  const app = new Hono<{ Variables: Variables }>();

  app.post("/members/:memberId/test", async (c) => {
    const session = c.get("session");
    if (!session?.user) {
      return c.json({ ok: false, error: "Authentication is required." }, 401);
    }
    const memberId = c.req.param("memberId");
    const member = await prisma.poolMember.findUnique({
      where: { id: memberId },
      select: {
        id: true,
        ModelPool: { select: { userId: true } },
        ExecutionTarget: {
          select: {
            DiscoveredModel: {
              select: {
                id: true,
                published: true,
                upstreamModelId: true,
                capabilityOverrideMode: true,
                capabilityOverrides: true,
                capabilityOverrideMetadata: true,
                Endpoint: {
                  select: {
                    published: true,
                    slug: true,
                    cliDeviceId: true,
                    capabilityMetadata: true,
                    defaultCapabilities: true,
                    CliDevice: { select: { status: true } },
                  },
                },
              },
            },
          },
        },
        DiscoveredModel: {
          select: {
            id: true,
            published: true,
            upstreamModelId: true,
            capabilityOverrideMode: true,
            capabilityOverrides: true,
            capabilityOverrideMetadata: true,
            Endpoint: {
              select: {
                published: true,
                slug: true,
                cliDeviceId: true,
                capabilityMetadata: true,
                defaultCapabilities: true,
                CliDevice: { select: { status: true } },
              },
            },
          },
        },
      },
    });
    if (!member || member.ModelPool.userId !== session.user.id) {
      return c.json({ ok: false, error: "Pool member not found." }, 404);
    }
    const model = member.ExecutionTarget?.DiscoveredModel ?? member.DiscoveredModel;
    if (!model) {
      return c.json({ ok: false, error: "Member execution target is not relay-capable." }, 409);
    }
    if (!model.published || !model.Endpoint.published) {
      return c.json({ ok: false, error: "Member model is unpublished." }, 409);
    }
    const supportsChat = supportsChatCompletions({
      capabilities: resolveEffectiveCapabilityMetadata({
        capabilityOverrideMode: model.capabilityOverrideMode,
        capabilityOverrideMetadata: model.capabilityOverrideMetadata,
        endpointCapabilityMetadata: model.Endpoint.capabilityMetadata,
      }),
      coarse:
        model.capabilityOverrideMode === "OVERRIDE"
          ? model.capabilityOverrides
          : model.Endpoint.defaultCapabilities,
    });
    if (!supportsChat) {
      return c.json(
        { ok: false, error: "This test only probes chat completions for chat-capable members." },
        409,
      );
    }
    if (!manager.getActiveCliDeviceIds().includes(model.Endpoint.cliDeviceId)) {
      return c.json({ ok: false, error: "Member CLI is disconnected." }, 503);
    }

    const startedAt = Date.now();
    let globalLease: ModelApiLimitLease | null = null;
    let cliLease: ModelApiLimitLease | null = null;
    try {
      globalLease = concurrencyLimiter.acquireGlobal({
        tokenId: `pool-member-test:${session.user.id}`,
        userId: session.user.id,
      });
      cliLease = concurrencyLimiter.acquireCli(model.Endpoint.cliDeviceId);
    } catch (error) {
      globalLease?.release();
      cliLease?.release();
      if (error instanceof ModelApiLimitError) {
        return c.json({ ok: false, error: error.message }, 429);
      }
      throw error;
    }

    const body = new TextEncoder().encode(
      JSON.stringify({
        model: model.upstreamModelId,
        stream: false,
        max_tokens: 8,
        messages: [{ role: "user", content: "Reply with the single word pong." }],
      }),
    );
    const attempt = startRelayAttempt({
      manager,
      cliDeviceId: model.Endpoint.cliDeviceId,
      endpointSlug: model.Endpoint.slug,
      family: "chat.completions",
      method: "POST",
      path: "/v1/chat/completions",
      headers: new Headers({ "content-type": "application/json" }),
      body,
      timeoutMs: TEST_TIMEOUT_MS,
    });

    try {
      const started = await attempt.started;
      const rawText = await readResponseUtf8(started.body);
      const terminal = await attempt.terminal;
      const latencyMs = Date.now() - startedAt;
      if (!terminal.ok || !isSuccessfulChatProbeReply(started.status, rawText)) {
        return c.json({
          ok: false,
          status: started.status,
          latencyMs,
          error: terminal.failure
            ? `Member test failed (${terminal.failure}).`
            : "Member did not return a valid chat completion containing pong.",
        });
      }
      await markPoolMemberRelaySuccess(member.id);
      return c.json({ ok: true, status: started.status, latencyMs });
    } catch (error) {
      return c.json({
        ok: false,
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : "Member test failed.",
      });
    } finally {
      cliLease.release();
      globalLease.release();
    }
  });

  return app;
}
