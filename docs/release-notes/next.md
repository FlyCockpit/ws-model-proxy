# Next release (after v0.3.1): upgrade notes

Draft notes for the release after v0.3.1 (2026-08-27). They cover the
`:external` consent redesign (#56), the OpenRouter provider type and catalog
(#57), the capacity lease owner (#58), provider URL fixes (#60), the web and MCP
consent surface (#59), and own-key routing (#61). Rename this file to the
version when the release is cut, and paste the sections below into the GitHub
release body (the generated installer notes follow them).

Full behaviour reference: [`docs/external-fallback.md`](../external-fallback.md).

## Discovery capacity lifecycle (#91, #114)

Slot-sharing llama.cpp, vLLM and SGLang processes now share a capacity when the
CLI reports multiple served aliases. Owner assignments and explicit detach choices
are durable per target when the capacity FK actually changes, including changes to
existing AUTO capacities. Saving the same capacity or only a policy keeps the target's
provenance. Untouched pool-member attachment fields preserve the target's current
capacity; deployment marks a target owner-assigned only when its latest audited capacity change (to a non-null capacity) is still in effect; legacy "Not attached" saves are re-attached automatically. Removed aliases
split once idle. Only a connected move group's source and destination capacities gate
its ACTIVE lease / WAITING waiter preflight; unrelated capacities and independent
endpoint groups keep progressing. A busy involved group retries on each later
inventory (CLI reconnect or operator reload), and may remain deferred until idle.
Direct and effective pool concurrency/context policies must
fit every destination. Shared AUTO limits follow engine slots, otherwise the current
automatic member sum; inadmissible lowerings retain the existing limit. Parent deletes
refresh surviving shared aggregates and remove empty AUTO discovery rows atomically.
Startup repairs idle orphans in bounded batches and skips contended owners for retry.
Shared AUTO limits with unknown values wait for a complete inventory aggregate.
Owner-created empty rows remain. Automatic labels choose the lowest free numeric
suffix even when a 120-character preferred label already ends in that suffix.
SERIALIZABLE automatic creators retry collisions on the capacity label unique index
with a fresh transaction after an owner-fence wait; other unique conflicts still surface.
Apply the schema and hardening before starting the new server; this adds target
assignment provenance and automatic concurrency seed columns.

## Before you deploy

- **Schema: `cli_device.connectionGeneration` is added (#129).** An additive
  non-null `int` with a default of `0`, so `APPLY_SCHEMA=safe` applies it
  without a "possible data loss" stop. It fences disconnect writes to the
  connection a session was accepted under, so a close delivered after a
  reconnect cannot re-open the pool members of a live device.

- **Set a stop grace of at least 52 s.** The server can take up to 47 s to shut
  down (`PROCESS_SHUTDOWN_DEADLINE_MS`). Docker's default of 10 s cuts the HTTP
  drain and relay close short. Use `docker stop -t 52`, compose
  `stop_grace_period: 52s`, or your platform's equivalent. See
  [README "Deployment requirements"](../../README.md#deployment-requirements).
- **Database sessions are forced to UTC.** Every Prisma connection (all
  application queries) sets `TimeZone=UTC` on connect. Raw-SQL clocks (`now()`, `clock_timestamp()`) are
  compared with JavaScript-written `timestamp without time zone` columns and
  depend on it.
- **Transaction-mode poolers are unsupported.** PgBouncer
  `pool_mode=transaction` loses the session settings (`TimeZone`, the sweeper's
  `statement_timeout`). Connect directly or use session pooling.
- **Schema: deploy once with `APPLY_SCHEMA=dangerous`, after a backup.** #61
  adds a unique constraint on `pool_grant (id, poolId, granteeUserId)`. It
  cannot fail (`id` is already the primary key), but Prisma treats every new
  unique constraint as possible data loss, so `APPLY_SCHEMA=safe` stops with
  "A unique constraint covering the columns `[id,poolId,granteeUserId]` on the
  table `pool_grant` will be added" and the container exits. The other schema
  changes from #56–#61 are additive (`publicEgressEnabled` became
  `fallbackEnabled` on the same column). If you upgrade straight from v0.3.1,
  the same push also applies #51 and #53, which drop `cli_device.label` and
  `cli_device_credential.name`; `dangerous` deletes those values. It also
  deletes CLI credentials whose device was deleted (their `cliDeviceId` is
  now required), so those CLIs must log in again; `safe` stops on those rows
  before Prisma lists its warnings. Run `safe` first and read every warning it
  prints before switching to `dangerous`, then go back to `APPLY_SCHEMA=off`. The schema deploy also re-applies the
  schema hardening that carries the grantee trigger fix below; with
  `APPLY_SCHEMA=off` that fix is not installed.

- **Capacity lock redesign and legacy storage drop (#78, #74): one more
  `APPLY_SCHEMA=dangerous` deploy, after a backup, with every server stopped.**
  The push drops the foreign keys between request history (admission,
  capacity leases, relay requests, stickiness, usage rollups, provider
  attempts and accounting) and the dashboard graph, moves the capacity
  scheduler state and fencing counter from `inference_capacity` into the new
  `capacity_runtime` table (the hardening re-seeds each fencing counter from
  its highest lease token; scheduler fairness restarts once), and drops
  `model_pool."publicEgressAcknowledged"`, the `dashboard_notice` table and an
  unused `user` index. `APPLY_SCHEMA=safe` stops listing exactly those
  columns and that table. Stop every running server first: an old server
  writes the dropped columns. Then start the new image once with
  `APPLY_SCHEMA=dangerous` and go back to `APPLY_SCHEMA=off`.

## Breaking changes

- **Plain pool names never leave the deployment.** Provider-backed PRIMARY
  members were moved to the external fallback tier, and fallback was enabled
  on those pools. A pool whose members are all providers must be called as
  `owner/pool:external`; its plain name answers `400 external_required`.
- **API tokens are private-only until a person opts in.** Existing and new
  tokens cannot use external providers until someone turns on "Allow external
  providers" for the token in the dashboard. Allowlist tokens also choose
  which pools may go external. The first time an existing allowlist token is
  enabled it includes **no** pools; check each pool you want.
- **`fallbackForGrantees` is off for every pool,** including existing ones.
  Owners must opt in to pay for grantees' external use.
- **Stored-Responses bindings to provider members created before this release
  are invalidated.** Their follow-ups return "not found".
- **The grant-time egress acknowledgement, grantee notices and email are
  gone.** The old oRPC and MCP arguments (`publicEgressAcknowledged`,
  `publicEgressEnabled`, the privacy-confirm flags) are silently stripped. Use
  `fallbackEnabled`, `fallbackForGrantees` and `externalAfterWaitMs` on the
  pool procedures in the dashboard or oRPC API. Over MCP only
  `externalAfterWaitMs` is accepted: MCP rejects `fallbackEnabled` and
  `fallbackForGrantees` (only a person may change them, in the dashboard).
- **Context-ceiling requests on plain names now fail** instead of falling back
  to a provider. With `:external` and token consent they may go external.
- **A wait budget of 0 means "admit only if a slot is free right now"**
  (measured on the database clock). Before, it effectively never admitted.
- **New response headers:** `x-wsmp-route` (`local | pool-fallback |
  own-key`), `x-wsmp-fallback-reason`, `x-wsmp-served-model`, and
  `x-wsmp-fallback: unavailable`. The response `model` field is the served
  upstream model id.
- **Own-key routing (BYOK).** Grantees can route `owner/pool:external`
  through their own provider key. The pool owner must first declare an
  external-equivalent model. Own-key traffic is billed to the grantee; the
  owner sees only an aggregate count. The own-key provider receives the
  payload **after** the pool's media transformer.
- **OpenRouter accounting is conservative for now.** Until OpenRouter usage
  normalization lands (#62), budgets over-count OpenRouter spend.

- **Deleting a device, endpoint, model, pool, capacity or user no longer
  waits for or is refused by its request history.** History keeps the deleted
  ids and is removed by the retention sweeps; a deleted user's remaining history is purged after 24 h.
  Accounts with provider accounting still cannot be deleted (archive them).

## Fixed

- **A disconnect that arrives just after a CLI reconnects no longer re-opens
  its pool members (#113, #129).** The reconnect hello had already made the
  members due, but the old socket's close could still be processed during the
  new registration and re-impose the full 60 s circuit-open (and a
  `DISCONNECTED` device status) over the live session. Disconnect writes now
  carry the connection generation they were issued under and apply only while
  the device still holds it, so the stale close matches no row.
- **Grantees of shared pools could not use local members.** Since #26
  (2026-08-25), on databases with schema hardening applied, a grantee's
  request to a shared pool's local member failed: the database rejected the
  request's start record and the request errored. Grantee `:external`
  responses paid by the pool owner were delivered, but their request record
  stayed pending until crash recovery. The `relay_request` consistency trigger
  now checks the selected target against the pool owner for pool routes, and
  against the requester for own-key and direct routes (#61). The schema deploy
  above installs it.

## Per-caller `:external` wait (#181)

A model-API token can store `externalAfterWaitMs` (null uses each pool's wait).
`:external` requests may also send `x-wsmp-external-after-wait-ms`. The pool
value is an owner floor: callers may only lengthen, up to the local capacity
wait budget, and cannot shorten below the floor. When fallback is off, the
caller waits the full local budget. MCP:
`model_api_token_external_wait_update`. The column is additive and nullable
(`APPLY_SCHEMA=safe`).

## CLI identity bind and native count

- **CLI devices and CLI tokens bind to the CLI identity key, not `/etc/machine-id`.**
  Hello signs a server nonce mixed with the server origin. Every existing
  device credential is refused until `wsmp login` is run once per machine.
  CLI tokens TOFU-bind the identity key on first hello; the owner can reset
  that bind from the dashboard without revoking the token. A copied
  `service.env` cannot take over another machine. Hello reports
  `identity_mismatch` when the bound key does not match. A 2.4 CLI against an
  older server exits with an upgrade-the-server error. Unexpected server
  failures send `protocol.error` `internal` and the CLI reconnects.
- **Metric routing rules live in `pool_routing_rule`.** Databases built from
  v0.3.1 never stored `model_pool.routingRules` JSON. Unreleased master
  databases that did lose those rules on the schema push (`APPLY_SCHEMA=safe`
  stops on the column drop; `dangerous` drops them). Re-enter the rules in
  the dashboard after upgrading a master-built DB.
- **Native Chat Completions counting is per endpoint.** The CLI probe writes
  `engineFacts.countContext` onto the inference capacity (`engineCountContext`,
  additive, `APPLY_SCHEMA=safe`). Near-ceiling Chat Completions skip native
  count when the method is missing or `unsupported` (Ollama, SGLang, generic,
  failed probes). When a method exists, the same `relay.request` carries
  `countFirst` and `countCeiling`: the CLI tokenizes, then either forwards the
  body once or returns structured `request_too_large`. Estimates never reject.
- **Reconnect keeps the probed count method** when the engine kind is unchanged.
  Tokenize counts above `1e12` are refused instead of closing the relay session.
- **Engine-load history survives a reconnect.** Disconnect no longer wipes the
  30-minute rings. New keys at the 2000-ring (or 64-per-device) cap are refused
  while existing live rings stay; rings older than the window are pruned.
- **`GET /v1/models` lists only ids this token can call now.** Plain pool and
  direct ids need a published PRIMARY local member (or the direct model) with
  a live CLI session. Empty, unpublished, and disconnected ids are omitted.
  FULL or saturated pools stay listed. `owner/pool:external` stays when the
  token has access, even if no local member is live.
- **MCP `fields` for nested argument errors are dotted paths** (`rules.0.threshold`).
  Guarded pool-create policy errors name the create input keys (`reservedSlots`,
  `memberConcurrencyLimit`, `memberContextCeiling`, `advanced.contextMargin`).
- **Callers that match `context_exceeded` must switch to `context_length_exceeded`.**
  Grant spend caps use the pool's pricing currency (`POOL_GRANT` scope). OpenRouter
  inventories may declare Chat Completions, Responses, and Anthropic Messages.
- **Prefix-cache resets send `delta = current` with `prefixCacheReset`.** A dropped
  reset frame is retried on the next scrape so post-restart counts are not lost.

## Post-deploy verification

The trigger fix is covered by the PostgreSQL CI suites but has not yet been
observed on a real deployment. After deploying:

- [ ] As a grantee, send one request to a shared pool that a local member
      serves. It succeeds.
- [ ] As a grantee with a token that allows external providers, send one
      `owner/pool:external` request that the pool owner pays for
      (`fallbackEnabled` and `fallbackForGrantees` on). It succeeds with
      `x-wsmp-route: pool-fallback`.
- [ ] Both `relay_request` rows reach a terminal state (not `PENDING`), and
      their selected execution target belongs to the pool owner.
- [ ] Record the result on issue #92.
