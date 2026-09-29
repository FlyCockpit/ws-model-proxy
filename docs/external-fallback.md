# External fallback (`owner/pool:external`)

Request data leaves a WSMP deployment for an external provider only when the
caller asks for it in the model name and every party allows it.

## Model names

- `owner/pool` (plain name): served by the pool's local members only. It never
  leaves the deployment.
- `owner/pool:external`: may use the pool's external (provider) fallback
  members or your own-key model when local service is unavailable.
  - The variant is lowercase and used once. Unknown, uppercase, or stacked
    variants, and any suffix on a direct model id, return `404 model_not_found`
    with a message naming the correct id.
  - Accepted on `/v1/chat/completions`, `/v1/responses`, and `/v1/messages`.
    `count_tokens` treats it as the plain name and never contacts a provider;
    on a pool with only external members it returns
    `400 local_members_required`.
    Embeddings, audio, and multipart requests reject it with
    `400 external_variant_unsupported`.

## When a request may go external

For owner-paid pool fallback, all of these must hold:

1. The deployment switch `WMP_PUBLIC_PROVIDER_EGRESS_ENABLED` is on.
2. The model name is `owner/pool:external`.
3. The API token allows external providers (`allowExternal`, off by default).
   Allowlist tokens also need the pool's `includeExternal` entry. All-visible
   tokens are all-or-nothing. Only a signed-in person can change these settings;
   MCP agents cannot. A signed-in user's own Chat Test counts as that user's
   consent. MCP diagnostics cannot use `:external`.
4. The pool owner enabled fallback (`fallbackEnabled`).
5. The requester is the pool owner, or the owner enabled `fallbackForGrantees`
   (off by default for every pool).

Own-key routing shares conditions 1–3, plus the exact live grant, owner equivalent declaration, and requester-owned active provider resources; the owner-paid flags do not apply.

These conditions are checked when the request arrives, and checked again against
current database state immediately before any request data is sent (the
switch, the owner's two settings, the token's consent and revocation or
expiry, the requester's account (not banned, no pending deletion), and, for
someone other than the owner, the exact pool grant the request was resolved
under; a revoked and re-created grant does not count). That last check runs
in the same database transaction that claims the provider credential for the
send, and it holds those settings unchanged until the send is claimed; token
expiry and the account state are evaluated together against the database's
statement clock, again after that transaction's last lock wait. If any of them no longer holds, nothing is sent. A change
saved after that point applies from the next send.

The request goes external only after local routing could not serve it:

- the local wait expired (an `:external` caller waits at most the pool's
  `externalAfterWaitMs`, default 2000 ms, and never longer than the local wait
  budget; 0 means "go external at once when no local member is free now");
- no healthy, compatible local member exists;
- a retryable local failure happened before the first response byte, after the
  other local members were tried;
- the request is larger than every local context window (only for
  `:external`; a plain name keeps the context error).

Hitting your own concurrency caps (per token, per user) is never a reason to go
external: you get `429` as before, and external requests (including stored
Responses operations on externally served responses) count against those caps.

A request has at most one external phase; precommit failover across external
members follows the existing retry rules.

### When the external attempt does not happen

If the attempt cannot send (no compatible external member, provider busy or
unhealthy, a consent withdrawn since the request arrived), `:external` never
gets worse local service than the plain name:

