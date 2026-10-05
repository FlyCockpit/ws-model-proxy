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

Node telemetry (relay protocol 2.11) is read-only over MCP. Node file tools
(relay protocol 2.11) are described in [CLI file tools](#cli-file-tools-relay-protocol-211).
`forwarder_device_metrics_get` (`{ cliDeviceId }`) returns a CLI device's static
`node.info`, its freshest `node.metrics` (live from the relay session, else the
stored once-a-minute snapshot, with `nodeMetricsSource`), the live
`endpoint.load` readings the relay holds in memory, a `node` snapshot (kind,
GPUs, live memory, labels, usable budgets, health warnings), and last-hour
`minuteHistory` min/avg/max gauges. Labels and usable budgets are human-only
dashboard writes; this tool is read-only. Health warnings are informational
and never preflight gates. Detected engine facts
(`engineKind`, `engineSlots`, `kvBudgetTokens`, `maxModelLen`,
`engineFactsSource`, `engineFactsAt`) and the derived `enginePreset` appear on
every capacity in `capacity_records_list`. `effectiveKvBudgetTokens` is the
capacity-card cut (live prefix-eviction applied to reported K, or the reported
K when the eviction read fails). Neither ever contains prompt text:
the CLI reads only slot ids, context sizes and busy flags from llama.cpp
`/slots`.

Discovery shares one capacity for a llama.cpp, vLLM, or SGLang endpoint only
when the CLI proves that at least two inventory model ids are aliases served
by that process. Ollama, LM Studio, and llama.cpp router mode retain separate
capacities. Model-swapping front ends are excluded only through engine detection
and router-role proof. Owner assignments are recorded per target only when the
capacity FK changes, including a real detach to null or a move to an existing AUTO
capacity. Equal-FK and policy-only inputs preserve provenance; an untouched web
attachment field preserves the target's current capacity. USER limits remain owner
controlled. Removed aliases split on a later idle inventory. Discovery defers each
connected move group while its source or destination capacities have ACTIVE leases
or WAITING waiters. Unrelated capacities and independent endpoint groups do not block
it. Every later inventory retries deferred groups; the CLI sends inventory on reconnect
or operator reload, so an involved busy capacity can defer moves until an idle inventory.
Existing handles keep their original capacity.
Every join and split must fit direct and effective pool concurrency and context policies.
Shared AUTO limits follow engine slots, otherwise the sum of current automatic member
limits; incompatible lowerings wait for a policy change and the next inventory.
Startup leaves unknown shared AUTO limits for that complete inventory aggregate.
Empty AUTO discovery capacities are removed with model, endpoint, and device
deletes, and an idempotent startup sweep repairs existing idle orphans. The sweep skips
contended owners and capacities for the next registration or startup.
Owner-created empty capacities remain visible in `capacity_records_list`.
Automatic capacity labels get a numeric suffix when an owner's existing label
collides; repeated discovery preserves the capacity identity and its label.

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
  (`auto` / `off`), `customMode` (`observe` / `enforce`; custom FULL starts
  observe-only), `loadSource`, `signals`, `enforced`, the engine kind and slots,
  the live reading (`running`, `waiting`, `kvUsage`, `kvOccupancy`, `slotsBusy`,
  `deferred`, age, `stale`, prefix cache totals) and the verdict state
  (`full_waiting`, `full_kv`, `full_slots`, `full_deferred`, `clear`, `stale`,
  `none`, `off`). `kvOccupancy` is display only: it never marks FULL and is not
  eviction evidence. `engineLoad.kvBudget` includes `reportedTokens`,
  `effectiveTokens` (warm-protection K for this pool; equals reported when
  protection is off), `placementTokens` (residency spreading K; always the
  live cut), `source` (`PROBE` / `CONFIG` / `CUSTOM` — provenance of the
  **reported** K, null when K is unknown), `cutFraction` (0–0.5), `floorFraction` (0.5),
  `lastObservedAt`, `expiresAt`, and `active`. Prefix-eviction feedback
  temporarily lowers token-mode warm-protection and residency-placement
  budgets; slot mode (including
  llama.cpp) has null effective tokens and is inactive. Failed feedback reads
  fall back to the reported budget. `endpoint.kv_occupancy` is also available as
  an explicit routing-rule series.
- `forwarder_pool_member_engine_load_set` (`{ poolMemberId, mode: "auto" |
  "off", customMode?: "observe" | "enforce", kvFullThreshold?, confirm: "RUN" }`)
  turns "use engine load" off for a member, sets whether custom FULL gates
  admission, or overrides its vLLM/SGLang KV threshold (default 0.95). Engine
  load only adds FULL (lease counts stay authoritative), a stale reading is
  ignored, and when every candidate is FULL a plain-name request is admitted by
  leases alone. Classified `cost` like the rules.
- `forwarder_pool_routing_rules_set` (`{ poolId, rules, confirm: "RUN" }`)
  replaces the whole list (at most 16). A rule is a flat record
  `{ metric, labels?, aggregate: "max" | "min" | "avg", op: ">" | ">=" |
  "<" | "<=", threshold, effect: "full" | "avoid", memberId?,
  excludeMemberId? }`; there is no expression language. `memberId` limits
  the rule to that pool member; `excludeMemberId` applies it to every other
  member; the two must not both be set. Label keys and values use the
  metric-name charset, and `__proto__` is not accepted as a label key (the
  rule is rejected, never widened).
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
- `forwarder_device_engine_adapters_set` (`{ cliDeviceId, adapters, confirm:
  "RUN" }`) replaces a device's remotely defined engine adapters
  (`{ endpointSlug, input: { route } | { command }, format: "json" |
  "prometheus", intervalSecs 2..5, timeoutSecs 1..4, map? }`). Same
  unsupervised-mode and CLI-commands credential gate as metric sources. The
  CLI refuses remote adapters unless its separate local
  `allowRemoteEngineAdapters` opt-in is on (metric-source opt-in is not
  enough), and runs a spec only after the person approves that exact
  canonical JSON on the machine (`wsmp endpoints adapter approve <slug>
  --sha256 <hash>`); a changed spec stops until it is approved again. Custom
  FULL starts observe-only. Occupancy is display only.
- `forwarder_device_engine_adapters_clear` (`{ cliDeviceId, confirm: "RUN" }`)
  clears those remote adapters and sends an empty list to the live CLI.

`forwarder_engine_load_history_get` (`{ poolId } | { capacityId }`) returns the
30-minute live engine-load history (10 s buckets) for a pool or capacity the
caller owns. Each member includes `series` (max `running` / `waiting` /
`kvUsage` / `kvOccupancy` / `slotsBusy`, summed prefix deltas, `source`, and
`gap` markers), `signals`, the effective KV FULL threshold, and reported K.
`kvOccupancy` is display only. A foreign pool or capacity returns `NOT_FOUND`.

`forwarder_pool_cache_stats_get` (`{ poolId, poolMemberId?, lastMinutes | lastDays,
bucket?, split? }`) returns the prompt-cache hit rate for a pool, or one member,
over a window ending now. `hitRate` is `cacheReadTokens / cacheKnownInputTokens`,
capped at 1, or `null` when nothing reported cache usage (never 0 for unknown).
`continuationHitRate` is the same ratio for requests that continued a known
session (matched affinity); it is `null` for windows that predate those rollup
columns. `coverage` is `cacheKnownRequests / requests` — check it first.
Compare `continuationHitRate` for equal windows before and after a change.
`notes` may include `low_coverage`, `window_truncated_by_retention`,
`hour_resolution`, and `engine_reports_no_cache_fields`. Minutes read minute
rollups; days read minute rollups up to 30 days and hour rollups beyond.
Owners see every requester on their pools; grantees see only their own. A
foreign pool or member returns `NOT_FOUND`. Engine prefix-cache counters stay
on the engine-load charts and are not mixed into this tool.

## CLI file tools (relay protocol 2.11)

Nine PAT-only tools read and change files on a CLI device (a node): `forwarder_cli_file_read`,
`forwarder_cli_file_stat`, `forwarder_cli_dir_list`, `forwarder_cli_file_search`
(read class, scope `read`, no confirmation) and `forwarder_cli_file_edit`,
`forwarder_cli_file_write`, `forwarder_cli_file_rename`, `forwarder_cli_dir_create`
(write class, `confirm: "RUN"`) and `forwarder_cli_file_delete` (`confirm: "DELETE"`).
All take `cliDeviceId`. The CLI runs the operations itself, fd-based and symlink-safe;
it does not compose shell commands. Every result that touches a file carries an
`etag`, results are bounded windows, and write-class calls take an optional `reason`
(500 characters) that goes to the CLI log and is shown on the CLI confirm screen
on a supervised node.

**Who may call.** The four read tools accept a personal access token with either
`allowCliCommands` + literal `mcp:write`, or `allowCliFileRead` + `mcp:read`.
Write tools and command tools require `allowCliCommands` + literal `mcp:write`.
OAuth never gets these tools. A read-grant-only PAT sees exactly the four read file
tools; calling a hidden write or command tool returns unknown-tool. Token flags
and scopes are reread at admission, and narrowing cancels pending operations.

**Permission matrix.** The effective mode is the lowest of the dashboard grant
and the CLI's own `wsmp config set-mcp-commands` mode in its live hello.
The read grant requires ALL of dashboard `mcpFileRead`, live CLI `mcpFileRead`,
and live `fileRootsConfigured`; missing or stale features never authorize it.
If a post-commit device-grant refresh cannot read the current policy, live terminal, command, and file authority (including unsupervised access) is withdrawn and pending work is cancelled until a successful refresh or reconnect.
A reconnect whose hello began before a device policy change installs no terminal,
command, or file authority until a serialized refresh establishes the current
policy. Admissions opened before the change are refused even if a later enable
restores authority; a fresh request may use the restored grant. Changes to another
device do not affect these admissions or require an extra hello policy read.

| Effective mode | Read grant | read, stat, list, search | edit, write, rename, mkdir, delete |
| --- | --- | --- | --- |
| `unsupervised` | either | headless | headless |
| `supervised` | on | headless | CLI keypress required |
| `supervised` | off | refused `supervised_only` | CLI keypress required |
| `off` | on | headless | refused `grant_disabled` / `feature_disabled` |
| `off` | off | refused `grant_disabled` / `feature_disabled` | refused (same) |

Supervised writes return `{commandId, kind:"supervised", status:"awaiting_user", waitingUntil, next}`.
A person opens the pending request in the dashboard Terminals screen and presses Enter
on the CLI-drawn screen to apply it, or `q` to decline. Pending list and browser Decline
use the same mechanism as supervised commands. `confirm: "RUN"` / `"DELETE"` expresses
the agent's intent; it does not replace the person's keypress. The screen shows the
operation, resolved physical path, optional reason, and a unified diff with one context
line computed independently from the real file on disk; the server cannot supply
or forge it. Disk-derived removed/context lines are masked. Every after-side byte
is tracked as requester-authored or carried from disk. If an added line carries
any masked disk byte (including a whole-line or continuation mask), the request is
blocked with `redacted_span` after the person dismisses the cannot-apply screen.
Pure requester-authored additions stay verbatim, with controls/invisible characters
escaped. Diff and mask lines split only on LF: a lone CR is escaped content; CRLF
stays one line ending. Unmappable line counts block with `redacted_span`. A diff
whose complete escaped display exceeds 8 KiB is blocked with `too_large` after the
person dismisses the cannot-apply screen; no hidden hunk can be approved. Details
show byte counts, mode in octal (explicit, effective default, or all preserved permission bits), `ifExists`, parent
creation and rename overwrite where applicable. Secret-class paths remain read-only and are
refused `secret_file`. Path policy is checked before display and again at apply, and
the daemon rechecks the etag: a file changed between display and approval returns
`conflict` and nothing is written for that mismatch. Since this apply-time error
arrives after acceptance with only a code, the server still reports an unknown outcome.
Supervised `edit.dryRun:true` returns `invalid_input`. On macOS, supervised rename
of a directory without replacement is refused `unsupported` (file/symlink overwrite
uses exchange or safe fail-if-exists publication). On platforms with neither Linux renameat2 nor macOS exchange, overwrite
is refused `unsupported` too: no unsafe rename fallback is used. Regular-file no-replace
moves remain available when the filesystem supports hard links.
Supervised approval implies no read grant.

Poll `forwarder_cli_command_result` with the returned id. It reports the shared
supervised statuses, plus `file:{op,result}` on success or `error:{code,message,outcome?}`.
Edit/write results omit `diff` and `hunks`; file errors have no path, current etag or
other detail. State-dependent refusals (including `not_found`, `exists`, `conflict`,
`hard_linked` and `owner_mismatch`) appear on a cannot-apply screen and reach the
agent only after a person dismisses it. This includes outside-root paths, escaping
symlinks and unavailable roots (`path_denied`), and disk-derived normalized arguments
above the 128 KiB child-input cap (`too_large`). The cap on the original request is
checked before disk access; an oversized normalized input uses a minimal blocked
input with the original paths. The child uses the daemon’s strict startup root
snapshot, including deny-all for unusable configured roots. Roots are judged on
resolved physical paths before display and again at apply; aliases resolving inside
a root are allowed. Apply-time policy stays authoritative.
Path-string/input refusals may arrive before display: `invalid_input`, `secret_file`,
protected/staging names (`path_denied`), special-tree text (`special_file`), declared
input/body size, `limit` and `disabled`. Root confinement is never a pre-display
text refusal. Decline returns code `declined`, definitively applying nothing.

Confirm waits expire after 15 minutes, using the same stop grace as commands.
After `supervised.accepted`, apply has a 30-second deadline; on expiry the server
sends unconditional `supervised.cancel` and reports `timeout` with `outcome:"unknown"`.
Session loss reports `offline`. Once `term.spawn` was dispatched, server termination
without authoritative CLI settlement carries `outcome:"unknown"`. It reports
`started:true` if the server received acceptance, otherwise `started:null`: acceptance
and apply may be in flight.
This includes confirm expiry/stop grace, token revoke/expiry, and grant changes.
The audit records unknown exactly once; late frames cannot change a finished result.
Every non-success after acceptance has `outcome:"unknown"`, including CLI
`conflict`, `not_found`, `io_error`, `cancelled` and `timeout`, token inactivity and
mode changes. The CLI sends only the error code, so the server cannot distinguish
an apply-time pinned-etag mismatch before commit from an ambiguous failure after
commit. Undispatched admission/spawn-send failures, CLI decline/rejection and a
blocked-screen `done{fileError}` before acceptance are definitively not applied.
The daemon honors cancellation only before the atomic commit point. Ask the person to inspect the file
before retrying an unknown result; use file_stat only if a read grant permits it.
The earliest expiry carried by the token row or the admitted credential ends a
supervised file request immediately, with `token_inactive`; after acceptance its
outcome is unknown. Results arriving at or after that expiry are not delivered.

Enable `wsmp config set-file-read on` and choose explicit directories with
`wsmp config set-file-roots <path>…`, restart wsmp, then grant “Agents may read
files (read-only)” on the dashboard. Suggested roots `~/models`, `~/deploy`,
`~/.config/llama-swap`, `~/.local/state/wsmp/logs` are help text only and never
applied automatically. Roots must be absolute existing directories after `~`
expansion, UTF-8, distinct, other than `/`, at most 32, and at most 64 KiB serialized in total (escapes count as their serialized form); a larger set is refused when saved or loaded. `clear-file-roots` clears them.
Restart applies both switches. A broken root reports roots unavailable and
retains a denying confinement policy, with no whole-filesystem fallback.
When roots are set, every operation, including rename destinations and list/search,
is confined on physical paths; symlinks and `..` cannot escape them. Linux also
uses a safe `openat2` RESOLVE_BENEATH/RESOLVE_NO_MAGICLINKS second guard where
supported. A concurrent local process that moves directories can still race a
held fd after resolution; these tools do not confine arbitrary local processes.
Without roots, unsupervised retains whole-filesystem access minus the protected set.

`forwarder_cli_devices_list` returns summaries (id, slug, status, grants, endpoint
slugs and probe status) and still reports `fileTools: {read, write}` (`headless`,
`supervised`, `off`), `mcpFileRead`, `reportedMcpFileRead`, `reportedFileRoots`, and
`allowFileToolsAsRoot`. It does not include `models[]` or capability JSON. Pages are
`{ items, nextCursor }` (`limit` default 20, max 50). `forwarder_cli_device_get`
`{ cliDeviceId }` returns one full device. `forwarder_model_pools_list` is the same
kind of page (pool id, slug, name, grants, member endpoint slugs, routing and health
status); `forwarder_model_pool_get` `{ poolId }` returns the full pool.
`supervised` writes need a person's keypress. For a supervised read
without the grant, request `cat` via a supervised command or enable the grant.
The CLI independently checks local mode, read switch, roots and UID at every op;
a server request never overrides local consent. Root refuses `unsupported` unless
`wsmp config set-file-tools-as-root on`. The protected wsmp state files,
`service.env`, writes to `config.json`, and special trees remain inaccessible.

**Masking boundary.** The CLI masks, before anything is windowed: (1) in dotenv and env
files (`.env`, `*.env`, `.envrc`, `service.env`) every value, shown as `KEY=⟦redacted:N⟧`
(other lines that are not blanks, comments or a simple `KEY=` are masked whole); (2) in
any other file, every line containing a secret-name word (ending in `_TOKEN`, `_KEY`,
`_SECRET`, `_PASSWORD`, `apikey`, `api-key`, `hf-token`, or equal to `PASSWORD`), the
following non-blank line, and every line indented deeper than it, each shown as
`⟦redacted line⟧`, plus the value of `--api-key` / `--hf-token` style flags; (3) private
key blocks (PEM BEGIN to the matching END) and SSH private key files; (4) the Hugging Face
token files. There is no vendor-prefix scanner. A construct that opens further back than
the bounded lookback of a windowed read is a documented residual. Edits cannot target a
masked span, and the etag is keyed. **On a read-grant-only node without exec, masking plus roots IS the security boundary.** **On an `unsupervised` node masking is not a security
boundary**: an agent with command access can `cat .env`. It keeps those secrets out of
transcripts on the normal path. Secret-class files (dotenv, key and token files, and their
directories) are read-only masked views: every write, edit, rename, delete or mkdir that
touches one is refused as `secret_file` (compared case-insensitively on every OS); use a
command to change such a file. The server never logs or stores file content, and it
additionally removes `wsmp_` credential substrings from every returned string.

**ETag workflow.** Read a file, then pass its `etag` as `expectedEtag` to `edit`, to `write`
with `ifExists: "replace"`, to `rename` with `overwrite`, and to `delete`. Line-range edits
and replaces require it. A headless stale-etag failure returns `error.code` `conflict`
with `currentEtag` (an etag, or the word `gone` when the file was removed): re-read
and retry. Supervised failures report only the code after the person's keypress.
`read` with `ifNoneMatch` answers `{unchanged: true, etag}`. Etags reset when the wsmp
daemon restarts, which costs one extra `conflict`. A write-class call that fails with
`error.outcome: "unknown"` may have changed the file, with any code: `timeout`,
`offline`, `cancelled`, `token_inactive`, a mode change, `io_error`,
`uncertain_outcome`, `not_found` on rename/delete, or `conflict` when a file was swapped
during the change. Headless
`replaced` conflicts are unknown and omit `currentEtag`. For supervised requests,
every non-success after acceptance is unknown, even a `conflict` caused by the
pinned pre-image changing before commit, because the error frame has only a code.
Ask the person to inspect the file, or call `forwarder_cli_file_stat` with `hash: true`
and a read grant to compare the etag before retrying. A retry
that carries `expectedEtag` is safe (a stale etag returns `conflict`); an exact-match edit
without `expectedEtag` is not idempotent, so check with `file_stat` first.

**Manual file recovery.** Atomic replace, exclusive create, plain rename,
overwrite rename and file/symlink delete use recovery when needed. They capture
compensation objects into one mode-0700 `.wsmp-recover-<10 alnum>` directory beside
the destination, with at most two captured data objects per operation, plus private
capability probes and preflight dummies. Replace creates its temp
inside this directory and first tries an atomic exchange with the destination;
no public staging name exists. If exchange is unavailable, private probes choose
no-replace rename or hard-link publication before any public name is changed.
The original is captured and checked against the held identity before publishing
the temp at the vacant name. A concurrent save captured instead of the original
is restored without overwriting another object, or retained and reported. A
concurrent create at the vacant name survives; the original stays in recovery
and the tool returns `uncertain_outcome`. If no safe publish primitive works,
`unsafe_filesystem` is a definitive headless refusal: nothing was changed. A
supervised error after acceptance remains unknown under the code-only outcome
contract, including `unsafe_filesystem`. Overwrite rename first preflights privately.
It exchanges the captured source with the destination when supported. Otherwise
no-replace, and link publication on mounts that present a different inode per name
(noino, sshfs), capture and prove both objects and publish the source fail-if-exists.
Stable-inode link publication, including Linux NFS, links the still-public source
onto the destination and then captures the source. Unpublished user sources
are never disposed: they return only to the source name or stay named in recovery. Every captured
object has a recorded origin; undo restores only to that origin, using identity
proof to return a moved source to its original source name. An unsettled
headless compensation returns `uncertain_outcome` with `error.outcome: "unknown"`,
`recovery` (an absolute directory path) and `kept` (up to four absolute paths,
including public names when capture failed). Successful headless edit/write/rename/delete
results may include `recovered` paths if cleanup failed or an exposed source alias
became its object's last name before cleanup. Supervised operations
use the same recovery and compensation primitives, with pin verification and
cancellation honored only before commit. Their error frame carries
only a closed error `code` (including `uncertain_outcome` and `unsafe_filesystem`);
every non-success after acceptance still has
`outcome: "unknown"`. Supervised success results omit `recovered`, including delete. A preview-time
`unsafe_filesystem` refusal uses the cannot-apply screen and reaches the agent only
after dismissal; it is never a pre-display rejection. The confirm child rejects
`uncertain_outcome` markers because only daemon apply can produce that verdict. Every retained
location reaches the person's daemon warning log (paths only, never content), including
when the confirmation child has exited. The child remains display-only; approval
creates no read grant and recovery paths never reach the agent through these results.
Inspect those paths using a shell, compare file contents, and restore them manually
without overwriting newer files before retrying. Find crash leftovers by listing
`.wsmp-recover-*` beside the target (a partial replace temp, probe, or `INTENT` file is inside it). File tools
permit reads and listing, but refuse writes, deletes, renames and creates inside recovery directories.
Recovered objects are never automatically deleted. Startup reports `.wsmp-recover-*` under
configured roots and does not delete them.

**Delete rule.** On every filesystem, files and symlinks are first captured into
recovery, checked against a live held identity, and only that proven object is
disposed. The symlink target is never deleted. A replacement captured instead of
the inspected object is restored without overwriting a newer name, or kept and
reported. A concurrent create at the now-vacant name survives. This adds one
mkdir/rmdir pair per file/symlink delete. Any recovery mkdir failure, including
ENOSPC, EDQUOT or EMLINK, fails closed with `io_error` and leaves the file unchanged;
free space with the shell. On macOS and other Unix, a file the CLI user cannot open
read-only (for example mode 000 or 0200) cannot be held and refuses before capture
with its real open errno (`io_error`, e.g. EACCES), public name unchanged; so does a
symlink on Unix targets other than Linux and macOS. Linux's O_PATH hold is unaffected. Directories are never captured for delete: a held
identity recheck is followed by rmdir by name. The kernel can remove only an
empty directory, so this cannot destroy a concurrent save; at worst it removes
a racer's empty directory. Non-empty directories are refused, and delete never
recurses.

**Exchange-less filesystems.** Fallback replace and overwrite rename leave the destination name
vacant between capture and safe publication. The window contains a bounded
number of syscalls, with no time bound: scheduling, network delays or a crash
can extend it. Readers see ENOENT, and concurrent creates survive. Publishing
is only as atomic as the filesystem's no-replace rename or link primitive;
the CLI cannot verify a daemon's emulation. Capability detection is per
operation and errno-driven, with probes at absent private names. Rename link
probes use the actual source and destination objects before capture, since link
permissions and link-count limits depend on the object. NFS and 9p
reject rename flags but usually support links. exFAT and CIFS support
no-replace rename only; exFAT has no hard links. Linux vfat supports both
exchange and no-replace rename. macOS HFS+ supports RENAME_EXCL but not
RENAME_SWAP. Overwrite rename works on no-replace-capable and link-only mounts.
No-replace and noino/sshfs link publication capture and prove source and destination,
then publish source into the vacant destination. Stable-inode link publication links
the still-public source onto the destination before capturing the source, so that
name stays until the destination holds the object. On mounts with neither primitive,
`unsafe_filesystem` refuses before moving anything; the unchanged public snapshot has
no recovery residue. Plain file/symlink rename uses direct no-replace where supported
(including supervised macOS files); otherwise it uses that same link order. A direct
rename that returns EINVAL while no-replace works inside R is `invalid_input` (the
destination name is not valid on this filesystem) and captures nothing. EINVAL while
no-replace is also rejected stays `unsafe_filesystem`. Directories move only with
no-replace, never overwrite even an empty directory, and a directory moved into its
resolved physical subtree refuses `invalid_input` before allocating R.
Private aliases are proven at their own names, including mounts where hard-link
names present different inode numbers. A successful link syscall commits; a rename
link error with ambiguous effect keeps/restores source and keeps destination, with
`uncertain_outcome`. Only a no-replace rename transfers a dentry for held-fd/name
reply reconciliation. After link rename the returned etag uses the published name
only when its bytes/mtime bind to the admitted source etag; a later save or failed
bounded read yields null. Clean publication removes the private alias and R;
failed cleanup reports `recovered`. Allocating R fails closed with `io_error`
(EEXIST) after 16 name collisions.

POSIX does not exclude other same-user processes. Every disposal compares the
private slot with a live held fd, which pins the inode during identity proof;
all of this operation's descriptors on the object are closed before its final
private unlink, avoiding an NFS silly rename caused by those descriptors.
A path-derived dev+ino snapshot alone never authorizes deletion. The
exact remaining windows are: (a) a same-user process that guessed the unpredictable
private directory can rename a new object onto a slot between the held-fd fstat
comparison, descriptor close and final unlinkat and lose that replacement (the link
probe also proves the alias only by a proof opened on that name, so the same actor can
swap the probe alias between its link and that proof; the temp is checked, against its
own still-open descriptor, to be the object the operation created before the link and
after the alias unlink); (a2) on filesystems without
NOREPLACE, capture uses plain rename into a private slot checked absent, and a
squatter arriving between the check and rename can be overwritten. These are the
private-slot deleting windows in recovery compensation. (b) undo briefly vacates public
names, and a concurrent create makes restoration fail EEXIST, retaining displaced
data with `uncertain_outcome`; for edit, write and overwrite rename the newest captured
external write is restored to its public name while an older displaced object stays in
recovery (plain rename verification and exclusive-create cleanup instead keep a
foreign object in recovery and report it). Unsupported
NOREPLACE restore uses EEXIST-safe linkat followed by held-fd-proven private-slot
unlink; directories and unsupported links stay in recovery with `uncertain_outcome`.
(b2) vacate-first recovery rename and exchange-less no-replace overwrite leave the
source name vacant from its capture until the operation ends. Link-first leaves the
source name in place until the destination holds that object, and vacates only the
destination on overwrite. A concurrent create remains at a vacant name on success;
if it prevents a restore, it is kept and reported with `uncertain_outcome`. Independently of the
filesystem, an in-place write into the inspected inode after the etag read can
be lost on replace or delete: the etag proves content only up to that read.
(d) a crash leaves `.wsmp-recover-*`, including a partial replace temp or
`probe`, preflight dummies, or both links. Before the first capture, every R-using
op (rename, replace, delete, including exchange overwrite) writes `INTENT` in that
directory and fsyncs the file; directory fsync `EINVAL`/`ENOTSUP` is best-effort.
`INTENT` is a versioned JSON object (`version` 2): `op`, `phase`
(`prepared`/`captured`/`committed`), `order` (`link-first`, `vacate-first`, or
`exchange-first`), `source`/`destination` as `{display, bytes}` (hex path bytes next
to a lossy display string), `slots` mapping `slot-1`/`slot-2` to `{origin, dev, ino,
kind, size}`, plus `pid`, `host`, `createdAt`, and `cliVersion`. Link-first overwrite
stores the destination in `slot-1` and the source in `slot-2`; exchange-first
overwrite stores the destination in `slot-1` (swap `from <-> to` first, then capture
D from `from`, so D is briefly visible under the source name); other orders store
the source in `slot-1`. Success removes `INTENT` only when R is empty. There is no
automatic replay. A rename crash can leave source and destination in R with both
public names vacant (vacate-first), only the destination vacant (link-first, before
the link), or D under the source name (exchange-first, after the swap). Live R
directories are indexed in the CLI state directory (`file-recovery/`). Startup reads
that registry (O(registered)) and never walks file roots. `wsmp recover` lists
abandoned R dirs; `wsmp recover --apply` rolls back (`mv -n` from slots) when phase
is prepared/captured and rolls forward (dispose leftovers) when committed;
`--scan` walks configured roots for unregistered dirs. Find R beside the
destination, in the registry, or in the startup log: wsmp reports each abandoned
`.wsmp-recover-<10 alnum>` directory and never deletes it. If INTENT is absent, the
log lists present slots; it does not say "read INTENT". `mv -n` a missing public
path back from its slot, and do not overwrite a newer file. If both public names
exist and the destination is a hard link of the source, the link may already have
committed: compare, then remove only the private slots, `INTENT`, and the empty
directory. On stable-inode NFS, plain rename uses link-first when rename flags are
rejected; no-replace-capable mounts keep direct rename and do not write `INTENT`. A
crash during replace can leave the original and temp in recovery with the public
name vacant; a delete crash can leave the captured file or symlink in recovery with
its public name vacant.
(e) unheld objects are never deleted and remain reported in recovery;
(f) on NFS a file that another process still holds open keeps a `.nfs*` entry in the
recovery directory after its unlink, so the directory is retained and listed in `recovered`;
the link probe's alias unlink keeps the temp's own descriptor open (it pins the inode against
number reuse), so a client that silly-renames per vnode (macOS/BSD NFS) may briefly keep a
`.nfs*` alias there until that descriptor closes, retained and reported the same way.
(g) after replace or rename hard-link publication, a process can open and write the
public temp/source,
then another save can replace that name before the private alias is unlinked;
where this mount's link counts can be believed, a count below 2 retains the last alias
and reports it (a veto, never a proof). Belief is decided per operation from the link probe:
right after the probe link the object has two names, so a count of 1 or an unreadable count
means counts cannot be used here (sshfs always reports 1) and the veto is off, exactly as
for replace in #169. The count is read by name with `statx` and `AT_STATX_FORCE_SYNC` on
Linux, so the kernel's attribute cache (FUSE, NFS, SMB) cannot make it stale (kernels
without statx, and other Unix systems such as macOS, use a plain stat, which can be); a
daemon's own cache can too, and then the veto is no better than none. A third save after the final
observation but before unlink, or on a mount whose counts mean nothing, can still orphan
the inode and discard the writes: this is the residual, narrowed where counts are real.
If alias cleanup fails instead, the published file has two hard links (nlink 2)
and edit/replace refuses `hard_linked` until manual cleanup of the reported alias.
Public file and symlink compensation names are never unlinked on an earlier
stat's authority; directory delete follows the empty-directory rule above.

