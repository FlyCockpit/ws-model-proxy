import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Manifest completeness contract (Phase 5): the catalog contains
 * EXACTLY the checked read/write catalog — no extras, no missing, no
 * duplicates — every target resolves against the REAL `appRouter`, and every
 * `appRouter` leaf is either a tool target or an explicit exclusion
 * (invariant 12: a new unclassified procedure fails this suite).
 */

vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    BETTER_AUTH_SECRET: "test-better-auth-secret",
    BETTER_AUTH_URL: "https://proxy.example.com",
    WMP_PUBLIC_PROVIDER_EGRESS_ENABLED: true,
    NODE_ENV: "test",
  },
}));

vi.mock("@ws-model-proxy/env/shared", () => ({
  env: {
    BETTER_AUTH_SECRET: "test-better-auth-secret",
    DATABASE_URL: "postgresql://mcp-manifest-test",
    NODE_ENV: "test",
  },
}));

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

vi.mock("../relay/cli-commands.js", () => ({
  startCliCommand: vi.fn(),
  waitCliCommand: vi.fn(),
  snapshotCliCommand: vi.fn(),
}));

const { MCP_TOOL_MANIFEST, MCP_TOOL_EXCLUSIONS } = await import("./tool-manifest");
const { appRouter } = await import("@ws-model-proxy/api/routers/index");

/** Read catalog — exact names, verbatim. */
const PLAN_READ_TOOLS: readonly string[] = [
  "app_config_get",
  "forwarder_guarded_candidates_list",
  "forwarder_cli_devices_list",
  "forwarder_model_pools_list",
  "forwarder_affinity_stats_get",
  "forwarder_models_visible_list",
  "provider_accounts_list",
  "provider_models_list",
  "provider_pricing_versions_list",
  "provider_credentials_list",
  "provider_audit_events_list",
  "provider_usage_page_list",
  "provider_usage_totals_get",
  "provider_budget_activity_list",
  "provider_attempt_events_list",
  "provider_attempts_list",
  "provider_budget_policies_list",
  "capacity_records_list",
  "capacity_audit_list",
  "model_api_tokens_list",
  "model_api_tokens_preview",
  "cli_tokens_list",
  "relay_requests_list",
  "overview_metrics",
  "overview_health",
];

/** Write catalog — exact names, verbatim. */
const PLAN_WRITE_TOOLS: readonly string[] = [
  "forwarder_guarded_pool_create",
  "forwarder_cli_device_rename",
  "forwarder_cli_metadata_remove",
  "forwarder_endpoint_metadata_remove",
  "forwarder_model_metadata_remove",
  "forwarder_affinity_clear",
  "forwarder_model_pool_create",
  "forwarder_model_pool_update",
  "forwarder_model_pool_delete",
  "forwarder_pool_member_add",
  "forwarder_provider_member_add",
  "forwarder_pool_member_update",
  "forwarder_provider_member_reorder",
  "forwarder_pool_member_remove",
  "forwarder_model_capabilities_update",
  "forwarder_model_capability_profile_set",
  "forwarder_model_attachment_limit_update",
  "forwarder_pool_grant_create",
  "forwarder_pool_grant_revoke",
  "provider_account_create",
  "provider_account_update",
  "provider_account_enabled_set",
  "provider_account_delete",
  "provider_model_create",
  "provider_model_update",
  "provider_model_delete",
  "provider_pricing_version_create",
  "provider_pricing_version_update",
  "provider_pricing_version_activate",
  "provider_pricing_version_retire",
  "provider_pricing_version_delete",
  "provider_credential_revoke",
  "provider_credential_reencrypt",
  "provider_credential_test",
  "provider_budget_policy_create",
  "provider_budget_policy_replace",
  "provider_budget_policy_deactivate",
  "capacity_record_create",
  "capacity_record_update",
  "capacity_record_remove",
  "capacity_direct_policy_update",
  "capacity_pool_policy_update",
  "capacity_member_policy_update",
  "model_api_token_revoke",
  "cli_token_revoke",
  "forwarder_pool_member_test",
  "forwarder_chat_completion_test",
  "forwarder_cli_command_run",
  "forwarder_cli_supervised_command_start",
  "forwarder_cli_command_result",
];

