# MCP tool coverage

GENERATED FILE — do not edit by hand. Produced from
`apps/server/src/mcp/tool-manifest.ts` (`MCP_TOOL_MANIFEST` +
`MCP_TOOL_EXCLUSIONS`) by `apps/server/src/mcp/tool-coverage-doc.ts`;
`apps/server/src/mcp/tool-coverage-doc.test.ts` fails when this file
drifts from the manifest. Regenerate with:

```sh
UPDATE_MCP_TOOL_COVERAGE=1 pnpm --filter server test -- tool-coverage-doc
```

Every `appRouter` leaf is either an MCP tool target or an explicit
exclusion (invariant 12); the completeness check walks the real router and
fails the suite when a leaf is unclassified.

## Coverage table

| Procedure / core target | Tool name | Scope | Confirmation | Side-effect class | Output projector | Feature gates | Exclusion reason |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `adminObservability.listCliDevices` | — (excluded) | — | — | — | — | — | Admin-only observability. |
| `adminObservability.listEndpoints` | — (excluded) | — | — | — | — | — | Admin-only observability. |
| `adminObservability.listModels` | — (excluded) | — | — | — | — | — | Admin-only observability. |
| `adminObservability.listPools` | — (excluded) | — | — | — | — | — | Admin-only observability. |
| `adminObservability.listRelayMetadataSummaries` | — (excluded) | — | — | — | — | — | Admin-only observability. |
| `appConfig` | `app_config_get` | read | — | pure | — | — | — |
| `auth.passwordCapabilities` | — (excluded) | — | — | — | — | — | Auth-router surface; not a model-proxy operation. |
| `auth.updateLocale` | — (excluded) | — | — | — | — | — | Account identity management, not model-proxy operation. |
| `auth.verifyEmailTransport` | — (excluded) | — | — | — | — | — | Auth-router surface; not a model-proxy operation. |
| `capacityManagement.create` | `capacity_record_create` | write | — | pure | — | `MODEL_API_GLOBAL_CAPACITY_ENABLED` | — |
| `capacityManagement.list` | `capacity_records_list` | read | — | pure | — | `MODEL_API_GLOBAL_CAPACITY_ENABLED` | — |
| `capacityManagement.listAudit` | `capacity_audit_list` | read | — | pure | — | `MODEL_API_GLOBAL_CAPACITY_ENABLED` | — |
| `capacityManagement.remove` | `capacity_record_remove` | write | DELETE | destructive | — | `MODEL_API_GLOBAL_CAPACITY_ENABLED` | — |
| `capacityManagement.update` | `capacity_record_update` | write | — | pure | — | `MODEL_API_GLOBAL_CAPACITY_ENABLED` | — |
| `capacityManagement.updateDirectPolicy` | `capacity_direct_policy_update` | write | — | pure | — | `MODEL_API_GLOBAL_CAPACITY_ENABLED` | — |
| `capacityManagement.updateMemberPolicy` | `capacity_member_policy_update` | write | — | pure | — | `MODEL_API_GLOBAL_CAPACITY_ENABLED` | — |
| `capacityManagement.updatePoolPolicy` | `capacity_pool_policy_update` | write | — | pure | — | `MODEL_API_GLOBAL_CAPACITY_ENABLED` | — |
| `cliCredentials.createToken` | — (excluded) | — | — | — | — | — | Returns the one-time raw token secret. |
| `cliCredentials.exchangeDeviceCode` | — (excluded) | — | — | — | — | — | Public device-flow credential exchange; not an MCP surface. |
| `cliCredentials.listTokens` | `cli_tokens_list` | read | — | pure | — | — | — |
| `cliCredentials.revokeToken` | `cli_token_revoke` | write | DELETE | destructive | — | — | — |
| `core:model-api/runChatCompletionDiagnostic` | `forwarder_chat_completion_test` | write | RUN | cost | — | — | — |
| `core:model-api/runPoolMemberTest` | `forwarder_pool_member_test` | write | RUN | cost | — | — | — |
| `devices.list` | — (excluded) | — | — | — | — | — | Admin-only device administration. |
| `devices.revoke` | — (excluded) | — | — | — | — | — | Admin-only device administration. |
| `forwarderManagement.addPoolMember` | `forwarder_pool_member_add` | write | — | pure | — | — | — |
| `forwarderManagement.addProviderPoolMember` | `forwarder_provider_member_add` | write | — | pure | — | `WMP_PUBLIC_PROVIDER_EGRESS_ENABLED` | — |
| `forwarderManagement.cacheAffinityStats` | `forwarder_affinity_stats_get` | read | — | pure | — | — | — |
| `forwarderManagement.clearCacheAffinity` | `forwarder_affinity_clear` | write | DELETE | destructive | — | — | — |
| `forwarderManagement.createGuardedModelPool` | `forwarder_guarded_pool_create` | write | — | pure | — | `WMP_PUBLIC_PROVIDER_EGRESS_ENABLED` | — |
| `forwarderManagement.createModelPool` | `forwarder_model_pool_create` | write | — | pure | — | `WMP_PUBLIC_PROVIDER_EGRESS_ENABLED` | — |
| `forwarderManagement.deleteModelPool` | `forwarder_model_pool_delete` | write | DELETE | destructive | — | — | — |
| `forwarderManagement.getProfileSlug` | — (excluded) | — | — | — | — | — | Profile-slug procedures are account identity management. |
| `forwarderManagement.grantPoolAccessByEmail` | `forwarder_pool_grant_create` | write | — | pure | — | — | — |
| `forwarderManagement.listCliDevices` | `forwarder_cli_devices_list` | read | — | pure | — | — | — |
| `forwarderManagement.listGuardedOverflowCandidates` | `forwarder_guarded_candidates_list` | read | — | pure | — | — | — |
| `forwarderManagement.listModelPools` | `forwarder_model_pools_list` | read | — | pure | — | — | — |
| `forwarderManagement.previewProfileSlugChange` | — (excluded) | — | — | — | — | — | Profile-slug procedures are account identity management. |
| `forwarderManagement.removeCliDeviceMetadata` | `forwarder_cli_metadata_remove` | write | DELETE | destructive | — | — | — |
| `forwarderManagement.removeDiscoveredModelMetadata` | `forwarder_model_metadata_remove` | write | DELETE | destructive | — | — | — |
| `forwarderManagement.removeEndpointMetadata` | `forwarder_endpoint_metadata_remove` | write | DELETE | destructive | — | — | — |
| `forwarderManagement.removePoolMember` | `forwarder_pool_member_remove` | write | DELETE | destructive | — | — | — |
| `forwarderManagement.reorderProviderPoolMember` | `forwarder_provider_member_reorder` | write | — | pure | — | — | — |
| `forwarderManagement.revokePoolAccessByEmail` | `forwarder_pool_grant_revoke` | write | DELETE | destructive | — | — | — |
| `forwarderManagement.setDiscoveredModelCapabilityProfile` | `forwarder_model_capability_profile_set` | write | — | pure | — | — | — |
| `forwarderManagement.updateDiscoveredModelAttachmentLimit` | `forwarder_model_attachment_limit_update` | write | — | pure | — | — | — |
| `forwarderManagement.updateDiscoveredModelCapabilities` | `forwarder_model_capabilities_update` | write | — | pure | — | — | — |
| `forwarderManagement.updateModelPool` | `forwarder_model_pool_update` | write | — | pure | — | `WMP_PUBLIC_PROVIDER_EGRESS_ENABLED`, `MODEL_API_GLOBAL_CAPACITY_ENABLED` | — |
| `forwarderManagement.updatePoolMember` | `forwarder_pool_member_update` | write | — | pure | — | `WMP_PUBLIC_PROVIDER_EGRESS_ENABLED` | — |
| `forwarderManagement.updateProfileSlug` | — (excluded) | — | — | — | — | — | Profile-slug procedures are account identity management. |
| `forwarderManagement.visibleModels` | `forwarder_models_visible_list` | read | — | pure | — | — | — |
| `mcpGrants.listMine` | — (excluded) | — | — | — | — | — | Human-only MCP grant management (Phase 7): a connected MCP client must not enumerate the user's other authorizations. |
| `mcpGrants.revokeMine` | — (excluded) | — | — | — | — | — | Human-only MCP grant revocation (Phase 7): only the browser session may kill grant generations. |
| `mcpTokens.create` | — (excluded) | — | — | — | — | — | Returns the one-time raw MCP personal-token secret; human-only browser session. |
| `mcpTokens.listMine` | — (excluded) | — | — | — | — | — | Human-only MCP personal-token management: a connected MCP client must not enumerate the user's other credentials. |
| `mcpTokens.revokeMine` | — (excluded) | — | — | — | — | — | Human-only MCP personal-token revocation: only the browser session may kill PAT generations. |
| `modelApiTokens.create` | — (excluded) | — | — | — | — | — | Returns the one-time raw token secret. |
| `modelApiTokens.list` | `model_api_tokens_list` | read | — | pure | — | — | — |
| `modelApiTokens.preview` | `model_api_tokens_preview` | read | — | pure | — | — | — |
| `modelApiTokens.revoke` | `model_api_token_revoke` | write | DELETE | destructive | — | — | — |
| `providerManagement.activatePricingVersion` | `provider_pricing_version_activate` | write | RUN | external | — | `WMP_PUBLIC_PROVIDER_EGRESS_ENABLED` | — |
| `providerManagement.createAccount` | `provider_account_create` | write | — | pure | — | `WMP_PUBLIC_PROVIDER_EGRESS_ENABLED` | — |
| `providerManagement.createBudgetPolicy` | `provider_budget_policy_create` | write | — | pure | — | `WMP_PUBLIC_PROVIDER_EGRESS_ENABLED` | — |
| `providerManagement.createCredential` | — (excluded) | — | — | — | — | — | Accepts plaintext provider secrets; permanently excluded by policy. |
| `providerManagement.createModel` | `provider_model_create` | write | — | pure | — | `WMP_PUBLIC_PROVIDER_EGRESS_ENABLED` | — |
| `providerManagement.createPricingVersion` | `provider_pricing_version_create` | write | — | pure | — | `WMP_PUBLIC_PROVIDER_EGRESS_ENABLED` | — |
| `providerManagement.deactivateBudgetPolicy` | `provider_budget_policy_deactivate` | write | DELETE | destructive | — | `WMP_PUBLIC_PROVIDER_EGRESS_ENABLED` | — |
| `providerManagement.deleteAccount` | `provider_account_delete` | write | DELETE | destructive | — | `WMP_PUBLIC_PROVIDER_EGRESS_ENABLED` | — |
| `providerManagement.deleteModel` | `provider_model_delete` | write | DELETE | destructive | — | `WMP_PUBLIC_PROVIDER_EGRESS_ENABLED` | — |
| `providerManagement.deletePricingVersion` | `provider_pricing_version_delete` | write | DELETE | destructive | — | `WMP_PUBLIC_PROVIDER_EGRESS_ENABLED` | — |
| `providerManagement.getUsageTotals` | `provider_usage_totals_get` | read | — | pure | — | `WMP_PUBLIC_PROVIDER_EGRESS_ENABLED` | — |
| `providerManagement.listAccounts` | `provider_accounts_list` | read | — | pure | — | `WMP_PUBLIC_PROVIDER_EGRESS_ENABLED` | — |
| `providerManagement.listAuditEvents` | `provider_audit_events_list` | read | — | pure | — | `WMP_PUBLIC_PROVIDER_EGRESS_ENABLED` | — |
| `providerManagement.listBudgetActivity` | `provider_budget_activity_list` | read | — | pure | — | `WMP_PUBLIC_PROVIDER_EGRESS_ENABLED` | — |
| `providerManagement.listBudgetPolicies` | `provider_budget_policies_list` | read | — | pure | — | `WMP_PUBLIC_PROVIDER_EGRESS_ENABLED` | — |
| `providerManagement.listCredentials` | `provider_credentials_list` | read | — | pure | `projectCredentialRows` | `WMP_PUBLIC_PROVIDER_EGRESS_ENABLED` | — |
| `providerManagement.listModels` | `provider_models_list` | read | — | pure | — | `WMP_PUBLIC_PROVIDER_EGRESS_ENABLED` | — |
| `providerManagement.listPricingVersions` | `provider_pricing_versions_list` | read | — | pure | — | `WMP_PUBLIC_PROVIDER_EGRESS_ENABLED` | — |
| `providerManagement.listProviderAttemptEvents` | `provider_attempt_events_list` | read | — | pure | — | `WMP_PUBLIC_PROVIDER_EGRESS_ENABLED` | — |
| `providerManagement.listProviderAttempts` | `provider_attempts_list` | read | — | pure | — | `WMP_PUBLIC_PROVIDER_EGRESS_ENABLED` | — |
| `providerManagement.listUsageReport` | — (excluded) | — | — | — | — | — | Overlaps the pageable usage report (provider_usage_page_list). |
| `providerManagement.listUsageReportPage` | `provider_usage_page_list` | read | — | pure | — | `WMP_PUBLIC_PROVIDER_EGRESS_ENABLED` | — |
| `providerManagement.repairExpiredAttempts` | — (excluded) | — | — | — | — | — | Operational accounting repair (admin-operated). |
| `providerManagement.replaceBudgetPolicy` | `provider_budget_policy_replace` | write | — | pure | — | `WMP_PUBLIC_PROVIDER_EGRESS_ENABLED` | — |
| `providerManagement.replaceCredential` | — (excluded) | — | — | — | — | — | Accepts plaintext provider secrets; permanently excluded by policy. |
| `providerManagement.retirePricingVersion` | `provider_pricing_version_retire` | write | RUN | external | — | `WMP_PUBLIC_PROVIDER_EGRESS_ENABLED` | — |
| `providerManagement.revokeCredential` | `provider_credential_revoke` | write | DELETE | destructive | — | `WMP_PUBLIC_PROVIDER_EGRESS_ENABLED` | — |
| `providerManagement.rotateCredential` | `provider_credential_reencrypt` | write | — | pure | — | `WMP_PUBLIC_PROVIDER_EGRESS_ENABLED` | — |
| `providerManagement.setAccountEnabled` | `provider_account_enabled_set` | write | — | pure | — | `WMP_PUBLIC_PROVIDER_EGRESS_ENABLED` | — |
| `providerManagement.testCredential` | `provider_credential_test` | write | RUN | cost | — | `WMP_PUBLIC_PROVIDER_EGRESS_ENABLED` | — |
| `providerManagement.updateAccount` | `provider_account_update` | write | — | pure | — | `WMP_PUBLIC_PROVIDER_EGRESS_ENABLED` | — |
| `providerManagement.updateModel` | `provider_model_update` | write | — | pure | — | `WMP_PUBLIC_PROVIDER_EGRESS_ENABLED` | — |
| `providerManagement.updatePricingVersion` | `provider_pricing_version_update` | write | — | pure | — | `WMP_PUBLIC_PROVIDER_EGRESS_ENABLED` | — |
| `relayMetadata.deleteOwn` | — (excluded) | — | — | — | — | — | Audit/history deletion without an agent workflow. |
| `relayMetadata.listOwn` | `relay_requests_list` | read | — | pure | — | — | — |
| `relayMetadata.prune` | — (excluded) | — | — | — | — | — | Admin-only accounting deletion. |
| `settings.getAll` | — (excluded) | — | — | — | — | — | Global application settings read; not model-proxy operation. |
| `settings.myNotificationPreferences` | — (excluded) | — | — | — | — | — | Notification settings are excluded from MCP. |
| `settings.update` | — (excluded) | — | — | — | — | — | Admin-only global settings mutation. |
| `settings.updateMyNotificationPreferences` | — (excluded) | — | — | — | — | — | Notification settings are excluded from MCP. |
| `users.archive` | — (excluded) | — | — | — | — | — | Admin-only account management. |
| `users.invite` | — (excluded) | — | — | — | — | — | Admin-only account management. |
| `users.list` | — (excluded) | — | — | — | — | — | Admin-only account management. |
| `users.remove` | — (excluded) | — | — | — | — | — | Admin-only account management. |
| `users.setRole` | — (excluded) | — | — | — | — | — | Admin-only account management. |
| `users.unarchive` | — (excluded) | — | — | — | — | — | Admin-only account management. |

