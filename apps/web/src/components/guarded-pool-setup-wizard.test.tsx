import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import enDashboard from "../locales/en-US/dashboard.json";

const queryData = vi.hoisted(() => ({ providers: [] as Array<Record<string, unknown>> }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: { current?: number }) =>
      values?.current ? `${key}:${values.current}` : key,
  }),
}));
vi.mock("@/utils/orpc", () => ({
  orpc: {
    appConfig: {
      queryOptions: () => ({
        queryKey: ["appConfig"],
        queryFn: async () => ({ capacityEnabled: true }),
        initialData: { capacityEnabled: true },
      }),
    },
    forwarderManagement: {
      key: () => ["forwarderManagement"],
      listGuardedOverflowCandidates: {
        queryOptions: () => ({
          queryKey: ["providers"],
          queryFn: async () => queryData.providers,
          initialData: queryData.providers,
        }),
      },
      createGuardedModelPool: {
        mutationOptions: (options: unknown) => ({
          mutationFn: async () => ({}),
          ...(options as object),
        }),
      },
    },
    capacityManagement: {
      list: { queryOptions: () => ({ queryKey: ["capacities"], queryFn: async () => [] }) },
    },
  },
}));
vi.mock("@ws-model-proxy/ui/components/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? children : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <footer>{children}</footer>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <header>{children}</header>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h1>{children}</h1>,
}));

import {
  buildGuardedPoolWizardSchema,
  combinedPrimaryMemberCount,
  combinedPrimarySurfaceIsSelectable,
  minimumSelectedPhysicalContext,
  nextRecommendedSurface,
  primarySurfaceIsSelectable,
  providerEgressFromAppConfig,
  providerOrderAfterMove,
  providerOrderAfterToggle,
  providerSelectionBlockedByEgress,
  recommendedCombinedPrimarySurface,
  recommendedPrimarySurface,
} from "../lib/guarded-pool-wizard-validation";
import {
  budgetIntegerRule,
  budgetSpendRule,
  deriveMemberOverride,
  focusFirstInvalidWizardField,
  GuardedPoolSetupWizard,
  MemberOverrideEditor,
  memberContextFitsPhysical,
} from "./guarded-pool-setup-wizard";

function findElement(
  node: ReactNode,
  predicate: (element: ReactElement<Record<string, unknown>>) => boolean,
): ReactElement<Record<string, unknown>> | undefined {
  if (!isValidElement(node)) return undefined;
  const element = node as ReactElement<Record<string, unknown>>;
  if (predicate(element)) return element;
  const children = element.props.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const match = findElement(child as ReactNode, predicate);
    if (match) return match;
  }
  return undefined;
}

const chatCapabilities = {
  version: 1 as const,
  protocol: "openai-compatible" as const,
  chatCompletions: { supported: true, streaming: true },
};
const localModel = {
  id: "local",
  canonicalModelId: "owner/cli/local/model",
  effectiveCapabilities: { metadata: chatCapabilities },
  executionTarget: { inferenceCapacityId: "capacity" },
};

// Single-surface model factory shared by the recommended-surface policy tests.
const policySurfaceModel = (id: string, surface: "openaiChatCompletions" | "openaiResponses") => ({
  ...localModel,
  id,
  effectiveCapabilities: {
    metadata: {
      version: 3 as const,
      protocol: "openai-compatible" as const,
      surfaces: {
        [surface]: {
          source: "declared" as const,
          confidence: "exact" as const,
          supported: true,
          streaming: true,
        },
      },
    },
  },
});
// Chat-native provider whose only native surface is OPENAI_CHAT_COMPLETIONS.
const chatOnlyProvider = {
  id: "provider",
  nativeCapabilities: {
    version: 3 as const,
    protocol: "openai-compatible" as const,
    surfaces: {
      openaiChatCompletions: {
        source: "provider" as const,
        confidence: "exact" as const,
        supported: true,
        streaming: true,
      },
    },
  },
};

function renderStep(
  initialStep: 0 | 1 | 2 | 3,
  initialProviderModelIds: string[] = [],
  providerEgressEnabled = true,
) {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <GuardedPoolSetupWizard
        open
        onOpenChange={() => undefined}
        directModels={[localModel]}
        initialStep={initialStep}
        protocolAdaptationAvailable
        initialProviderModelIds={initialProviderModelIds}
        capacityEnabled
        providerEgressEnabled={providerEgressEnabled}
      />
    </QueryClientProvider>,
  );
}

