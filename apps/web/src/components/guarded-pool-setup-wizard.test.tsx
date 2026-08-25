import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

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
        queryOptions: () => ({ queryKey: ["providers"], queryFn: async () => [] }),
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
    open ? <>{children}</> : null,
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
} from "../lib/guarded-pool-wizard-validation";
import { focusFirstInvalidWizardField, GuardedPoolSetupWizard } from "./guarded-pool-setup-wizard";

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

  it("renders the egress acknowledgement only after provider selection", () => {
    expect(renderStep(2)).not.toContain("dashboard:pools.wizard.egressWarning");
    const withProvider = renderStep(2, ["provider"]);
    expect(withProvider).toContain("dashboard:pools.wizard.egressWarning");
    expect(withProvider).toContain("dashboard:pools.wizard.fields.publicEgressAcknowledged");
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
});
