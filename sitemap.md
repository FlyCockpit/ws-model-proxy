# Sitemap

Current routes for the web app (`apps/web/src/routes/`).

> Every URL is prefixed with a locale segment: `/{lang}/...`, where `{lang}` is one of the supported BCP 47 tags (`en-US`, `es-MX`). Visiting an unprefixed path or an unknown locale redirects to `/${DEFAULT_LOCALE}/...`.

## Public Routes

Only indexable content pages belong in `apps/server/src/seo.ts` `PUBLIC_PATHS` for `/sitemap.xml` and `/llms.txt`. Auth and device routes are public in the router sense, but intentionally excluded from SEO discovery.

| Path | Description |
|------|-------------|
| `/{lang}/` | Locale root. Redirects signed-in users to the dashboard and signed-out visitors to login. |
| `/{lang}/login` | Email/password sign-in with optional two-factor support. |
| `/{lang}/signup` | Email/password public account creation. When public signup is disabled, a fresh production database admits only the configured canonical `ADMIN_EMAIL` to bootstrap its first admin; local and test retain first-user bootstrap. Later accounts are created through authenticated admin actions. When SMTP is configured, shows a post-signup verification prompt. |
| `/{lang}/verify-email` | Landing page after Better-Auth validates an email verification token (`?ok=1` / `?error=`). Also offers resend when email delivery is configured. |
| `/{lang}/device` | OAuth 2.0 device-authorization grant verification for CLI/device login. Reads `?user_code=...`, redirects unauthenticated visitors to login, shows the request without claiming it, and requires an explicit Approve click (claims and approves atomically); Cancel leaves the code claimable. |
| `/{lang}/mcp-login` | MCP OAuth sign-in page (feature-gated by `WMP_MCP_ENABLED`; real 404 while disabled, and intentionally excluded from SEO discovery). Shares the standard sign-in component and shows display-safe requesting-client data from the signed OAuth transaction; the authenticated branch handles reauthorization after a grant revocation. |
| `/{lang}/mcp-consent` | MCP OAuth consent page (feature-gated by `WMP_MCP_ENABLED`; real 404 while disabled, and intentionally excluded from SEO discovery). Requires a session, explains requested scopes (read/write and background renewal with 72-hour inactivity expiry, revocable in Settings), and submits accept/deny through the signed OAuth transaction. |

## Authenticated Routes

All require an active session, enforced by the `_auth` layout.

| Path | Description |
|------|-------------|
| `/{lang}/dashboard` | Overview: owner-scoped traffic, prompt-cache, latency, error metrics, and engine-load (24h / 7d) per pool and direct model (1h / 24h / 7d), a health strip for CLIs, endpoints, and pool members, and a setup checklist for new users. |
| `/{lang}/dashboard/chat-test` | Authenticated model chat test surface. |
| `/{lang}/dashboard/clis` | Own CLI devices and discovered endpoint/model metadata. |
| `/{lang}/dashboard/deployments` | Durable recipe revisions, group-aware start/stop previews and human confirmations, node deployment grants, instance claims, and inference contribution consent. |
| `/{lang}/dashboard/terminals` | Browser terminals on the user's own CLIs. |
| `/{lang}/dashboard/cli-tokens` | Own manually created CLI tokens. |
| `/{lang}/dashboard/api-tokens` | Own OpenAI-compatible API tokens: scope, expiry, per-token cloud access consent, revocation. |
| `/{lang}/dashboard/cloud-providers` | Own provider keys and per-shared-pool own-key preferences; read/clear while egress is disabled. |
| `/{lang}/dashboard/pools` | Own model pools with a request-flow strip, health badges, 24h requests/errors with sparklines, and static external-availability badges; pool cards lead to their dedicated detail pages. |
| `/{lang}/dashboard/pools/new` | Guided model-pool creation. |
| `/{lang}/dashboard/pools/{poolId}` | Owner-only model-pool overview: cache stats and local members with their custom limits. |
| `/{lang}/dashboard/pools/{poolId}/fallback` | Owner-only external fallback and grantee switches, side-by-side local and :external model names, the provider order with move controls, plus the external-equivalent model picker (OpenRouter catalog; declaring one is the owner's BYOK consent), aggregate successful own-key requests, and the fallback change history (source: dashboard or MCP). |
| `/{lang}/dashboard/pools/{poolId}/routing` | Owner-only execution policy (paid warm protection, embedding contract), protocol compatibility, cache-affinity and cache-protection settings, and metric routing rules shown as sentences. |
| `/{lang}/dashboard/pools/{poolId}/limits` | Owner-only pool limits and queueing (admission and capacity policy). |
| `/{lang}/dashboard/pools/{poolId}/media` | Owner-only media transformer, transcription fallback, and attachment settings. |
| `/{lang}/dashboard/pools/{poolId}/sharing` | Owner-only pool grants; external use is separately controlled by pool settings and caller token/request consent. |
| `/{lang}/dashboard/pools/{poolId}/settings` | Owner-only pool identity (name, slug, description) and the danger zone (delete pool). |
| `/{lang}/dashboard/runtimes` | Owner-scoped runtimes: the physical engine limits shared by direct models and pools. |
| `/{lang}/dashboard/request-log` | Own relay request metadata (request log) and its cleanup. |
| `/{lang}/settings` | Profile settings. |
| `/{lang}/settings/security` | Two-factor authentication enable/disable. |
| `/{lang}/settings/mcp` | Own MCP (Model Context Protocol) authorizations: personal access tokens plus per-client OAuth grant list and revocation. Stays available while MCP is disabled so outstanding access can be killed during an emergency shutdown. Token creation is disabled while MCP is off. |

## Admin Routes

Gated by the `admin` layout (`apps/web/src/routes/$lang/admin.tsx`). Non-admins and unauthenticated visitors see a 404 instead of a redirect.

| Path | Description |
|------|-------------|
| `/{lang}/admin` | Overview for the reduced self-hosted admin surface. |
| `/{lang}/admin/users` | User management: invite, search/filter, promote/demote, archive/restore, delete. |
| `/{lang}/admin/devices` | Device-authorization codes for CLI/device sign-in. |
| `/{lang}/admin/observability` | Admin observability for CLIs, endpoints, models, pools, and relay metadata. |
| `/{lang}/admin/settings` | Admin-only settings such as signup enable/disable, force-2FA, and media policy (asset retention TTL, aggregate storage stats, purge expired, and delete-all — metadata/policy only, no asset content view). |

## Navigation

Navigation destinations are defined in `apps/web/src/lib/nav-items.ts` and filtered by audience (`public`, `authenticated`, `admin`) plus placement (`desktop`, `mobile`, `userMenu`).

- Desktop: signed-in users see Dashboard and Settings. Admins also see Admin.
- Mobile: bottom tab bar shows Dashboard and Settings for signed-in users, plus Admin for admins.
- User menu: signed-out visitors get Sign In / Sign Up actions; signed-in users get account destinations from the shared model.

## Notes

- Keep this file updated as pages are added or removed.
- The `_auth` layout also enforces mandatory 2FA setup when `force2fa` is enabled.
- The `admin` layout returns 404 for non-admins; do not add admin links to navigation visible to all users.
- Client-side links should preserve the current locale segment. Use `<Link to="/$lang/dashboard" params={{ lang }} />` rather than hardcoded `/dashboard` strings.