The table describes owner-paid fallback. Own-key provider-only failures can
preserve the upstream status as described under [Own-key failure and accounting](#own-key-failure-and-accounting).

| Situation | Result |
| --- | --- |
| Local wait expired, pool has local members | Waits again for the rest of the local budget, `B - min(B, E)` (B = local wait budget, E = `externalAfterWaitMs`; no budget stays unbounded; 0 means "only if free now"). If still no slot: `429 rate_limited`, like the plain name. The place in the local queue is not kept. |
| No compatible or healthy local member, context too large, or local failures after every member was tried | The same error the plain name gets. |
| Pool has only external members, no external member fits the request | `400 unsupported_capability` |
| Pool has only external members, the compatible ones are all in a provider health cooldown | `503 external_unavailable` |
| Pool has only external members, provider busy | `429 rate_limited` |
| Pool has only external members, anything else (unhealthy, failure before the first byte, fallback or consent withdrawn) | `503 external_unavailable` |
| Client cancels before a provider response is committed | `499 cancelled` (also recorded as 499, irrespective of a rejected upstream status) |

All of these carry `x-wsmp-fallback: unavailable`.

## Responses and headers

- `x-wsmp-route: local | pool-fallback | own-key`
- `x-wsmp-fallback-reason` and `x-wsmp-served-model` on external responses.
  The response `model` field is the provider's served model id.
- `x-wsmp-fallback: unavailable` when `:external` was requested, the response
  did not come from an external provider, and either no external route exists
  for this caller (owner settings, or no external members) or an external
  attempt was needed but did not happen. A `:external` request that local
  members served before any trigger fired carries no such header.
- With the switch off, `:external` requests get `403 external_providers_disabled`
  (OpenAI error shape, or an Anthropic `permission_error` on `/v1/messages`) and
  `/v1/models` does not list `:external` names.
- A token that does not allow external providers gets
  `403 external_not_permitted` for `:external` names.
- A pool with only external members answers its plain name with
  `400 external_required`, naming the `:external` id.

`/v1/models` lists `owner/pool:external` only when this token could be served
that way (switch, token, owner consent, and a configured pool fallback or own-key route).

Attempts that are refused before provider I/O settle their token and spend
reservations at zero. If bytes may have reached the provider and no trustworthy
usage is available, settlement retains the conservative reserved amount.

## Stored Responses

A response served externally can be continued, retrieved, cancelled, compacted,
listed, or deleted only with `owner/pool:external`-level consent that still
holds (switch, token, and owner settings), checked on arrival and again
before sending. Withdrawing these restorable permissions gives `403 external_not_permitted` (or
`403 external_providers_disabled` with the switch off). A plain-name follow-up
gets `400 external_required`. A busy provider gives `429`. A provider that is
temporarily unavailable (a disabled model or account, health cooldown, a recovery
probe already in flight, a failure before anything was sent) gives
`503 external_unavailable`; retry later. Only a binding
that can never be served again (its member, endpoint identity or version,
upstream model, or native Responses support changed, or its exact grant was
revoked or replaced) gives `404`, whether detected on arrival or at the send
boundary. Re-granting access cannot revive an old binding. `:external`
follow-ups to locally served responses stay on their local member.

Locally served responses work the same way for owners and grantees: a
follow-up returns to the member (and backend) that stored the response. A
grantee's binding is tied to their exact grant, so revoking or replacing the
grant removes it (`404` afterwards). A member that was removed from the pool or
disabled is no longer reachable through the binding (`404`); a draining member
still serves its follow-ups. These checks run again right before the request is
sent, so a revoke or removal while a request waits for capacity also gives
`404`. A locally served response ends only once its follow-up binding is
saved. If the binding cannot be saved (for example, the member was removed or
the grant revoked while the response was generated), the response ends with a
stream error instead of a clean end, because it could not be continued.

## Breaking changes in this release

The consolidated upgrade notes, including deploy requirements and the grantee
local-member fix, are in [`release-notes/next.md`](release-notes/next.md).

- Plain pool names never leave the deployment. Provider-backed PRIMARY members
  were moved to the external fallback tier, and fallback was enabled on those
  pools. Pools with only provider members must be called as
  `owner/pool:external`.
- Existing API tokens are private-only until a person enables "Allow external
  providers" on the token (and, for allowlist tokens, per pool).
- `fallbackForGrantees` is off for every pool, including existing ones. Owners
  must opt in to pay for grantees' external use.
- Stored-Responses bindings to provider members created before this release
  are invalidated; their follow-ups return "not found".
- The grant-time egress acknowledgement is gone. The pool create/update and
  grant procedures (oRPC and MCP) no longer take `publicEgressAcknowledged` or
  `publicEgressEnabled`; unknown arguments are stripped, so old clients
  silently lose them. Use `fallbackEnabled`, `fallbackForGrantees`, and
  `externalAfterWaitMs` on the pool procedures. Over MCP, the general pool
  tools reject `fallbackEnabled` and `fallbackForGrantees`; change them with
  `forwarder_pool_fallback_update` (literal `mcp:write`, no confirmation, cost
  stated in its description, every change audited). The guarded pool tool
  creates local-only pools. A new
  `externalAfterWaitMs` must not exceed the pool's local wait budget; a save
  that does not change it is never rejected because of it. The guarded pool wizard also strips the old arguments and rejects provider models
  at the PRIMARY tier.
- Owners can turn fallback off without removing external members.
- Wait budgets are measured on the database clock. A budget of 0 now means
  "admit only if a slot is free right now" instead of never admitting.
- With the deployment switch off, provider keys and configuration can still be
  listed, revoked, and deleted.


### Legacy storage removed (one `APPLY_SCHEMA=dangerous` deploy)

The release that removes the retired acknowledgement storage requires
`APPLY_SCHEMA=dangerous` once. Back up the database first. It drops
`model_pool."publicEgressAcknowledged"` and the `dashboard_notice` table
(legacy grantee notices, unused since the fallback redesign), and the unused
`user` index on `("deletionSweepNextAttemptAt", "deletionRequestedAt")`. No
user-visible behaviour changes. The pool field `fallbackEnabled` keeps its
stored column name `publicEgressEnabled`. The same deploy carries the capacity
lock redesign (DL-1): it drops the foreign keys between request history and
the dashboard graph and moves the capacity scheduler state into
`capacity_runtime`. Stop every running server before the apply; an old server
writes columns the apply removes.

## Dashboard flow

On a pool’s **Fallback** page, enable **Allow external fallback** and optionally
**Also for grantees**. The second setting lets shared users use your providers
at your expense; their token and request must still opt in. The page shows both
model names with copy buttons. Selecting provider models in the setup wizard
enables fallback for the owner; sharing it stays off. No additional confirmation,
grantee notice, or email is sent.

Model API tokens start with external access off. During creation, or in the
**External providers** editor afterward, a person can allow external providers.
During creation, external access includes every selected pool; uncheck individual
pools to keep them local only. Later, turning external access off and back on
preserves the saved per-pool choices, including an empty selection. All-visible
tokens allow all pools or none.
Enabling the permission lets prompts, attachments, tools, and generated output
leave this deployment for third-party providers when the request uses
`<pool>:external` and local members cannot serve it. If creation succeeds but
the separate permission save cannot be confirmed, the secret remains visible;
check the token’s permissions before using it.

The **Fallback available** badge (a static **Local only** chip otherwise)
describes availability for the viewer, based on the deployment switch, pool
settings, configured provider members and, for grantees, their own provider
key. Tapping, clicking, hovering or keyboard-focusing it opens a hint that lists
the routes open to this viewer: the pool's fallback providers and/or the
viewer's own provider key (billed to them). It does not promise current provider
health or imply that plain-name requests go external.
Owners see their provider account labels. Eligible grantees see only coarse provider
types, never the owner's account labels, identifiers, URLs or credential metadata;
ineligible grantees receive neither labels nor types. Shared request history also
withholds the owner's target, member, capacity and attempt identifiers.
Chat Test lists a separate `:external` entry for eligible pools; selecting it
provides the signed-in person’s consent for that test.

Provider management remains on the Pools and Fallback pages when the deployment
switch is off. Stored account and key details remain visible, with revoke and
delete actions available. Creation, edits, imports, and credential tests are
hidden or disabled. Token and pool consent can still be withdrawn: turn external
access off, uncheck per-pool consent, and disable pool fallback or grantee
coverage; wait-time edits still save. Turning consent on or enabling fallback
while the switch is off is blocked in the UI with feedback. Saved choices
remain intact. While deployment flags load, the UI shows skeletons; a failed
fetch shows a retry state. Secrets are never returned.


## OpenRouter privacy (`data_collection: "deny"`)

Every request WMP sends to an **OpenRouter** provider account carries
OpenRouter's provider-routing preference `provider: { data_collection: "deny" }`.
OpenRouter then routes only to upstream providers that do not store or train
on prompts. This covers owner-paid pool fallback and own-key (BYOK) traffic,
native pass-through and adapted requests alike. Other provider types never get
the field. If the rendered body already has a `provider` object, its other keys
are kept and `data_collection` is overwritten, so a caller cannot relax it.

Each OpenRouter account has the setting **Allow OpenRouter providers that may
collect data** (off by default) on the Providers page. The owner sets it for
owner-paid accounts; grantees set it on their own accounts. It is human-only:
MCP cannot change it, and MCP cannot move an OpenRouter account to another
provider type either (that would drop the preference, which is keyed on the
type). Changing an account's provider type in the dashboard resets the setting
to off. Turning it off takes effect for requests not yet sent: the send step
re-reads it under the account lock. Changes are recorded as `ACCOUNT_UPDATED`
provider audit events.

With `deny` on, some models (often `:free` ones) have no eligible provider.
OpenRouter then answers 404 ("No endpoints found matching your data policy");
WMP returns **503** with code `provider_data_policy_unavailable` and a message
that names the cause, instead of the bare 404 (an OpenAI error object, or an
Anthropic `api_error` envelope on the Messages surface). Choose another model or allow
data collection on that account.

## Own-key routing (BYOK)

`/{lang}/dashboard/providers` manages your provider keys. Its **Pools** tab
lets a grantee choose a model from their own account for each shared pool.
The owner must declare `externalEquivalentModel`; it is the picker's initial
suggestion, not a required upstream id. An owner uses their own keys as pool
members, never through a grantee preference. Clearing a choice is always
available, including while the deployment switch is off.

Local members are always tried first. At the existing external triggers
(no healthy compatible local member, wait budget, pre-first-byte local
failure after other locals, or an oversized `:external` context), a grantee's
own-key route is tried before owner-paid fallback. Only a failure before any
client bytes permits another route, and owner-paid fallback still requires
`fallbackEnabled` and `fallbackForGrantees`. Streams never switch midway.

Own-key egress requires the deployment switch, the `:external` name, a valid
requester, token `allowExternal` (and ALLOWLIST `includeExternal` for the pool),
the exact live grant, the owner's equivalent declaration, and a requester-owned
enabled model/account/current credential. Signed-in Chat Test follows the
same explicit-name consent as other external requests. MCP cannot set these
preferences. The send claim rechecks consent under the documented C1–C6 lock
order after capacity and budget waits, with a fresh requester-validity read
after the final lock wait. Revoking and replacing a grant never revives an old
preference or Responses binding.

Own-key dispatch uses **DIRECT admission on the requester's capacity**.
Budgets, pricing, reservations, attempts and usage belong to the requester;
the owner's pool budget is not charged. Cache affinity is skipped. Usage
rollups omit the owner's pool/member keys. Owners receive only an aggregate
own-key request count, with no grantee provider or target details. Raw counts
follow RelayRequest retention. Durable own-key route identity is written
before provider I/O, so crash repair retains requester ownership.

**Media:** the pool's media transformer runs before routing. Your own provider
receives that transformed payload, including any transformer results. Original
media is not buffered for a separate external route. Protocol adaptation for
your model is opt-in on your Pools choice; it does not inherit the owner's
adaptation switch or lossy developer-role setting.

Native Responses bindings store the route and exact provider endpoint tuple.
Own-key follow-ups require `:external` and current own-key consent. Stored
response operations revalidate consent too: withdrawals return 403, permanent
identity/grant loss 404, and temporary provider unavailability 503. Bindings
never fail over to another route. The HTTP route header uses `pool-fallback`;
existing durable owner-paid records retain `pool-external` for additive schema
compatibility. Own-key durable records and headers use `own-key`.

Catalog pricing bounds include base and tiered one-hour cache writes and audio
tokens; any variable (`-1`) or malformed supported rate makes pricing unknown.
Audio rates bound both input/output and additional-token accounting. The shared
usage parser supports existing token categories and direct cost, but does not
normalize OpenRouter `cache_write_tokens`, `is_byok`, or `cost_details` metadata.
Those unknown categories keep accounting on the conservative liability path.
Complete OpenRouter usage normalization is deferred to a separate PR with
provider-specific tests. Provider
search, image and audio service charges can be non-token charges: token prices
and token-based budgets are not a bound on the provider's total bill. The
picker and import summary disclose this limitation.

### Own-key failure and accounting

Own-key capacity admission tries only capacity available now, preserving time for the owner-paid tier and any remaining local wait. A skipped own-key tier permits an independently consented owner-paid attempt even for non-retry-safe operations; after provider I/O may have started, the operation's retry policy applies. No tier changes after a response commits. On a provider-only pool, when the owner-paid plan is disabled or empty, an own-key provider error retains its status and safe Retry-After header. Cancellation retains the relay's cancellation status. Unserved failures have no `x-wsmp-route` header. Owner-paid failures retain the status table above, including `503 external_unavailable` for transport errors and retryable upstream failures before the first byte.

Own-key route/target intent is persisted after consent and request setup, immediately before transport I/O. Known no-send failures leave the prior route intact. A failed, uncommitted tier durably restores the prior route and target before pool fallback or local resumption. Terminal metadata uses that same identity. Crash recovery attributes a pending send intent to the requester because the transport may have run; a crash before intent or after supersession uses the prior route. The owner's aggregate counts successful own-key requests only.
