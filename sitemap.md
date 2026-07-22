# Sitemap

Current routes for the web app (`apps/web/src/routes/`).

> Every URL is prefixed with a locale segment: `/{lang}/...`, where `{lang}` is one of the supported BCP 47 tags (`en-US`, `es-MX`). Visiting an unprefixed path or an unknown locale redirects to `/${DEFAULT_LOCALE}/...`.

## Public Routes

Only indexable content pages belong in `apps/server/src/seo.ts` `PUBLIC_PATHS` for `/sitemap.xml` and `/llms.txt`. Auth and device routes are public in the router sense, but intentionally excluded from SEO discovery.

| Path | Description |
|------|-------------|
| `/{lang}/` | Locale root. Redirects signed-in users to the dashboard and signed-out visitors to login. |
| `/{lang}/login` | Email/password sign-in with optional two-factor support. |
| `/{lang}/signup` | Email/password account creation. The first account can bootstrap even when signup is disabled and becomes admin automatically; later signups follow the admin-controlled signup setting. When SMTP is configured, shows a post-signup verification prompt. |
| `/{lang}/verify-email` | Landing page after Better-Auth validates an email verification token (`?ok=1` / `?error=`). Also offers resend when email delivery is configured. |
| `/{lang}/device` | OAuth 2.0 device-authorization grant verification for CLI/device login. Reads `?user_code=...`, redirects unauthenticated visitors to login, and requires an explicit approve/deny click. |

## Authenticated Routes

All require an active session, enforced by the `_auth` layout.

| Path | Description |
|------|-------------|
| `/{lang}/dashboard` | Main dashboard landing page. |
| `/{lang}/dashboard/chat-test` | Authenticated model chat test surface. |
| `/{lang}/dashboard/clis` | Own CLI devices and discovered endpoint/model metadata. |
| `/{lang}/dashboard/cli-tokens` | Own manually created CLI tokens. |
| `/{lang}/dashboard/model-api-tokens` | Own OpenAI-compatible model API tokens. |
| `/{lang}/dashboard/pools` | Own model pools, pool members, and pool grants. |
| `/{lang}/dashboard/relay-metadata` | Own relay request metadata cleanup. |
| `/{lang}/settings` | Profile settings. |
| `/{lang}/settings/security` | Two-factor authentication enable/disable. |

## Admin Routes

Gated by the `admin` layout (`apps/web/src/routes/$lang/admin.tsx`). Non-admins and unauthenticated visitors see a 404 instead of a redirect.

| Path | Description |
|------|-------------|
| `/{lang}/admin` | Overview for the reduced self-hosted admin surface. |
| `/{lang}/admin/users` | User management: invite, search/filter, promote/demote, archive/restore, delete. |
| `/{lang}/admin/devices` | Device-authorization codes for CLI/device sign-in. |
| `/{lang}/admin/observability` | Admin observability for CLIs, endpoints, models, pools, and relay metadata. |
| `/{lang}/admin/settings` | Admin-only settings such as signup enable/disable and force-2FA. |
| `/{lang}/admin/seed` | Run the database seed (`packages/db/prisma/seed.ts -> runSeed()`) inline on demand. |

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
