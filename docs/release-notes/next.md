# Next release (after v0.3.1): upgrade notes

## 0.4.0 managed inference

Durable recipe revisions, group-aware deployment plans, human confirmations and
per-node deployment grants are available in Dashboard → Deployments. A switch
stops every rank of each conflicting group, leaving unrelated groups untouched.
Claims remain held until authoritative stop proof; readiness and health gate serving.
Recipes declare measured resources rather than hardcoded model/hardware assumptions.
Every rank's command set explicitly declares `management: ownedProcess | externalService`.
Externally managed services require a reliable status command: exit 0 means alive,
exit 3 proves stopped; other results remain unknown and cannot release claims.
Inference contributions are two-party, revocable offers of specific serving models;
accepting inference never grants control of a contributor's machines.

**`wsmp config set-deployments on` gives the server a shell on that machine.**
For a job the server reports as approved by a person, the CLI runs its commands
(`/bin/sh -c`, as the user running wsmp) whatever the MCP command mode is,
including `off`. The mode applies only to jobs reported as agent-authored, and
in `supervised` it accepts the server's approval flag; there is no confirm
screen on the node. Turn deployments on only on nodes whose server you would
trust with a shell there. Deployments stay off by default.

Interactive recipe commands (a command a person must run, e.g. one asking for
a sudo password) are not usable yet. A recipe can mark commands `interactive`
and be saved, but starting it is refused until a follow-up release. The
node-local switch `wsmp config set-deployment-operator-terminal` exists (off by
default) but has no effect yet.

Recipe commands are limited to 4,096 UTF-8 bytes when saved and again after
placeholder substitution, the same limit the CLI enforces, so a long command is
refused at save or plan time instead of leaving an instance stuck stopping.
Revisions saved earlier with longer commands can still be read, but planning
refuses them. The CLI keeps its deployment state bounded: verified-stopped
instances are dropped an hour after their stop, or sooner (oldest first) when
the 256-instance cap needs room, and stops always have 2 MiB of state reserved,
so state growth can no longer block a stop.

Upgrade every CLI to relay protocol 2.11. Deployment inventory is a complete snapshot
framed by `snapshotId`, sequential `chunkIndex` and `final`; chunks carry at most 512
records and the CLI also bounds encoded frame bytes. The server acknowledges only
after durable current-session commit; the CLI then waits for endpoint-inventory
acknowledgement before consuming the next queued deployment update. One absolute
30-second deadline covers both publication phases and interrupts stalled socket
writes; durable-commit timeout reconnects without authorizing partial inventory. A partial
snapshot is not a complete inventory. Earlier CLI protocols are refused, not silently downgraded.

CLI credential identity is bound to the credential, not a WebSocket session.
Identity reset is a human-only audited action. Unbound CLI tokens bind once on
first valid use; device credentials minted before identity binding are refused
and need `wsmp login`. A pool-grantee spend cap survives revoke/re-grant;
changing a grant's ID does not silently reset the owner's monetary protection.
Databases built from master: the schema push drops the disposable cache column
`capacity_kv_eviction.lastSessionId`, which `APPLY_SCHEMA=safe` refuses when
rows exist; use `APPLY_SCHEMA=dangerous` once. Schema hardening (behavioral
triggers and ownership/claim guards) is installed by `safe`/`dangerous` and
`pnpm db:push`; `APPLY_SCHEMA=off` skips schema sync entirely and is not a way
to remove it. Databases without hardening are unsupported. Hardening takes its
table locks with NOWAIT and retries for about a minute; if a long autovacuum
on a large cache table outlasts that, the deploy stops with a retryable lock
conflict (55P03) and changes nothing. Re-run it, or run `VACUUM` on the named
table first.

External fallback is local-first, with separate human-only, default-off consent for
paid cache-only protection. Embedding fallback requires an exact vector-space contract.
Pools without connected published local service are absent from model listings.
WMP stores no chat content; native Responses defaults to `store: false`, while an
explicit caller may opt into the backend's storage.

