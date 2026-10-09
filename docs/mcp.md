# MCP server

WS Model Proxy exposes its operations to MCP (Model Context Protocol) clients as
an OAuth-protected resource at `/mcp`. The surface is on by default.
`WMP_MCP_ENABLED` is the kill switch (`false` closes it). Everything else — the
canonical URL, protocol profile, scopes, token lifetimes, and registration
policy — is derived from configuration in code, not operator tuning.

The tool catalog (all 28 tools, their procedures, confirmation literals and rate
limits, and every procedure kept off MCP with its reason) is the generated,
test-enforced [docs/mcp-tool-coverage.md](./mcp-tool-coverage.md). The tool
definitions themselves are `MCP_TOOLS` in
`packages/api/src/contracts/mcp-tools.ts`; `apps/server/src/mcp/tools.ts`
registers them. This document holds the longer guidance the tool descriptions
point to, and the server behavior around the tools.

## Tools

Agents work with the user's nouns: nodes, runtimes, pools, profiles, providers,
requests and metrics.

- **Levels.** A credential is Read-only (`READ`) or Full (`FULL`). READ
  credentials see the 7 read tools (`*_get`, `requests_list`, `metrics_query`);
  FULL credentials see all 28. A FULL tool called with a READ credential answers
  exactly like an unknown tool. Even Full cannot touch sharing, API keys,
  agent tokens, provider accounts, enrollment, hold lines or node trust; those
  stay with people. An agent token's level is chosen when it is created; an
  OAuth connection's level is chosen by the person on the consent page and can
  be changed in Access → Agents (see [Scopes](#scopes)).
- **Node trust.** Commands, files, secrets, metric commands and definition
  changes need a node at Full control. A Relay-only node relays inference for
  the definitions it held when it entered Relay only; agents cannot start,
  stop or change anything there. Lowering only stops new agent access through
  wsmp: software an agent already left on the node at Full control (a systemd
  user service, say) keeps running as the same user and can even raise trust
  locally. If you distrust what an agent did, reinstall the node.
- **Notes.** Most writes take an optional `note` (1–500 characters);
  `node_command_queue_for_user` requires one, and the deletes,
  `runtime_start`, `runtime_stop` (except with `markStopped`), `profile_apply` and
  `model_test` take none.
  Say what you are trying; people see it beside the change (runtime version
  history, node activity, command log, queued commands).
- **Deleting nodes.** `node_delete` removes an offline node only (refused with
  `node_online` while it is connected, with no override); its always-on
  runtimes go and instances with a part there stop. It is audited with the
  node's slug and id. People delete any node in the browser.
- **Confirmation.** Deletes take `confirm: "DELETE"`, `node_command_run`
  takes `confirm: "RUN"` and `runtime_stop` with `markStopped` takes
  `confirm: "MARK_STOPPED"`. The literal only proves intent; it never replaces a
  person's confirmation where one is required.
- **Previews.** `runtime_start` and `profile_apply` accept a preview first: it
  shows placements, what stops and hold changes. Preview when unsure.

### Commands versus runtimes

`node_command_run` is for one-off work: downloads while experimenting, builds,
diagnostics, benchmarks. It answers within about 15 seconds with the command's
state; poll `node_command_get` (`waitMs` waits up to 30 s, `cancel` stops the
command and everything it started). A command lives at most its timeout
(default 1 hour) and never longer than the node's command lifetime (1 minute to
24 hours). Each poll returns at most a 64 KiB output tail.

Anything that should keep running or serve traffic must be a runtime. A server
started with a command is invisible to the proxy and dies with the command. When
a step needs a person (for example a `sudo` password), queue it with
`node_command_queue_for_user`; it runs only when they press Run and Enter in
Terminals. Poll its `id` with `node_command_get` as well: the answer has
`queuedForUser: true` and the queued state (`QUEUED`, `RUN`, `DISMISSED`,
`EXPIRED`, `REFUSED` or `WITHDRAWN`) and never output, since the person runs it
in their terminal.

- **Expiry.** A queued command expires `expiresInHours` after it was queued
  (default 24, at most 168). Past that it reads as `EXPIRED` at once, and the
  hourly retention sweep stores `EXPIRED`. Revoking or lowering the agent
  credential that queued it expires it too. Decided commands (run, dismissed,
  expired, refused or withdrawn) are deleted 7 days later; the node audit keeps
  the command's digest for 90 days.
- **Withdraw.** `node_command_get` with `cancel: true` withdraws a command that
  is still `QUEUED` (`WITHDRAWN`, audited). Only the agent credential that
  queued it (the same agent token, or the same OAuth client grant) can withdraw
  it; another credential gets `not_your_command`. A command the person already
  ran, dismissed or that expired cannot be withdrawn (`command_not_running`).
- **Run and dismiss are human-only.** Only the person runs or dismisses a
  queued command, on the Terminals page; there is no MCP tool for either.

### Stops that cannot be proven

A stopping instance keeps its resources and ports until its node proves the
stop. Every command the node runs for a rank (prepare, start, after-join,
stop, status, health) runs in that rank's systemd user slice, so whatever a
command leaves behind (a fork, a `setsid` daemon) stays where the node looks.
A stop runs the stop command, stops the rank's units, then ends everything
left in the slice (SIGTERM, then SIGKILL after 10 seconds); status and health
checks never kill anything. On Linux these commands need the systemd user
manager (lingering, or wsmp running as the installed `wsmp.service`).
The node proves the stop from what it observes itself: no process is left in
the rank's units or its slice, and every port reserved for the rank (`port`
and the distributed port) is free. For a `process` runtime the `status`
command is not needed for that proof and cannot block it (a stub `status:
"true"` would say "alive" forever). A run whose processes may live outside
the slice also needs its `status` command to say stopped (exit 3): a
`service` runtime (a start that hands off to docker or a service manager
escapes the slice on purpose), any step a person ran in a terminal (a
prepare too), and any run on a node without systemd units. A `status`
command that can never say stopped (`true`, `:`, `exit 0`; new definitions
refuse it) counts as none on a node with systemd units, so a version saved
earlier with one is proven by its empty units and free ports; on a node
without units such a run stays unproven. The same proof is
required again before a repeated stop answers stopped and before the node's
inventory reports a rank stopped. A stop step completes as soon as this proof holds. When the stop
steps fail, the server asks the node for a status probe that checks the same
proof; the stop then completes with no person involved. Only when the node
cannot prove it (still alive, or offline for 10 minutes) does the instance
show `needsOperator: "MARK_STOPPED"`; the probe is repeated every 5 minutes, so
a later proof still completes it. Each rank's `lastStopCheck.errorCode` says
why the last probe failed: `process_alive`, `process_unknown` (the node could
not read its units), `port_in_use`, `port_held_outside_runtime` (nothing is
left in the rank's units, yet a reserved port is still held: usually
something the run started escaped them, such as containers from `docker
compose up -d` or a server that daemonizes; any other process on that port
reads the same), `status_running`, `status_unknown`,
`unowned_service` (runs outside the node's units with no `status` command), or
`not_stopped` from a node too old to say.

To mark such an instance stopped, call `runtime_stop {instanceId,
markStopped: true, confirm: "MARK_STOPPED"}` (optionally `nodeNumber` for one
node of a multi-node instance, and a `note`). It touches nothing on the node.
Agents may do this only on Full-control nodes (`trust_relay` otherwise). The
claim stays counted until a status probe proves the stop, but the instance
settles STOPPED and later starts stop waiting for it (`waits_for_stop`). The
probes go on after that, also on a STOPPED instance, and the first one that
proves the stop releases the claim; `lastStopCheck` keeps showing why.
`runtimes_get` keeps listing a STOPPED or FAILED instance while any of its
ranks is still reserved, with that `reserved` state and `lastStopCheck`
(instance rows leave out null fields and empty lists: an absent field is
null, e.g. no `nodeSlug` means the node was removed). Marking such a rank
stopped again answers CONFLICT with the last automatic check's result. Each
node marked stopped writes a `marked_stopped` row in the node's activity.

When the node can never prove the stop (a run launched with a status command
that always says running, a node that is gone), only a person can free that
capacity: **Release resources** on the runtime or node page ("I've checked,
release it"). It frees the reserved port, memory and GPUs at once, through the
same release a proven stop uses; the old process may still be running, so the
dialog asks the person to check the node first and shows why the stop is not
proven (`status_running`, `port_in_use`, node offline, ...). The rank records
who released it, when and that reason (`releasedUnproven` in `runtimes_get`),
the node's activity gets a `claim_released` row, and the rank leaves the
5-minute stop checks. A proof that arrives later changes nothing; if the old
process still holds the port, the next start there fails with the usual
reasons. Agents, API keys and the CLI relay can never release.

An agent may ask instead: `runtime_stop {instanceId, nodeNumber?,
requestRelease: {findings, evidence?}}` on a part marked stopped on a
Full-control node (`trust_relay` otherwise), with what it checked (`findings`
up to 4,000 characters; `evidence` up to 8 `{command, output}` pairs). The text is cleaned like node command output (control
characters removed, wsmp credentials redacted, clipped to those lengths) and
shown to the person as the agent's unverified words; a command that is empty
once cleaned is refused. One request may wait per part
(`release_request_pending`); it shows on the runtime page, in Needs you and as
the rank's `releaseRequestId`. The person approves (the same release) or
declines. `requestRelease: "withdraw"` takes back the calling agent's own
request. A request expires after 24 hours and is cleared when the hold ends by
itself (a proof, a restart, the node deleted) or the agent's credential is
revoked.

### Runtime definitions

`runtime_create` and `runtime_update` take the definition as `spec`
(advertised as a plain object to keep `tools/list` small; the server validates
it in full and refusals name the failing path). Start from
`runtimes_get {presets: true}`, or copy a definition shared with you with
`forkFrom`. The schema is `runtimeSpecSchema` in
`packages/api/src/lib/runtime-spec.ts`, and the node validates the same rules.

A spec has exactly one of:

- `address` (an **always-on** runtime: a server that is already running):
  `{ baseUrl, auth?, headers? }`. `baseUrl` is `http(s)://host[:port][/prefix]`
  with `localhost` or an IP literal as host, written in normalized form.
  `auth` is `{ mode: "bearer" }` or `{ mode: "header", header }` plus
  `env: "WSMP_SECRET_…"`; `headers` are `{ name, env }` pairs. Secrets are
  referenced by name only. The proxy never starts or stops it:
  `runtime_start` (with or without `instanceId` or `preview`) refuses with
  `always_on_runtime`. Its health is probed automatically; `model_test`
  checks it now.
- `launch` (a **startable** runtime: commands that start one):
  - `management`: `process` (the node owns the process: every process stays in
    the unit the node starts; a start that hands off to docker or a service
    manager must be `service`) or `service` (stop and a `status` command prove
    it; exit 0 alive, exit 3 stopped). A `status` command must be able to say
    stopped: `true`, `:`, `exit 0` and the like are refused (`systemctl
    is-active --quiet <unit>` exits 3 for a stopped unit). <a id="process-detached"></a>A
    `process` start that hands off anyway (`docker compose up -d`, a server
    that daemonizes) is caught once its port answers while nothing is left in
    its unit: the start fails with `phaseReason: "process_detached"` and is not
    restarted. Whatever it started runs outside the node's control, so the
    stop cannot be proven while it holds the port; stop it by hand and redefine
    the runtime as `service` with real `stop` and `status` commands.
  - <a id="docker-compose"></a>A Docker Compose stack is a `service` with
    detached commands:

    ```json
    {
      "management": "service",
      "commands": [{
        "start": "docker compose up -d",
        "stop": "docker compose down",
        "status": "out=$(docker compose ps --status running -q) || exit 1; [ -n \"$out\" ] || exit 3"
      }]
    }
    ```

    The status command exits 0 while a container of the project runs and 3
    once none does; when `docker compose ps` itself fails (the daemon is down,
    no compose file in the working directory) it exits 1, which the node reads
    as "cannot tell" rather than stopped. A plain `... | grep -q . || exit 3`
    would answer stopped on such a failure. Run the commands from the
    project's directory (e.g. `cd /srv/llm && docker compose up -d`) or pass
    `-f <file>` to each. Avoid a foreground `docker compose up` as a `process`
    start: the containers run under dockerd, outside the rank's slice, so the
    node cannot see or stop them itself; compose's own 10 s stop timeout races
    wsmp's 10 s grace before it kills the slice, which can leave containers
    running; and a container with no published port (a GPU-only worker) can be
    reported stopped while it still runs and holds the GPU.
  - `groupSize` (1–64 nodes), `resources` (one entry, or one per rank:
    `{kind: "none"}`, `{kind: "unified", memoryGb}`, `{kind: "cpu", ramGb}` or
    `{kind: "discrete", gpuCount, vramGb, ramGb?, vendor?}`), `labels` the node
    must carry, optional `port: {fixed}` (≥ 1024, single node only), and
    `fabric` (multi-node only).
  - `commands` (one entry, or one per rank): `start` required; `stop`
    required for `service` and for an interactive stop, optional for `process`
    (the node's stop ends everything in the rank's slice and proves it, so a
    process runtime needs no stop command of its own); `prepare`, `afterJoin`,
    `status`, `health`, `interactive` (steps a person completes in a
    terminal; they need `management: "service"` for start or afterJoin, and a
    `status` command) and `timeoutsSec` (prepare ≤ 24 h,
    default 1 h; start and afterJoin ≤ 1 h, default 15 min; stop default 5 min;
    status default 1 min). Commands may use `{{port}}`, `{{node_rank}}`,
    `{{nnodes}}`, `{{dist_port}}`, `{{memory_gb}}`, `{{gpu_ids}}`,
    `{{vram_gb}}`, `{{memory_fraction}}`, `{{head_addr}}`, `{{fabric_ip}}`,
    `{{fabric_iface}}` and `{{fabric_rdma_device}}`.
  - `secrets`: node secret names exported to every command.
  - `readiness: {path, expectedStatus, timeoutMs}` (required when the runtime
    serves models) and the required `health: {intervalMs, failureThreshold,
    successThreshold}`. An UNHEALTHY instance (`phaseReason:
    "health_failed"`) shows why its last probe failed in `healthDetail`:
    `serving_unconfirmed` (the serving process is gone from its unit),
    `http_<code>`, `connect_refused`, `timeout`, `unreachable`,
    `command_failed` (the `health` command) or `status_not_running`.

A runtime that serves models also declares `api` (`openai` or `anthropic`),
`engine` (`vllm`, `sglang`, `llama_cpp`, `ollama`, `lm_studio`, `other`),
`modelType` (`llm`, `embeddings`, `transcription`) and `models` (`{id,
capabilities?, embeddingContract?, transcription?}`), and may set a
`metricsReader` (`builtin`, a `route`, or a `command`) and `expandMedia`
(inline remote media for servers that cannot fetch URLs). A startable runtime
without models is a **service**: it claims its resources but is never a pool
member.

Put model downloads and other setup in an idempotent `prepare` step, so applying
a profile on a fresh node fetches weights by itself. A spec is at most 48 KiB as
canonical JSON and one command at most 4 KiB. `limits` (null: automatic) and
`advanced` settings are separate inputs; `runtimes_get` shows their keys and
effective values. Limit edits apply live; a changed definition saves a new
version and needs `restartRunning` to reach running instances.

### Request compatibility

Engines differ in what they accept, and harnesses send what they send. Every
runtime version has a `compat` setting (`runtime_create` / `runtime_update`
take it as a plain object that **replaces** the whole setting; `null` returns it
to automatic; schema `requestCompatSchema` in
`packages/api/src/lib/request-compat.ts`). The same policy applies to every
request the runtime receives, forwarded natively or translated between
protocols:

- `unknownFieldPolicy`: `auto` (default) drops unknown **non-semantic** fields
  the engine does not accept; `forward` sends everything as written; `strict`
  refuses unknown fields with a 400 naming the field.
- Semantic fields are never dropped automatically: `model`, `messages`,
  `input`, `instructions`, `system`, `prompt`, `tools`, `tool_choice`,
  `response_format`, `text.format`, `stream`, `max_tokens`,
  `max_output_tokens`, `max_completion_tokens`, `temperature`, `top_p`,
  `top_k`, `min_p`, penalties, `stop`, `n`, `seed`, `logprobs`, `reasoning`,
  `reasoning_effort`, `thinking`, `prediction`, `parallel_tool_calls`,
  output constraints (`guided_*`, `structured_outputs`, `grammar`,
  `json_schema`, `logit_bias`), `chat_template_kwargs`, conversation state
  (`previous_response_id`, `conversation`) and embedding `dimensions` /
  `encoding_format` (the list is `SEMANTIC_FIELDS`). When the engine rejects
  one, the caller gets a clear 400 naming it with the engine's words.
  `allowDropSemanticFields: [path]` accepts losing one.
- `rewriteRules` (at most 32, applied in order, optionally per `endpoint`):
  `{op: "rename", path, to}`, `{op: "drop", path}`, `{op: "default", path,
  value}` (only when the caller did not send it), `{op: "clamp", path, min?,
  max?}` and `{op: "mapRole", from, to}`. Paths are dotted, with `[]` for every
  element of an array: `messages[].cache_control`. Rules cannot touch `model`
  or `stream`, credential- or address-like keys, and defaults cannot add
  content, adapters, files or media.
- `headers`: per client header (`anthropic-beta`, `anthropic-version`,
  `openai-beta`, `openai-version`, `idempotency-key`, `x-request-id`,
  `request-id`) `forward` or `strip`. Auth headers are never forwarded; the
  node adds its own upstream credentials from its secrets.
- `extras`: `streamUsage` and `topK` override whether the proxy adds
  `stream_options.include_usage` or renders `top_k` (automatic: from the
  engine's description, what was learned and the engine kind; unknown engines
  get neither). Missing usage is estimated and marked as estimated.
- `response`: `reasoningField` (`auto`, `reasoning`, `reasoning_content`,
  `strip`) and `stripNonStandard` shape native Chat and Messages answers;
  finish reasons, thinking signatures and missing Anthropic usage are always
  normalized.

What the engine accepts is learned per runtime launch: from its OpenAPI
description (`GET /openapi.json`, read through the node from a loopback engine
when an instance becomes ready) and, without one, from its 400s (the named
field is dropped and the request sent once more, before anything reached the
client). `runtimes_get` shows it as `requestProfile`; `runtime_update
{relearn: true}` forgets it. Requests record what was dropped or rewritten
(names only) in `requests_list` as `compat`.

### Model-name aliases

Harnesses that hard-code a model name (`gpt-4o`, `claude-sonnet-4-5`) can call a
pool through an alias: `pool_update {poolId, aliases: {set: [{name,
apiKeyId?}], remove: [aliasId]}}`; `pools_get {aliases: true}` lists them. An
alias lives in your own namespace (for every key, or one key, which wins), only
resolves to a pool the key in use can call, and is listed by `/v1/models`. A new
alias may not take a pool ID you can call; when a pool shared with you later
gets an ID one of your aliases has, the alias wins for you until you rename or
delete it: that name reaches the alias's pool everywhere (also `model_test`),
and `pools_get` marks the alias `hides` and the share `hiddenByAlias`. Agents may manage aliases; API keys stay
people-only. The model API accepts the key as `Authorization: Bearer`,
`x-api-key` or `api-key`.

### Node metric commands

`node_update` takes `metricCommands`: at most 16 entries (32 KiB together) of
`{ name, command, intervalSecs (5–3600), timeoutSecs (1–60), format, map? }`.
`format` is `lines` (`<metric> <value>` per line), `json` or `prometheus`.
Without `map`, `json` reads a top-level number and `prometheus` the first sample,
recorded as `name`. `map` names up to 16 metrics, each `{ series, labels?,
aggregate?, scale?, divideBy? }`, where `series` is a Prometheus series name or
a JSON pointer.

### Metrics

`metrics_query` reads the minute and hour rollups, never the request log.
The answer is `{ start, series: [{ group?, at, values }], totals, truncated? }`:
a point's time is `start + at × step`, buckets with no data are left out, and a
metric with no data is left out of `totals`. Values are ms (latency, TTFT,
queue wait), tokens/s, GB, percent (`*_pct`) or fractions 0–1 (KV usage,
`full_ratio`, `cache_hit_rate`, `cloud_share`). At most 720 buckets and 2,880
buckets × metrics per query; a grouped answer keeps the largest groups that fit
(at most 10) and says `truncated`. Group key `""` collects rows without one
(cloud traffic has no node). Engine load and node gauges are kept 8 and 7 days;
`custom:<name>` reads node metric command values (average per bucket). A pool
shared with you answers request metrics of your own requests only, ungrouped or
by `source`.

Tests are not load: `model_test` (source `AGENT_TEST`) and the web Test page
(source `TEST`). Request metrics leave them out, as the Overview does, and
`totals.tests` counts the ones left out (absent when there are none). Pass
`includeTests: true` to count them like any other request, for example to group
a bench by `source`. A test of a runtime
(`runtime:<id>:<model>`) does not go through a pool: it counts in that runtime's
(version, node, instance) metrics, never in a pool the runtime serves. Test the
pool's callable ID to exercise the pool. Rollups are written with each
request's completion, so a finished test shows up at once.

### Node files

`node_file_read` reads, stats, lists or searches under the folders the node
allows and returns an `etag`. `node_file_write` (write, mkdir, rename, delete)
and `node_file_edit` (exact-text replacements, at most 20 per call) change
files; pass the etag you read as `ifMatch` so a file that changed since is
refused instead of overwritten. The node enforces its own roots and refuses
secret files.

- **Who.** A Full agent token on the caller's own node at Full control.
  People signed in to the web app use a browser terminal instead.
- **Paths.** Absolute paths under the node's file roots only: `~` and relative
  paths are refused, not expanded. `nodes_get` lists the roots under
  `features.files.roots` and where they come from under `features.files.source`:
  `default` (the user's home directory, used until a person sets roots),
  `configured` (`wsmp config set-file-roots`) or `disabled`
  (`wsmp config set-file-tools off`). A refused path's error lists them too. wsmp's own
  config, credentials, secrets, runtime stores, state directory, service unit
  and binary are off limits (writes) or read-only (config).
- **Roots are node-only.** Only a person at the node sets the roots. No MCP
  tool changes them, and `wsmp config set-…` (like the other commands that
  change wsmp itself: `login`, `trust full`, `secret`, `logout`, `run`,
  `terminal approve`, `recover --apply` and `service
  install|uninstall|env-sync`) refuses to run from a command, job or terminal
  wsmp started. Do not try to widen them through `node_command_run`; ask the
  person.
- **Reads paginate.** A read returns at most 400 lines and 32 KiB at a time
  (`limit` up to 2,000 lines), never `too_large` for files up to 64 MiB. When the file goes on, the
  result has `more: {startLine, byteOffset?}`: call again with
  `offset: more.startLine` (and `byteOffset: more.byteOffset` when a single long
  line was cut). A 2 MiB text file is read in pages this way.
- **Writes.** `node_file_write` without `ifMatch` only creates a new file; with
  `ifMatch` it replaces exactly the version you read. `node_file_edit`
  requires `ifMatch`. Content is at most 1 MiB (UTF-8 text or base64, measured
  decoded); a larger write is refused as invalid input (`content`). The MCP
  request body is capped at 1 MiB as well, so the largest write that fits is a
  little under 1 MiB of plain text, or about 750 KiB (decoded) as base64.
- **Errors.** `data.reason` carries the file error code (`path_denied`,
  `conflict` with the current etag, `exists`, `not_found`, `too_large`, ...).
  An `outcome: "unknown"` means the change may or may not have happened: stat
  the path before retrying.
- **Audit.** Every operation writes a node activity row with the path, size,
  outcome and credential, never the content. Revoking the token or banning the
  owner cancels operations in flight.

### Results and errors

A result is JSON in the text content and in `structuredContent.result`. Output
is redacted (no secret WMP holds ever appears), made JSON-safe, and capped at
256 KiB; a larger result fails with `OUTPUT_TOO_LARGE`. The `nodes_get` list
rows (hostname, `fabrics` as name, ip and `peerCount`, `gpus` as vendor and
name, `secretNames`, counts) leave out null fields and empty lists: a missing
field is null or empty.

A failed call returns `isError: true` with `structuredContent.error`:

- **Refusals** keep their fixed message and carry `code`, a stable `reason`
  and, when it helps, a `subjectId`. The message says what to do next.
  `node_secret_set` replaces even that message with the reason, so nothing a
  procedure says can carry a secret back.
- **Invalid input** is `invalid_input` with up to 20 `issues`, each `path` and
  `message` (sensitive tools get `path` and `code` only). A message may quote
  part of your own input; a sensitive tool's input is never echoed.
- `TOO_MANY_REQUESTS` (tool rate limit, with `retryAfterSeconds`) and
  `REQUEST_ABORTED` (the request or credential went away). `BAD_REQUEST`,
  `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT` and
  `PRECONDITION_FAILED` keep the procedure's own message (sensitive tools: a
  static one). Anything else is `INTERNAL_ERROR` with a `requestId`.

No tool's arguments are logged. A tool with secret input (`node_secret_set`)
and the procedures in `SENSITIVE_INPUT_PROCEDURES` are never logged, audited
(the secret's name only) or echoed.

### Audit

Agent actions are recorded with the agent token (`agentTokenId`) or OAuth
grant (`mcpGrantId`) that made them: runtime versions and operations, node
commands, node activity (files, secrets, commands), queued commands and the
general audit log. Node commands and node activity store an HMAC of the
command text plus the program name, never the text; a queued command keeps its
text so the person can read it before pressing Run. People read them under
Activity, the node's activity, Terminals and the runtime's version history.

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
  flag plus disconnecting connections and revoking agent tokens in
  Access → Agents, never secret rotation.
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
- Rate-limit tuning: the limits are built in (`/mcp` 120 requests / 60 s,
  consent 30 / 60 s, whole-service registration 60 / 3600 s).
  `WMP_RATE_LIMIT_SCALE` (default 1, range 0.1–100) multiplies every budget;
  the windows stay fixed. See [Rate limits](#rate-limits-process-local).

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
- Access → Agents **stays available** (listing and revoking connections and
  agent tokens only require a normal browser session), so outstanding access
  can be killed during an emergency shutdown. New agent tokens cannot be
  created. Existing access JWTs also
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

Servers behind a proxy must preserve `Host` (or configure the ingress so
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

- `/mcp` accepts `mcp:read` **or** `mcp:write` (`mcp:write` semantically
  includes read).
- An unauthenticated `/mcp` request gets a `WWW-Authenticate` challenge with
  `scope="mcp:read mcp:write"`, the same scopes as `scopes_supported` in
  `/.well-known/oauth-protected-resource`, so a client asks for both and the
  consent page can offer Full. Read-only stays the consent default.
- Write tools need a FULL request level, which for OAuth requires the literal
  `mcp:write` (below). Scope matching is exact-token: padded or case-variant
  tokens never match.
- At the authorization endpoint, a missing or blank `scope` is rejected locally
  with a non-redirecting OAuth `invalid_scope` error; the requested `resource`
  set must contain the canonical `/mcp` URL or the request is rejected locally
  with `invalid_target`. Neither check ever uses or redirects to a
  caller-supplied redirect URI. Every present, well-formed request is forwarded
  to Better Auth unchanged for client/redirect validation.

An OAuth request's level is FULL only when its grant is Full and the access
token carries `mcp:write`; otherwise it is READ. A client can therefore ask for
less than the person allowed (omit `mcp:write`), never for more. The grant's
level is the person's choice:

- **Consent page.** When the client asks for `mcp:write`, the page offers
  Read-only or Full, starting at Read-only (the agent token dialog's default)
  and explaining Full in the dialog's words. A request without `mcp:write` is
  approved Read-only and the page says so. The choice travels as the `level`
  field of the person's `POST /api/auth/oauth2/consent` body (a cookie session
  behind Better Auth's origin check, pinned by the signed `oauth_query`); a
  missing `level` means Read-only. No authorize parameter, scope or signed-query
  value is ever read as a level, so a client cannot pick Full. `FULL` without
  `mcp:write` among the approved scopes, or any other value, is refused (400)
  before a code is issued. When the approval issues a code, the level is
  recorded on the exact grant generation the code exchanges into before the
  response reaches the browser; if it cannot be recorded, the code is withheld
  (500) and the remembered approval is forgotten, so the next authorize asks
  again. A concurrent change to the same grant is retried on the fresh row.
- **Access → Agents.** A person changes a connection between Read-only and
  Full (`access.oauthGrants.setLevel`, a human procedure: cookie session with a
  verified CSRF header; agents and agent tokens are refused). Raising asks for
  confirmation, showing what Full allows. Full is offered (and accepted) only
  for a connection whose remembered approval includes `mcp:write`
  (`fullAvailable` in the list); otherwise the page says the agent must
  reconnect asking for `mcp:write`.

Lowering to Read-only (in Access → Agents, or by choosing Read-only when the
person approves the client again) takes effect at once: the next `/mcp`
request and every node admission read the grant and see READ; the grant's
in-flight write tool calls are aborted (read calls finish), and so is a write
call whose request read the level just before the lowering; its running node
commands and file ops are cancelled and the commands it queued for a person
expire (`credential_lowered`). Nothing caches a grant's level, so there is no
cached admission to drop. Runtime operations the grant already started (start,
stop, restart) are not undone, as with a revocation. Raising takes effect on
the next call. Every level
write is audited (`audit_event`, actor USER, resource `mcp_grant`:
`mcp_grant.consent` for the consent page, `mcp_grant.level` for Access →
Agents, with the level before and after).

An agent token's level is the one it was created with.

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
- `/{lang}/mcp-consent` — the consent page. It shows the requesting client,
  the requested scopes and the access level (Read-only or Full, see
  [Scopes](#scopes)), with Authorize and Deny. The level is part of what the
  person approves. First use always prompts;
  expanded scopes (for example stepping up from `mcp:read` to `mcp:write`)
  prompt again for the full requested set, and the level chosen on that prompt
  replaces the grant's level. A remembered consent is reused only when the
  client, the user, the session-derived reference, the requested scopes
  (every requested scope must be inside the remembered set), and the requested
  resources all match the stored consent row — and an explicit `prompt=consent`
  overrides reuse and forces the page (whose choice again replaces the level).
  A reused consent never changes the level: re-authorization keeps the level
  the person last chose on the page or in Access → Agents. Denial is honored: the consent endpoint
  answers HTTP 200 `{redirect: true, url}` pointing at the validated callback
  with `error=access_denied` — no code and no grant are minted. The page
  explains `offline_access` (background renewal, 72-hour inactivity expiry,
  revocable in Access → Agents). Remote client logos are never
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

Every OAuth access JWT carries a private `mcp_grant_id` claim bound to an
application-owned `McpGrant` generation keyed by
`(userId, clientId, referenceId)`, where the reference is an HMAC of the
consenting session and the validated client. Each grant records a level
(the person's choice on the consent page, created when the approval issues its
code; Read-only for a grant created without the page). On every `/mcp` request
the exact grant is loaded and must be active:

- **Disconnecting** a connection (Access → Agents, `access.oauthGrants.revoke`)
  tombstones the grant, marks the client's refresh and access token rows for
  that person revoked (rows are not deleted, so replay evidence survives until
  the retention cleanup), deletes the remembered consent so reconnecting asks
  again. It also aborts the grant's in-flight tool calls, cancels its running
  node commands and expires the commands it queued for a person. Authorization
  codes still pending are not swept; they expire within minutes.
- **Refresh** requires the exact grant generation to remain active. A revoked
  generation can never refresh again.
- **Self-contained JWTs** cannot be deleted server-side. Their residual
  lifetime is at most 10 minutes, and the live per-request grant check makes a
  token from a tombstoned generation unusable at `/mcp` immediately.
- Within the 30-second retry window, retrying the **rotated (cached) ancestor**
  refresh token after a disconnect returns the byte-identical cached token
  pair, while that cached access token gets 403 at `/mcp` — cached delivery,
  not restored authorization. Presenting the revoked **current** refresh token
  fails and deletes the whole refresh family.
- A new browser session (a new reference) can authorize again and requires
  fresh consent.
- Deleting the user, an active ban, or a forced-2FA requirement also fails
  live checks immediately regardless of token expiry.

## Agent tokens and connections

Access → Agents shows the MCP URL, the OAuth connections (client name, redirect
host, level) with a Read-only / Full control and a Disconnect action, and agent
tokens.

An **agent token** (`wsmp_agent_…`) is for a headless client; send it as
`Authorization: Bearer <token>` to `/mcp`. A person creates it in the browser
(`access.agentTokens.create` is a human procedure, never an MCP tool), choosing
Read-only or Full and an expiry. The secret is shown once; the server keeps a
digest.

- The expiry is a timestamp strictly in the future and at most 365 days
  (`MCP_PAT_MAX_TTL_DAYS`) ahead. `null` (no expiry) is accepted only while
  `WMP_AGENT_TOKEN_ALLOW_NO_EXPIRY` is on (its default). The form proposes 90
  days.
- A person may hold at most 10 active tokens; revoke one before creating
  another.
- Revoking a token aborts its in-flight tool calls, cancels its running node
  commands and expires the commands it queued. Expired and revoked tokens fail
  at `/mcp` like unknown ones.
- Tokens cannot be created while MCP is turned off; listing and revoking stay
  available.

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
  deletion — the scan does **not** match stored user/client ownership.
  Unrelated email/OTP verification records are never swept.
- Automatic CIMD-client deletion and JWKS key deletion are deliberately
  deferred pending a separately reviewed policy.

## Rate limits (process-local)

- `/mcp`: an unconditional, pre-authentication IP-keyed bucket
  (120 requests / 60 s, times `WMP_RATE_LIMIT_SCALE`), a 1 MB body cap, then — after token verification — an identity-keyed
  quota on `sub + client_id` with the same budget. Pre-auth buckets are never
  keyed by token bytes.
- Tools: some tools have a stricter per-credential limit (`runtime_start`,
  `runtime_stop` and `profile_apply` share 10 per minute; `node_command_run`
  and `node_command_queue_for_user` share 30 per minute; `model_test` with
  `bench` 2 per minute). The [coverage table](./mcp-tool-coverage.md) lists
  them. A limited call fails with `TOO_MANY_REQUESTS` and `retryAfterSeconds`.
- MCP OAuth endpoints (authorize, consent, continue, token, revoke,
  public-client, public-client-prelogin, JWKS) use an exact method+path
  allowlist with a protocol bucket and a tighter **user-keyed** bucket for the
  consent/continue forms (keyed by the signed-in `session.user.id`, with an
  IP fallback when no session is resolved — the budget is shared across all
  of that user's sessions; consent/continue consume only this tighter bucket,
  not both). Small form-body caps run before the limiters. Everything else
  under `/api/auth/*` keeps the general auth limiter.
- The RFC 7591 register endpoint has its own **whole-service** bucket
  (60 requests / 3600 s, times `WMP_RATE_LIMIT_SCALE`) keyed globally rather than by IP — DCR is
  intentionally unauthenticated, so an IP key would let rotating source
  addresses persist unbounded OAuth client rows. It runs before the general
  auth limiter on that path.
- **All limits are process-local and in-memory**: counters reset on process
  restart, and clients exceeding a bucket get `429` with a `Retry-After`
  header. Statelessness removes session affinity, not the need for
  distributed limiting: the documented ceilings assume a **single-process
  server** — when replicas scale horizontally, every in-memory ceiling
  effectively multiplies by the replica count, so arrange shared enforcement
  before relying on fleet-wide ceilings. Distributed rate limiting is out of
  scope for this release.
- The node relay (`/api/cli/ws`) has its own buckets, apart from sign-in:
  10 authenticated connections per node per minute and 30 failed
  (unauthenticated) connections per address per minute, each then blocked for
  5 minutes (times `WMP_RATE_LIMIT_SCALE`). Only failed connections count
  against an address.

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
   `2026-07-28` wire requires header/body agreement: `MCP-Protocol-Version`
   must repeat the `_meta` protocol version, `Mcp-Method` must repeat the body
   `method`, and `Mcp-Name` must repeat `params.name` when present (a missing
   or mismatched header fails with `-32020`). `params._meta` carries the protocol
   version, client info, and capabilities:

   ```
   POST /mcp HTTP/1.1
   Host: <canonical host>
   Content-Type: application/json
   Accept: application/json
   Authorization: Bearer <access JWT>
   MCP-Protocol-Version: 2026-07-28
   Mcp-Method: tools/call
   Mcp-Name: pools_get

   {
     "jsonrpc": "2.0",
     "id": 1,
     "method": "tools/call",
     "params": {
       "name": "pools_get",
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

Operator procedure, not a unit test. Run against a server that leaves
`WMP_MCP_ENABLED` at its default of true:

1. Discovery — all four well-known aliases return metadata; the RFC 7591
   `registration_endpoint` is advertised.
2. CIMD — first-use client registration from a published metadata URL.
3. Login with 2FA.
4. Consent including `offline_access`.
5. Read — a read tool succeeds.
6. Read-only write denial / step-up — a connection approved Read-only lists
   only the read tools and a write tool answers as unknown, even with
   `mcp:write`. Raise it to Full in Access → Agents (or re-authorize with
   `prompt=consent` and choose Full) and repeat the write; lower it again and
   the next write answers as unknown.
7. Confirmation denial / success (Full agent token) — a delete without
   `confirm`, then with `confirm: "DELETE"`.
8. Refresh rotation and retry — tokens rotate; a retried refresh within the
   window returns the cached response.
9. Access → Agents connection listing, level change / disconnect.
10. Post-revoke refresh, both branches — ORDER MATTERS: within the
    30-second window, first retry the **rotated ancestor** (it returns the
    cached pair whose access token gets 403 at `/mcp` — cached delivery, not
    restored authorization); only THEN present the revoked **current**
    refresh token (rejected, and it wipes the whole refresh family — doing
    this first makes the cached branch unobservable).
11. Reauthorization — sign in again after revocation; fresh consent required.
12. Wrong-resource denial — a token for a foreign resource/audience is
    rejected.
13. Bearer / DPoP interoperability — a plain Bearer client works; a
    DPoP-bound client's proofs validate (and a bad proof fails).
