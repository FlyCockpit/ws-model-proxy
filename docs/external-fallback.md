# External fallback (`owner/pool:external`)

Request data leaves a WSMP deployment for an external provider only when the
caller asks for it in the model name and every party allows it.

## Model names

- `owner/pool` (plain name): served by the pool's local members only. It never
  leaves the deployment.
- `owner/pool:external`: may use the pool's external (provider) fallback
  members when the local pool is saturated.
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

All of these must hold:

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

All five are checked when the request arrives, and checked again against
current database state immediately before any request data is sent (the
switch, the owner's two settings, the token's consent and revocation or
expiry, the requester's account (not banned, no pending deletion), and, for
someone other than the owner, the exact pool grant the request was resolved
under; a revoked and re-created grant does not count). That last check runs
in the same database transaction that claims the provider credential for the
send, and it holds those settings unchanged until the send is claimed; token
expiry and the account state are evaluated again after that transaction's
last lock wait. If any of them no longer holds, nothing is sent. A change
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

| Situation | Result |
| --- | --- |
| Local wait expired, pool has local members | Waits again for the rest of the local budget, `B - min(B, E)` (B = local wait budget, E = `externalAfterWaitMs`; no budget stays unbounded; 0 means "only if free now"). If still no slot: `429 rate_limited`, like the plain name. The place in the local queue is not kept. |
| No compatible or healthy local member, context too large, or local failures after every member was tried | The same error the plain name gets. |
| Pool has only external members, no external member fits the request | `400 unsupported_capability` |
| Pool has only external members, the compatible ones are all in a provider health cooldown | `503 external_unavailable` |
| Pool has only external members, provider busy | `429 rate_limited` |
| Pool has only external members, anything else (unhealthy, failure before the first byte, fallback or consent withdrawn) | `503 external_unavailable` |

All of these carry `x-wsmp-fallback: unavailable`.

## Responses and headers

- `x-wsmp-route: local | pool-external`
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
that way (switch, token, owner settings, at least one external member).

## Stored Responses

A response served externally can be continued, retrieved, cancelled, compacted,
listed, or deleted only with `owner/pool:external`-level consent that still
holds (switch, token, grant, and owner settings), checked on arrival and again
before sending. Without it the answer is `403 external_not_permitted` (or
`403 external_providers_disabled` with the switch off). A plain-name follow-up
gets `400 external_required`. A busy provider gives `429`. A provider that is
temporarily unavailable (health cooldown, a recovery probe already in flight,
a failure before anything was sent) gives `503`; retry later. Only a binding
that can never be served again (its member, endpoint identity or version,
upstream model, or native Responses support changed) gives `404`. `:external`
follow-ups to locally served responses stay on their local member.

## Breaking changes in this release

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
  `externalAfterWaitMs` on the pool procedures. Over MCP, `fallbackEnabled` and
  `fallbackForGrantees` are rejected (a person changes them in the dashboard),
  and the guarded pool tool creates local-only pools. A new
  `externalAfterWaitMs` must not exceed the pool's local wait budget; a save
  that does not change it is never rejected because of it. The guarded pool wizard still
  accepts and ignores `publicEgressAcknowledged`, and rejects provider models
  at the PRIMARY tier.
- Owners can turn fallback off without removing external members.
- Wait budgets are measured on the database clock. A budget of 0 now means
  "admit only if a slot is free right now" instead of never admitting.
- With the deployment switch off, provider keys and configuration can still be
  listed, revoked, and deleted.