Clearing affinity now invalidates a pool's private hint incarnation immediately
and returns `{cleared: true, reclamation: "pending"}` instead of a deleted-row
count. Physical metadata is reclaimed in durable bounded batches; concurrent
requests captured after the clear may establish new warmth. Physical reset
confidence across relay processes uses database-clock observer leases: failed
reset-receipt writes become unknown when the last admitted two-second lease
expires, not through an instantaneous guarantee during a network partition.
This optional confidence never controls permission to perform local inference.

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
- **API tokens are private-only until a person opts in.** Tokens are created
  local only; nothing can use external providers until someone turns on
  **Cloud access** for the token (Dashboard → API tokens). Allowlist tokens
  also choose which pools may go external. The first time an existing
  allowlist token is enabled it includes **no** pools; check each pool you
  want.
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
  to a provider. A request that is too large for one local member is first
  retried once on each other local member that could fit it (members with the
  same engine identity only when their usable ceiling is large enough). With
  `:external` and token consent it may then go external.
- **Grantee spend caps are set only through the pool grant.** The cap is keyed
  by owner, pool and grantee: its recorded spend survives revoke/re-grant and
  period edits, and a currency change starts a new cap. `providerManagement`
  budget procedures now refuse `POOL_GRANT` scopes; use
  `forwarderManagement.updatePoolGrant` or its MCP tool.
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

- **Browser requests from another site are refused on the API.** Every
  cookie-authenticated `/rpc` and `/api-reference` request that a browser
  marks as cross-site (a foreign `Origin`, or `Sec-Fetch-Site: cross-site` /
  `same-site` without an allowed `Origin`) is refused with 403, whatever the
  procedure or body encoding. Non-browser clients (the CLI) are unaffected.
- **Consent, credential and paid-egress actions refuse agents in the
  procedure itself,** not only by being left out of the MCP tool list.
  `inferenceContributions.offer` is now human-only and no longer an MCP tool.
- **Inference contributions lend spare capacity.** On a contributor's machine
  a pool gets the lowest priority, no reserved slots and may always borrow:
  the pool owner's priority, reservation and borrow settings never hold back
  the contributor's own traffic. Pool owners no longer see a contributor's
  live telemetry, device name or engine-load history.
- **Agents set recipes up; people stay in control.** While MCP commands are
  allowed on a CLI, an agent can write recipes and start or stop them. A
  person can always start or stop any recipe from the dashboard, also after
  turning that CLI's MCP commands off: command modes govern agents only.
  When a person starts commands an agent wrote (tracked per command text
  across revisions, so editing one field does not relabel the rest), the
  dashboard shows them for review and asks for confirmation first.

- **Speech-to-text recipes.** A recipe's `attachment.type` can be `llm`,
  `embeddings` or `transcription`. A transcription deployment joins its pool
  as a speech-to-text model for `/audio/transcriptions`, including streamed
  results. Without a profile it receives plain JSON requests; declare an
  optional `attachment.transcription` profile (languages, response formats,
  timestamp granularities, diarization, language detection, upload size and
  MIME types) so requests that use those options route to it — and note that
  a profile also narrows what it accepts (for example a lower upload limit).
  Agents create these recipes through the MCP recipe tools like any other.
  Upgrade the server and every CLI together (relay 2.11 only). After
  downgrading a CLI that ran one, remove its deployment state file.

- **Recipes can be renamed while stopped.** A recipe's slug can be changed
  while none of its deployments are running, in the dashboard or by an agent
  over MCP (`updateConfig`, while MCP commands are allowed on a CLI). A rename
  is refused while any deployment of the recipe runs, and a slug another
  recipe uses is refused.
- **Legacy recipe slugs must be renamed before starting.** A recipe saved
  earlier whose slug ends with `-` or repeats `-` (`--`) is refused at start
  (`invalid_recipe_slug`) because nodes refuse the endpoint it would create.
  Rename it while it is stopped, then start it.
- **A start that stops running models asks first.** When a start or switch
  would stop running deployments, the dashboard shows a confirm dialog naming
  each one before anything is stopped; cancelling leaves them running.
- **File-tool writes need a filesystem that can sync directories.** The CLI
  now journals file-tool writes so an interrupted one can be recovered. Where
  a file root or the CLI state directory is on a filesystem that cannot sync
  directories (some NFS, FUSE or sshfs mounts), writes are refused with
  `unsafe_filesystem` before anything changes. `wsmp recover` lists
  interrupted work; `--apply` undoes only an interrupted capture or an
  unacknowledged delete, and a rename or replace that may have published stays
  manual. See [`apps/cli/docs/file-recovery.md`](../../apps/cli/docs/file-recovery.md).

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
  `service.env` cannot take over another machine once its token has
  connected; a never-used token binds to whichever copy connects first.
  The CLI state directory must be writable: it holds the identity key, and
  `wsmp connect` fails without it. Hello reports
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
