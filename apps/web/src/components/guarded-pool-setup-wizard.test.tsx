import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const queryData = vi.hoisted(() => ({ providers: [] as Array<Record<string, unknown>> }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: { current?: number }) =>
      values?.current ? `${key}:${values.current}` : key,
  }),
}));
vi.mock("@/utils/orpc", () => ({
  orpc: {
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
  minimumSelectedPhysicalContext,
  primarySurfaceIsSelectable,
  providerOrderAfterMove,
  providerOrderAfterToggle,
  recommendedPrimarySurface,
  safeContextControls,
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

function renderStep(initialStep: 0 | 1 | 2 | 3, initialProviderModelIds: string[] = []) {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <GuardedPoolSetupWizard
        open
        onOpenChange={() => undefined}
        directModels={[localModel]}
        initialStep={initialStep}
        initialProviderModelIds={initialProviderModelIds}
      />
    </QueryClientProvider>,
  );
}

describe("GuardedPoolSetupWizard", () => {
  it("renders each of the four navigable steps", () => {
    for (const step of [0, 1, 2, 3] as const)
      expect(renderStep(step)).toContain(`dashboard:pools.wizard.step:${step + 1}`);
    expect(renderStep(0)).toContain("dashboard:pools.wizard.localModels");
    expect(renderStep(1)).toContain("dashboard:pools.wizard.capacityDistinctHint");
    expect(renderStep(2)).toContain("dashboard:pools.wizard.providerOrder");
    expect(renderStep(3)).toContain("dashboard:pools.wizard.atomicRollback");
  });

  it("renders optional advanced capacity, member, affinity, adaptation, and budget controls", () => {
    const capacity = renderStep(1);
    expect(capacity).toContain("dashboard:pools.wizard.advanced.title");
    expect(capacity).toContain("dashboard:pools.wizard.fields.physicalCountStrategy");
    expect(capacity).toContain("dashboard:pools.wizard.fields.protocolAdaptationEnabled");
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

  it("derives safe member defaults only when customization is enabled by the caller", () => {
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
      contextCeilingMode: "LIMITED",
      contextCeiling: 30_000,
      contextMargin: 2_000,
    });
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
    const value = deriveMemberOverride({
      memberConcurrencyLimit: 1,
      reservedSlots: 0,
      borrowPolicy: "WHEN_IDLE",
      localWaitBudgetMs: 30_000,
      memberContextCeiling: 32_000,
      contextMargin: 1_000,
    });
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

  it("derives a positive global ceiling and heterogeneous per-member defaults", () => {
    expect(safeContextControls(8_192)).toEqual({
      contextCeiling: 7_168,
      contextMargin: 1_024,
    });
    expect(safeContextControls(512)).toEqual({ contextCeiling: 1, contextMargin: 511 });
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
      ),
    ).toMatchObject({ contextCeiling: 7_168, contextMargin: 1_024 });
  });
});