**Separate create residuals.** Exclusive create uses O_EXCL at a public name,
then writes its content there; concurrent readers can observe the intermediate
file, and a concurrent write to that created inode before the tool finishes
writing can be overwritten. Failed-parent cleanup (`rollback_created`) retains
its separate check-to-rmdir-by-name race; the kernel removes only empty
directories.
These paths, the case-only rename below, recovery-directory privacy and the
existing recovery reporting bounds are separate from the exchange-less replace
and file/symlink delete rules.

**Case-only renames.** `rename` with `overwrite` refuses a destination that is the same
file as the source (`invalid_input`), except a case-only respelling of one directory
entry (for example `Foo.txt` to `foo.txt` on a case-insensitive macOS volume: same
directory, one hard link, names equal after case folding), which is done by a plain
atomic rename that replaces nothing; the supervised confirm screen labels it `overwrite: false (case-only rename ...)` for the same reason. A real hard-link alias (link count above 1) is
still refused. The one residual window: a same-user process that creates a second entry
under the other spelling between the check and the rename can lose that entry.
On a case-insensitive mount without stable inode numbers, two spellings may fail
same-object admission and proceed to vacate-both: capturing source also vacates
destination, so destination capture returns `conflict("gone")` and source is
restored to its source name. A true hard-link alias pair hidden by noino can instead
complete vacate-both without losing its data (where link counts can be believed, the shared object keeps a name even if a writer
and a third save leave only the private names: one is kept and reported);
stable-inode alias pairs still refuse.