## Human-only procedures (Phase 7)

The `mcpGrants` router (`packages/api/src/routers/mcp-grants.ts`) and the
`mcpTokens` router (`packages/api/src/routers/mcp-tokens.ts`) are
HUMAN-ONLY: they are mounted on `appRouter` for the browser-session settings
page (`/{lang}/settings/mcp`) and are excluded from the MCP tool catalog in
`MCP_TOOL_EXCLUSIONS`. None of these procedures may ever appear as an MCP
tool: a connected MCP client must not be able to enumerate, mint, or revoke
the human's other authorizations or personal tokens.

Enforcement (all pinned by `apps/server/src/mcp/tool-manifest.test.ts`):

- the invariant-12 completeness check walks every `appRouter` leaf and fails
  unless each leaf is a tool target or an explicit `MCP_TOOL_EXCLUSIONS`
  entry — adding `mcpGrants` or `mcpTokens` without an exclusion fails the
  suite;
- the pinned exclusion list asserts the `mcpGrants` and `mcpTokens` leaves
  verbatim;
- a dedicated Phase 7 assertion proves those leaves are absent from the tool
  catalog under any name, and drives EVERY procedure-backed tool's real
  invoker through a recording proxy client: each tool must dispatch to
  exactly its declared target leaf (so a selector swap fails the suite) and
  no dispatch may touch any `mcpGrants` or `mcpTokens` path.

Unlike authorization, discovery, MCP login/consent, and `/mcp`, grant and
token *revocation* and the settings page are deliberately NOT gated on
`WMP_MCP_ENABLED` (invariant 13): humans must be able to kill outstanding
authorization during an emergency MCP shutdown. Personal-token *creation*
is gated on the flag. Normal browser authentication still applies.