/** Confirmation literals for the write catalog. */
const PLAN_CONFIRMATIONS: Readonly<Record<string, "DELETE" | "RUN" | null>> = Object.freeze({
  forwarder_cli_metadata_remove: "DELETE",
  forwarder_endpoint_metadata_remove: "DELETE",
  forwarder_model_metadata_remove: "DELETE",
  forwarder_affinity_clear: "DELETE",
  forwarder_model_pool_delete: "DELETE",
  forwarder_pool_member_remove: "DELETE",
  forwarder_pool_grant_revoke: "DELETE",
  provider_account_delete: "DELETE",
  provider_model_delete: "DELETE",
  provider_pricing_version_activate: "RUN",
  provider_pricing_version_retire: "RUN",
  provider_pricing_version_delete: "DELETE",
  provider_credential_revoke: "DELETE",
  provider_credential_test: "RUN",
  provider_budget_policy_deactivate: "DELETE",
  capacity_record_remove: "DELETE",
  model_api_token_revoke: "DELETE",
  cli_token_revoke: "DELETE",
  forwarder_pool_member_test: "RUN",
  forwarder_chat_completion_test: "RUN",
  forwarder_cli_command_run: "RUN",
  forwarder_cli_supervised_command_start: "RUN",
});

/** Exact catalog targets (name → target) for drift detection. */
const PLAN_TARGETS: Readonly<Record<string, string>> = Object.freeze({
  app_config_get: "appConfig",
  forwarder_guarded_candidates_list: "forwarderManagement.listGuardedOverflowCandidates",
  forwarder_cli_devices_list: "forwarderManagement.listCliDevices",
  forwarder_model_pools_list: "forwarderManagement.listModelPools",
  forwarder_affinity_stats_get: "forwarderManagement.cacheAffinityStats",
  forwarder_models_visible_list: "forwarderManagement.visibleModels",
  provider_accounts_list: "providerManagement.listAccounts",
  provider_models_list: "providerManagement.listModels",
  provider_pricing_versions_list: "providerManagement.listPricingVersions",
  provider_credentials_list: "providerManagement.listCredentials",
  provider_audit_events_list: "providerManagement.listAuditEvents",
  provider_usage_page_list: "providerManagement.listUsageReportPage",
  provider_usage_totals_get: "providerManagement.getUsageTotals",
  provider_budget_activity_list: "providerManagement.listBudgetActivity",
  provider_attempt_events_list: "providerManagement.listProviderAttemptEvents",
  provider_attempts_list: "providerManagement.listProviderAttempts",
  provider_budget_policies_list: "providerManagement.listBudgetPolicies",
  capacity_records_list: "capacityManagement.list",
  capacity_audit_list: "capacityManagement.listAudit",
  model_api_tokens_list: "modelApiTokens.list",
  model_api_tokens_preview: "modelApiTokens.preview",
  cli_tokens_list: "cliCredentials.listTokens",
  relay_requests_list: "relayMetadata.listOwn",
  overview_metrics: "overview.metrics",
  overview_health: "overview.health",
  forwarder_guarded_pool_create: "forwarderManagement.createGuardedModelPool",
  forwarder_cli_device_rename: "forwarderManagement.renameCliDevice",
  forwarder_cli_metadata_remove: "forwarderManagement.removeCliDeviceMetadata",
  forwarder_endpoint_metadata_remove: "forwarderManagement.removeEndpointMetadata",
  forwarder_model_metadata_remove: "forwarderManagement.removeDiscoveredModelMetadata",
  forwarder_affinity_clear: "forwarderManagement.clearCacheAffinity",
  forwarder_model_pool_create: "forwarderManagement.createModelPool",
  forwarder_model_pool_update: "forwarderManagement.updateModelPool",
  forwarder_model_pool_delete: "forwarderManagement.deleteModelPool",
  forwarder_pool_member_add: "forwarderManagement.addPoolMember",
  forwarder_provider_member_add: "forwarderManagement.addProviderPoolMember",
  forwarder_pool_member_update: "forwarderManagement.updatePoolMember",
  forwarder_provider_member_reorder: "forwarderManagement.reorderProviderPoolMember",
  forwarder_pool_member_remove: "forwarderManagement.removePoolMember",
  forwarder_model_capabilities_update: "forwarderManagement.updateDiscoveredModelCapabilities",
  forwarder_model_capability_profile_set: "forwarderManagement.setDiscoveredModelCapabilityProfile",
  forwarder_model_attachment_limit_update:
    "forwarderManagement.updateDiscoveredModelAttachmentLimit",
  forwarder_pool_grant_create: "forwarderManagement.grantPoolAccessByEmail",
  forwarder_pool_grant_revoke: "forwarderManagement.revokePoolAccessByEmail",
  provider_account_create: "providerManagement.createAccount",
  provider_account_update: "providerManagement.updateAccount",
  provider_account_enabled_set: "providerManagement.setAccountEnabled",
  provider_account_delete: "providerManagement.deleteAccount",
  provider_model_create: "providerManagement.createModel",
  provider_model_update: "providerManagement.updateModel",
  provider_model_delete: "providerManagement.deleteModel",
  provider_pricing_version_create: "providerManagement.createPricingVersion",
  provider_pricing_version_update: "providerManagement.updatePricingVersion",
  provider_pricing_version_activate: "providerManagement.activatePricingVersion",
  provider_pricing_version_retire: "providerManagement.retirePricingVersion",
  provider_pricing_version_delete: "providerManagement.deletePricingVersion",
  provider_credential_revoke: "providerManagement.revokeCredential",
  provider_credential_reencrypt: "providerManagement.rotateCredential",
  provider_credential_test: "providerManagement.testCredential",
  provider_budget_policy_create: "providerManagement.createBudgetPolicy",
  provider_budget_policy_replace: "providerManagement.replaceBudgetPolicy",
  provider_budget_policy_deactivate: "providerManagement.deactivateBudgetPolicy",
  capacity_record_create: "capacityManagement.create",
  capacity_record_update: "capacityManagement.update",
  capacity_record_remove: "capacityManagement.remove",
  capacity_direct_policy_update: "capacityManagement.updateDirectPolicy",
  capacity_pool_policy_update: "capacityManagement.updatePoolPolicy",
  capacity_member_policy_update: "capacityManagement.updateMemberPolicy",
  model_api_token_revoke: "modelApiTokens.revoke",
  cli_token_revoke: "cliCredentials.revokeToken",
  forwarder_pool_member_test: "core:model-api/runPoolMemberTest",
  forwarder_chat_completion_test: "core:model-api/runChatCompletionDiagnostic",
  forwarder_cli_command_run: "core:forwarderCliCommandRun",
  forwarder_cli_supervised_command_start: "core:forwarderCliSupervisedCommandStart",
  forwarder_cli_command_result: "core:forwarderCliCommandResult",
});

