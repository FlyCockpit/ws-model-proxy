import { getOAuthProviderState } from "@better-auth/oauth-provider";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import {
  MCP_MISSING_SCOPE_DESCRIPTION,
  MCP_REMOVED_WRITE_DESCRIPTION,
  requestsRemovedMcpWrite,
  scopeParameterMissing,
} from "./agent-scopes";
import { MCP_SCOPES } from "./mcp-config";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** A local, non-redirecting `invalid_scope` refusal that is never cached. */
function scopeRefusal(description: string): APIError {
  return new APIError(
    "BAD_REQUEST",
    { error: "invalid_scope", error_description: description },
    { "cache-control": "no-store" },
  );
}

/** Application scope policy around the installed OAuth provider's protocol endpoints. */
export function mcpScopePolicy() {
  return {
    id: "wsmp-mcp-scope-policy",
    // CIMD registration goes through the provider's internal persistence seam, not the
    // public register endpoint. Its ceiling already rejects this unknown scope; present
    // the same migration guidance when that failure reaches our HTTP response.
    onResponse: async (response) => {
      if (
        response.status !== 400 ||
        !response.headers.get("content-type")?.includes("application/json")
      )
        return;
      const body = record(
        await response
          .clone()
          .json()
          .catch(() => null),
      );
      if (body.error !== "invalid_scope" || !requestsRemovedMcpWrite(body.error_description))
        return;
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      headers.set("cache-control", "no-store");
      return {
        response: new Response(
          JSON.stringify({ ...body, error_description: MCP_REMOVED_WRITE_DESCRIPTION }),
          { status: 400, headers },
        ),
      };
    },
    hooks: {
      before: [
        {
          matcher: (ctx) =>
            ctx.path === "/oauth2/token" ||
            ctx.path === "/oauth2/register" ||
            ctx.path === "/oauth2/authorize" ||
            ctx.path === "/oauth2/consent" ||
            ctx.path === "/oauth2/continue" ||
            typeof record(ctx.body).oauth_query === "string",
          handler: createAuthMiddleware(async (ctx) => {
            // Composed after oauth-provider: its before hook has verified oauth_query
            // and populated request-local state. Check the original query even when
            // consent's body narrows it. Authorize is also re-dispatched internally
            // after sign-in/social callbacks and continuation, without an HTTP guard.
            const signedQuery = (await getOAuthProviderState())?.query;
            const signedScope = signedQuery
              ? new URLSearchParams(signedQuery).get("scope")
              : undefined;
            if (
              requestsRemovedMcpWrite(record(ctx.body).scope) ||
              requestsRemovedMcpWrite(signedScope) ||
              (ctx.path === "/oauth2/authorize" && requestsRemovedMcpWrite(record(ctx.query).scope))
            ) {
              throw scopeRefusal(MCP_REMOVED_WRITE_DESCRIPTION);
            }
            // better-auth#12194: the provider answers an authorize request without `scope`
            // with every scope stored on the client, which for a DCR client registered
            // without one is the whole ceiling. The server's HTTP guard refuses it first;
            // this repeats the refusal for every dispatch of the endpoint (auth.api calls,
            // sign-in and continuation re-dispatches) and for a signed query without scope.
            // It reads the parameters where the provider does: the form body only for a
            // POST it dispatches as an authorize request, otherwise the query.
            if (ctx.path === "/oauth2/authorize") {
              const settings = record(record(ctx).authorizeSettings ?? { isAuthorize: true });
              const parameters =
                ctx.method === "POST" && settings.isAuthorize === true ? ctx.body : ctx.query;
              if (scopeParameterMissing(record(parameters).scope)) {
                throw scopeRefusal(MCP_MISSING_SCOPE_DESCRIPTION);
              }
            }
            if (signedQuery && scopeParameterMissing(signedScope)) {
              throw scopeRefusal(MCP_MISSING_SCOPE_DESCRIPTION);
            }
            // Blank DCR scope means no requested subset. Normalize it before
            // upstream validation, which otherwise treats tabs as scope tokens.
            const body = record(ctx.body);
            if (
              ctx.path === "/oauth2/register" &&
              typeof body.scope === "string" &&
              body.scope.trim().length === 0
            ) {
              delete body.scope;
            }
          }),
        },
      ],
      after: [
        {
          matcher: (ctx) => ctx.path === "/oauth2/register",
          handler: createAuthMiddleware(async (ctx) => {
            const result = record(ctx.context.returned);
            if (typeof result.client_id !== "string" || result.error) return;
            const requested = record(ctx.body).scope;
            const scopes =
              typeof requested === "string" && requested.trim().length > 0
                ? [...new Set(requested.split(" ").filter(Boolean))]
                : [...MCP_SCOPES];
            // oauth-provider 1.7.18 validates the request, then persists its entire
            // registration ceiling and builds this response from the stored client.
            // With no requested subset, retain exactly MCP_SCOPES in canonical order;
            // registration is not authorization. Otherwise keep the requested subset.
            // Skip the write only if the stored list already matches exactly.
            //
            // Accepted residual window (owner decision 2026-11-13; no upstream hook persists
            // the requested scopes in the provider's own transaction, and wrapping the adapter
            // would depend on its internals). The provider has already committed the client
            // and its resource links when this hook runs. If the process dies before the
            // update below commits, or the update and then the client deletion below fail
            // (best effort; a leftover link without its client is harmless), a client with
            // the whole ceiling (mcp:read, the six fine scopes, offline_access) stays behind.
            // Its client_id and secret are never sent: the response is lost with the process,
            // or is the 500 below. The id is 32 random letters. Using it would still need a
            // person's consent, which shows the requested scopes, and PKCE (required for every
            // client), so it grants nothing by itself. DCR here is always unauthenticated
            // (clientPrivileges denies session registration), so the orphan has no owner, no
            // consent and no tokens; the OAuth cleanup sweep deletes such a registration 24
            // hours after its creation.
            if (result.scope === scopes.join(" ")) return;
            // Finalize before releasing the ID and secret. Keep upstream validation,
            // PKCE, resource links and auth.
            try {
              const updated = await ctx.context.adapter.update({
                model: "oauthClient",
                where: [{ field: "clientId", value: result.client_id }],
                update: { scopes },
              });
              if (updated === null) throw new Error("Client scope narrowing failed");
            } catch {
              // The provider has already committed. Remove links first (also for
              // adapters without FK cascades), then the unfinalized client. Attempt
              // both deletions even if one fails; never log credentials or DB errors.
              for (const model of ["oauthClientResource", "oauthClient"]) {
                try {
                  await ctx.context.adapter.deleteMany({
                    model,
                    where: [{ field: "clientId", value: result.client_id }],
                  });
                } catch {
                  ctx.context.logger.error("Failed to remove an unfinalized OAuth registration", {
                    model,
                  });
                }
              }
              // An after-hook APIError inherits the endpoint's already-selected
              // 201 in Better Auth 1.7.18. A Response preserves the real 500 status.
              return Response.json(
                {
                  error: "server_error",
                  error_description: "Client registration could not be finalized.",
                },
                { status: 500, headers: { "cache-control": "no-store" } },
              );
            }
            return ctx.json({ ...result, scope: scopes.join(" ") });
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}
