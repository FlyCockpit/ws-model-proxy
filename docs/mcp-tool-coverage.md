# MCP tool coverage

GENERATED FILE — do not edit by hand. Produced from `MCP_TOOLS` and
`MCP_EXCLUDED_SESSION_PROCEDURES` in `packages/api/src/contracts/mcp-tools.ts` and the
procedure access levels in `packages/api/src/contracts/`;
`packages/api/src/contracts/mcp-tool-coverage.test.ts` fails when this file drifts.
Regenerate with:

```sh
UPDATE_MCP_TOOL_COVERAGE=1 pnpm --filter @ws-model-proxy/api test mcp-tool-coverage
```

Every oRPC procedure appears below: called by one or more tools (`agent` access), kept off
MCP with a reason (`session` access), or unreachable by agent credentials (`public`, `human`,
`admin`, `human_admin`). See [MCP server](mcp.md) for scopes, errors and examples.

## Tools (28)

READ credentials see the READ tools; FULL credentials see all.

| Tool | Token | Procedures | Confirm | Rate limit | Notes | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `nodes_get` | READ | `nodes.list`, `nodes.get` | — | — (only the `/mcp` request limit) | — | Your nodes, or one in detail: trust, hardware, fabrics, hold, held definitions (versions frozen on a Relay-only node), instances, found local servers, secret names. |
| `runtimes_get` | READ | `runtimes.list`, `runtimes.get`, `runtimes.versions.list`, `runtimes.versions.get`, `runtimes.presets.list`, `runtimes.shares.list` | — | — (only the `/mcp` request limit) | — | Your runtimes, or one in detail (versions: the version list; versionId: one full definition; presets: starting points; shared: definitions shared with you). |
| `pools_get` | READ | `pools.list`, `pools.get`, `pools.history.list`, `pools.aliases.list` | — | — (only the `/mcp` request limit) | — | Your pools and pools shared with you, or one pool (history: its change log; aliases: your model-name aliases). |
| `profiles_get` | READ | `profiles.list`, `profiles.get` | — | — (only the `/mcp` request limit) | — | Your profiles, or one: owned nodes, hold lines, pinned versions, satisfied now (pinned versions running). |
| `providers_get` | READ | `providers.accounts.list`, `providers.models.list` | — | — (only the `/mcp` request limit) | — | Cloud provider accounts and models with this month's spend (never keys). Only people change providers. |
| `requests_list` | READ | `activity.requests.list` | — | — (only the `/mcp` request limit) | — | Recent requests without prompts: route, what served them, timings, tokens, errors. |
| `metrics_query` | READ | `activity.metrics.query` | — | — (only the `/mcp` request limit) | — | Request, engine-load and node metrics for a pool, runtime, version, node or instance over a range, optionally grouped; point time = start + at×step. Use it to compare versions after a change. Tests (model_test, Test page) are left out (totals.tests counts them) unless includeTests; a runtime test counts on the runtime, not its pools. |
| `model_test` | FULL | `models.test` | — | 2/min (`bench`, only with `bench`) | — | Send a test to a callable ID (not :external) or one of your runtimes and see what served it and how fast; bench repeats it on your own pools and runtimes. |
| `pool_create` | FULL | `pools.create` | — | — (only the `/mcp` request limit) | compact: `advanced`, `routing` | Create a pool from your served models. Cloud fallback stays off until a person turns it on. |
| `pool_update` | FULL | `pools.update`, `pools.members.addContributed`, `pools.members.removeContributed`, `pools.aliases.set`, `pools.aliases.delete` | — | — (only the `/mcp` request limit) | compact: `members`, `aliases`, `routing`, `cloud`, `advanced` | Change a pool you own, contribute/withdraw your own served models in a pool shared with you (can contribute), or set your model-name aliases for any pool you can use. People only: cloud mode, paid warm protection, own-key consent, only-my-own-hardware. |
| `pool_delete` | FULL | `pools.delete` | `DELETE` | — (only the `/mcp` request limit) | — | Delete a pool with its shares, contributed members, API-key entries and sidecar links. confirm: "DELETE". |
| `runtime_create` | FULL | `runtimes.create`, `runtimes.presets.list`, `runtimes.fork` | — | — (only the `/mcp` request limit) | compact: `spec`, `limits`, `advanced`, `compat` | Define a runtime (a server on a node, or commands that start one), or copy one shared with you (forkFrom). Put model downloads and other setup in an idempotent prepare step so applying a profile on a fresh node fetches weights by itself. |
| `runtime_update` | FULL | `runtimes.update`, `runtimes.models.setCapabilities` | — | — (only the `/mcp` request limit) | compact: `spec`, `limits`, `advanced`, `compat` | Save a new version (say why in note); limit edits apply live, a changed definition needs restartRunning. Setup such as model downloads belongs in the idempotent prepare step. |
| `runtime_delete` | FULL | `runtimes.delete` | `DELETE` | — (only the `/mcp` request limit) | — | Delete a runtime that no instance runs and no profile pins. confirm: "DELETE". |
| `runtime_start` | FULL | `runtimes.start` | — | 10/min (`start_stop_apply`) | — | Start a startable runtime on nodes (or count instances placed for you), or restart an instance; preview shows placements and what stops. Refused on Relay-only and held nodes. |
| `runtime_stop` | FULL | `runtimes.stop`, `runtimes.instances.markStopped` | `MARK_STOPPED` (optional) | 10/min (`start_stop_apply`) | — | Stop an instance, or every instance of a runtime (optionally on one node). markStopped with confirm "MARK_STOPPED" marks stopped an instance whose stop its node cannot prove (Full-control nodes). |
| `profile_save` | FULL | `profiles.save` | — | — (only the `/mcp` request limit) | — | Create or replace a profile: owned nodes and pinned runtime versions. Hold lines are for people. |
| `profile_apply` | FULL | `profiles.apply` | — | 10/min (`start_stop_apply`) | — | Apply a profile (preview first if unsure): start its pins, stop other startable runtimes on its nodes. Refused if any owned node is Relay only. |
| `profile_delete` | FULL | `profiles.delete` | `DELETE` | — (only the `/mcp` request limit) | — | Delete a profile; nothing stops. confirm: "DELETE". |
| `node_update` | FULL | `nodes.update` | — | — (only the `/mcp` request limit) | compact: `hardware`, `metricCommands` | Change a Full-control node: labels, ports, hardware, metric commands, fabrics, command lifetime, rescan. |
| `node_delete` | FULL | `nodes.deleteOffline` | `DELETE` | — (only the `/mcp` request limit) | — | Delete an offline node (refused while online: node_online): its always-on runtimes go, instances with a part there stop. confirm: "DELETE". |
| `node_secret_set` | FULL | `nodes.secrets.set`, `nodes.secrets.delete` | — | — (only the `/mcp` request limit) | secret input, never logged or echoed | Set (or with value null delete) a WSMP_SECRET_* on a Full-control node, for runtimes to reference by name. Write-only: never shown again. |
| `node_command_run` | FULL | `nodes.commands.run` | `RUN` | 30/min (`node_command`) | — | Run a one-off command (downloads while experimenting, builds, diagnostics, benchmarks) on a Full-control node; answers within ~15 s, then poll with node_command_get. Anything that should keep running or serve traffic must be a runtime: a server started here is invisible to the proxy and dies with the command. confirm: "RUN". |
| `node_command_get` | FULL | `nodes.commands.get` | — | — (only the `/mcp` request limit) | — | State and output tail of a command from node_command_run (or the state of one from node_command_queue_for_user); waitMs waits for it, cancel stops it and everything it started. |
| `node_command_queue_for_user` | FULL | `nodes.queued.enqueue` | — | 30/min (`node_command`) | — | Queue a command a person must run (e.g. it needs their sudo password); it runs only when they press Run and Enter. |
| `node_file_read` | FULL | `nodes.files.read` | — | — (only the `/mcp` request limit) | — | Read, stat, list or search under the node's allowed folders; returns an etag. |
| `node_file_write` | FULL | `nodes.files.write` | — | — (only the `/mcp` request limit) | — | Write, mkdir, rename or delete under the node's allowed folders (ifMatch: the etag you read). |
| `node_file_edit` | FULL | `nodes.files.edit` | — | — (only the `/mcp` request limit) | — | Replace exact text in a file (ifMatch required); returns the new etag and a diff. |