describe("GuardedPoolSetupWizard", () => {
  it("derives compatibility across provider-only and mixed PRIMARY selections", () => {
    const provider = {
      id: "provider",
      nativeCapabilities: {
        version: 3,
        protocol: "openai-compatible",
        surfaces: {
          openaiResponses: {
            source: "provider",
            confidence: "exact",
            supported: true,
            streaming: true,
          },
        },
      },
    };
    expect(recommendedCombinedPrimarySurface([], [], [provider.id], [provider], "PRIMARY")).toBe(
      "OPENAI_RESPONSES",
    );
    expect(
      combinedPrimarySurfaceIsSelectable(
        "OPENAI_RESPONSES",
        [localModel.id],
        [localModel],
        [provider.id],
        [provider],
        "PRIMARY",
        false,
      ),
    ).toBe(false);
    expect(
      combinedPrimarySurfaceIsSelectable(
        "OPENAI_CHAT_COMPLETIONS",
        [localModel.id],
        [localModel],
        [provider.id],
        [provider],
        "PUBLIC_OVERFLOW",
        false,
      ),
    ).toBe(true);
  });

  it("renders each of the four navigable steps", () => {
    for (const step of [0, 1, 2, 3] as const)
      expect(renderStep(step)).toContain(`dashboard:pools.wizard.step:${step + 1}`);
    expect(renderStep(0)).toContain("dashboard:pools.wizard.localModels");
    expect(renderStep(1)).toContain("dashboard:pools.wizard.capacityDistinctHint");
    expect(renderStep(2)).toContain("dashboard:pools.wizard.providerOrder");
    expect(renderStep(3)).toContain("dashboard:pools.wizard.atomicRollback");
  });

  it("renders only wizard field hint keys that exist in the en-US bundle", () => {
    // The identity-mocked t() hides missing keys (raw key paths render as
    // text), so pin every rendered *Hint key against the real bundle.
    const markup = ([0, 1, 2, 3] as const).map((step) => renderStep(step)).join("");
    const renderedHintKeys = [
      ...new Set(markup.match(/dashboard:pools\.wizard\.fields\.[A-Za-z0-9]+Hint\b/g) ?? []),
    ];
    expect(renderedHintKeys.length).toBeGreaterThan(0);
    const fields = (
      enDashboard as {
        pools: {
          wizard: {
            fields: Record<string, unknown>;
          };
        };
      }
    ).pools.wizard.fields;
    const missing = renderedHintKeys.filter(
      (key) => typeof fields[key.replace("dashboard:pools.wizard.fields.", "")] !== "string",
    );
    expect(missing).toEqual([]);
  });

  it("renders optional advanced capacity, member, affinity, adaptation, and budget controls", () => {
    const capacity = renderStep(1);
    expect(capacity).toContain("dashboard:pools.wizard.advanced.title");
    expect(capacity).toContain("dashboard:pools.wizard.fields.physicalCountStrategy");
    expect(capacity).toContain("dashboard:pools.protocolCompatibility");
    for (const option of ["native", "lossless", "lossy"])
      expect(capacity).toContain(`dashboard:pools.protocolOptions.${option}.label`);
    expect(capacity).toContain("dashboard:pools.wizard.fields.affinityEnabled");
    expect(capacity).toContain("dashboard:pools.wizard.advanced.memberOverrides");
    expect(capacity).toContain("sm:grid-cols-2");

    const budgets = renderStep(2, ["provider"]);
    expect(budgets).toContain("dashboard:pools.wizard.advanced.budgetTitle");
    for (const field of [
      "tokenAttempt",
      "tokenDay",
      "tokenMonth",
      "tokenLifetime",
      "spendDay",
      "spendMonth",
    ])
      expect(budgets).toContain(`dashboard:pools.wizard.fields.${field}`);
    expect(budgets).toContain("pools.wizard.advanced.unlimitedWarning");
  });

  it("renders the egress acknowledgement only after provider selection", () => {
    expect(renderStep(2)).not.toContain("dashboard:pools.wizard.egressWarning");
    const withProvider = renderStep(2, ["provider"]);
    expect(withProvider).toContain("dashboard:pools.wizard.egressWarning");
    expect(withProvider).toContain("dashboard:pools.wizard.fields.publicEgressAcknowledged");
  });

  it("disables provider checkboxes and explains why when deployment egress is off", () => {
    queryData.providers = [
      {
        id: "provider-a",
        upstreamModelId: "gpt-example",
        displayName: "Primary provider",
        providerAccount: { label: "OpenAI" },
        pricing: { currency: "USD" },
      },
    ];
    const markup = renderStep(2, [], false);
    expect(markup).toContain('id="guarded-provider-provider-a"');
    expect(markup).toContain('data-disabled=""');
    expect(markup).toContain("dashboard:pools.wizard.providerEgressDisabled");
    // Enabled deployments keep the checkbox interactive and show no notice.
    const enabled = renderStep(2);
    expect(enabled).not.toContain("dashboard:pools.wizard.providerEgressDisabled");
    queryData.providers = [];
  });

  it("does not pre-select initial providers when deployment egress is off", () => {
    const markup = renderStep(2, ["provider-a"], false);
    expect(markup).not.toContain('data-checked="true"');
    expect(markup).not.toContain("dashboard:pools.wizard.egressWarning");
  });

  it("flags provider selections as blocked only when egress is disabled", () => {
    expect(providerSelectionBlockedByEgress(false, ["provider-a"])).toBe(true);
    expect(providerSelectionBlockedByEgress(false, [])).toBe(false);
    expect(providerSelectionBlockedByEgress(true, ["provider-a"])).toBe(false);
  });

  it("reads the egress gate fail-closed from an appConfig snapshot", () => {
    expect(providerEgressFromAppConfig(undefined)).toBe(false);
    expect(providerEgressFromAppConfig(null)).toBe(false);
    expect(providerEgressFromAppConfig("junk")).toBe(false);
    expect(providerEgressFromAppConfig({})).toBe(false);
    expect(providerEgressFromAppConfig({ capacityEnabled: true })).toBe(false);
    expect(providerEgressFromAppConfig({ providerEgressEnabled: false })).toBe(false);
    expect(providerEgressFromAppConfig({ providerEgressEnabled: true })).toBe(true);
    expect(
      providerEgressFromAppConfig({ capacityEnabled: true, providerEgressEnabled: true }),
    ).toBe(true);
  });

  const validWizardValues = {
    slug: "guarded-pool",
    name: "Guarded pool",
    localModelIds: ["local"],
    memberConcurrencyLimit: 1,
    memberContextCeiling: null as number | null,
    reservedSlots: 0,
    localWaitBudgetMs: 30_000,
    recommendedSurface: "OPENAI_CHAT_COMPLETIONS" as const,
    providerModelIds: ["provider-a"],
    providerTier: "PUBLIC_OVERFLOW" as const,
    providerConcurrencyLimit: 1,
    dailySpendLimit: "10.00",
    publicEgressAcknowledged: true,
    physicalCountStrategy: "CONSERVATIVE_ESTIMATE" as const,
    contextMargin: 0,
    borrowPolicy: "WHEN_IDLE" as const,
    protocolAdaptationEnabled: false,
    allowLossyDeveloperRoleCollapse: false,
    affinityEnabled: false,
    affinityTtlSeconds: 3_600,
    affinityMaxRecords: 10_000,
    affinityPrefixWeight: 100,
    affinityConversationWeight: 150,
    affinityConfirmedCacheWeight: 250,
    affinityLoadPenaltyWeight: 100,
    providerConcurrencyMode: "LIMITED" as const,
    tokenAttemptMode: "LIMITED" as const,
    tokenAttemptLimit: "100000",
    tokenDayMode: "LIMITED" as const,
    tokenDayLimit: "1000000",
    tokenMonthMode: "LIMITED" as const,
    tokenMonthLimit: "10000000",
    tokenLifetimeMode: "UNLIMITED" as const,
    tokenLifetimeLimit: "",
    spendDayMode: "LIMITED" as const,
    spendMonthMode: "LIMITED" as const,
    spendMonthLimit: "100",
  };

  it("schema rejects provider selections under its own path when egress is disabled", () => {
    const result = buildGuardedPoolWizardSchema({
      providerEgressEnabled: false,
      protocolAdaptationAvailable: false,
      directModels: [localModel],
      providerModels: [],
      capacities: [],
    }).safeParse(validWizardValues);
    // Isolated from every other validation: the gate issue is the only one.
    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected parse failure");
    expect(result.error.issues.map((issue) => issue.path)).toEqual([["providerEgressBlocked"]]);
  });

  it("schema accepts the same provider selection when egress is enabled", () => {
    const result = buildGuardedPoolWizardSchema({
      providerEgressEnabled: true,
      protocolAdaptationAvailable: false,
      directModels: [localModel],
      providerModels: [],
      capacities: [],
    }).safeParse(validWizardValues);
    expect(result.success).toBe(true);
  });

  it("gives provider selection controls stable accessible names", () => {
    queryData.providers = [
      {
        id: "provider-a",
        upstreamModelId: "gpt-example",
        displayName: "Primary provider",
        providerAccount: { label: "OpenAI" },
        pricing: { currency: "USD" },
      },
    ];
    const markup = renderStep(2);
    expect(markup).toContain('id="guarded-provider-provider-a"');
    expect(markup).toContain('aria-label="dashboard:pools.wizard.selectProvider"');
    queryData.providers = [];
  });

  it("focuses the first rendered invalid control", () => {
    let focused = false;
    focusFirstInvalidWizardField({
      querySelector: () =>
        ({
          focus: () => {
            focused = true;
          },
        }) as HTMLElement,
    });
    expect(focused).toBe(true);
  });

  it("defaults member context controls to inherit without a synthetic margin", () => {
    expect(
      deriveMemberOverride({
        memberConcurrencyLimit: 3,
        reservedSlots: 1,
        borrowPolicy: "NEVER",
        localWaitBudgetMs: 12_000,
        memberContextCeiling: 30_000,
        contextMargin: 2_000,
      }),
    ).toEqual({
      concurrencyMode: "LIMITED",
      concurrencyLimit: 3,
      reservedSlots: 1,
      borrowPolicy: "NEVER",
      waitBudgetMode: "LIMITED",
      waitBudgetMs: 12_000,
      contextCeilingMode: "INHERIT",
      contextCeiling: 30_000,
      contextMargin: 2_000,
    });
  });

  it("uses the model declaration before physical capacity and leaves an unknown LIMITED value empty", () => {
    const values = {
      memberConcurrencyLimit: 1,
      reservedSlots: 0,
      borrowPolicy: "WHEN_IDLE" as const,
      localWaitBudgetMs: 30_000,
      memberContextCeiling: null,
      contextMargin: 0,
    };
    expect(deriveMemberOverride(values, 128_000, 8_192).contextCeiling).toBe(128_000);
    expect(deriveMemberOverride(values).contextCeiling).toBeNull();
  });

  it("enables a member editor through its keyboard-operable checkbox callback", () => {
    let enabled = false;
    const editor = MemberOverrideEditor({
      modelId: "local",
      label: "owner/cli/local/model",
      value: deriveMemberOverride({
        memberConcurrencyLimit: 1,
        reservedSlots: 0,
        borrowPolicy: "WHEN_IDLE",
        localWaitBudgetMs: 30_000,
        memberContextCeiling: 31_744,
        contextMargin: 1_024,
      }),
      enabled,
      onEnabled: (next) => {
        enabled = next;
      },
      onChange: () => undefined,
    });
    const checkbox = findElement(
      editor,
      (element) => typeof element.props.onCheckedChange === "function",
    );
    expect(checkbox).toBeDefined();
    if (!checkbox) throw new Error("member override checkbox not rendered");
    (checkbox.props.onCheckedChange as (checked: boolean) => void)(true);
    expect(enabled).toBe(true);
  });

  it("renders and detects a model-specific physical context error", () => {
    const value = {
      ...deriveMemberOverride({
        memberConcurrencyLimit: 1,
        reservedSlots: 0,
        borrowPolicy: "WHEN_IDLE",
        localWaitBudgetMs: 30_000,
        memberContextCeiling: 32_000,
        contextMargin: 1_000,
      }),
      contextCeilingMode: "LIMITED" as const,
      contextMargin: 1_000,
    };
    expect(memberContextFitsPhysical(value, 32_768)).toBe(false);
    const markup = renderToStaticMarkup(
      MemberOverrideEditor({
        modelId: "local",
        label: "local",
        value,
        enabled: true,
        contextError: "localized context error",
        onEnabled: () => undefined,
        onChange: () => undefined,
      }),
    );
    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toContain("localized context error");
    expect(markup).toContain('<option value="INHERIT">');
    expect((markup.match(/value="INHERIT"/g) ?? []).length).toBe(1);
  });

  it("serializes independent LIMITED and UNLIMITED budget transitions", () => {
    expect(budgetIntegerRule("LIMITED", "1200")).toEqual({
      mode: "LIMITED",
      limitValue: 1200,
    });
    expect(budgetIntegerRule("UNLIMITED", "")).toEqual({
      mode: "UNLIMITED",
      limitValue: null,
    });
    expect(budgetSpendRule("LIMITED", "12.50")).toEqual({
      mode: "LIMITED",
      limitValue: "12.50",
    });
    expect(budgetSpendRule("UNLIMITED", "")).toEqual({
      mode: "UNLIMITED",
      limitValue: null,
    });
  });

  it("preserves explicit provider order across selection and arrow moves", () => {
    const selected = providerOrderAfterToggle(["a"], "b", true);
    expect(selected).toEqual(["a", "b"]);
    expect(providerOrderAfterMove(selected, 1, -1)).toEqual(["b", "a"]);
  });

  it("prefers native and allows every explicitly selected native surface", () => {
    const multiNative = [
      {
        ...localModel,
        effectiveCapabilities: {
          metadata: {
            version: 3 as const,
            protocol: "openai-compatible" as const,
            surfaces: {
              openaiChatCompletions: {
                source: "declared" as const,
                confidence: "exact" as const,
                supported: true,
                streaming: true,
              },
              anthropicMessages: {
                source: "declared" as const,
                confidence: "exact" as const,
                supported: true,
                streaming: true,
              },
            },
          },
        },
      },
    ];
    expect(recommendedPrimarySurface(["local"], [localModel])).toBe("OPENAI_CHAT_COMPLETIONS");
    expect(primarySurfaceIsSelectable("OPENAI_CHAT_COMPLETIONS", ["local"], multiNative)).toBe(
      true,
    );
    expect(primarySurfaceIsSelectable("ANTHROPIC_MESSAGES", ["local"], multiNative)).toBe(true);
    expect(primarySurfaceIsSelectable("OPENAI_RESPONSES", ["local"], multiNative)).toBe(false);
  });

  it("requires explicit adaptation for heterogeneous primary APIs", () => {
    const surfaceModel = (id: string, surface: "openaiChatCompletions" | "openaiResponses") => ({
      ...localModel,
      id,
      effectiveCapabilities: {
        metadata: {
          version: 3 as const,
          protocol: "openai-compatible" as const,
          surfaces: {
            [surface]: {
              source: "declared" as const,
              confidence: "exact" as const,
              supported: true,
              streaming: true,
            },
          },
        },
      },
    });
    const heterogeneous = [
      surfaceModel("chat", "openaiChatCompletions"),
      surfaceModel("responses", "openaiResponses"),
    ];
    const selected = ["chat", "responses"];

    expect(recommendedPrimarySurface(selected, heterogeneous)).toBeNull();
    expect(primarySurfaceIsSelectable("OPENAI_RESPONSES", selected, heterogeneous)).toBe(false);
    expect(recommendedPrimarySurface(selected, heterogeneous, true)).toBe("OPENAI_RESPONSES");
    expect(primarySurfaceIsSelectable("OPENAI_RESPONSES", selected, heterogeneous, true)).toBe(
      true,
    );
  });

  it("applies the auto-set-once and auto-repair recommended-surface policy", () => {
    const surfaceModel = (id: string, surface: "openaiChatCompletions" | "openaiResponses") => ({
      ...localModel,
      id,
      effectiveCapabilities: {
        metadata: {
          version: 3 as const,
          protocol: "openai-compatible" as const,
          surfaces: {
            [surface]: {
              source: "declared" as const,
              confidence: "exact" as const,
              supported: true,
              streaming: true,
            },
          },
        },
      },
    });
    const chat = surfaceModel("chat", "openaiChatCompletions");
    const responses = surfaceModel("responses", "openaiResponses");
    const fresh = { manuallyChosen: false, autoSetByMember: false };
    const selectionOf = (
      localIds: readonly string[],
      protocolAdaptationEnabled = false,
      providerTier: "PRIMARY" | "PUBLIC_OVERFLOW" = "PRIMARY",
    ) => ({
      localIds,
      localModels: [chat, responses],
      providerIds: [] as readonly string[],
      providerModels: [] as never[],
      providerTier,
      protocolAdaptationEnabled,
    });

    // First selection defaults to that single member's best native API.
    const first = nextRecommendedSurface("OPENAI_RESPONSES", fresh, selectionOf(["chat"]), true);
    expect(first).toEqual({
      surface: "OPENAI_CHAT_COMPLETIONS",
      flags: { manuallyChosen: false, autoSetByMember: true },
    });

    // No recompute when a second member joins while the value stays valid.
    expect(
      nextRecommendedSurface(
        first.surface,
        first.flags,
        selectionOf(["chat", "responses"], true),
        false,
      ).surface,
    ).toBe("OPENAI_CHAT_COMPLETIONS");

    // No re-default on a later "first" transition once a member already set it.
    expect(
      nextRecommendedSurface("OPENAI_RESPONSES", first.flags, selectionOf(["chat"], true), true)
        .surface,
    ).toBe("OPENAI_RESPONSES");

    // A manual choice persists while it remains selectable.
    const manual = { manuallyChosen: true, autoSetByMember: true };
    const keptManual = nextRecommendedSurface(
      "OPENAI_RESPONSES",
      manual,
      selectionOf(["chat", "responses"], true),
      false,
    );
    expect(keptManual.surface).toBe("OPENAI_RESPONSES");
    expect(keptManual.flags).toEqual(manual);

    // Auto-repair replaces a manual choice that became unselectable (the
    // chat-only member cannot serve OPENAI_RESPONSES without adaptation).
    const repaired = nextRecommendedSurface(
      "OPENAI_RESPONSES",
      manual,
      selectionOf(["chat"]),
      false,
    );
    expect(repaired).toEqual({
      surface: "OPENAI_CHAT_COMPLETIONS",
      flags: { manuallyChosen: false, autoSetByMember: true },
    });

    // Unselectable with no selectable fallback keeps the value (the schema
    // flags it inline; the user must adjust members or enable adaptation).
    expect(
      nextRecommendedSurface("OPENAI_RESPONSES", fresh, selectionOf(["chat", "responses"]), false)
        .surface,
    ).toBe("OPENAI_RESPONSES");

    // A zero-primary selection (PUBLIC_OVERFLOW-only providers) never repairs.
    expect(
      nextRecommendedSurface(
        "OPENAI_RESPONSES",
        fresh,
        selectionOf([], false, "PUBLIC_OVERFLOW"),
        false,
      ).surface,
    ).toBe("OPENAI_RESPONSES");
  });

  it("keeps a selectable manual choice that is not the ranked winner across member changes", () => {
    const chat = policySurfaceModel("chat", "openaiChatCompletions");
    const responses = policySurfaceModel("responses", "openaiResponses");
    const manual = { manuallyChosen: true, autoSetByMember: true };
    // Mixed members with adaptation: the combined ranking returns
    // OPENAI_RESPONSES (see "requires explicit adaptation..."), but the manual
    // OPENAI_CHAT_COMPLETIONS is selectable and must survive the member set
    // that would re-rank it. Under the OLD always-recompute policy this member
    // change rewrote the surface to the ranked winner OPENAI_RESPONSES, so
    // this test fails there.
    const kept = nextRecommendedSurface(
      "OPENAI_CHAT_COMPLETIONS",
      manual,
      {
        localIds: ["chat", "responses"],
        localModels: [chat, responses],
        providerIds: [],
        providerModels: [],
        providerTier: "PRIMARY",
        protocolAdaptationEnabled: true,
      },
      false,
    );
    expect(kept.surface).toBe("OPENAI_CHAT_COMPLETIONS");
    expect(kept.flags).toEqual(manual);
  });

  it("auto-sets from the combined primary set on a provider-first PRIMARY selection", () => {
    // Adaptation keeps the OPENAI_RESPONSES default selectable for the
    // chat-native provider, so only the first-PRIMARY-member branch can write.
    // Under the OLD locals-only first branch the ranking returned null (no
    // locals selected) and repair stayed silent (still selectable), leaving
    // OPENAI_RESPONSES with fresh flags — this test fails there.
    const decision = nextRecommendedSurface(
      "OPENAI_RESPONSES",
      { manuallyChosen: false, autoSetByMember: false },
      {
        localIds: [],
        localModels: [policySurfaceModel("chat", "openaiChatCompletions")],
        providerIds: [chatOnlyProvider.id],
        providerModels: [chatOnlyProvider],
        providerTier: "PRIMARY",
        protocolAdaptationEnabled: true,
      },
      true,
    );
    expect(decision).toEqual({
      surface: "OPENAI_CHAT_COMPLETIONS",
      flags: { manuallyChosen: false, autoSetByMember: true },
    });
  });

  it("never auto-sets from PUBLIC_OVERFLOW provider selections", () => {
    // Robustness pin: even a caller that mislabels a PUBLIC_OVERFLOW provider
    // toggle as a first-member selection must not trigger a write, because the
    // combined primary set excludes overflow-tier providers.
    const decision = nextRecommendedSurface(
      "OPENAI_RESPONSES",
      { manuallyChosen: false, autoSetByMember: false },
      {
        localIds: [],
        localModels: [policySurfaceModel("chat", "openaiChatCompletions")],
        providerIds: [chatOnlyProvider.id],
        providerModels: [chatOnlyProvider],
        providerTier: "PUBLIC_OVERFLOW",
        protocolAdaptationEnabled: true,
      },
      true,
    );
    expect(decision.surface).toBe("OPENAI_RESPONSES");
    expect(decision.flags).toEqual({ manuallyChosen: false, autoSetByMember: false });
  });

  it("writes nothing when the combined primary ranking is null and lets a later member fire the first branch", () => {
    const chat = policySurfaceModel("chat", "openaiChatCompletions");
    const responses = policySurfaceModel("responses", "openaiResponses");
    const noSurfacesProvider = { id: "opaque", nativeCapabilities: { version: 1 } };
    const fresh = { manuallyChosen: false, autoSetByMember: false };
    // The opaque provider shares no selectable surface with the chat local, so
    // the first-PRIMARY-member ranking is null: no write, flags untouched.
    const unwritten = nextRecommendedSurface(
      "OPENAI_RESPONSES",
      fresh,
      {
        localIds: [chat.id],
        localModels: [chat, responses],
        providerIds: [noSurfacesProvider.id],
        providerModels: [noSurfacesProvider],
        providerTier: "PRIMARY",
        protocolAdaptationEnabled: false,
      },
      true,
    );
    expect(unwritten.surface).toBe("OPENAI_RESPONSES");
    expect(unwritten.flags).toEqual(fresh);
    // A later legitimate empty → non-empty transition (repair here, since the
    // current surface is unselectable for the chat local) may still write.
    const later = nextRecommendedSurface(
      "OPENAI_RESPONSES",
      unwritten.flags,
      {
        localIds: [chat.id],
        localModels: [chat, responses],
        providerIds: [],
        providerModels: [],
        providerTier: "PRIMARY",
        protocolAdaptationEnabled: false,
      },
      true,
    );
    expect(later).toEqual({
      surface: "OPENAI_CHAT_COMPLETIONS",
      flags: { manuallyChosen: false, autoSetByMember: true },
    });
  });

  it("counts primary members across locals and PRIMARY-tier providers only", () => {
    expect(combinedPrimaryMemberCount([], [], "PRIMARY")).toBe(0);
    expect(combinedPrimaryMemberCount(["a"], ["p1", "p2"], "PRIMARY")).toBe(3);
    expect(combinedPrimaryMemberCount(["a"], ["p1", "p2"], "PUBLIC_OVERFLOW")).toBe(1);
  });

  it("uses the smallest selected physical context for inline validation", () => {
    expect(
      minimumSelectedPhysicalContext(
        ["a", "b"],
        [
          { id: "a", executionTarget: { inferenceCapacityId: "cap-a" } },
          { id: "b", executionTarget: { inferenceCapacityId: "cap-b" } },
        ],
        [
          { id: "cap-a", physicalMaxContext: 65_536 },
          { id: "cap-b", physicalMaxContext: 32_768 },
        ],
      ),
    ).toBe(32_768);
  });

  it("keeps inherited defaults and carries a configured margin into an explicit override", () => {
    expect(
      deriveMemberOverride(
        {
          memberConcurrencyLimit: 1,
          reservedSlots: 0,
          borrowPolicy: "WHEN_IDLE",
          localWaitBudgetMs: 30_000,
          memberContextCeiling: 31_744,
          contextMargin: 1_024,
        },
        8_192,
        4_096,
      ),
    ).toMatchObject({ contextCeilingMode: "INHERIT", contextMargin: 1_024 });
  });
});
