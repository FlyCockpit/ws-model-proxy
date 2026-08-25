// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  models: [] as Array<Record<string, unknown>>,
  mutations: [] as Array<{ operation: string; input: unknown }>,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en-US" },
  }),
}));
vi.mock("@ws-model-proxy/ui/components/sileo", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("@/utils/orpc", () => {
  const account = {
    id: "account",
    label: "Provider",
    providerType: "openai",
    providerVersion: null,
    baseUrl: "https://provider.example/v1",
    endpointIdentity: "https://provider.example/v1",
    endpointVersion: 1,
    authType: "BEARER",
    status: "ACTIVE",
    enabled: true,
    safeConfiguration: null,
    healthStatus: "HEALTHY",
    healthCheckedAt: null,
    currentCredentialId: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  const queryValue = (operation: string) => {
    if (operation === "listAccounts") return [account];
    if (operation === "listModels") return state.models;
    if (operation === "listUsageReportPage" || operation === "listProviderAttempts")
      return { items: [], nextCursor: null };
    if (operation === "getUsageTotals") return { totals: [], excludedRowCount: 0 };
    if (operation === "listBudgetActivity") return { caveats: [] };
    return [];
  };
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_target, property) => {
        const name = String(property);
        if (name === "queryOptions")
          return (options?: unknown) => ({
            queryKey: [...path, options],
            queryFn: async () => queryValue(path.at(-1) ?? ""),
          });
        if (name === "mutationOptions")
          return (options?: { onSuccess?: (result: unknown) => void }) => ({
            mutationFn: async (input: unknown) => {
              const operation = path.at(-1) ?? "";
              state.mutations.push({ operation, input });
              const result = operation === "createAccount" ? account : { id: "model" };
              options?.onSuccess?.(result);
              return result;
            },
          });
        if (name === "key") return () => path;
        return node([...path, name]);
      },
    });
  return { orpc: node([]) };
});

import { ProviderOperationsSection } from "./provider-operations-section";

function Providers({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {children}
    </QueryClientProvider>
  );
}

const inventory = {
  version: 4,
  protocol: "openai-compatible",
  surfaces: {
    openaiChatCompletions: {
      source: "dashboard",
      confidence: "exact",
      operations: ["create"],
      tools: true,
      parallelTools: true,
    },
    openaiResponses: {
      source: "dashboard",
      confidence: "exact",
      operations: ["create", "retrieve", "countTokens"],
      structuredOutput: true,
      reasoning: true,
      hostedTools: true,
      maxContextTokens: 128000,
    },
  },
};

describe("ProviderOperationsSection capability inventory interactions", () => {
  beforeEach(() => {
    state.models = [];
    state.mutations = [];
  });

  it("validates and submits the create-model inventory through TanStack Form", async () => {
    render(<ProviderOperationsSection />, { wrapper: Providers });
    await screen.findByText("dashboard:providers.models");
    fireEvent.change(screen.getByLabelText("dashboard:providers.fields.upstreamModel"), {
      target: { value: "upstream-model" },
    });
    const editor = screen.getByLabelText("dashboard:providers.fields.capabilityInventory");
    fireEvent.change(editor, { target: { value: "{" } });
    fireEvent.click(screen.getByRole("button", { name: /dashboard:providers.actions.addModel/u }));
    await waitFor(() => expect(editor.getAttribute("aria-invalid")).toBe("true"));
    expect(state.mutations.some(({ operation }) => operation === "createModel")).toBe(false);

    fireEvent.change(editor, { target: { value: JSON.stringify(inventory) } });
    fireEvent.click(screen.getByRole("button", { name: /dashboard:providers.actions.addModel/u }));
    await waitFor(() =>
      expect(
        state.mutations.find(({ operation }) => operation === "createModel")?.input,
      ).toMatchObject({
        providerAccountId: "account",
        upstreamModelId: "upstream-model",
        nativeCapabilities: inventory,
      }),
    );
  });

  it("loads, updates, and clears the owner inventory through the mounted edit form", async () => {
    state.models = [
      {
        id: "model",
        providerAccountId: "account",
        upstreamModelId: "upstream-model",
        displayName: null,
        nativeCapabilities: inventory,
        contextWindow: null,
        maxOutputTokens: null,
        concurrencyLimit: null,
        pricingVersion: null,
        healthStatus: "HEALTHY",
        enabled: false,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
    ];
    render(<ProviderOperationsSection />, { wrapper: Providers });
    await screen.findAllByText("upstream-model");
    const editors = screen.getAllByLabelText("dashboard:providers.fields.capabilityInventory");
    const editor = editors.at(-1);
    if (!editor) throw new Error("edit inventory field not rendered");
    expect((editor as HTMLTextAreaElement).value).toBe(JSON.stringify(inventory, null, 2));

    fireEvent.change(editor, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "dashboard:providers.actions.saveModel" }));
    await waitFor(() =>
      expect(state.mutations.find(({ operation }) => operation === "updateModel")?.input).toEqual({
        id: "model",
        displayName: null,
        contextWindow: null,
        maxOutputTokens: null,
        concurrencyLimit: null,
        nativeCapabilities: null,
      }),
    );
  });
});