/**
 * Every leaf procedure path on the real appRouter. oRPC v1 procedures are
 * objects carrying the `~orpc` marker; routers are plain objects of routers
 * and procedures — anything else (internals attached to a procedure) is not
 * walked.
 */
function collectRouterLeaves(router: unknown, prefix = ""): string[] {
  const leaves: string[] = [];
  if (router !== null && typeof router === "object") {
    if (Object.hasOwn(router, "~orpc")) {
      leaves.push(prefix);
      return leaves;
    }
    for (const [key, value] of Object.entries(router)) {
      const path = prefix ? `${prefix}.${key}` : key;
      leaves.push(...collectRouterLeaves(value, path));
    }
  }
  return leaves;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("MCP tool manifest — exact catalog", () => {
  it("contains exactly 25 read + 50 write names (no extras, no missing, no duplicates)", () => {
    const names = MCP_TOOL_MANIFEST.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual([...PLAN_READ_TOOLS, ...PLAN_WRITE_TOOLS].sort());
    expect(PLAN_READ_TOOLS).toHaveLength(25);
    expect(PLAN_WRITE_TOOLS).toHaveLength(50);
    expect(MCP_TOOL_MANIFEST).toHaveLength(75);
  });

  it("every descriptor carries its catalog target", () => {
    for (const tool of MCP_TOOL_MANIFEST) {
      expect(PLAN_TARGETS[tool.name]).toBe(tool.target);
    }
  });

  it("read tools require the read scope; write tools require literal write scope", () => {
    const readNames = new Set(PLAN_READ_TOOLS);
    for (const tool of MCP_TOOL_MANIFEST) {
      expect(tool.scope).toBe(readNames.has(tool.name) ? "read" : "write");
    }
  });

  it("confirmation policies match the catalog exactly", () => {
    for (const tool of MCP_TOOL_MANIFEST) {
      const expected = PLAN_CONFIRMATIONS[tool.name] ?? null;
      expect(`${tool.name}: ${tool.confirmation}`).toBe(`${tool.name}: ${expected}`);
    }
    // Destructive and external/cost tools are never unconfirmed.
    for (const tool of MCP_TOOL_MANIFEST) {
      if (tool.classification === "destructive") expect(tool.confirmation).toBe("DELETE");
      if (tool.classification === "external" || tool.classification === "cost") {
        expect(tool.confirmation).toBe("RUN");
      }
      if (tool.confirmation !== null) {
        expect(["destructive", "external", "cost"]).toContain(tool.classification);
      }
    }
  });

  it("every procedure-backed descriptor has exactly one invocation; diagnostics have cores", () => {
    for (const tool of MCP_TOOL_MANIFEST) {
      const invocations = [tool.invokeProcedure, tool.invokeCore].filter(Boolean).length;
      expect(`${tool.name}: ${invocations}`).toBe(`${tool.name}: 1`);
      if (tool.target.startsWith("core:")) {
        expect(tool.invokeCore).toBeTypeOf("function");
      } else {
        expect(tool.invokeProcedure).toBeTypeOf("function");
      }
    }
  });

  it("every procedure target resolves against the real appRouter", () => {
    const leaves = new Set(collectRouterLeaves(appRouter));
    for (const tool of MCP_TOOL_MANIFEST) {
      if (!tool.target.startsWith("core:")) {
        expect(`${tool.name}: ${leaves.has(tool.target)}`).toBe(`${tool.name}: true`);
      }
    }
  });
});

describe("MCP tool manifest — appRouter leaf classification (invariant 12)", () => {
  it("every appRouter leaf is either a tool target or an explicit exclusion", () => {
    const leaves = collectRouterLeaves(appRouter).sort();
    const toolTargets = new Set(
      MCP_TOOL_MANIFEST.filter((tool) => !tool.target.startsWith("core:")).map(
        (tool) => tool.target,
      ),
    );
    const excluded = new Set(MCP_TOOL_EXCLUSIONS.map((entry) => entry.target));
    expect([...toolTargets].filter((target) => excluded.has(target))).toEqual([]);
    const unclassified = leaves.filter((leaf) => !toolTargets.has(leaf) && !excluded.has(leaf));
    expect(unclassified).toEqual([]);
  });

  it("the explicit first-release exclusions are present verbatim", () => {
    const excluded = new Set(MCP_TOOL_EXCLUSIONS.map((entry) => entry.target));
    for (const required of [
      "modelApiTokens.create",
      // Human-only external-provider consent (fallback redesign C1).
      "modelApiTokens.updateExternalAccess",
      "cliCredentials.createToken",
      "cliCredentials.exchangeDeviceCode",
      "cliCredentials.deviceLoginRequest",
      "providerManagement.createCredential",
      "providerManagement.replaceCredential",
      "providerManagement.listUsageReport",
      "providerManagement.repairExpiredAttempts",
      "relayMetadata.deleteOwn",
      "relayMetadata.prune",
      "settings.update",
      "mcpGrants.listMine",
      "mcpGrants.revokeMine",
      "mcpTokens.listMine",
      "mcpTokens.create",
      "mcpTokens.updateMine",
      "mcpTokens.revokeMine",
      "forwarderManagement.setCliDeviceFeatureGrants",
      "supervisedCommands.pending",
      "supervisedCommands.submitOutput",
    ]) {
      expect(excluded.has(required)).toBe(true);
    }
    // The profile-slug trio (forwarderManagement) is excluded, not exposed.
    for (const slugProc of [
      "forwarderManagement.getProfileSlug",
      "forwarderManagement.previewProfileSlugChange",
      "forwarderManagement.updateProfileSlug",
    ]) {
      expect(excluded.has(slugProc)).toBe(true);
    }
  });

  it("excluded procedures never appear as tools under a different name", () => {
    const toolTargets = MCP_TOOL_MANIFEST.map((tool) => tool.target);
    for (const exclusion of MCP_TOOL_EXCLUSIONS) {
      expect(toolTargets).not.toContain(exclusion.target);
    }
  });

  it("human grant management (Phase 7) stays human-only — provably absent from the tool catalog AND from every dispatch", async () => {
    // The mcpGrants router is browser-session-only: a connected MCP client
    // must never enumerate or revoke the user's authorizations. Pin BOTH the
    // explicit exclusions and an EXECUTABLE dispatch proof: the old
    // invokeProcedure.toString() inspection could not see the selector
    // captured inside procedureInvoker's closure (tool-manifest.ts returns
    // `(client, input) => select(client)(input)`), so swapping a selector to
    // client.mcpGrants.listMine would have passed it.
    const toolNames = MCP_TOOL_MANIFEST.map((tool) => tool.name);
    const toolTargets = MCP_TOOL_MANIFEST.map((tool) => tool.target);
    for (const leaf of [
      "mcpGrants.listMine",
      "mcpGrants.revokeMine",
      "mcpTokens.listMine",
      "mcpTokens.create",
      "mcpTokens.updateMine",
      "mcpTokens.revokeMine",
    ]) {
      expect(toolTargets).not.toContain(leaf);
      expect(toolNames).not.toContain(leaf);
      expect(MCP_TOOL_EXCLUSIONS.map((entry) => entry.target)).toContain(leaf);
    }

    // Recording client: every property access records its full path; every
    // invocation records the exact leaf path dispatched to.
    type ToolClient = Parameters<
      NonNullable<(typeof MCP_TOOL_MANIFEST)[number]["invokeProcedure"]>
    >[0];
    const accessed = new Set<string>();
    const invoked: string[] = [];
    const callable = (path: string): unknown =>
      new Proxy(
        (..._args: unknown[]) => {
          invoked.push(path);
          return Promise.resolve(undefined);
        },
        {
          get(_target, prop) {
            if (typeof prop !== "string") return undefined;
            const nested = `${path}.${prop}`;
            accessed.add(nested);
            return callable(nested);
          },
        },
      );
    const recordingClient = new Proxy({} as Record<string, unknown>, {
      get(_target, prop) {
        if (typeof prop !== "string") return undefined;
        accessed.add(prop);
        return callable(prop);
      },
    }) as unknown as ToolClient;

    // Drive EVERY procedure-backed tool through the real dispatch path.
    let dispatched = 0;
    for (const tool of MCP_TOOL_MANIFEST) {
      if (!tool.invokeProcedure) continue; // 5 extracted cores (2 diagnostics + 3 CLI commands)
      const before = invoked.length;
      await tool.invokeProcedure(recordingClient, {});
      dispatched += 1;
      // The recorder itself is proven to work: each tool dispatched to
      // EXACTLY its declared target leaf — a selector change fails here.
      expect(`${tool.name}: ${invoked.slice(before).join(",")}`).toBe(
        `${tool.name}: ${PLAN_TARGETS[tool.name]}`,
      );
    }
    // 75 catalog entries − 5 extracted cores = 70 procedure dispatches.
    expect(dispatched).toBe(70);
    expect(invoked).toHaveLength(70);

    // Human-only proof: ZERO mcpGrants access (property or invocation)
    // across every dispatch.
    const grantAccesses = [...accessed].filter(
      (path) => path === "mcpGrants" || path.startsWith("mcpGrants."),
    );
    expect(grantAccesses).toEqual([]);
    expect(invoked.filter((path) => path.startsWith("mcpGrants"))).toEqual([]);
    const tokenAccesses = [...accessed].filter(
      (path) => path === "mcpTokens" || path.startsWith("mcpTokens."),
    );
    expect(tokenAccesses).toEqual([]);
    expect(invoked.filter((path) => path.startsWith("mcpTokens"))).toEqual([]);
    // Human-only proof: no tool can reach a token's external-provider consent.
    expect(toolTargets).not.toContain("modelApiTokens.updateExternalAccess");
    expect([...accessed].filter((path) => path === "modelApiTokens.updateExternalAccess")).toEqual(
      [],
    );
    expect(invoked).not.toContain("modelApiTokens.updateExternalAccess");
  });
});

describe("MCP tool manifest — feature-dependency metadata (G8a)", () => {
  const PROVIDER_EGRESS = "WMP_PUBLIC_PROVIDER_EGRESS_ENABLED";

  it("every provider-management tool advertises the provider-egress dependency", () => {
    for (const tool of MCP_TOOL_MANIFEST.filter((entry) =>
      entry.target.startsWith("providerManagement."),
    )) {
      expect(`${tool.name}: ${tool.featureDependencies?.join(",")}`).toBe(
        `${tool.name}: ${PROVIDER_EGRESS}`,
      );
    }
  });

  it("capacity-management tools are not behind a deployment feature flag", () => {
    for (const tool of MCP_TOOL_MANIFEST.filter((entry) =>
      entry.target.startsWith("capacityManagement."),
    )) {
      expect(tool.featureDependencies).toBeUndefined();
    }
  });

  it("the forwarder procedures with runtime feature gates advertise them", () => {
    const byName = new Map(MCP_TOOL_MANIFEST.map((tool) => [tool.name, tool]));
    // Unconditional provider-egress gate on provider member creation.
    expect(byName.get("forwarder_provider_member_add")?.featureDependencies).toEqual([
      PROVIDER_EGRESS,
    ]);
    // Conditional provider-egress gates.
    expect(byName.get("forwarder_guarded_pool_create")?.featureDependencies).toEqual([
      PROVIDER_EGRESS,
    ]);
    expect(byName.get("forwarder_model_pool_create")?.featureDependencies).toEqual([
      PROVIDER_EGRESS,
    ]);
    expect(byName.get("forwarder_pool_member_update")?.featureDependencies).toEqual([
      PROVIDER_EGRESS,
    ]);
    expect(byName.get("forwarder_model_pool_update")?.featureDependencies).toEqual([
      PROVIDER_EGRESS,
    ]);
  });

  it("D-K: MCP pool tools cannot change the owner's external fallback switches", async () => {
    const byName = new Map(MCP_TOOL_MANIFEST.map((tool) => [tool.name, tool]));
    for (const name of ["forwarder_model_pool_create", "forwarder_model_pool_update"]) {
      const schema = byName.get(name)!.inputSchema;
      for (const key of ["fallbackEnabled", "fallbackForGrantees"])
        for (const value of [true, false]) {
          const result = (await schema["~standard"].validate({ id: "pool", [key]: value })) as {
            issues?: { message: string; path?: readonly PropertyKey[] }[];
          };
          expect(result.issues?.[0]?.path).toEqual([key]);
          expect(result.issues?.[0]?.message).toContain("only by a person");
        }
      // Other owner settings, including the external wait, still pass through.
      const allowed = await schema["~standard"].validate({
        id: "pool",
        name: "Pool",
        externalAfterWaitMs: 500,
      });
      expect(allowed).not.toHaveProperty("issues");
      const { toJSONSchema } = await import("zod");
      const json: unknown = toJSONSchema(schema as unknown as Parameters<typeof toJSONSchema>[0]);
      expect(json).toMatchObject({
        properties: { fallbackEnabled: { not: {} }, fallbackForGrantees: { not: {} } },
      });
    }
    // Guarded create turns fallback on when it attaches external members, so
    // MCP may create only local-only guarded pools.
    const guarded = byName.get("forwarder_guarded_pool_create")!.inputSchema;
    const withExternal = (await guarded["~standard"].validate({
      providerModels: [{ providerModelId: "provider-model" }],
    })) as { issues?: unknown[] };
    expect(withExternal.issues).toHaveLength(1);
    expect(
      await guarded["~standard"].validate({ localModelIds: ["model"], providerModels: [] }),
    ).not.toHaveProperty("issues");
  });

  it("tools without runtime feature gates advertise none", () => {
    const byName = new Map(MCP_TOOL_MANIFEST.map((tool) => [tool.name, tool]));
    for (const name of ["app_config_get", "model_api_token_revoke", "relay_requests_list"]) {
      expect(byName.get(name)?.featureDependencies).toBeUndefined();
    }
  });

  it("date-valued procedure inputs carry ISO-8601 input adapters (G3)", () => {
    const byName = new Map(MCP_TOOL_MANIFEST.map((tool) => [tool.name, tool]));
    for (const name of ["relay_requests_list"] as const) {
      expect(byName.get(name)?.inputAdapter).toBeTypeOf("function");
    }
    for (const name of [
      "forwarder_cli_metadata_remove",
      "forwarder_endpoint_metadata_remove",
      "forwarder_model_metadata_remove",
    ] as const) {
      expect(byName.get(name)?.inputAdapter).toBeTypeOf("function");
    }
  });
});

const { isoDateFieldsAdapter, McpInvalidDateInputError, MCP_TOOL_INPUT_MAX_BYTES } = await import(
  "./tool-manifest"
);

describe("G3 — strict RFC 3339 UTC date adaptation (isoDateFieldsAdapter)", () => {
  const adapt = isoDateFieldsAdapter(["staleBefore"]);

  it("accepts real calendar timestamps and constructs them via Date.UTC", () => {
    const result = adapt({ staleBefore: "2026-02-28T23:59:59Z" }) as { staleBefore: Date };
    expect(result.staleBefore.toISOString()).toBe("2026-02-28T23:59:59.000Z");
    const leap = adapt({ staleBefore: "2024-02-29T00:00:00.123Z" }) as { staleBefore: Date };
    expect(leap.staleBefore.toISOString()).toBe("2024-02-29T00:00:00.123Z");
    const boundary = adapt({ staleBefore: "0000-01-01T00:00:00Z" }) as { staleBefore: Date };
    // ISO year 0000 maps to 1 BCE in ECMAScript's proleptic calendar.
    expect(boundary.staleBefore.getTime()).toBe(-62167219200000);
  });

  it("rejects impossible calendar dates instead of normalizing them", () => {
    for (const value of [
      "2026-02-30T00:00:00Z", // Feb 30 → previously normalized to March 2
      "2026-04-31T00:00:00Z", // Apr 31
      "2025-02-29T00:00:00Z", // Feb 29 on a NON-leap year
      "2026-01-00T00:00:00Z", // day 0
      "2026-13-01T00:00:00Z", // month 13
      "2026-02-28T24:00:00Z", // hour 24
      "2026-02-28T23:60:00Z", // minute 60
      "2026-02-28T23:59:60Z", // second 60 (no leap-second normalization)
    ]) {
      expect(() => adapt({ staleBefore: value })).toThrow(McpInvalidDateInputError);
    }
  });

  it("rejects non-strict shapes: offsets, date-only, spaces, non-strings, explicit null", () => {
    for (const value of [
      "2026-02-28T00:00:00+01:00", // offset form, not UTC Z
      "2026-02-28T00:00:00", // missing Z
      "2025-12-31", // date-only (previously accepted)
      "2026-02-28 00:00:00Z", // space separator
      1769640000000, // numeric timestamp
      null,
      {},
    ]) {
      expect(() => adapt({ staleBefore: value })).toThrow(McpInvalidDateInputError);
    }
    // Explicit null is NEVER deleted (the guard must not silently vanish).
    expect(() => adapt({ staleBefore: null })).toThrow(McpInvalidDateInputError);
  });

  it("absent fields and Date instances pass through untouched", () => {
    expect(adapt({})).toEqual({});
    const date = new Date("2026-01-01T00:00:00Z");
    expect(adapt({ staleBefore: date })).toEqual({ staleBefore: date });
  });

  it("truncates fractional seconds to milliseconds — no rollover, no float artifacts (G3 pass 4)", () => {
    // .9999 previously ROUNDED to 1000 ms, crossing the year boundary before
    // setUTCFullYear overwrote the rolled-over year.
    const rollover = adapt({ staleBefore: "2026-12-31T23:59:59.9999Z" }) as {
      staleBefore: Date;
    };
    expect(rollover.staleBefore.toISOString()).toBe("2026-12-31T23:59:59.999Z");
    const lowYear = adapt({ staleBefore: "0099-12-31T23:59:59.9999Z" }) as {
      staleBefore: Date;
    };
    expect(lowYear.staleBefore.toISOString()).toBe("0099-12-31T23:59:59.999Z");
    // Long fractions truncate deterministically.
    const long = adapt({ staleBefore: "2026-06-01T12:00:00.123456789Z" }) as {
      staleBefore: Date;
    };
    expect(long.staleBefore.toISOString()).toBe("2026-06-01T12:00:00.123Z");
    // Exactly-three-digit and single-digit fractions stay exact (string
    // slicing avoids 0.123 * 1000 === 122.999... float drift).
    const exact = adapt({ staleBefore: "2026-06-01T12:00:00.123Z" }) as { staleBefore: Date };
    expect(exact.staleBefore.toISOString()).toBe("2026-06-01T12:00:00.123Z");
    const short = adapt({ staleBefore: "2026-06-01T12:00:00.1Z" }) as { staleBefore: Date };
    expect(short.staleBefore.toISOString()).toBe("2026-06-01T12:00:00.100Z");
    const two = adapt({ staleBefore: "2026-06-01T12:00:00.99Z" }) as { staleBefore: Date };
    expect(two.staleBefore.toISOString()).toBe("2026-06-01T12:00:00.990Z");
  });

  it("normal fractional timestamps keep their calendar date (regression)", () => {
    const normal = adapt({ staleBefore: "2026-03-15T10:30:45.678Z" }) as { staleBefore: Date };
    expect(normal.staleBefore.toISOString()).toBe("2026-03-15T10:30:45.678Z");
    const none = adapt({ staleBefore: "2026-03-15T10:30:45Z" }) as { staleBefore: Date };
    expect(none.staleBefore.toISOString()).toBe("2026-03-15T10:30:45.000Z");
  });
});

describe("G5 — advertised schemas bound tool input size", () => {
  it("an input under 64 KiB parses normally through the guard", async () => {
    const schema = MCP_TOOL_MANIFEST.find((tool) => tool.name === "app_config_get")!.inputSchema;
    const result = await schema["~standard"].validate({ any: "payload" });
    expect(result).not.toHaveProperty("issues");
  });

  it("an oversized input produces ONE bounded issue via the standard schema", async () => {
    const schema = MCP_TOOL_MANIFEST.find((tool) => tool.name === "app_config_get")!.inputSchema;
    const huge = { blob: "x".repeat(MCP_TOOL_INPUT_MAX_BYTES + 1024) };
    const result = (await schema["~standard"].validate(huge)) as { issues: unknown[] };
    expect(result.issues).toHaveLength(1);
  });

  it("the guard runs FIRST: oversized input with invalid children yields ONLY the size issue (G5 pass 4)", async () => {
    // The pass-3 appended check ran AFTER object/child parsing and was
    // SKIPPED when child parsing aborted — this exact input produced only
    // nested issues. The first-stage pipeline guard always runs first.
    const schema = MCP_TOOL_MANIFEST.find(
      (tool) => tool.name === "forwarder_chat_completion_test",
    )!.inputSchema;
    const result = (await schema["~standard"].validate({
      model: 123,
      messages: [{ role: "user" }],
      confirm: "RUN",
      blob: "x".repeat(70_000),
    })) as { issues: { message: string }[] };
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.message).toContain("input exceeds the maximum size");
  });

  it("the size bound measures the PRE-parse value — JSON-origin __proto__ keys are counted (documented conservative scope)", async () => {
    // The pass-3 post-parse check never saw a __proto__ key JSON parsing
    // dropped. The first-stage guard measures what the SDK hands the
    // schema BEFORE parsing, so an oversized payload is rejected even when
    // parsing would have dropped its bulk — deliberately conservative; the
    // raw wire is separately bounded by the 1 MiB body cap.
    const input = JSON.parse(`{"__proto__":"${"x".repeat(70_000)}"}`);
    const schema = MCP_TOOL_MANIFEST.find((tool) => tool.name === "app_config_get")!.inputSchema;
    const result = (await schema["~standard"].validate(input)) as { issues: unknown[] };
    expect(result.issues).toHaveLength(1);
    expect(JSON.stringify(result.issues)).toContain("input exceeds the maximum size");
  });

  it("G5 pass 5 HTTP parity: empty and roleless message entries pass the chat schema", async () => {
    // Full input parity (R69/R70): the shared HTTP diagnostic path
    // (prepareJsonModeledRequest) validates JSON + model then FORWARDS — it
    // relays `messages: []` (pinned by the HTTP regression) and does not
    // independently validate roles. The MCP schema is a plain unknown-array
    // with no minimum and no role check; the byte bound stays the only
    // intentional restriction.
    const schema = MCP_TOOL_MANIFEST.find(
      (tool) => tool.name === "forwarder_chat_completion_test",
    )!.inputSchema;
    for (const messages of [
      [],
      [{ content: "hi" }],
      [{ role: "user", content: "hello" }],
      [{ role: "user" }, { content: "x" }],
      ["plain-string-entry"],
    ]) {
      const result = await schema["~standard"].validate({ model: "m", messages, confirm: "RUN" });
      expect(result).not.toHaveProperty("issues");
    }
  });

  it("G5 pass 4 HTTP parity: 17- and 50-message valid histories pass the chat schema", async () => {
    // The shared HTTP diagnostic path imposes no message-count limit; MCP
    // must not either. The 64 KiB byte bound remains the budget.
    const schema = MCP_TOOL_MANIFEST.find(
      (tool) => tool.name === "forwarder_chat_completion_test",
    )!.inputSchema;
    for (const count of [17, 50]) {
      const result = await schema["~standard"].validate({
        model: "m",
        confirm: "RUN",
        messages: Array.from({ length: count }, () => ({ role: "user", content: "hello" })),
      });
      expect(result).not.toHaveProperty("issues");
    }
  });

  it("the advertised JSON Schema shape is unchanged by the first-stage guard", async () => {
    // The pipe's JSON Schema equals the inner loose object's — the guard
    // emits no JSON-Schema keywords, so the advertised shape (type object,
    // loose additionalProperties, required confirm/memberId/model) is
    // identical to the pass-3 appended-check form.
    const { toJSONSchema } = await import("zod");
    for (const name of ["app_config_get", "provider_account_delete"] as const) {
      const schema = MCP_TOOL_MANIFEST.find((tool) => tool.name === name)!.inputSchema;
      const json = toJSONSchema(schema as unknown as Parameters<typeof toJSONSchema>[0]);
      expect(json).toEqual({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties:
          name === "provider_account_delete"
            ? { confirm: { type: "string", const: "DELETE" } }
            : {},
        ...(name === "provider_account_delete" ? { required: ["confirm"] } : {}),
        additionalProperties: {},
      });
    }
  });
});
