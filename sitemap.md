# Sitemap

Routes of the web app (`apps/web/src/routes/`), 0.4.0 information architecture (spec §7). In the
S0 skeleton most signed-in pages are stubs (`PageStub`) that later chunks fill in; the auth pages,
Settings and the admin Users and Settings pages are complete. Navigation lives in
`apps/web/src/lib/nav-items.ts`; signed-in pages render inside the app frame
(`routes/$lang/_auth/_app.tsx`, `components/app-frame.tsx`).

Only indexable content pages belong in `apps/server/src/seo.ts` `PUBLIC_PATHS` for `/sitemap.xml`
and `/llms.txt` (the locale root); auth and MCP routes are intentionally excluded.

> Every URL is prefixed with a locale segment: `/{lang}/...`, where `{lang}` is one of the
> supported BCP 47 tags (`en-US`, `es-MX`). Visiting an unprefixed path or an unknown locale
> redirects to `/${DEFAULT_LOCALE}/...`.

## Public Routes

| Path | Description |
|------|-------------|
| `/` | Redirects to `/{lang}`. |
| `/{lang}/` | Landing. Signed-in people go to Overview (or Get started until onboarding is done). |
| `/{lang}/login` | Sign in (email/password, optional two-factor). |
| `/{lang}/signup` | Sign up. The first account becomes admin; later accounts follow the sign-up setting. |
| `/{lang}/verify-email` | Verify email (only when SMTP is configured). |
| `/{lang}/mcp-login` | Agent sign-in for OAuth (feature-gated by `WMP_MCP_ENABLED`; not in SEO). |
| `/{lang}/mcp-consent` | Agent consent: Read-only (default) or Full, what Full allows (commands and files on Full-control nodes), and the client's redirect host (feature-gated; not in SEO). |

## Authenticated Routes

All require an active session (`_auth` layout).