**Version skew.** `uncertain_outcome` and `unsafe_filesystem` are new file error
codes of relay 2.11. Upgrade the server before the `wsmp` CLI: a server that
predates these codes treats the CLI's rejection frame as malformed instead of
reporting the typed error (retained files stay on disk). An older CLI never
emits `unsafe_filesystem`.

**Revocation and bans.** Revoking or narrowing a personal token, revoking a CLI
credential or device, and deleting a user end that principal's in-flight file operations and
commands (`token_inactive` or `offline`; a write-class call carries `error.outcome: "unknown"`).
Banning a user (the dashboard archive action, the admin ban, or an admin update that sets the
ban) does the same for every token the user holds and refuses calls still being admitted; the
CLI's relay connection stays up. Everything ends on the server at once, including supervised
commands and supervised file requests still waiting for a person's confirmation or already applying (a file request ends `token_inactive`, with `outcome: "unknown"` once dispatched per the outcome contract; if its confirm deadline had already passed and the server was waiting for the CLI to stop, it ends `timeout`): a call waiting for a headless command returns
`cancelled`, and the CLI's late output and exit are dropped and never reported as a success. The
CLI is asked to stop the process, and the command keeps its execution slot only until the CLI
answers or 15 seconds pass. The cancel runs in the server process that performed the ban: another
replica ends the work at its deadline and refuses the user's next call.

