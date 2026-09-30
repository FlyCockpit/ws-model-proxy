# MCP server

WS Model Proxy exposes its dashboard operations to MCP (Model Context Protocol)
clients as an OAuth-protected resource. The surface is on by default.
`WMP_MCP_ENABLED` is the kill switch (`false` closes it). Everything else — the canonical URL,
protocol profile, scopes, token lifetimes, and registration policy — is derived
from configuration in code, not operator tuning.

The tool catalog (every exposed tool, its scope, confirmation literal, and every
excluded procedure) is maintained in the generated, test-enforced artifact
[docs/mcp-tool-coverage.md](./mcp-tool-coverage.md). This document describes the
server behavior around it; it does not duplicate the catalog.

Node telemetry (relay protocol 2.7) is read-only over MCP.
`forwarder_device_metrics_get` (`{ cliDeviceId }`) returns a CLI device's static
`node.info`, its freshest `node.metrics` (live from the relay session, else the
stored once-a-minute snapshot, with `nodeMetricsSource`), and the live
`endpoint.load` readings the relay holds in memory. Detected engine facts
(`engineKind`, `engineSlots`, `kvBudgetTokens`, `maxModelLen`,
`engineFactsSource`, `engineFactsAt`) and the derived `enginePreset` appear on
every capacity in `capacity_records_list`. Neither ever contains prompt text:
the CLI reads only slot ids, context sizes and busy flags from llama.cpp
`/slots`.

`forwarder_device_metrics_get` also lists `series`: every metric a pool routing
rule can name on that device (built-in `node.*` series such as
`node.cpu.usage_percent`, `node.memory.used_percent` or
`node.gpu.temperature_c{gpu="0"}`, and the CLI's custom series), with its
labels, latest value and whether it is stale. It also returns the remote metric
source definitions the server holds (`remoteMetricSources`, each with the
`commandSha256` the CLI pins) next to the CLI's own view of every source in
`nodeMetrics.sources` (`active`, `pending_approval`, `refused`, ...).

Metric routing rules (S-B part 2):

- `forwarder_pool_routing_rules_get` (`{ poolId }`) returns the pool's rules,
  each primary member's current verdict (`full`, `avoid` or none), its state
  (`active`, `stale`, `unevaluated`), a per-rule `triggered` / `clear` /
  `stale` state, the member's `endpoint.*` load series (`endpoint.running`,
  `endpoint.waiting`, `endpoint.kv_usage`, ...) and the series of each member's
  device. Each member also carries `engineLoad` (S-D): its override `mode`
  (`auto` / `off`), the engine kind and slots, the live reading (`running`,
  `waiting`, `kvUsage`, `slotsBusy`, `deferred`, age, `stale`, prefix cache
  totals) and the verdict state (`full_waiting`, `full_kv`, `full_slots`,
  `full_deferred`, `clear`, `stale`, `none`, `off`).
- `forwarder_pool_member_engine_load_set` (`{ poolMemberId, mode: "auto" |
  "off", kvFullThreshold?, confirm: "RUN" }`) turns "use engine load" off for
  a member or overrides its vLLM/SGLang KV threshold (default 0.95). Engine
  load only adds FULL (lease counts stay authoritative), a stale reading is
  ignored, and when every candidate is FULL a plain-name request is admitted by
  leases alone. Classified `cost` like the rules.
- `forwarder_pool_routing_rules_set` (`{ poolId, rules, confirm: "RUN" }`)
  replaces the whole list (at most 16). A rule is a flat record
  `{ metric, labels?, aggregate: "max", op: ">" | ">=" | "<" | "<=",
  threshold, effect: "full" | "avoid" }`; there is no expression language.
  Label keys and values use the metric-name charset, and `__proto__` is not
  accepted as a label key (the rule is rejected, never widened).
  `full` makes the member FULL: the request queues, goes to another member, or
  (for `:external` callers only) goes external after `externalAfterWaitMs`.
  `avoid` ranks the member last among free members and never makes it
  ineligible. A stale or missing metric makes its rule inert, and when every
  candidate is metric-FULL a plain-name request is admitted by leases alone
  (fail open), so metrics never make a pool sit idle. It is confirmed and
  classified `cost` because a `full` rule can send `:external` traffic to paid
  providers.
- `forwarder_device_metric_sources_set` (`{ cliDeviceId, sources, confirm:
  "RUN" }`) replaces a device's remotely defined metric sources
  (`{ name, command, intervalSecs >= 5, timeoutSecs, format: "number" | "json"
  | "prometheus" }`). The server accepts it only while the device's MCP command
  mode is `unsupervised`, only for a personal token minted with the CLI
  commands option (`allowCliCommands`; OAuth clients and other tokens neither
  see nor can call it), and sends an empty list to the CLI whenever the mode
  is anything else. The CLI refuses remote sources unless its local
  `allowRemoteMetricSources` opt-in is on, and runs a command only after the
  person approves that exact command string on the machine
  (`wsmp metrics approve <name> --sha256 <hash>`, the hash of the command they
  read); a changed command stops until it is approved
  again. stderr and command output never leave the CLI; only parsed numbers do.

## Setup

Required environment:

- `DATABASE_URL`: Postgres connection string (as for the rest of the app).
- `BETTER_AUTH_SECRET`: existing app secret. The consent-reference HMAC derives
  from it, and Better Auth's JWT plugin **encrypts the private half of its
  asymmetric signing keypairs with it** (public keys are stored in JWKS;
  private key material is encrypted at rest using the secret). Consequence:
  rotating the secret does **not** revoke MCP grants — `/mcp` admission checks
  the persisted grant identity and `revokedAt`, not any derivation of the
  secret, and already-issued JWT signatures remain valid — but a rotated
  secret can **break private-key decryption for subsequent token issuance**
  until the JWKS keys are cleaned up or re-minted. Emergency revocation is the
  flag plus `Settings → MCP` grant revocation, never secret rotation.
