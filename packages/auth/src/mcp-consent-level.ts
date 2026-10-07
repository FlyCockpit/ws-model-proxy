/**
 * The access level a person chooses on the MCP consent page (Read-only or Full), carried from
 * the approval into the grant.
 *
 * The consent page posts `{ accept, level, oauth_query }` to Better Auth's `/oauth2/consent`.
 * That endpoint is the person's: a cookie session (`sessionMiddleware`) behind Better Auth's
 * origin check (CSRF), with the transaction pinned by the signed `oauth_query`. `level` is a
 * field of that body only; nothing the client controls (authorize parameters, scope, the
 * signed query) is ever read as a level. Absent means Read-only, the same default as the agent
 * token dialog, so a forged or replayed approval can never come out Full.
 *
 * - before: refuse an unknown `level`, and Full when the approved scopes lack `mcp:write`
 *   (a token without it can never act at Full, so the page never offers it).
 * - after: when the approval issued a code, record the level on the exact grant generation
 *   the code exchanges into (`recordConsentedMcpGrantLevel`) BEFORE the response, and so the
 *   code, reaches the browser. A storage failure withholds the code (500).
 *
 * Remembered consent (no page shown) never writes a level: re-authorization keeps the level
 * the person last chose. A scope step-up (or `prompt=consent`) shows the page again, and the
 * person's new choice replaces the level.
 */
import { getOAuthProviderState } from "@better-auth/oauth-provider";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { mcpScopesAllow, parseMcpScopes } from "./mcp-config";
import { deriveMcpConsentReferenceId } from "./mcp-grant";
import {
  isMcpGrantLevel,
  type McpGrantLevel,
  recordConsentedMcpGrantLevel,
} from "./mcp-grant-level";

/** Better Auth's consent endpoint path (router-relative). */
export const MCP_CONSENT_ENDPOINT_PATH = "/oauth2/consent";

function bodyRecord(body: unknown): Record<string, unknown> {
  return body !== null && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

/** The approval's level: absent → READ (the default); anything but READ/FULL → null. */
export function consentLevelOf(body: unknown): McpGrantLevel | null {
  const level = bodyRecord(body).level;
  if (level === undefined) return "READ";
  return isMcpGrantLevel(level) ? level : null;
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

function invalidLevel(description: string): APIError {
  return new APIError("BAD_REQUEST", { error: "invalid_request", error_description: description });
}

/**
 * The Better Auth plugin carrying the consent page's level into the grant. Composed right
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
            const level = consentLevelOf(ctx.body);
            if (level === null) throw invalidLevel("level must be READ or FULL");
            if (
              level === "FULL" &&
              !mcpScopesAllow(approvedScopes(ctx.body, await signedQueryOf()), "write")
            ) {
              throw invalidLevel("Full access needs the mcp:write scope");
            }
          }),
        },
      ],
      after: [
        {
          matcher: (ctx) => ctx.path === MCP_CONSENT_ENDPOINT_PATH,
          handler: createAuthMiddleware(async (ctx) => {
            if (!consentAccepts(ctx.body) || !consentIssuedCode(ctx.context.returned)) return;
            const level = consentLevelOf(ctx.body);
            if (level === null) throw invalidLevel("level must be READ or FULL");
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
              await recordConsentedMcpGrantLevel({
                userId: session.user.id,
                clientId,
                referenceId,
                level,
              });
            } catch (error) {
              console.error(
                "[mcp-consent] recording the grant level failed",
                error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error,
              );
              // Better Auth already remembered this approval. Forget it, so the next authorize
              // shows the page again instead of issuing a code at the level the person just
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