**Limits.** Supervised writes share command limits: one awaiting per CLI, two awaiting
per user, and two live per CLI. Headless limits are 120 file operations per minute per user, of which at most 30 change files;
4 in flight per CLI and 16 per user. Headless limits return `limit` with `retryAfterMs`;
supervised admission limits return `limit`. Operations are never queued. Headless
operations time out after 30 seconds (search and hashing have shorter CLI budgets);
an MCP abort sends `file.cancel`, honored before a mutation's rename. Once a supervised
request is registered, an MCP abort preserves its id and the person's pending decision. Read
windows are held to 96 KiB by the 256 KiB tool output cap (`too_large` asks for a narrower
request; escape-dense text needs a smaller `maxBytes`), write content is at most 1 MiB
DECODED, and the whole request of stat, list, search and edit must fit one 64 KiB relay
frame. The 1 MB `/mcp` request-body cap that every call shares is the
real ceiling on the encoded form, so a base64 write arrives at roughly 768 KiB (786,432 bytes)
decoded or less (it encodes to 4/3 of that); larger bodies cannot be written with the
current tools. Admission and headless errors are in-band `isError` results;
completed supervised failures appear in the polled `result.error`. Both use a
stable `error.code`: the command codes
(`not_found`, `grant_disabled`, `offline`, `feature_disabled`, `supervised_only`,
`unsupported`, `limit`, `token_inactive`, `upgrade_required`), `invalid_input`, and the
file codes (`path_denied`, `secret_file`, `not_a_file`, `not_a_dir`, `binary_file`,
`too_large`, `conflict`, `uncertain_outcome`, `unsafe_filesystem`, `match_count`, `no_match`, `redacted_span`, `exists`,
`hard_linked`, `owner_mismatch`, `setuid`, `special_file`, `io_error`, `timeout`,
`cancelled`, `declined`). The CLI re-checks its own startup mode, read switch and roots on every
op and can refuse one itself; its `file.rejected` reason is either a file code above or
one of `bad_frame`, `supervised_only`, `grant_disabled` (the dashboard grant is off) and
`feature_disabled` (the CLI's `wsmp config set-mcp-commands` mode is off), and the
server passes that reason through as the same `error.code`, except `bad_frame`, which settles as `io_error` because the op never ran. A CLI that speaks an older
relay protocol returns `upgrade_required`
("this CLI speaks relay <v>; upgrade wsmp").

## Setup

### Durable deployments and inference contributions (0.4.0)

Recipe tools (`deployment_configs_list`, `deployment_config_get`,
`deployment_config_create`, `deployment_config_update`) read and save immutable
specifications; updates require `expectedRevision`. Deployment lists return
`{items, nextCursor}` with `limit` default 50, maximum 100; use `cursor` for the
next page. Config reads return the latest immutable revision; a plan's preview
resolves its exact start revision and stopped groups rather than substituting a
newer revision. Instance and plan step detail includes the latest 100 steps,
with `stepsTruncated` and database step counts when history is longer.
Deployment lifecycle tools
(`deployment_plan_start`, `deployment_plan_stop`, `deployment_plan_apply`) require
a command-enabled personal token, `mcp:write`, and live node command permissions.
OAuth or a general write token never grants machine execution. Apply additionally
requires `confirm: "RUN"`; this MCP literal does not replace a required person's
confirmation. Read `deployment_plan_status` for the immutable commands and whole
groups affected. Human confirmation, node grants and protected-instance preemption
permission are dashboard-only. CLI local policy always remains authoritative.

Inference tools list, offer and revoke a specific serving model contribution.
`inferenceContributions.accept` is human-only. A pool contribution grants inference,
not shell or deployment rights, and either party may revoke it.

Pool summaries load at most 20 grants and 20 members per pool in the database.
`grantCount` and `memberCount` are full database counts; `grantsTruncated` and
`membersTruncated` explicitly report abbreviated inline lists. Budget policies are
queried only for those selected grants, so truncation never drops their spend cap.
Use the owner-scoped full pool read when detailed configuration is required.

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
The tool description lists those preconditions. When they fail, the error
names `fallbackEnabled` or `externalAfterWaitMs`. The general pool tools reject
the two switches (the advertised schema describes each as forbidden and names
this tool); they still accept `externalAfterWaitMs`, and their descriptions
state its cost.

`model_api_token_external_wait_update` (`{ id, externalAfterWaitMs }`, write,
no confirmation) stores how long this token's `:external` requests wait for
local capacity. Null uses each pool's `externalAfterWaitMs`. Pool
`externalAfterWaitMs` is an owner floor: callers may only lengthen, up to the
local capacity wait budget. A request may also send
`x-wsmp-external-after-wait-ms`; that override cannot go below the pool floor
or past the local wait budget. Neither owners nor grantees can shorten requests below the pool floor.
The stored value is 0..600000; each request still applies the floor and budget
for that pool. Every change records `TOKEN_EXTERNAL_WAIT_UPDATED` in the content-free
provider audit log. MCP diagnostics cannot use `:external`.

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
command tools return a masked copy of what a command printed on your own CLI
device (behind the separate `allowCliCommands` consent). The CLI masks headless
stdout/stderr and the shared/review capture of supervised output before it
leaves the node; the person's encrypted terminal viewer is unchanged.

Masking scans the terminal-cleaned view, including indentation. Terminal parser
state carries across lines and chunks, including control strings containing LF.
A line with any mask emits masked cleaned text with CR/LF terminators preserved;
an unmasked line keeps its raw bytes. Control strings hiding LF are held through
the next terminal ground-state LF so names cannot be joined after scanning.
Masked groups spanning hidden LFs emit opaque physical-line markers with their
CR/LF bytes preserved. The server's `cleanText` still runs afterwards.
The person's encrypted terminal viewer keeps the original bytes.

The file tools' restartable scanner masks private-key PEM blocks through the
matching END label (missing or mismatched END stays masked); whole lines with
secret-name tokens as `⟦redacted line⟧`, the following non-blank line and deeper
indentation continuation (including blanks within the run); secret flag value
tails such as `--api-key` / `--hf-token` and their continuation; and every
non-blank output line when the command text names `.cache/huggingface/token`
or `.huggingface/token`. Token words are case-insensitive and end in `_TOKEN`,
`_KEY`, `_SECRET`, `_PASSWORD`, `apikey`, `api-key`, `api_key`, `hf-token` or
`hf_token`, or equal `PASSWORD`. Open quotes/backslashes on token/value lines
continue until a blank line. Printed dotenv-style token lines are masked whole;
`KEY=⟦redacted:N⟧` applies only to the file tools' dotenv view.

Each normal line is scanned once, held until a terminal ground-state LF or
EOF/completion, with at most
64 KiB held per stream and no filesystem access. An overlong line is scanned
in bounded pieces with retained private-key labels and overlap across piece boundaries,
and masked whole, never emitting a prefix or unbroken token tail. When the overlong line begins inside a live multi-line
secret run — an open private-key PEM block, an open quote or backslash
continuation, an indentation run from the output itself — that run's remaining output is opaque through
EOF, like the 1 MiB case, because the state a fresh scanner would drop is what
masks the lines that follow. Otherwise, at its terminating LF a fresh scanner is
primed with every unclosed private-key BEGIN label from that line and an
unconditional until-blank opener. Every non-blank output line stays masked until
the next blank line, including output after an overlong public line or closed
quote. (The recovery's own synthetic guard is exempt: a second overlong line right after it recovers again, masking at least as much.) A matching END closes the corresponding carried PEM block.
Recovery also treats that line as a column-0 secret-name token line: the next
non-blank line is masked whole, and subsequent lines indented deeper than column
0 stay masked. Blank lines do not consume the next-line protection; PEM and other
opener detection still run on protected lines. Normal scanning resumes after
the blank unless PEM, indentation, or next-value protection extends masking. CR/LF
bytes are preserved. Opaque fallbacks stay closed through EOF: more than
1 MiB of input contributing live masking state bounds PEM/indentation state, and
an over-long line inside a live run fails closed instead of dropping the opener.
A PEM marker exceeding the 1 KiB recovery overlap on an overlong line stays
opaque through EOF, since its exact label cannot safely be reconstructed.
A cleaned LF inside an overlong terminal group, including LF executed inside
unfinished CSI, also makes the remaining stream opaque through EOF.
The latency bound is in bytes; a silent
process has no wall-clock flush deadline. Invalid UTF-8 passes through when its
cleaned lossy scan finds no mask. EOF flushes partial output; teardown flushes exec tails or
discards unshared capture. Masking precedes the 8 KiB head / 40 KiB tail cuts,
and `output_bytes`/stream totals count masked bytes. WMP credentials are still
scrubbed by the server. Other secrets (vendor tokens, JWTs, cloud credentials)
are returned as printed, and on an `unsupervised` node this masking is not a
security boundary. The threat model is accidental disclosure, not crafted evasion.

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
`structuredContent.error.code`. Application messages are not copied into
tool output except sanitized static argument-shaped `BAD_REQUEST` messages described below.
Allowlisted oRPC codes keep their name (`BAD_REQUEST`,
`UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `TOO_MANY_REQUESTS`);
anything else is `INTERNAL_ERROR` with a `requestId`. Wrapper-level errors
use their own codes (for example `INSUFFICIENT_SCOPE`, `CONFIRMATION_REQUIRED`,
`invalid_input`, `OUTPUT_TOO_LARGE`, `REQUEST_ABORTED`).

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

An argument-shaped failure uses `invalid_input` and names the failing fields,
in the text and in `structuredContent`:

A schema rejection includes `issues`:

```json
{
  "error": {
    "code": "invalid_input",
    "fields": ["poolId"],
    "message": "poolId: Invalid input: expected string, received undefined",
    "issues": [{ "path": ["poolId"], "code": "invalid_type", "message": "Invalid input: expected string, received undefined" }]
  }
}
```

A schema-valid rejection names the procedure's fields and keeps its static message:

```json
{
  "error": {
    "code": "invalid_input",
    "fields": ["capacityConcurrencyLimit"],
    "message": "Effective concurrency limit exceeds physical capacity."
  }
}
```

`fields` contains only failing dotted caller-input paths (for example
`advanced.contextMargin` or `rules.0.threshold`), never suggested replacement names.
Suggestions remain separately on each issue; their total comparison work is bounded
independently of tool-schema size. `unknownKeyCount` is the total count, not the number
of suggestions. Safe declared reason enums survive even when no field can be named.
Timestamp adapter failures use the same `invalid_input` / `fields` contract.
`fields` is present whenever the failure is argument-shaped and at least one
key can be named: missing or out-of-range values, a key that is not on this
object (`unrecognized_keys`, counted on the issue as `unknownKeyCount` with
`suggestions` drawn from the tool's declared names), and a
schema-valid rejection such as a concurrency limit past physical capacity
(`data.fields` on the procedure error, kept only when that tool advertises
the name). `message` is the explanation. Validator `issues` are included when
the failure came from the schema: `path` names the failing field (array
indexes are numbers; a segment that is not a field the tool declares is
`"?"`), `code` is the validator's issue code (anything outside a short
allowlist of standard codes is reported as `invalid`), and each issue
`message` is the validator's own text. Input values and caller-chosen key
names are never echoed: messages that could quote a value (`custom`,
`unrecognized_keys`, unknown codes) are replaced by fixed text, unrecognized
keys become a count plus server-chosen suggestions, and at most 20 issues
are returned. A `BAD_REQUEST` that is not about an argument (for example a
failed precondition with no field list) stays the plain "Invalid input".

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
in `cli_agent_action_event`, along with file operations. Supervised edit, write,
rename, mkdir and delete requests each record exactly one `supervised_file_write`
event, including admission refusals; they do not also record a headless file
event. Its path is the requested path (the source for rename), its reason is
`<op>:<code>` (`write:completed`, `edit:conflict`, etc.), and available etags and
write byte counts are metadata. Accepted writes whose apply deadline or session
loss leaves the result uncertain record `unknown`, and so does any dispatched
request the server ends (revocation, policy change, session loss, confirm expiry)
before the CLI has authoritatively settled it. A file error the CLI reports before
acceptance records `failed`, a spawn/admission rejection `refused`, and a
CLI-acknowledged confirm expiry or decline records `expired` or `declined`;
requests never dispatched to the CLI record `cancelled` or `refused`. Headless file operations retain their per-tool
`file_*` kinds and use `<code>` for their reason. Both reason shapes are returned
by `forwarder_cli_activity_list`. Unverified device ids are stored as `unknown`. The
log is **metadata only**: who (user, device, token), what (kind, and for a
command a keyed HMAC-SHA256 of the command text plus its program name — never
the command text itself), when, and how it ended (`completed`, `refused`, `failed`,
`cancelled`, `declined`, `expired`, `unknown`, with a stable reason such as
`exit:1` or `limit`). The reason is a stable machine code: a CLI rejection frame
(`exec.rejected`, `supervised.rejected`) whose reason is not a known code is
stored as `rejected`, so CLI-supplied text never reaches the column. File
content, diffs and command output are never stored, and the command's arguments
are never stored: the server reduces the command text to its program name: it skips leading plain
`NAME=value` assignments (never stored), removes one layer of quotes, takes the
basename of a path and lowercases it, and stores the result only when it is in a
fixed, code-reviewed allowlist of common program names
(`CLI_AGENT_PROGRAM_ALLOWLIST` in `packages/config/src/cli-agent-audit.ts`), else `?`
(an unknown program, a non-plain assignment value, a flag, a redirection or a
command cut for length; a wrapper such as `sudo` or `env` is stored by its own
name), so only allowlisted strings ever reach the row; the server also hashes the whole text (the first 16384 characters of an oversized, refused command). The digest is
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