## Session procedures kept off MCP

| Procedure | Reason |
| --- | --- |
| `access.agentTokens.list` | Agent tokens are managed by people. |
| `access.apiKeys.list` | API keys are managed by people. |
| `access.contributing.pools` | pools_get lists pools shared with you and whether you may contribute. |
| `access.oauthGrants.list` | Agent connections are managed by people. |
| `access.shares.list` | Sharing is for people only; pools_get shows the count. |
| `activity.commands.list` | Agents follow their own commands with node_command_get. |
| `activity.needsYou.count` | The web nav badge; agents read needs in runtimes_get and nodes_get. |
| `activity.needsYou.list` | Needs-you items are in runtimes_get (instances) and nodes_get. |
| `activity.overview.summary` | Use metrics_query. |
| `app.flags` | Web app switches. |
| `auth.passwordCapabilities` | Web app plumbing. |
| `auth.updateLocale` | Web app plumbing. |
| `models.list` | Callable IDs are part of pools_get. |
| `nodes.activity.list` | Audit history for people (agents see their own results). |
| `nodes.credentials.list` | Credentials are managed by people. |
| `nodes.enrollmentCodes.list` | Enrollment is a person's approval; agents never see codes. |
| `nodes.fabrics.list` | nodes_get shows each node's fabrics and peers. |
| `nodes.queued.list` | Queued items are shown in nodes_get. |
| `providers.accounts.get` | providers_get covers accounts and models. |
| `providers.attempts.list` | Use requests_list (cloud attempts are requests with route cloud). |
| `providers.catalog.search` | Adding provider models is for people only. |
| `providers.pricing.list` | providers_get shows the active price. |
| `providers.usage.list` | Spend details are for people; providers_get shows the month's total. |
| `runtimes.detected.add` | Agents use runtime_create with preset detected. |
| `settings.get` | Account settings are for people. |

