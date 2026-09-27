// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  enabled: true,
  pools: [] as Array<Record<string, unknown>>,
  sets: [] as Array<Record<string, unknown>>,
  clears: [] as Array<Record<string, unknown>>,
  imports: [] as Array<Record<string, unknown>>,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en-US" } }),
}));
vi.mock("@/components/provider-operations-section", () => ({
  ProviderOperationsSection: () => <div>provider-key-management</div>,
}));
vi.mock("@/components/provider-catalog-picker", () => ({
  ProviderCatalogPicker: ({ initialQuery }: { initialQuery: string }) => <div>{initialQuery}</div>,
}));
vi.mock("@/utils/orpc", () => {
  const mutation = (name: "sets" | "clears" | "imports", result = {}) => ({
    mutationOptions: (options = {}) => ({
      ...options,
      mutationFn: async (input: Record<string, unknown>) => {
        state[name].push(input);
        return result;
      },
    }),
  });
  const query = (key: string, data: () => unknown) => ({
    queryOptions: (options = {}) => ({ ...options, queryKey: [key], queryFn: async () => data() }),
  });
  return {
    orpc: {
      poolFallbackPreferences: {
        key: () => ["preferences"],
        list: query("preferences", () => ({ enabled: state.enabled, pools: state.pools })),
        set: mutation("sets"),
        clear: mutation("clears"),
        ownerAggregate: query("aggregate", () => ({ count: 3 })),
      },
      providerManagement: {
        key: () => ["accounts"],
        listAccounts: query("accounts", () => [
          { id: "account", label: "My key", providerType: "openrouter", enabled: true },
        ]),
        listModels: query("models", () => [
          { id: "existing", upstreamModelId: "Existing model", enabled: true },
        ]),
        updateModel: mutation("sets"),
      },
      providerCatalog: {
        importModel: mutation("imports", { model: { id: "imported", enabled: true } }),
      },
    },
  };
});
const { ProvidersPage, OwnKeyPools } = await import("./providers-page");
function mount(node: React.ReactNode) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      {node}
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  state.enabled = true;
  state.pools = [];
  state.sets = [];
  state.clears = [];
  state.imports = [];
});
afterEach(cleanup);
function pool() {
  return {
    id: "pool",
    name: "Shared pool",
    modelId: "owner/pool",
    externalEquivalentModel: "vendor/default",
    providerModelId: null,
    upstreamModelId: null,
    ready: false,
    tokenAllowed: false,
    protocolAdaptationEnabled: false,
  };
}
it("shows provider management by default and the Pools tab", () => {
  mount(<ProvidersPage />);
  expect(screen.getByText("provider-key-management")).toBeTruthy();
  expect(screen.getByRole("tab", { name: "byok.pools" })).toBeTruthy();
});
it("shows the empty shared-pools state", async () => {
  mount(<OwnKeyPools />);
  expect(await screen.findByText("byok.empty")).toBeTruthy();
});
it("preselects owner model, imports to own account and saves preference", async () => {
  state.pools = [pool()];
  mount(<OwnKeyPools />);
  expect(await screen.findByText("byok.tokenMissing")).toBeTruthy();
  fireEvent.change(await screen.findByLabelText("byok.account"), { target: { value: "account" } });
  expect(await screen.findByText("vendor/default")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "byok.importUse" }));
  await waitFor(() =>
    expect(state.sets).toEqual([
      { poolId: "pool", providerModelId: "imported", protocolAdaptationEnabled: false },
    ]),
  );
  expect(state.imports).toEqual([
    { providerAccountId: "account", modelId: "vendor/default", enabled: true },
  ]);
});
it("switch off preserves clear while suppressing selection/import", async () => {
  state.enabled = false;
  state.pools = [{ ...pool(), providerModelId: "own-model" }];
  mount(<OwnKeyPools />);
  expect(await screen.findByText("byok.disabled")).toBeTruthy();
  expect(screen.queryByLabelText("byok.account")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "byok.clear" }));
  await waitFor(() => expect(state.clears).toEqual([{ poolId: "pool" }]));
});
it("owner withdrawal shows unavailable and still allows clearing", async () => {
  state.pools = [{ ...pool(), externalEquivalentModel: null, providerModelId: "own-model" }];
  mount(<OwnKeyPools />);
  expect(await screen.findByText("byok.ownerMissing")).toBeTruthy();
  expect(screen.queryByLabelText("byok.account")).toBeNull();
  expect(screen.getByRole("button", { name: "byok.clear" })).toBeTruthy();
});