- `BETTER_AUTH_URL`: the canonical **public** origin of the server
  (for example `https://wmp.example.test`). The MCP resource URL, OAuth issuer,
  and DPoP `htu` validation are all derived from this value (see below).
- `WMP_MCP_ENABLED`: installs the Better Auth MCP/OAuth plugins and opens
  the MCP surface. Default `true`. Set `false` to close it.

Optional:

- `CORS_ORIGIN`: browser origin on split-origin deploys. When set, it is also
  the accepted browser origin for MCP login/consent pages.
- SMTP settings: email is optional for the whole app. Without SMTP, signup and
  login work and email verification is off; with SMTP configured, verification
  is required — the MCP login page follows the same behavior because it reuses
  the standard sign-in flow.
- Rate-limit tuning: `RATE_LIMIT_MCP_POINTS` (default 120),
  `RATE_LIMIT_MCP_DURATION` (default 60 s), `RATE_LIMIT_MCP_CONSENT_POINTS`
  (default 30), `RATE_LIMIT_MCP_CONSENT_DURATION` (default 60 s), and the
  whole-service registration bucket
  `RATE_LIMIT_MCP_REGISTRATION_POINTS`/`RATE_LIMIT_MCP_REGISTRATION_DURATION`
  (default 60 requests / 3600 s). See
  [Rate limits](#rate-limits-process-local).

The generated `.env.example` files track these keys
(`pnpm env:sync` / `pnpm env:check`); do not hand-edit them.

The MCP surface uses the Better Auth OAuth/JWKS tables plus the
application-owned `McpGrant` table. Those models are in the Prisma schema
whether or not the kill switch is off. Apply them with the repository's safe
schema workflow (`pnpm db:push` locally; `APPLY_SCHEMA=safe` for additive
deploys) before first use.

### Flag-off behavior (emergency kill switch)

With `WMP_MCP_ENABLED=false`:

- `/mcp`, the OAuth authorization/token endpoints, the four discovery
  well-known aliases, and the MCP login/consent pages return **real 404s** for
  every HTTP method. The paths stay reserved ahead of static assets and SSR, so
  nothing falls through to the SPA shell.
- The human grant list and revocation page (`Settings → MCP`) **stays
  available** — it only requires a normal browser session — so outstanding
  access can be killed during an emergency shutdown. Existing access JWTs also
  stop working immediately at the `/mcp` gate itself.

Emergency rollback is therefore: set the flag to `false` and restart. Do not
drop the OAuth/JWKS tables; they are additive.

## Canonical URL and reverse-proxy behavior

There is exactly one canonical public MCP resource URL:
`new URL("/mcp", BETTER_AUTH_URL)`. The OAuth issuer is
`new URL("/api/auth", BETTER_AUTH_URL)`.

Because the server may sit behind TLS-terminating proxies, every MCP OAuth
request (discovery aliases, `/api/auth/oauth2/*`, JWKS, and `/mcp`) is first
rebuilt onto the configured canonical origin:

- The raw `Host` header must be singular and equal the canonical host
  (case-insensitive), or be a member of a small trusted-ingress allowlist that
  is an empty, frozen code constant by default. With an allowlisted direct
  `Host`, exactly one `X-Forwarded-Host` equal to the canonical host is
  required; surrounding ASCII spaces/tabs on the forwarded value are stripped
  before the comparison, while Unicode whitespace padding and comma-ambiguous
  (multi-value) forwarded values are rejected. With the canonical direct
  `Host`, forwarding headers are ignored entirely and have no effect —
  spoofed `X-Forwarded-Host`/`X-Forwarded-Proto` cannot influence the result.
- When `Origin` is present it must be strictly well-formed and match the
  configured web origin (`CORS_ORIGIN` when set, else `BETTER_AUTH_URL`) or the
  server origin.
- The canonical scheme and host always come from `BETTER_AUTH_URL`, never from
  the request. DPoP `htu` validation therefore checks proofs against the
  canonical public URL, so TLS termination in front of the app does not break
  sender-constrained clients.
- Forwarding and hop-by-hop headers are dropped from the rebuilt request —
  including every header nominated by `Connection` — while method, path,
  query, body, `Authorization`, and the allowed `Origin` are preserved.

Deployments behind a proxy must preserve `Host` (or configure the ingress so
the direct host is allowlisted and `X-Forwarded-Host` is exactly the canonical
public host).

## Client registration (CIMD + dynamic registration)

Two registration paths are enabled (CIMD = **Client ID Metadata Document**):

- **CIMD first-use registration**: a client publishes its metadata document
  over HTTPS; on first use the server fetches it through Better Auth's
  hardened transport (resolve-once DNS validation, public-address checks,
  connection pinning, TLS hostname validation, byte/time limits, redirect
  refusal) and registers the client. The CIMD path is pinned to the MCP
  `2026-07-28` metadata profile.
- **Dynamic Client Registration (RFC 7591)**: advertised in discovery
  metadata via `registration_endpoint` (`…/oauth2/register`). Unauthenticated
  initial registration is enabled as well — clients such as rmcp/Grok
  register without an initial client credential. PKCE is still required for
  public clients (`clientRegistrationRequirePKCE`), registration scope
  ceilings still cap what a registered client may declare, and user-facing
  OAuth client/resource CRUD is denied entirely.
- Registration scope ceiling: the ceiling is `mcp:read mcp:write
  offline_access`, and the provider persists that FULL set as the client's
  registered capabilities even when the registration request omits `scope`.
  Registered capabilities are not authorization: every requested scope is
  still validated and consented to at authorize time.
- Grant types are limited to `authorization_code` and `refresh_token`.
  `client_credentials` is never enabled (tools are user-bound).

The two paths differ in client identity: a CIMD client's `client_id` IS its
metadata URL; a DCR response returns a GENERATED `client_id` that the client
must use in every subsequent OAuth request (see the client examples).

Registration is not a client allowlist; a production cohort would be a
separate policy change.

## Protocol and transport

- Endpoint: `POST /mcp` only. Other methods get `405` with `Allow: POST`
  before authentication.
- Built on the official MCP SDK v2 server with `legacy: "reject"` (legacy
  protocol negotiation is rejected), JSON response mode, and
  `maxSubscriptions: 0` — no subscriptions, no SSE, no notifications.
- Stateless: there is no MCP session ID, session header, or sticky routing. A
  fresh SDK server instance is created per request and torn down by the SDK.
- Request bodies are capped at 1 MB.
- Only `Authorization: Bearer` and `Authorization: DPoP` authenticate `/mcp`;
  browser cookies never do.
- Shutdown is bounded and ordered: on SIGTERM/SIGINT, periodic jobs stop and
  in-flight HTTP requests **drain first** (ordinary work may continue during
  the drain); the MCP admission gate then closes — new `/mcp` admissions get
  503 from that moment and outstanding admitted exchanges are aborted — and
  gate closure is what arms the database shutdown fence (new DB work through
  the shared client is rejected from that point, before Prisma disconnects).
  Explicitly permitted durable cleanup (capacity-lease release and waiter
  terminalization) is exempt from the fence and still runs after fencing.

## Scopes

Three scopes exist: `mcp:read`, `mcp:write`, and `offline_access`.

- Read tools accept `mcp:read` **or** `mcp:write` (`mcp:write` semantically
  includes read).
- Write tools require the literal `mcp:write`. Scope matching is exact-token:
  padded or case-variant tokens never match.
- At the authorization endpoint, a missing or blank `scope` is rejected locally
  with a non-redirecting OAuth `invalid_scope` error; the requested `resource`
  set must contain the canonical `/mcp` URL or the request is rejected locally
  with `invalid_target`. Neither check ever uses or redirects to a
  caller-supplied redirect URI. Every present, well-formed request is forwarded
  to Better Auth unchanged for client/redirect validation.

## Confirmation literals

Destructive operations (remove/delete/revoke/clear) require the caller to pass
`confirm: "DELETE"`. Cost-bearing or externally-visible diagnostic operations
(pricing activation/retirement, credential tests, pool-member and chat
completion tests) require `confirm: "RUN"`. Ordinary reversible writes need no
ceremonial confirmation. The exact per-tool policy is in the
[coverage artifact](./mcp-tool-coverage.md); the wrapper strips the
confirmation field before the underlying procedure runs.

## External fallback tools

`forwarder_pool_fallback_get` (read) returns a pool's external-fallback state.
Owners get `fallbackEnabled`, `fallbackForGrantees`, `externalAfterWaitMs`,
`externalEquivalentModel`, the external members in fallback order and the
aggregate own-key request count. Grantees get whether owner-paid fallback is
available to them (provider types only, never the owner's account labels) and
their own-key route.

`forwarder_pool_fallback_update` (write, literal `mcp:write`, no confirmation
literal) changes `fallbackEnabled`, `fallbackForGrantees` and
`externalAfterWaitMs`. These settings cost money: turning fallback on sends
`:external` requests to the owner's paid provider accounts, and
`fallbackForGrantees` makes the owner pay for every grantee's external use.
The tool description states this. The procedure applies the same checks as the
dashboard (deployment switch, audited protection policy on every external
member, wait within the local budget), and every change, from MCP or the
dashboard, is recorded as a `POOL_FALLBACK_UPDATED` provider audit event
(`metadata.source` is `mcp` or `dashboard`), readable with
`provider_audit_events_list` (`poolId` filters one pool's history) and shown
as the fallback change history on the pool's Fallback tab in the dashboard.
The tool description also lists the preconditions an agent otherwise sees only
as a plain "Invalid input". The general pool tools reject the two switches (the
advertised schema describes each as forbidden and names this tool); they still
accept `externalAfterWaitMs`, and their descriptions
state its cost.

Still human-only: token external consent (`allowExternal`, `includeExternal`),
own-key preferences, the pool external-equivalent picker, catalog search,
the OpenRouter "providers that may collect data" account setting, and moving
an OpenRouter account to another provider type (`provider_account_update`
refuses it, since the privacy preference is keyed on the type).

No tool output can contain a secret value WMP holds (provider API keys,
encrypted credential material, token secrets or hashes, device-flow and 2FA
backup codes). Projections pick safe fields, a recursive redactor removes
secret-bearing keys and product credentials under any key, and the serializer
elides byte values. A test drives every tool with secret-laden results and
searches the output for every seeded secret value in every encoding. The CLI
command tools return what a command printed on your own CLI device (behind the
separate `allowCliCommands` consent); WMP credentials in that text are
scrubbed, but other device content is returned as printed.
Three independent switches gate each command (the token, the device's dashboard
grant and the CLI's own config); see [CLI command switches](cli-command-switches.md).

## Tool input schemas

Each procedure-backed tool advertises the JSON Schema of its real oRPC input
(generated from the procedure's zod schema, so required fields such as
`poolId` show up in `tools/list`), plus the few fields MCP itself owns:

- `confirm`: the exact literal (`DELETE` or `RUN`), required on gated tools;
- fields an agent must not use, advertised as `{ "not": {} }` with a
  `description` that names the tool to use instead (the pool fallback switches
  point to `forwarder_pool_fallback_update`; `allowDataCollection` is
  dashboard-only);
- timestamp filters, advertised as RFC 3339 UTC strings.

The generator lives in `apps/server/src/mcp/input-schema.ts`, and a test
compares every tool's advertised schema with its procedure schema. The schema
is advisory: the oRPC procedure still validates every call, so a client that
ignores the schema gets the same checks.

## Tool errors

A failed tool call returns `isError: true`, a short stable text, and
`structuredContent.error.code`. Application messages are never copied into
tool output. Allowlisted oRPC codes keep their name (`BAD_REQUEST`,
`UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `TOO_MANY_REQUESTS`);
anything else is `INTERNAL_ERROR` with a `requestId`. Wrapper-level errors
use their own codes (for example `INSUFFICIENT_SCOPE`, `CONFIRMATION_REQUIRED`,
`INVALID_INPUT`, `OUTPUT_TOO_LARGE`, `REQUEST_ABORTED`).

A deletion-related `CONFLICT` also carries a stable `reason`
(`@ws-model-proxy/config/deletion-conflict`), in the text (`Conflict:
<reason>`) and in `structuredContent`:

```json
{ "error": { "code": "CONFLICT", "reason": "retained_history" } }
```

| `reason` | Meaning | What to do |
| --- | --- | --- |
| `retained_history` | Provider accounting history must be kept, so the user can never be deleted. | Archive the user instead. |
| `delete_pending` | The user's request history could not be drained yet; nothing was deleted. | Retry once requests finish. |
| `delete_contended` | The set of affected owners kept changing under the delete, or it kept deadlocking (including a server-side lock or statement timeout); nothing was deleted. | Retry. |
| `still_attached` | A capacity is still attached to a pool member. | Detach it first. |
| `not_stale` | A stale-only delete found the item reporting recently. | Nothing; it is live. |
| `deletion_in_progress` | The user is being deleted and cannot be restored. | Nothing. |

Only these values are forwarded; any other `data` on a `CONFLICT` is dropped.

A `BAD_REQUEST` caused by invalid arguments also lists what was wrong, in the
text (`Invalid input: poolId: Invalid input: expected string, received
undefined`) and in `structuredContent`:

```json
{
  "error": {
    "code": "BAD_REQUEST",
    "issues": [{ "path": ["poolId"], "code": "invalid_type", "message": "Invalid input: expected string, received undefined" }]
  }
}
```

`path` names the failing field (array indexes are numbers; a segment that is
not a field the tool declares is `"?"`), `code` is the validator's issue code (anything outside a short allowlist
of standard codes is reported as `invalid`),
and `message` is the validator's own text. Input values are never echoed:
messages that could quote a value (`custom`, `unrecognized_keys`, unknown
codes) are replaced by fixed text, and at most 20 issues are returned. A
`BAD_REQUEST` the procedure raises for a reason other than argument shape
(for example a failed precondition) stays the plain "Invalid input".

## Login, consent, and scope step-up

The authorization flow uses Better Auth's signed OAuth transaction
(`oauth_query`) end to end:

- `/{lang}/mcp-login` — the MCP sign-in page. It shares the standard sign-in
  component (email/password, social, email OTP, TOTP/2FA) and shows
  display-safe requesting-client data fetched pre-login through a signed
  transaction. If the current session's grant generation has been revoked, the
  page offers "Sign in again to reauthorize": signing out (preserving the
  signed query) and signing in again creates a new session-derived grant
  generation that requires fresh consent.
- `/{lang}/mcp-consent` — the consent page. First use always prompts; expanded
  scopes (for example stepping up from `mcp:read` to `mcp:write`) prompt again
  for the full requested set. A remembered consent is reused only when the
  client, the user, the session-derived reference, the requested scopes
  (every requested scope must be inside the remembered set), and the requested
  resources all match the stored consent row — and an explicit `prompt=consent`
  overrides reuse and forces the page. Denial is honored: the consent endpoint
  answers HTTP 200 `{redirect: true, url}` pointing at the validated callback
  with `error=access_denied` — no code and no grant are minted. The page
  explains read/write and `offline_access` (background renewal, 72-hour
  inactivity expiry, revocable in Settings). Remote client logos are never
  fetched or rendered.
- Tampered, expired, or unsigned OAuth queries fail closed.

These pages are excluded from SEO discovery and return real 404s while the
flag is off.

## Tokens: access JWTs, rolling refresh, and the 30-second retry window

- Access tokens are self-contained, resource-bound JWTs valid for
  **10 minutes**, audience-bound to the canonical `/mcp` resource.
- Refresh tokens rotate on **every** successful refresh. The refresh family
  expires after **72 hours of inactivity** — the clock rolls forward on each
  rotation, so an actively used client never expires.
- Better Auth retains a **30-second retry window**: a retried refresh within
  30 seconds of a rotation returns the cached response instead of failing as a
  replay. This tolerates lost-response retries. The window cannot restore a
  revoked grant's access (a cached response's access token still dies at the
  live `/mcp` grant check), and presenting the revoked **current** refresh
  token fails and deletes the whole refresh family — see
  [Grants and revocation](#grants-and-revocation) for both post-revoke
  branches.

## Grants and revocation

Every access JWT carries a private `mcp_grant_id` claim bound to an
application-owned `McpGrant` generation keyed by
`(userId, clientId, referenceId)`, where the reference is an HMAC of the
consenting session and the validated client. On every `/mcp` request the exact
grant is loaded and must be active:

- **Human revocation** (Settings → MCP, `confirm: "REVOKE"`) tombstones every
  collected generation for the user/client — including pending authorization
  codes discovered from bounded, validated scans — marks matching refresh rows
  revoked (revocation itself never deletes rows — rotated/expired refresh rows
  are removed later by the retention cleanup once eligible — so replay
  evidence survives), deletes remembered consent, and is idempotent.
- **Refresh** requires the exact grant generation to remain active. A revoked
  generation can never refresh again.
- **Self-contained JWTs** cannot be deleted server-side. Their residual
  lifetime is bounded to at most 10 minutes, and only while the grant remains
  active: the live per-request grant check makes a token from a tombstoned
  generation unusable at `/mcp` immediately, even if a raced or cached
  issuance left an inert token row behind.
- The exact guarantee: a **tombstoned generation** can never refresh again
  and never passes `/mcp`. Re-authorization does not always require a new
  browser session and fresh consent: one accepted interval exists. If a
  reference is **artifact-free** at revocation time (the authorization code
  was already consumed, no consent row carries it, and no grant row exists
  yet) and its connection was revoked mid-exchange, the resumed exchange can
  mint a **new active generation** — grant creation checks only the exact
  persisted reference, and with none of the three artifacts collected the
  revoke had nothing to tombstone (pinned by the integration suite's
  skip-consent fixture, which has zero consent/verification/grant rows for
  the reference). Conversely, when a consent row (or pending code) DOES
  carry the reference, revocation collects and tombstones it and the
  resumed exchange fails. A genuinely new browser session (new reference
  generation) also works and requires fresh consent (the
  remembered-consent row was deleted by the revoke).
- Within the 30-second retry window there is a second accepted branch: after
  revocation, retrying the **rotated (cached) ancestor** refresh token
  returns HTTP 200 with the byte-identical cached token pair, while that
  cached access token gets 403 at `/mcp` — cached delivery, not restored
  authorization. Presenting the revoked **current** refresh token fails and
  terminally deletes the whole refresh family.
- Deleting the user, an active ban, or a forced-2FA requirement also fails
  live checks immediately regardless of token expiry.

Observed upstream behavior (pinned by the integration suite): exchanging an
authorization code whose generation was revoked while the code was pending
surfaces as a bare 500 with an empty body from the installed provider, and
mints nothing. The acceptance invariant — no token from a tombstoned
generation can refresh or pass `/mcp` — holds either way.

## Human grant listing and revocation page

`Settings → MCP` lists, per connected client: safe name/URI, the internal
client record ID, deduplicated scopes, first/latest authorization activity,
the latest rolling inactivity expiry, the active refresh count, and DPoP state
(`all | some | none`). Clients whose grants are all revoked are hidden from
the list. Revocation uses an `AlertDialog` with the `REVOKE` confirmation
literal and returns only `{ revoked: true }`. Token hashes, reference IDs,
session IDs, redirect URIs, and key material are never returned. The CIMD
client cache row is preserved because other users may share the client.

## Personal access tokens

`Settings → MCP` can also mint a personal access token (`wsmp_mcp_…`) for a
headless client. The secret is shown once, creation requires a browser
session, and `mcpTokens.create` is not an MCP tool. This is separate from the
10-minute OAuth access JWTs above.

- Omitting `expiresAt` mints a token that expires **90 days** later, measured
  as exactly 90 × 24 hours (`90 * 86_400_000` ms) from the server clock at
  creation. That is the product default, including the settings form, whether
  or not no-expiry is allowed.
- An explicit `null` means no expiry. That choice is allowed only while
  `WMP_MCP_PAT_ALLOW_NO_EXPIRY` is on (the flag's default stays `true`).
  Turning the flag off refuses explicit no-expiry mints; omission still means
  90 days. The form keeps the "No expiry" option only while the flag is on.
- An explicit timestamp is stored as given when it is strictly in the future
  and at most 365 days (`MCP_PAT_MAX_TTL_DAYS`) from now.
- Changing the flag or the default does not rewrite tokens that already
  exist. List and revoke stay available while MCP is disabled; create does
  not.

## DPoP (optional, preferred)

DPoP is advertised in discovery metadata and validated when used, but is not
mandatory:

- Bearer clients remain fully accepted.
- A client that wants sender-constrained tokens opts in at registration with
  `dpop_bound_access_tokens: true` (recommended — see the client example
  below). Its token-endpoint requests (code exchange and every refresh) and
  every `/mcp` request then require valid DPoP proofs: correct `ath`
  (access-token hash, `/mcp` only), `htu` (the **token-endpoint URL** at the
  token endpoint, the **canonical public `/mcp` URL** at `/mcp` — TLS
  termination does not break it), method, key, expiry, and replay protection.
- Presenting a DPoP scheme against a non-bound token is rejected.

## Retention and cleanup

A cleanup job runs once at startup and hourly while `WMP_MCP_ENABLED` is on
(interval and cutoffs are code constants). **With the flag off the job is not
scheduled at all**: rolling the flag back stops the sweeps, and re-enabling it
starts an immediate sweep that will remove artifacts already past eligibility
(there is no catch-up deferral).

- Rotated refresh-token family rows are retained until expiry so replay and
  family-invalidation evidence is not removed early.
- **Unclaimed dynamic registrations are deleted 24 hours after CREATION**
  (this clock runs from creation, unlike the token grace below, which runs
  from expiry): an RFC 7591 registration with no user/reference owner and no
  consent, access-token, or refresh rows is an abandoned registration and is
  removed by the sweep. CIMD clients (`clientDiscoveryId` set) are exempt.
  An unused DCR-only registration can therefore disappear a day after it was
  created — re-register if that happens.
- The 24-hour audit grace runs **from artifact expiry** (a row becomes
  eligible 24 hours after it expired — not from rollback or revocation).
  After grace, expired access/refresh rows are removed in dependency order,
  along with expired client assertions. Batches are bounded (500 rows
  generally; authorization-code verification scans use 200; DPoP verification
  batches use the general 500-row helper) and operations are idempotent, so
  they are safe across replicas.
- DPoP verification records are swept by their exact identifier prefix plus
  expiry — these use a 1-second verifier-floor safety margin instead of the
  24-hour artifact grace. The safety invariant runs in the RETENTION
  direction: a replay reservation must REMAIN until the verifier can no
  longer accept that proof (deleting one early reopens replay); the sweep
  therefore deletes only at `expiresAt <= now - 1s`, and the hourly
  schedule can retain records well past eligibility — that is safe, only
  late. Authorization-code candidates are validated by bounded
  JSON parsing plus an exact `type === "authorization_code"` check before
  deletion — the scan does **not** match stored user/client ownership (that
  stronger validation belongs to human revocation, which uses validated
  scans). Unrelated email/OTP verification records are never swept.
- Automatic CIMD-client deletion and JWKS key deletion are deliberately
  deferred pending a separately reviewed policy.

## Agent audit log

Every command an MCP agent runs on a CLI device (`forwarder_cli_command_run`,
`forwarder_cli_supervised_command_start`), including refused ones, is recorded
in `cli_agent_action_event` (file operations join it with the file tools). The
log is **metadata only**: who (user, device, token), what (kind, and for a
command a keyed HMAC-SHA256 of the command text plus its program name — never
the command text itself), when, and how it ended (`completed`, `refused`, `failed`,
`cancelled`, `declined`, `expired`, `unknown`, with a stable reason such as
`exit:1` or `limit`). The reason is a stable machine code: a CLI rejection frame
(`exec.rejected`, `supervised.rejected`) whose reason is not a known code is
stored as `rejected`, so CLI-supplied text never reaches the column. File
content, diffs and command output are never stored, and the command's arguments
are never stored: the server reduces the command text to its program (the
first word, only when it is a bare name of letters, digits, `.`, `_` and `-` that
`sh` and `cmd /C`, which the CLI uses on Windows without `sh`, both read as the
command word: a leading `NAME=value`, a quoted word, a path, a redirection, a
flag, a `+` or a built-in followed by `.` all store `?`, as does a command cut
for length) and hashes the whole text (the first 16384 characters of an oversized, refused command). The digest is
HMAC-SHA256 under a key derived from the server auth secret via HKDF-SHA256
(fixed info `wsmp-cli-agent-audit-v1`), so a copy of the table alone cannot be
used to check a guessed command; when the key cannot be derived the hash is
stored as `hmac-sha256:unavailable` and still leaks nothing. Writing an
event never blocks or fails the operation (a bounded in-process queue, dropped
and counted when the database cannot keep up). Rows are deleted after **90
days** by the hourly retention sweep, and with the user on account deletion
(the deletion drain removes them; a row recorded or skipped after that drain,
such as the cancellation of a command still running when the account is
deleted, is removed by the deleted-user purge within its grace period, and the
hourly retention sweep deletes any event whose user no longer exists).
The owner reads them under `Dashboard → CLIs → Agent activity` and through
`forwarder_cli_activity_list` (read scope; visible only to a personal token
minted with CLI commands, like the other CLI tools).

## Rate limits (process-local)

- `/mcp`: an unconditional, pre-authentication IP-keyed bucket
  (`RATE_LIMIT_MCP_POINTS`/`RATE_LIMIT_MCP_DURATION`, default 120 requests /
  60 s), a 1 MB body cap, then — after token verification — an identity-keyed
  quota on `sub + client_id` with the same budget. Pre-auth buckets are never
  keyed by token bytes.
- MCP OAuth endpoints (authorize, consent, continue, token, revoke,
  public-client, public-client-prelogin, JWKS) use an exact method+path
  allowlist with a protocol bucket and a tighter **user-keyed** bucket for the
  consent/continue forms (keyed by the signed-in `session.user.id`, with an
  IP fallback when no session is resolved — the budget is shared across all
  of that user's sessions; consent/continue consume only this tighter bucket,
  not both). Small form-body caps run before the limiters. Everything else
  under `/api/auth/*` keeps the general auth limiter.
- The RFC 7591 register endpoint has its own **whole-service** bucket
  (`RATE_LIMIT_MCP_REGISTRATION_POINTS`/`RATE_LIMIT_MCP_REGISTRATION_DURATION`,
  default 60 requests / 3600 s) keyed globally rather than by IP — DCR is
  intentionally unauthenticated, so an IP key would let rotating source
  addresses persist unbounded OAuth client rows. It runs before the general
  auth limiter on that path.
- **All limits are process-local and in-memory**: counters reset on process
  restart, and clients exceeding a bucket get `429` with a `Retry-After`
  header. Statelessness removes session affinity, not the need for
  distributed limiting: the documented ceilings assume a **single-process
  deployment** — when replicas scale horizontally, every in-memory ceiling
  effectively multiplies by the replica count, so arrange shared enforcement
  before relying on fleet-wide ceilings. Distributed rate limiting is out of
  scope for this release.

## Client examples

### Discovery — two document types, four paths

There are **two distinct metadata documents**, each served at two paths:

- **RFC 9728 protected-resource metadata** (the `/mcp` resource):
  `/.well-known/oauth-protected-resource` and
  `/.well-known/oauth-protected-resource/mcp`. Fields: `resource` (the
  canonical `/mcp` URL), `authorization_servers`, `bearer_methods_supported`,
  `dpop_signing_alg_values_supported`, `scopes_supported` (`mcp:read
  mcp:write` — `offline_access` is authorization-server-only and filtered out
  here).
- **RFC 8414 authorization-server metadata** (the OAuth issuer):
  `/.well-known/oauth-authorization-server/api/auth` and
  `/api/auth/.well-known/oauth-authorization-server`. Fields: `issuer`,
  `authorization_endpoint`, `token_endpoint`, `jwks_uri`, scopes (including
  `offline_access`), DPoP algorithms, the CIMD advertisement
  (`client_id_metadata_document_supported`), and the RFC 7591
  `registration_endpoint` (`…/oauth2/register`).

These are different documents, not aliases of each other. GET returns the
metadata; HEAD returns the same status/headers without a body; other methods
get `405 Allow: GET, HEAD`.

### Publishing CIMD metadata

A CIMD client publishes a metadata document at a **public HTTPS URL, and the
`client_id` IS that URL** — it is a required field and must exactly equal the
document's own address. The installed validator rejects `http://` metadata
URLs, private/loopback HTTPS hosts, URLs without an explicit path component,
fragments, and embedded credentials. (This is separate from **redirect
callbacks** — loopback callbacks like `http://127.0.0.1:8765/callback` are
permitted — and from the local **server origin**, which may be a loopback
`BETTER_AUTH_URL` in development. Only the *hosted metadata document* must be
public HTTPS.)

```json
{
  "client_id": "https://client.example.test/wmp-agent/client.json",
  "client_name": "My WMP agent",
  "redirect_uris": ["http://127.0.0.1:8765/callback"],
  "grant_types": ["authorization_code", "refresh_token"],
  "scope": "mcp:read mcp:write offline_access",
  "dpop_bound_access_tokens": true
}
```

On first use the server fetches this document through Better Auth's hardened
transport (see [Client registration](#client-registration-cimd--dynamic-registration))
and registers the client; `client_id` in every OAuth request below is the
metadata URL itself.

A client that prefers RFC 7591 dynamic registration instead POSTs to the
advertised `registration_endpoint` (`POST /api/auth/oauth2/register`). The
DCR request is NOT the CIMD document above posted as-is — that returns
`400 invalid_redirect_uri` for a loopback public client. Adapt it: add
`"application_type": "native"` and `"token_endpoint_auth_method": "none"`
(keep the same `redirect_uris`, grant types, scope, and
`dpop_bound_access_tokens`), and expect a `201` response whose `client_id`
is a GENERATED identifier — use THAT `client_id` (not any URL) in every
OAuth request below.

### Wire sequence (Bearer or DPoP client)

Let `ISSUER` = `<BETTER_AUTH_URL>/api/auth` and `RESOURCE` =
`<BETTER_AUTH_URL>/mcp`.

1. **Authorize** (browser) — direct the user to
   `GET {ISSUER}/oauth2/authorize?` with: `response_type=code`,
   `client_id=<metadata URL>`, `redirect_uri`, **PKCE** (`code_challenge` =
   base64url(SHA-256(verifier)), `code_challenge_method=S256` — required for
   public clients and the only supported method), `scope` (include
   `offline_access` for refresh tokens), `resource=<{RESOURCE}>` (required —
   requests without the canonical resource are rejected locally with
   `invalid_target`), and a `state`. After login and consent the callback
   receives `code` + `state` (+ `iss`).
2. **Code exchange** — `POST {ISSUER}/oauth2/token`
   (`application/x-www-form-urlencoded`):

   ```
   grant_type=authorization_code
   client_id=<metadata URL>
   code=<code>
   redirect_uri=<same as above>
   code_verifier=<PKCE verifier>
   ```

   The response carries `access_token` (a 10-minute JWT), `refresh_token`,
   and `token_type` (`Bearer`, or `DPoP` for bound clients).
3. **Refresh** — same endpoint:

   ```
   grant_type=refresh_token
   client_id=<metadata URL>
   refresh_token=<current refresh token>
   ```

   Refresh tokens rotate on every refresh; within 30 seconds of a rotation a
   retried (rotated) token returns the cached pair. After a revocation the
   window still delivers the cached pair for the rotated ancestor (cached
   delivery only — that access token fails at `/mcp`), while presenting the
   revoked **current** token fails and deletes the whole refresh family
   (see [Grants and revocation](#grants-and-revocation)).
4. **Tool call** — `POST /mcp` (JSON, one JSON-RPC message per request). The
   `2026-07-28` wire requires header/body agreement: `Mcp-Method` must repeat
   the body `method`, and `Mcp-Name` must repeat `params.name` when present
   (a mismatch fails with `-32020`). `params._meta` carries the protocol
   version, client info, and capabilities:

   ```
   POST /mcp HTTP/1.1
   Host: <canonical host>
   Content-Type: application/json
   Accept: application/json
   Authorization: Bearer <access JWT>
   Mcp-Method: tools/call
   Mcp-Name: forwarder_model_pools_list

   {
     "jsonrpc": "2.0",
     "id": 1,
     "method": "tools/call",
     "params": {
       "name": "forwarder_model_pools_list",
       "arguments": {},
       "_meta": {
         "io.modelcontextprotocol/protocolVersion": "2026-07-28",
         "io.modelcontextprotocol/clientInfo": { "name": "my-agent", "version": "1.0.0" },
         "io.modelcontextprotocol/clientCapabilities": {}
       }
     }
   }
   ```

### DPoP-preferred client (sender-constrained tokens)

Register with `dpop_bound_access_tokens: true` (as above). Generate an
asymmetric keypair (e.g. **ES256**/P-256; the advertised algorithms include
ES256), compute its RFC 7638 JWK thumbprint, and send a fresh RFC 9449 DPoP
proof JWT in a `DPoP` header on **every token-endpoint and `/mcp` request**:

- Proof header: `{ "typ": "dpop+jwt", "alg": "ES256", "jwk": <PUBLIC jwk> }`;
  payload `{ "htm": "POST", "htu": <URL>, "jti": <unique>, "iat": <now>,
  "ath": <base64url(SHA-256(access token)) — /mcp requests only> }`.
- **htu differs by endpoint**: at the **token endpoint** the proof's `htu` is
  the token-endpoint URL (`{ISSUER}/oauth2/token`); at **/mcp** it is the
  canonical `/mcp` URL. A proof naming the other endpoint is rejected.
- Token requests carry `Authorization: DPoP <access JWT>` only at `/mcp`; the
  token endpoint itself just needs the `DPoP` proof header (exchange and every
  refresh both require it for bound clients).
- A successful exchange/refresh returns `token_type: "DPoP"` and binds the
  key thumbprint into the token's `cnf.jkt`; every subsequent `/mcp` request
  must present a valid proof from that same key (correct `ath`, `htu`, `htm`,
  fresh `jti`, unexpired).
- Failure modes: a missing/invalid proof at the **token endpoint** is
  `400 invalid_dpop_proof`; a missing/invalid proof (or a `Bearer` scheme on
  a bound token) at **/mcp** is a `401` with a `WWW-Authenticate: DPoP`
  challenge.

### Notes

- `dpop_bound_access_tokens: true` is the recommended shape (sender-constrained
  tokens); omit it for a plain Bearer client — Bearer clients remain fully
  accepted.
- Public clients must use PKCE (the server requires it; S256 only).
- The MCP endpoint URL is the canonical `RESOURCE` above; every request
  needs the explicit canonical `Host` header when behind a proxy (see
  [Canonical URL](#canonical-url-and-reverse-proxy-behavior)).

## Better Auth bump checklist

When bumping the Better Auth family (`better-auth`, `@better-auth/mcp`,
`@better-auth/oauth-provider`, `@better-auth/cimd`), re-verify:

1. **Package alignment** — one compatible family version across core and
   plugins (`pnpm why better-auth`); re-check the Kysely pin.
2. **Generated OAuth and TwoFactor schema** — regenerate the schema from the
   new plugin output and reconcile against `packages/db/prisma/schema/auth.prisma`
   (the schema suite derives expected fields from the installed plugins and
   pins the deviation set, including `OauthResource.allowedScopes Json?`).
3. **SDK protocol version** — the MCP server SDK v2 package and its
   `legacy: "reject"` / JSON / `maxSubscriptions: 0` options; handler-owned
   teardown.
4. **Discovery aliases** — the four well-known paths still served natively by
   the plugins; the RFC 7591 `registration_endpoint` still advertised.
5. **`oauthProviderClient` signed state** — `oauth_query` still carries the
   signed transaction through sign-in, 2FA, consent, and continuation.
6. **Consent behavior** — first-use and expanded-scope (full-set re-prompt)
   consent, remembered consent, denial, and the prelogin endpoint's
   signature requirements.
7. **JWT claim / `AuthInfo` mapping** — the `extensions[].claims.accessToken`
   hook surface and `referenceId` forwarding at exchange, refresh, and
   introspection.
8. **DPoP and proxy validation** — `requireMcpAuth` options, the DB-backed
   replay store, and `htu` derivation against the canonical URL behind TLS
   termination.
9. **Refresh rotation/reuse** — rotation on every refresh, the 72-hour rolling
   inactivity expiry, and the 30-second cached-retry window semantics.
10. **Native endpoint limits** — the provider's own per-endpoint limits on
    token, authorize, introspect, revoke, and userinfo, and how they compose
    with the app's MCP OAuth limiter allowlist.
11. **Standalone device flow** — the `deviceAuthorization` plugin and CLI
    device flow remain unchanged by the bump.
12. **JWT revocation latency** — the residual ≤ 10-minute access-token
    lifetime and the live `/mcp` grant check remain the only revocation
    latency bounds; confirm no new server-side JWT denylist assumption.

## Manual MCP Inspector smoke checklist

Operator procedure, not a unit test. Run against a deployment that leaves
`WMP_MCP_ENABLED` at its default of true:

1. Discovery — all four well-known aliases return metadata; the RFC 7591
   `registration_endpoint` is advertised.
2. CIMD — first-use client registration from a published metadata URL.
3. Login with 2FA.
4. Consent including `offline_access`.
5. Read — a read tool succeeds.
6. Read-only write denial / step-up — write denied without `mcp:write`;
   re-consent for the expanded full scope set.
7. Confirmation denial / success — write tool without `confirm`, then with
   the literal.
8. Refresh rotation and retry — tokens rotate; a retried refresh within the
   window returns the cached response.
9. Settings grant listing / revocation.
10. Post-revoke refresh, both branches — ORDER MATTERS: within the
    30-second window, first retry the **rotated ancestor** (it returns the
    cached pair whose access token gets 403 at `/mcp` — cached delivery, not
    restored authorization); only THEN present the revoked **current**
    refresh token (rejected, and it wipes the whole refresh family — doing
    this first makes the cached branch unobservable).
11. Reauthorization — sign in again after revocation; fresh consent required
    (this path created a remembered consent row in step 4, so the narrow
    artifact-free exception — consumed code, no consent row, no grant yet,
    revoked mid-exchange — does not apply here; see
    [Grants and revocation](#grants-and-revocation)).
12. Wrong-resource denial — a token for a foreign resource/audience is
    rejected.
13. Bearer / DPoP interoperability — a plain Bearer client works; a
    DPoP-bound client's proofs validate (and a bad proof fails).