## Procedures agents can never reach

| Access | Procedures |
| --- | --- |
| `public` | `app.config`, `auth.inviteInfo`, `auth.verifyEmailTransport` |
| `human` | `access.agentTokens.create`, `access.agentTokens.revoke`, `access.apiKeys.create`, `access.apiKeys.revoke`, `access.invites.resend`, `access.invites.revoke`, `access.oauthGrants.revoke`, `access.oauthGrants.setLevel`, `access.shares.create`, `access.shares.delete`, `access.shares.setOwnKey`, `access.shares.update`, `activity.requests.delete`, `auth.acceptInvite`, `nodes.credentials.revoke`, `nodes.delete`, `nodes.enrollmentCodes.create`, `nodes.enrollmentCodes.revoke`, `nodes.fabrics.delete`, `nodes.fabrics.rename`, `nodes.lowerTrust`, `nodes.lowerTrustPreview`, `nodes.queued.dismiss`, `nodes.queued.run`, `nodes.rename`, `nodes.setHold`, `nodes.setTemporary`, `nodes.terminals.openTicket`, `pools.cloud.setMode`, `pools.cloud.setOwnKeyEquivalent`, `pools.cloud.setPaidWarmProtection`, `pools.routing.setOwnHardwareOnly`, `pools.rules.delete`, `providers.accounts.create`, `providers.accounts.delete`, `providers.accounts.setDataCollection`, `providers.accounts.setEnabled`, `providers.accounts.update`, `providers.credentials.reencrypt`, `providers.credentials.replace`, `providers.credentials.revoke`, `providers.credentials.test`, `providers.models.create`, `providers.models.delete`, `providers.models.update`, `providers.pricing.activate`, `providers.pricing.create`, `providers.pricing.delete`, `providers.pricing.retire`, `providers.spendCaps.clear`, `providers.spendCaps.set`, `runtimes.shares.create`, `runtimes.shares.delete`, `runtimes.steps.attach`, `runtimes.steps.cancel`, `runtimes.steps.reopen`, `settings.onboarding.complete`, `settings.update` |
| `admin` | `adminObservability.nodes`, `adminObservability.pools`, `adminObservability.relay`, `adminObservability.runtimes`, `adminSettings.get`, `app.features`, `users.list` |
| `human_admin` | `adminSettings.update`, `users.archive`, `users.invite`, `users.remove`, `users.setRole`, `users.unarchive` |