| Path | Description |
|------|-------------|
| `/{lang}/welcome` | Get started: add a node (enrollment one-liner with countdown), add detected servers, create a pool, connect an agent, create an API key. |
| `/{lang}/overview` | KPIs (requests, errors, p95, TTFT, queue wait, cloud share; agent tests excluded), Needs-you list, nodes strip, pool cards with sparklines, getting-started checklist until done. |
| `/{lang}/models` | Every callable ID you may use (own pools and pools shared with you with can use): `owner/pool` and, where cloud mode covers you, `owner/pool:external`; type, status, base URL, copy buttons and snippets. |
| `/{lang}/test` | Test a callable ID or one of your served models directly (web only): chat, embeddings, transcription, live speech-to-text mic panel. |
| `/{lang}/pools` | Pool cards (flow strip, health, sparkline, cloud badge), pools shared with you, New pool sheet. |
| `/{lang}/pools/{poolId}` | Pool overview: stats, members (local, contributed, cloud in order) with load and status, call snippet, hardware it runs on, name and description. |
| `/{lang}/pools/{poolId}/routing` | Priority class, pool cap, kept slots, borrowing, only my own hardware. |
| `/{lang}/pools/{poolId}/cloud` | Cloud mode (off / for me / for me and people I share with), cloud members order, embedding contract, paid warm protection, own-key consent, history. |
| `/{lang}/pools/{poolId}/media` | Sidecar pools per input (images, audio, video): pool picker, prompt, limits, pipeline strip. |
| `/{lang}/pools/{poolId}/sharing` | Shares (email, can use / can contribute, priority class, monthly cap, protection) and contributed members by person. |
| `/{lang}/pools/{poolId}/advanced` | Automatic settings with overrides (max wait, context ceiling and margin, affinity, warm protection, API adaptation, attachments, transcription fallback), metric routing rules (read-only, Delete per rule), danger zone. |
| `/{lang}/runtimes` | Runtimes grouped by node (always-on and instances of startable ones), not running, Needs you, detected-servers banner. |
| `/{lang}/runtimes/new` | New runtime: preset picker (detected server, vLLM, SGLang, llama.cpp, Ollama service, systemd unit), then the definition form. |
| `/{lang}/runtimes/{runtimeId}` | Runtime overview: instances (phase, nodes, KV meter, slots, waiting, restart window), Start (node picker, preview, confirm), Stop, Restart, Forget, served models, metrics by version, sharing. |
| `/{lang}/runtimes/{runtimeId}/definition` | Definition form and raw JSON, version history with notes and diffs, agent-written badges, applies-live vs needs-restart hints. |
| `/{lang}/runtimes/{runtimeId}/advanced` | Limits and advanced settings (automatic / override), metrics reader, restart settings. |
| `/{lang}/profiles` | Profiles: nodes, items, satisfied, pins outdated, Apply. |
| `/{lang}/profiles/{profileId}` | Profile editor (nodes, pinned items, Update pins) and Apply → preview → Confirm. |
| `/{lang}/nodes` | Node cards (online, trust, hardware, free memory, runtimes), Add node dialog. |
| `/{lang}/nodes/{nodeId}` | Hardware (effective with sources, declaration incl. reserved memory), trust card (Lower to Relay only; raise with `wsmp trust full` on the node), labels, port range, node metric commands, detected servers, activity, Replace, delete. |
| `/{lang}/terminals` | Browser terminals (Full-control nodes), commands agents queued for you (Run / Dismiss), interactive steps waiting for you. |
| `/{lang}/providers` | Provider accounts with this month's spend against the monthly cap, health; add account. |
| `/{lang}/providers/{accountId}` | Key (replace/revoke), models (enable, type, pricing), monthly cap, data collection, usage. |
| `/{lang}/access` | Redirects to `/{lang}/access/api-keys`. |
| `/{lang}/access/api-keys` | API keys (all pools or selected pools), expiry, base URL and example. |
| `/{lang}/access/agents` | MCP URL, OAuth connections (level), agent tokens (Read-only / Full, expiry). |
| `/{lang}/access/shares` | Shares you made and shares you received; your own-key choice for shared pools. |
| `/{lang}/access/contributions` | Pools you may contribute to (add a served model), what you contribute, runtime definitions shared with you (fork). |
| `/{lang}/activity` | Metrics explorer: scope (pool / runtime / version / node), metric, range and step, compare versions. |
| `/{lang}/activity/requests` | Request log with filters and delete. |
| `/{lang}/settings` | Profile, locale, alert e-mails. |
| `/{lang}/settings/security` | Password and two-factor authentication. |

## Admin Routes

Gated by the `admin` layout; non-admins see a 404.

| Path | Description |
|------|-------------|
| `/{lang}/admin` | Admin overview. |
| `/{lang}/admin/users` | Invite, role, ban, remove. |
| `/{lang}/admin/observability` | Every node, runtime, pool and the request log across accounts. |
| `/{lang}/admin/settings` | Sign-up, forced 2FA, media retention and attachment cap. |

## Removed (no redirects)

`/dashboard`, `/dashboard/chat-test`, `/dashboard/clis`, `/dashboard/deployments`,
`/dashboard/terminals`, `/dashboard/cli-tokens`, `/dashboard/api-tokens`,
`/dashboard/cloud-providers`, `/dashboard/pools/**` (incl. `new`, `fallback`, `limits`,
`settings`), `/dashboard/runtimes`, `/dashboard/request-log`, `/settings/mcp`, `/admin/devices`,
`/device` (device login is gone).

## Navigation

- Desktop sidebar: Overview · Models · Pools · Runtimes · Profiles · Nodes · Providers · Access ·
  Activity; footer: Terminals (badge: queued agent commands and Needs you), Settings, Admin
  (admins). Every item has a one-line hint.
- Mobile: the existing `BottomNav` with Overview · Models · Pools · Runtimes · More (sheet with the
  rest, Needs-you badge on More).

41 pages: 6 public (plus the `/` redirect), 31 signed-in, 4 admin.


## Notes

- Keep this file updated as pages are added or removed.
- The `_auth` layout also enforces mandatory 2FA setup when forced 2FA is on (a signed-in read
  answers FORBIDDEN until the person enrolls).
- The `admin` layout returns 404 for non-admins; do not add admin links visible to everyone.
- Client-side links keep the locale segment: `<Link to="/$lang/overview" params={{ lang }} />`.
