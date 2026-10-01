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

The owner's two settings are also checked before the request takes a provider
capacity slot, so a request whose owner turned fallback (or grantee coverage)
off after it arrived does not wait on the owner's provider capacity; it gets
the same refusal the send check would give.

Each lock wait of the send check is bounded (2 s). If it cannot get its locks
in time (for example while budget accounting holds the same provider account),
nothing is sent, the reservation is released, and the attempt counts as
temporarily unavailable (`503 external_unavailable` on a provider-only pool).
Using a token for local traffic never waits on that check: the token's
"last used" time is recorded at most once a minute and skipped while the row
is busy.

### Pool owner account state

While a pool owner's account is banned (until a temporary ban expires) or has
a pending deletion, the owner's pools are unavailable to everyone:

- grantees no longer see them in `/v1/models`, the dashboard's model lists,
  token allowlist choices, or the own-key fallback settings (a saved own-key
  choice is kept and applies again when the owner's access returns); the
  usage overview labels them like a pool no longer shared with you;
- requests that name them get the not-found error any unknown model gets
  (`404`), including stored-Responses follow-ups bound to them;
- the send check above re-checks the owner's account against the database
  clock, own-key sends included; a ban or deletion mark saved while a request
  is in flight stops the send;
- one local-send check runs before every send to the owner's machines. It
  reads the owner's account, the requester's account (a requester banned or
  marked for deletion while the request waited gets `401`, nothing is sent),
  the exact grant the request was resolved under (revoked: `404`) and the
  member (removed or disabled: skipped): each local attempt (including after a wait in the local queue and
  before each retry on another member), the native context count, each media
  transformer hop, and stored-Responses follow-ups bound to a local member;
  a follow-up to a pool you can no longer see gets `404`, never `401` (a
  visible pool reached through different access than the binding's is `401`);
- a request that finds the owner inactive after it arrived (at a local send,
  or at the external check) ends there with `404`, without
  `x-wsmp-route`/`x-wsmp-fallback`: it does not resume the local wait. When
  the external check instead finds the requester's own account banned or
  marked for deletion, the request also ends without those headers: `401` on
  pool requests, `403 external_not_permitted` on stored-Responses operations
  bound to an external provider. Work already sent to the owner's machine or a
  provider is not recalled.

When a temporary ban expires, or an admin lifts the ban, the pools are
available again under the same grants.

### Provider target changes

The same send check also confirms that the external member is still in the
pool (and enabled for routing), that its provider model and account are still
enabled, and that the provider endpoint and model are the ones the request was
prepared for. If one of them changed since the request was routed, nothing is
sent: the next external member is tried only when the operation can be safely
retried; otherwise the request gets `503 external_unavailable` (a stored
Responses follow-up whose member or endpoint is gone gets `404`, a disabled
provider `503`).

One availability condition is not re-checked at the send: a stored-Responses
binding whose retention (`expiresAt`) lapses during a long wait is still
honoured once.

The request goes external only after local routing could not serve it:

- the local wait expired (an `:external` caller waits at most the pool's
  `externalAfterWaitMs`, default 2000 ms, and never longer than the local wait
  budget; 0 means "go external at once when no local member is free now").
  When the request's prefix is warm on a busy member, the other local members
  are held back for the pool's cache-holder wait first (see
  [Waiting for the cache holder](#waiting-for-the-cache-holder)); the external
  wait then counts from the end of that hold, so a request never goes external
  while a cold local member is free. Pre-commit retry rounds keep the original
  external deadline instead of waiting another `externalAfterWaitMs` each;
- no local member is free for a new conversation because the members with an
  idle slot hold protected warm sessions (including your own; see
  [Warm-session protection](#warm-session-protection)). A pool is saturated
  for a request when no member is free for it, and "protected" counts as not
  free: a new `:external` conversation may go external at once while a local
  slot is technically idle but holds protected sessions. The reason is
  `local_saturated_protected`. A continuation of a conversation is never
  sent away by protection;
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

On a pool that also has local members, an owner-paid external phase waits for
provider capacity at most `min(provider member budget, 10 s)`. If no provider
slot frees by then, the attempt counts as "provider busy" and the request goes
back to its local queue for the rest of the local budget (see the table below).
The 10 s cap covers the whole external phase: a pre-commit retry on the next
external member gets only what is left of it.
Pools with only external members keep the provider member's own budget.

### Waiting for the cache holder

Cache-aware routing predicts which member still holds a request's prompt
prefix. When that member is busy, the other members are not used at once: they
become eligible only after the pool's cache-holder wait, so the warm member can
take the request if it frees in time. Without an affinity hit nothing waits.

- Automatic (the default): the re-prefill time the warm member saves, from the
  matched prefix size and the member's measured cold prefill speed (recent
  requests with at least 2000 prompt tokens and at most 5 % cache hits), capped
  at 30 s; 2 s until the speed is measured.
- A fixed value from 0 to 30000 ms (0 turns the wait off). Set it on the pool's
  routing tab, `cacheHolderWaitMs` on `forwarderManagement.createModelPool` /
  `updateModelPool` and `capacityManagement.updatePoolPolicy`, or the
  `forwarder_model_pool_update` MCP tool (`null` = automatic).

Relay metadata records `affinityWaitMs` (how long the request was held for the
warm member) and `affinityOutcome` `HOLDER_WAITED` (the warm member was granted
by the held admission) or `HOLDER_SPILLED` (another member was granted after the
wait). A member that serves only after a pre-commit failover keeps the ordinary
affinity outcome (`PREDICTED_MATCH` / `NO_MATCH`).

The hold also delays everything that counts from the spill instant: the local
wait budgets of the request and, for `:external`, the external fallback wait
both start counting after the hold.

### Warm-session protection

A new conversation should not evict a protected warm session's recently used,
large prompt cache (including your own conversations') when another member, or
an external provider, can take it. No engine
reports how old its cached prefixes are, so WSMP estimates "warm" from its own
routing records (sizes and times only, never prompt content). Traffic that
bypasses WSMP is not seen.

A session is protected when it was used within the pool's protection window
(default 5 minutes) and is at least the minimum size (default 8192 tokens).
For each request, every local member that has no affinity hit for it is:

- **full** when all its slots are busy;
- **protected** when it is not full but every idle slot holds a protected warm
  session (slot mode), or, when the engine reports its KV budget (vLLM, SGLang:
  protocol 2.7 engine facts), when the protected tokens plus the request exceed
  90% of its effective budget (token mode). In slot mode a session whose next
  turn is running right now is served by one of the active leases, so it does not
  also fill an idle slot: only protected sessions no active lease is serving
  count against the idle slots. In token mode every protected session counts,
  because a running session's cache is still in the pool;
- **free** otherwise.

Token-mode KV eviction feedback lowers the effective budget when a successful
local pooled request continues a digest-proven, live-tip warm session whose
previous matched record confirmed engine caching. Both the expected prefix and
the actual reported prompt must be at least `protectMinTokens`; the record must
be within that engine's protection window. A reported cache read of at most 5%
of the expected prefix is an eviction observation. The first observation on a
capacity that is not already cut only arms feedback from that session; a second
observation from a different session lowers K. Later observations from the same
session are ignored, including after a live cut, so one conversation's template
rewrites cannot walk K down. Two independent sessions still cut. Pending
corroboration lasts until `expiresAt` (30 minutes from the arming write). An
expired row is a new first miss, matching readers that already ignore expiry.
Chat templates that rewrite earlier turns (Qwen3 and DeepSeek-R1 strip reasoning;
gpt-oss drops earlier analysis channels) can look like a miss on a long confirmed
session when the user sends a follow-up. Follow-ups from that same session do not
cut. A miss from a second session still can.
Unknown cache fields, hits,
partial hits above 5%, short prefixes, client-id-only matches, instruction hints,
matches to ancestors that are not live tips and unranked targets produce no
observation. A client id with a digest-proven live stored tip of that same session
does count: evidence comes from one SQL statement proving that the resolved
session owns a live tip in the request chain and reading the whole-prompt estimate
stored on that tip node. Only an identifiable write of that tip can set its
estimate, including a replay, truncation or bound Responses lineage write. The
matching live hint proves the same session and current digest version and
supplies recency and cache confirmation in the same snapshot.
Byte/unit-overflow requests can refresh routing hints and an authoritative
client's warm footprint without changing its retained tip or the tip's estimate,
even when both writes use the same timestamp. Such a refresh can update evidence
recency and confirmation, but cannot lend its larger footprint to the retained
tip. A refresh that changes the hint's session still yields no evidence. Legacy
nodes with no estimate yield no evidence. The nullable integer node
column is added by safe schema push without deleting existing data.
A concurrent truncation therefore exposes both the new tip and its rewritten
footprint, or neither. Client ids pin the evidence owner even when other sessions
have identical tips. For implicit sessions, identical tips are indistinguishable:
the resolver picks the earliest-expiring tip. If another session last stamped
the shared hint, that turn yields no evidence, failing closed. At most one
observation is lost per tied session; its own identifiable write restamps the
hints and restores evidence. No other session's footprint is accepted. These
checks apply **as of the ranking snapshot** and do not establish engine residency
at dispatch or response time; a later unrelated writer does not affect that snapshot.
The bound Responses `previous_response_id` path is excluded: it has neither a ranked
decision nor the matched record's age. Endpoint prefix-cache counters are also
excluded: they are cumulative, include bypass traffic and cannot be attributed
to a matched prefix. Unconfirmed records cannot count; remembering a zero-read
miss removes confirmation from that prefix.

After a second distinct session corroborates, each further miss from a new
session cuts 5% of the **reported** K (`KV_EVICTION_STEP = 0.05`), with at most
10 distinct sessions per flush and a 50% maximum cut (`KV_EVICTION_MAX_CUT`).
The integer effective budget stays between `ceil(0.5 * K)` and K. Cuts recover
linearly at `0.5 / 1_800_000` per millisecond: a full cut recovers in exactly
30 minutes (`KV_EVICTION_RECOVERY_MS`). Hits write nothing. Only the PROTECTED
threshold (`W_protected + r > K_eff x 0.9`) uses the effective budget; the equity
shares, and so which sessions are protected, stay on the reported K, so evidence
can only make a member PROTECTED sooner (monotone), never release a protected
session. A lower threshold redirects new sessions, which reduces evictions until
evidence stops. The 50% cap, not the 10-per-flush clamp, bounds the cut: a burst
of confirmed misses (for example after an engine restart that flushed every
cache) can reach the cap within seconds, and the cut then recovers over 30
minutes. Distinct sessions whose misses are small but non-zero can each cut
once, and a single-member pool (nowhere to redirect) can hold the cut at the
cap while it stays overloaded. All of this
stays in the fail-safe direction: protection never blocks a request.
Reported-budget changes automatically scale the relative cut. Slot mode,
including llama.cpp, is unaffected. Budgets must be positive int32 counts;
malformed budgets select slot mode, and corrupt stored cuts are clamped.

Feedback is buffered without request-path I/O and flushed at most once per second
per capacity per process, with one trailing timer. At most 1024 capacities are
pending; observations for new keys beyond that bound are dropped. Failed flushes
are dropped and logged at most once per minute; feedback never affects response
finalization. The owner-guarded atomic SQL upsert combines concurrent process
writers without graph/capacity locks or transactions. Application time is passed
explicitly; negative elapsed time is clamped to zero and observation/expiry times
use `GREATEST`, bounding clock skew. A write against an expired row is a new
first miss, so the pending window is the 30-minute expiry rather than hourly
cleanup. Rows are an expiring class-H cache without
foreign keys, never drained during parent deletion. Readers ignore expired rows
and fall back to reported K if the read fails; retention deletes rows expired
more than an hour ago. Shutdown clears timers and the DB fence prevents writes.
The dashboard warns when the KV budget is lowered. The MCP pool-rules read
shows reported/effective budgets, current cut/floor and observation/expiry times. This adds one table only;
there is no destructive schema change.

llama.cpp is always slot mode, and its sessions are protected for half the
pool's window: it restores evicted slot prompts from host RAM, so evicting
one there is cheap.

Then:

1. The cache holder or any free member serves as usual; protected members are
   tried last.
2. With only protected members, or protected and full ones, a new `:external`
   conversation goes external now (`local_saturated_protected`). Without an
   external route (plain name, or the attempt does not dispatch), the request is
   admitted on the protected member whose protected sessions are oldest (then
   smallest), with the full local wait budget: protection never makes a request
   wait or queue behind full members.
3. With only full members, the request queues as before.

With an external route, protected members sit out only the first local
admission; after the external attempt they are ordinary (last) candidates.

Protection is on by default. The pool's routing tab ("Protect active
conversations"), `forwarderManagement.updateModelPool` and the
`forwarder_model_pool_update` MCP tool set `protectionEnabled`,
`protectionWindowSeconds` (1–3600), `protectMinTokens`, and how one member's
capacity is shared between the people whose sessions are warm
(`protectionShare`):

- `EQUAL_SHARE` (default): each active user may keep `max(1, slots / active
  users)` sessions protected. An active user has at least one session inside the
  window and above the minimum size; small or idle sessions do not dilute
  anyone's share.
- `FIXED_PERCENT`: each user may keep `protectionFixedPercent` % of the slots.
- `FIRST_COME`: no per-user cap.

A valid client conversation id is authoritative, even when instructions change.
Without one, continuity uses the last 64 digest-chain nodes, deepest first: a
live tip wins by earliest expiry then session id; otherwise a sole ancestor
owner permits edits/truncations. Ambiguous ancestors start a fresh session.
A request cut back to only its opening message looks the same as a new
conversation with that opening, so it stays fresh even when exactly one live
conversation starts that way. Leading instructions (system/developer units
before the first conversation unit, the Anthropic `system` field, Responses
`instructions`), tools, semantic and unknown parameters bind the root; a later
system/developer message keeps its position in the history and behaves like
any other edit. Only the 17 approved sampling parameters are free (alongside
model/stream and consumed content). Anthropic `stop_sequences` is free, the
same as OpenAI `stop`: a stop list does not change the cached prefix. A body
carrier is excluded only when it wins validation and supplies the client id;
invalid, inactive and losing carriers bind like unknown parameters.
For a winning Anthropic metadata token, only `metadata.user_id` is excluded;
other metadata fields still bind. Root/instruction warmth alone never links sessions.

The first valid carrier wins: body `conversation`, then `conversation_id`
(string or object with string `id`), then OpenAI `prompt_cache_key`; headers
`x-conversation-id`, `session_id`, `session-id`, `x-session-id`, then
`x-claude-code-session-id`; finally Anthropic `metadata.user_id` containing
`_session_<uuid>` (only the UUID). Header names ignore case. Ids are trimmed
strings of 1–256 characters from `[A-Za-z0-9._:/@=+-]`; invalid carriers fall
through without errors. Only the original authenticated request supplies ids.
They are HMACed with requester tenant, resource owner, token scope, grant,
pool, target/runtime and surface, so the same string cannot cross those
boundaries. Raw ids are never stored. Session headers are read separately from
the upstream header allowlist, including external fallback.

Carrier research (2026-09-30; behavior can vary by client version):

| Carrier | Evidence and confidence |
| --- | --- |
| `conversation` / `conversation_id` (string or `id` object) | High confidence in this project's existing request support and tests; no assertion that Codex/OpenCode sends these by default. |
| `prompt_cache_key` | Authoritative on Chat/Responses within the authenticated tenant scope. A constant per-user/feature key merges those conversations into one session and affects only that tenant’s advisory protection; tenants cannot reach another tenant’s sessions. High: [Codex source](https://github.com/openai/codex/blob/main/codex-rs/core/src/client.rs) uses the session id, with overrides/internal-parent variants; [OpenCode provider options](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/provider/transform.ts) set `promptCacheKey` from the session, subject to provider configuration. The AI SDK maps it to `prompt_cache_key` on [Chat](https://github.com/vercel/ai/blob/main/packages/openai/src/chat/openai-chat-language-model.ts) and [Responses](https://github.com/vercel/ai/blob/main/packages/openai/src/responses/openai-responses-language-model.ts). |
| `x-conversation-id` | Generic carrier for custom clients; low confidence that the named clients send it by default. No local producer found. |
| `session_id` | Alternate spelling; medium confidence in older/client-plugin behavior, not confirmed as current Codex's spelling. |
| `session-id` | High: current [Codex header builder](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/requests/headers.rs) sends this spelling. |
| `x-session-id` | High: [OpenCode request preparation](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/llm/request.ts) and [session runner](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session/runner/llm.ts) send `X-Session-Id`; provider/version settings can differ. |
| `x-claude-code-session-id` | High: the official [Claude Code changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) records its addition in v2.1.86. |
| Anthropic `_session_<uuid>` in `metadata.user_id` | Medium for historical behavior: a [Claude Code issue's bundled-code report](https://github.com/anthropics/claude-code/issues/15782) shows this format. No claim that all current versions use it; the header is preferred. |

Any valid constant id has the same authoritative behavior as `prompt_cache_key`:
set ids per conversation to keep that tenant's conversations separate.

**Limits without client ids:** continuation evidence requires assistant/tool
output after the first user unit. Leading assistant greetings are starter context.
User-only and greeting+user starters always start fresh, including truncation to
such a starter. In all six causal arrival orders of A1, B1, A2, B2 (A1 before A2;
B1 before B2), identical user-only starters create two sessions, and distinct
assistant replies in A2/B2 advance separate tips (starter labels may exchange).
Greeting+distinct-user starters and their distinct later histories also stay
separate, sequentially and concurrently, on Chat, Messages and Responses.
Byte-identical later histories merge at the deepest tip. Shared-starter edits
can split/join siblings. Few-shot openers `[user(example), assistant(label),
user(query)]` already contain continuation evidence: different queries can merge
permanently as indistinguishable edits of that shared example. Tests pin this
residual limit. Distinct client ids keep these conversations separate.

Native Responses appends input deltas to the committed parent chain; stateless
full history containing the same create+delta units can match those retained
nodes when it contains continuation evidence (assistant/tool output). A
user-only history stays fresh under the starter rule. A missing/expired parent
publishes no delta-only nodes, including with a client id; that id can still
identify the session footprint. Canonicalization preserves every own JSON key,
including `__proto__`. Affinity's advisory depth limit is 128 (request root at
depth 0; each object property or array entry adds one level). Exceeding that
limit or a converter/HMAC/work-budget error makes the whole request unidentifiable:
no nodes, hints, client session footprint or Responses lineage.

Ranking builds canonical request material once and reuses it across targets;
only binding and HMAC work depends on the target. A shared **16,777,216 visited-node
budget (8 × 2 MiB)** bounds validation, extraction and incremental serialization.
Work-budget exhaustion makes the whole advisory request unidentifiable. Arrays
are visited by index without copying or sorting keys; object keys are collected
only while their minimum encoded byte cost fits. Strings are escaped in chunks
of at most 4096 code units, preserving surrogate pairs. Conversation processing
also stops after **4096 units** with the same identity-refusal behavior as byte
overflow. These bounds prevent many tiny values from monopolizing the process.
Ordinary requests retain the same canonical bytes and v5 digests.

Non-finite numbers accepted by JSON parsing, such as `1e400` and `-1e400`, bind
as `null`, matching native `JSON.stringify` forwarding. This applies to scalar
values, object members and array elements in parameters, tools, instructions
and messages; no member, array property or conversation unit is silently dropped.

The 2 MiB canonical identity limit is separate: bytes are counted for the
instruction/tools/parameters root and then each conversation unit. Size-only
overflow refuses identity and lineage, while retaining safe instruction hints
and the last 64 nodes of the under-cap chain prefix as routing hints. An oversized
root cannot produce conversation routing hints; an oversized unit stops the
chain, and later units cannot restart it. Large supported vision histories can
therefore remain warm. A valid authoritative client id still refreshes its one
session footprint; without an id only shared hints are refreshed, with no new
per-turn footprint. Routing hints never establish resolver identity.

Model API JSON acceptance has a separate **256-level request nesting limit**,
measured iteratively with parallel container/depth stacks immediately after JSON
parsing, before model lookup, counting, affinity ranking or dispatch. Depth 257 and above return HTTP 400 with
a protocol-appropriate invalid-request error: `request JSON nesting exceeds 256
levels`. Depth 129 through 256 is served with affinity advisory identity off,
including bound Responses follow-ups. Realistic tool/JSON schemas are far below
256, which also stays safely below Node 24's recursive serializer limit.

Adapters enforce the same literal **256-level** bound when request rendering
decodes embedded tool argument JSON strings into objects. Each decoded argument
has a fresh depth-0 boundary: depth 256 is supported, and 257 or greater fails
with `request JSON nesting exceeds 256 levels`. Local and external request render
preflight returns the requested protocol's HTTP 400 before member admission or
dispatch, without recording a member health failure.

Provider responses have a separate **256-level** limit covering whole nonstream
JSON bodies, SSE stream `data` JSON, and embedded tool arguments decoded during
response adaptation. Overflow is an upstream failure:
`response_json_depth_exceeded` / `provider response JSON nesting exceeds 256 levels`.
It returns HTTP 502 before any output, or a terminal protocol error event after
output; the relay finishes `FAILED` with `protocol_error`. Native argument strings
passed through without decoding retain their existing behavior.

The shared parser covers `/chat/completions`, `/messages`,
`/messages/count_tokens`, `/responses` (create and bound input follow-ups),
`/responses/count_tokens`, `/embeddings` and `/audio/speech`, including local,
public-overflow and authenticated Chat Test paths. MCP tool arguments use the
same guard before their first size serialization, and the chat diagnostic core
checks again before creating its synthetic model API request. Multipart audio
routes do not parse JSON bodies. Responses retrieve/delete/cancel/input-items/
compact use empty relay bodies. Other JSON reads in routing, public overflow,
privacy, diagnostics and protocol adapters inspect already accepted internal
requests, upstream responses/SSE, or embedded tool argument strings; they are
not separate HTTP JSON acceptance paths.

Retention keeps at most 64 nodes and one tip per identifiable session, plus a
separate session footprint. Bound writes retain only the selected server parent's
same-root tail, up to its bound tip depth, after proving that tip is still on the parent's current
chain. A client-id override copies and re-stamps that proven tail, discarding
its own unrelated old nodes/hints. Instruction hints carry a type namespace so
routing-only hints without node rows cannot be inherited as instructions. A stale
binding after a stateless rewrite
cannot retain unproven ancestors. Pruning preserves omitted instruction hints
from the proven chain. Bound turns refresh the committed token estimate with a
delta estimate computed before dispatch (empty deltas carry size forward).
EOF awaits the affinity commit before saving Responses warm lineage. Persistence
uses `maxWait=2000ms`, `timeout=2500ms`, and `lock_timeout=1000ms`; errors save the
Responses binding without a warm link. Resolution uses at most 64 indexed
LIMIT 1/2 probes. Expiry cleanup takes at most 200 rows per table per completion;
the background sweeper drains the rest. Retention eviction also takes 200 rows
per completion, so reducing a cap converges over subsequent writes. Normal
writes add fewer than that batch. Pool clear and deleted-user drains remove both
tables; v5 discards older/null-session rows. Active leases name committed session
ids in `admission_request.warmSessionIds`.

The records of
every pool of the owner on the member count; each session's override comes from
its own pool (grant, or the owner's percent), each distinct override is its own
budget (the share mode, window and minimum size are the requesting pool's), and one user's total never exceeds their largest share. `UNPROTECTED`
sessions are never shielded and never count. Reads are bounded per user per
member and override value (2000 newest sessions), so one busy user or pool cannot hide another's
sessions.

Over the share, a user's oldest sessions lose protection first. The owner has
no grant, so `ownerProtectionPercent` sets the owner's own share (null = the
share mode, 0 = unprotected, 1–100 = percent). Each grant has the same override
(`protectionOverridePercent`) plus a queue priority (`queuePriority`, 0–31)
that replaces the pool and member capacity priority for that grantee's waiting
requests (null inherits). Only the pool owner sets them: the pool's access tab,
`forwarderManagement.updatePoolGrant`, or the `forwarder_pool_grant_update` MCP
tool.

### When the external attempt does not happen

If the attempt cannot send (no compatible external member, provider busy or
unhealthy, a consent withdrawn since the request arrived), `:external` never
gets worse local service than the plain name:

The table describes owner-paid fallback. Own-key provider-only failures can
preserve the upstream status as described under [Own-key failure and accounting](#own-key-failure-and-accounting).

| Situation | Result |
| --- | --- |
| Local wait expired, pool has local members (including a capped provider wait that expired) | Waits again for the rest of the local budget, `B - min(B, E)` (B = local wait budget, E = `externalAfterWaitMs`; no budget stays unbounded; 0 means "only if free now"). If still no slot: `429 rate_limited`, like the plain name. The place in the local queue is not kept. |
| No compatible or healthy local member, context too large, or local failures after every member was tried | The same error the plain name gets. |
| Pool has only external members, no external member fits the request | `400 unsupported_capability` |
| Pool has only external members, the compatible ones are all in a provider health cooldown | `503 external_unavailable` |
| Pool has only external members, provider busy | `429 rate_limited` |
| Pool has only external members, anything else (unhealthy, failure before the first byte, send check timed out, fallback or consent withdrawn) | `503 external_unavailable` |
| Owner account banned or deletion pending (any pool shape) | `404`, the request ends (see [Pool owner account state](#pool-owner-account-state)) |
| Requester account banned or deletion pending, seen by the external check | `401`, the request ends, no `x-wsmp-fallback` |
| Client cancels before a provider response is committed | `499 cancelled` (also recorded as 499, irrespective of a rejected upstream status, and also when the external attempt had already ended as busy or unavailable) |

All of these except the two account rows carry `x-wsmp-fallback: unavailable`.

## Responses and headers

- `x-wsmp-route: local | pool-fallback | own-key`
- `x-wsmp-fallback-reason` and `x-wsmp-served-model` on external responses.
  The reason is `local_wait_expired`, `local_saturated_protected`,
  `no_local_member`, `local_context_ceiling` or `local_failure`.
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
Audio rates bound both input/output and additional-token accounting.
Usage from `openrouter` provider accounts is parsed with an OpenRouter-specific
dialect, checked against live captures (Chat Completions, Messages and Responses,
2026-09-29). `prompt_tokens_details.cache_write_tokens` (Messages:
`cache_creation_input_tokens`) is settled as cache-write tokens; on Chat
(verified by a cache-write capture) and Responses (inferred from Chat: the
captured Responses calls had no cache activity) it is a subset of the prompt
count, like `cached_tokens`. One-hour
cache writes (`cache_creation.ephemeral_1h_input_tokens`), positive
`video_tokens` / `image_tokens`, two spellings of the same count, a non-object
detail container, and any other unrecognized or malformed field keep the
response on the conservative liability path. Spend settles from OpenRouter's
`cost` ("the total amount charged to your account"). With `is_byok: true` the
upstream provider also bills the key owner, so spend is `cost +
cost_details.upstream_inference_cost` ("the actual cost charged by the upstream
AI provider"); a BYOK usage without a valid upstream cost keeps the liability.
`is_byok` must be present as a boolean (every capture carries one): a missing,
null or non-boolean value is invalid usage and keeps the liability.
A response settles only from its one authoritative usage record: Chat, the
root `usage` (final chunk when streaming); Messages, the `message` body or the
`message_delta` event (the partial `message_start` snapshot is superseded, and
a final below that snapshot in any token count is a regression that keeps the
liability);
Responses, the `response` body or the terminal `response.completed` event
(`usage: null` is absence). A recognised terminal is held until the rest of the
response is read, bounded by 256 KiB and 2 seconds after recognition. The byte
budget includes trailing bytes in the held terminal chunk, measured from the
terminal record's framing boundary; pre-terminal content does not consume it.
Reads can overshoot by one transport chunk. If either bound is reached, the
liability stays, even when that chunk already contains the whole response.
The terminal audit event records actual transport completion independently of
the answer's success. Cleanup pauses the upstream before cancelling its reader.
Internal teardown, attempt ownership loss, the provider socket idle timeout,
and combined caller/lease/deadline aborts error the response body after headers
arrive, even if the transport is complete; unread records keep the liability.
Before headers arrive, egress timeout or abort rejects the request instead.
Cancellation is snapshotted at settlement entry: a later client disconnect
stops delivery without changing that settlement's outcome.
OpenRouter's native Responses stream sends no
`event:` lines and its terminal is not recognised: the stream is read to EOF and
the full hold stays (the surface is unclaimed). Several different authoritative usages, usage in
any other root carrier (`usage`, `response.usage`, `message.usage`; nested
objects are never read), a second usage container in one record, a non-JSON `data:`
record, or a stream that stops being valid SSE keep the usage as audit evidence
only: no charge and no total from it settles below the liability. Usage-looking
text outside a record (for example in SSE comments or a truncated body) is
never read. Other provider types do not accept this
vocabulary: the same payload from an `openai` or `*-compatible` account still
fails closed. Provider
search, image and audio service charges can be non-token charges: token prices
and token-based budgets are not a bound on the provider's total bill. The
picker and import summary disclose this limitation.

### Own-key failure and accounting

Own-key capacity admission tries only capacity available now, preserving time for the owner-paid tier and any remaining local wait. A skipped own-key tier permits an independently consented owner-paid attempt even for non-retry-safe operations; after provider I/O may have started, the operation's retry policy applies. No tier changes after a response commits. On a provider-only pool, when the owner-paid plan is disabled or empty, an own-key provider error retains its status and safe Retry-After header. Cancellation retains the relay's cancellation status. Unserved failures have no `x-wsmp-route` header. Owner-paid failures retain the status table above, including `503 external_unavailable` for transport errors and retryable upstream failures before the first byte.

Own-key route/target intent is persisted after consent and request setup, immediately before transport I/O. Known no-send failures leave the prior route intact. A failed, uncommitted tier durably restores the prior route and target before pool fallback or local resumption. Terminal metadata uses that same identity. Crash recovery attributes a pending send intent to the requester because the transport may have run; a crash before intent or after supersession uses the prior route. The owner's aggregate counts successful own-key requests only.
