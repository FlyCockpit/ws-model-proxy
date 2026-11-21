/** The person chooses scopes and node restrictions in the signed consent transaction. */
import { getOAuthProviderState } from "@better-auth/oauth-provider";
import prisma from "@ws-model-proxy/db";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { type AgentAccess, isAgentScope, oauthScopeCeiling } from "./agent-scopes";
import { parseMcpScopes } from "./mcp-config";
import { deriveMcpConsentReferenceId } from "./mcp-grant";
import { recordConsentedMcpGrantAccess } from "./mcp-grant-access";

/** Better Auth's consent endpoint path (router-relative). */
export const MCP_CONSENT_ENDPOINT_PATH = "/oauth2/consent";

function bodyRecord(body: unknown): Record<string, unknown> {
  return body !== null && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

/** Missing fields default to read and all owned nodes; malformed values fail closed. */
export function consentAccessOf(body: unknown): AgentAccess | null {
  const record = bodyRecord(body);
  const scopes = record.scopes === undefined ? ["read"] : record.scopes;
  const nodeIds = record.nodeIds === undefined ? null : record.nodeIds;
  if (
    !Array.isArray(scopes) ||
    !scopes.every(isAgentScope) ||
    !scopes.includes("read") ||
    scopes.length > 7
  )
    return null;
  if (
    nodeIds !== null &&
    (!Array.isArray(nodeIds) ||
      nodeIds.length > 10000 ||
      !nodeIds.every((id) => typeof id === "string" && id.length > 0))
  )
    return null;
  return {
    scopes: [...new Set(scopes)],
    nodeIds: nodeIds === null ? null : [...new Set<string>(nodeIds)],
  };
}

/** Whether the body approves (Better Auth treats anything but `true` as a denial). */
export function consentAccepts(body: unknown): boolean {
  return bodyRecord(body).accept === true;
}

/**
 * The scopes the approval grants: the body's narrowed `scope` when present, else the signed
 * query's requested scope (Better Auth's own rule).
 */
export function approvedScopes(body: unknown, signedQuery: string | null): string[] {
  const narrowed = bodyRecord(body).scope;
  if (typeof narrowed === "string") return parseMcpScopes(narrowed);
  if (signedQuery === null) return [];
  return parseMcpScopes(new URLSearchParams(signedQuery).get("scope") ?? "");
}

/**
 * Whether the consent endpoint answered with a redirect carrying an authorization code (and no
 * OAuth error, should a client's registered redirect URI itself contain `code`).
 */
export function consentIssuedCode(returned: unknown): boolean {
  const record = bodyRecord(returned);
  if (record.redirect !== true || typeof record.url !== "string") return false;
  try {
    const params = new URL(record.url).searchParams;
    return params.has("code") && !params.has("error");
  } catch {
    return false;
  }
}

async function signedQueryOf(): Promise<string | null> {
  try {
    return (await getOAuthProviderState())?.query ?? null;
  } catch {
    return null;
  }
}

function invalidAccess(description: string): APIError {
  return new APIError("BAD_REQUEST", { error: "invalid_request", error_description: description });
}

/**
 * The Better Auth plugin carrying the consent page's access into the grant. Composed right
 * after `mcp()`, so the provider's own before hook has verified the signed query first.
 */
export function mcpConsentLevel({ secret }: { secret: string }) {
  return {
    id: "wsmp-mcp-consent-level",
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === MCP_CONSENT_ENDPOINT_PATH,
          handler: createAuthMiddleware(async (ctx) => {
            if (!consentAccepts(ctx.body)) return;
            const access = consentAccessOf(ctx.body);
            if (access === null)
              throw invalidAccess("Invalid agent scopes or nodes; read is required.");
            const ceiling = oauthScopeCeiling(approvedScopes(ctx.body, await signedQueryOf()));
            if (access.scopes.some((scope) => !ceiling.includes(scope)))
              throw invalidAccess("Agent scopes exceed the approved OAuth scopes.");
            if (access.nodeIds?.length) {
              const session = await getSessionFromCtx(ctx);
              if (!session) throw invalidAccess("A session is required.");
              const nodes = await prisma.node.findMany({
                where: { userId: session.user.id, id: { in: [...access.nodeIds] } },
                select: { id: true },
              });
              if (nodes.length !== access.nodeIds.length)
                throw invalidAccess("One or more selected nodes do not exist.");
            }
          }),
        },
      ],
      after: [
        {
          matcher: (ctx) => ctx.path === MCP_CONSENT_ENDPOINT_PATH,
          handler: createAuthMiddleware(async (ctx) => {
            if (!consentAccepts(ctx.body) || !consentIssuedCode(ctx.context.returned)) return;
            const access = consentAccessOf(ctx.body);
            if (access === null)
              throw invalidAccess("Invalid agent scopes or nodes; read is required.");
            const session = await getSessionFromCtx(ctx);
            const query = await signedQueryOf();
            const clientId = query === null ? null : new URLSearchParams(query).get("client_id");
            if (!session || !clientId) {
              // The endpoint itself required both; refusing keeps the code from the browser.
              throw new APIError("BAD_REQUEST", { error: "invalid_request" });
            }
            const referenceId = deriveMcpConsentReferenceId({
              secret,
              sessionId: session.session.id,
              clientId,
            });
            try {
              await recordConsentedMcpGrantAccess({
                userId: session.user.id,
                clientId,
                referenceId,
                scopes: access.scopes,
                nodeIds: access.nodeIds,
              });
            } catch (error) {
              console.error(
                "[mcp-consent] recording the grant access failed",
                error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error,
              );
              // Better Auth already remembered this approval. Forget it, so the next authorize
              // shows the page again instead of issuing a code with the access the person just
              // tried to change (e.g. a lowering that did not land).
              try {
                await ctx.context.adapter.deleteMany({
                  model: "oauthConsent",
                  where: [
                    { field: "clientId", value: clientId },
                    { field: "userId", value: session.user.id },
                    { field: "referenceId", value: referenceId },
                  ],
                });
              } catch (forgetError) {
                console.error(
                  "[mcp-consent] forgetting the remembered consent failed",
                  forgetError instanceof Error
                    ? (forgetError.constructor?.name ?? "Error")
                    : typeof forgetError,
                );
              }
              throw new APIError("INTERNAL_SERVER_ERROR", { error: "server_error" });
            }
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}
