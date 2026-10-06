// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  tokens: [] as Array<Record<string, unknown>>,
  calls: [] as Array<{ name: string; input: Record<string, unknown> }>,
  failConsent: false,
  failCreate: false,
  providerEgressEnabled: true,
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@ws-model-proxy/ui/components/sileo", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("@/utils/orpc", () => {
  const pools = [
    ...["one", "two"].map((id) => ({
      id,
      modelId: `owner/${id}`,
      name: id,
      effectiveProviderEgress: true,
      providerAccountLabels: ["Provider"],
      externalRoutes: ["pool-fallback"],
    })),
    // Local-only: no cloud providers, so no `:external` model to offer.
    {
      id: "local",
      modelId: "owner/local",
      name: "local",
      effectiveProviderEgress: false,
      providerAccountLabels: [],
      externalRoutes: [],
    },
  ];
  const query = (key: string, data: () => unknown) => ({
    queryOptions: () => ({ queryKey: [key], queryFn: async () => data(), initialData: data() }),
  });
  const mutation = (name: string) => ({
    mutationOptions: (options?: Record<string, unknown>) => ({
      ...options,
      mutationFn: async (input: Record<string, unknown>) => {
        state.calls.push({ name, input });
        if (name === "update" && state.failConsent) throw new Error("save failed");
        if (name === "create" && state.failCreate) throw new Error("create failed");
        if (name === "create")
          return { token: { id: "new-token" }, secret: "test-one-time-secret" };
        if (name === "updateWait")
          state.tokens = state.tokens.map((token) =>
            token.id === input.id
              ? { ...token, externalAfterWaitMs: input.externalAfterWaitMs }
              : token,
          );
        if (name === "update")
          state.tokens = state.tokens.map((token) =>
            token.id === input.id
              ? {
                  ...token,
                  allowExternal: input.allowExternal,
                  ...(input.externalModelPoolIds
                    ? {
                        allowlist: {
                          ...(token.allowlist as Record<string, unknown>),
                          externalModelPoolIds: input.externalModelPoolIds,
                        },
                      }
                    : {}),
                }
              : token,
          );
        return {};
      },
    }),
  });
  return {
    orpc: {
      modelApiTokens: {
        key: () => ["tokens"],
        // Like the server: revoked tokens only with includeRevoked.
        list: {
          queryOptions: (options?: { input?: { includeRevoked?: boolean } }) => {
            const rows = () =>
              options?.input?.includeRevoked
                ? state.tokens
                : state.tokens.filter((row) => !row.revokedAt);
            return {
              queryKey: ["tokens", options?.input?.includeRevoked === true],
              queryFn: async () => rows(),
              initialData: rows(),
            };
          },
        },
        preview: query("preview", () => ({
          providerEgressEnabled: state.providerEgressEnabled,
          directModels: [],
          modelPools: pools,
        })),
        create: mutation("create"),
        updateExternalAccess: mutation("update"),
        updateExternalWait: mutation("updateWait"),
        revoke: mutation("revoke"),
      },
      forwarderManagement: {
        visibleModels: query("visible", () => ({
          providerEgressEnabled: state.providerEgressEnabled,
          directModels: [],
          modelPools: pools,
        })),
      },
    },
  };
});

import { createAppMutationCache } from "@/utils/mutation-error-toast";
import { ModelApiTokensSection } from "./forwarder-dashboard-sections";

let queryClient: QueryClient;
function mount() {
  queryClient = new QueryClient({
    mutationCache: createAppMutationCache((key) => key),
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ModelApiTokensSection />
    </QueryClientProvider>,
  );
}
function openCreate() {
  fireEvent.click(screen.getByRole("button", { name: "dashboard:tokens.createModelApi" }));
  fireEvent.change(screen.getByLabelText("dashboard:tokens.name"), {
    target: { value: "Example" },
  });
}
function submit() {
  fireEvent.click(screen.getByRole("button", { name: "dashboard:tokens.create" }));
}
afterEach(() => {
  cleanup();
  state.tokens = [];
  state.calls = [];
  state.failConsent = false;
  state.failCreate = false;
  state.providerEgressEnabled = true;
  vi.clearAllMocks();
});

function token(overrides: Record<string, unknown> = {}) {
  return {
    id: "existing",
    name: "Existing",
    lookupPrefix: "wmp_abc",
    allowExternal: false,
    scopeMode: "ALLOWLIST",
    externalAfterWaitMs: null,
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
    createdAt: new Date(0),
    allowlist: {
      directModelCount: 0,
      modelPoolCount: 2,
      modelPoolIds: ["one", "two"],
      externalModelPoolIds: [],
    },
    ...overrides,
  };
}
function openCloud() {
  fireEvent.click(screen.getByRole("button", { name: /dashboard:tokens\.cloudAccess\.button/ }));
  return screen.getByRole("dialog");
}
function cloudSwitch() {
  return screen.getByRole("switch", { name: "dashboard:tokens.cloudAccess.allow" });
}
function save() {
  fireEvent.click(screen.getByRole("button", { name: "dashboard:tokens.cloudAccess.save" }));
}
const updates = () => state.calls.filter((call) => call.name === "update");

describe("creating model API tokens", () => {
  it("creates local-only tokens and keeps the one-time secret until it is acknowledged", async () => {
    mount();
    expect(screen.getByText("dashboard:tokens.empty")).toBeTruthy();
    openCreate();
    expect(screen.queryByRole("switch", { name: "dashboard:tokens.cloudAccess.allow" })).toBeNull();
    submit();
    await waitFor(() => expect(state.calls).toHaveLength(1));
    expect(state.calls[0]).toEqual({
      name: "create",
      input: { name: "Example", scopeMode: "ALL_VISIBLE", modelIds: [] },
    });
    fireEvent.click(await screen.findByRole("button", { name: "dashboard:actions.showSecret" }));
    expect(screen.getByText("test-one-time-secret")).toBeTruthy();
    expect(screen.getByText("dashboard:tokens.cloudAfterCreate")).toBeTruthy();
    // No close control, and Done waits for the acknowledgement.
    const done = screen.getByRole("button", { name: "dashboard:tokens.done" });
    expect(done.hasAttribute("disabled")).toBe(true);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.getByText("test-one-time-secret")).toBeTruthy();
    fireEvent.click(screen.getByRole("switch", { name: "dashboard:tokens.secretSaved" }));
    fireEvent.click(done);
    await waitFor(() => expect(screen.queryByText("test-one-time-secret")).toBeNull());
    expect(updates()).toHaveLength(0);
    expect(state.calls.filter((call) => call.name === "create")).toHaveLength(1);
  });

  it("sends an expiry preset as an absolute time", async () => {
    mount();
    openCreate();
    fireEvent.click(screen.getByRole("button", { name: "dashboard:tokens.expiry.days30" }));
    const before = Date.now();
    submit();
    await waitFor(() => expect(state.calls).toHaveLength(1));
    const expiresAt = state.calls[0]?.input.expiresAt as Date;
    expect(expiresAt.getTime() - before).toBeGreaterThanOrEqual(30 * 86_400_000 - 1000);
    expect(expiresAt.getTime() - before).toBeLessThanOrEqual(30 * 86_400_000 + 1000);
  });

  it("lets the dialog close again after a failed create", async () => {
    state.failCreate = true;
    mount();
    openCreate();
    submit();
    await waitFor(() => expect(state.calls).toHaveLength(1));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "dashboard:tokens.create" }).hasAttribute("disabled"),
      ).toBe(false),
    );
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

describe("cloud access dialog", () => {
  it("saves an all-visible token's consent in one call", async () => {
    state.tokens = [token({ scopeMode: "ALL_VISIBLE" })];
    mount();
    openCloud();
    expect(screen.queryByText("dashboard:tokens.cloudAccess.warning")).toBeNull();
    fireEvent.click(cloudSwitch());
    expect(screen.getByText("dashboard:tokens.cloudAccess.warning")).toBeTruthy();
    expect(screen.getByText("dashboard:tokens.cloudAccess.allVisible")).toBeTruthy();
    expect(screen.getByText("owner/one:external")).toBeTruthy();
    save();
    await waitFor(() => expect(updates()).toHaveLength(1));
    expect(updates()[0]?.input).toEqual({ id: "existing", allowExternal: true });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("enables an allowlist token without rewriting its stored empty pool choices", async () => {
    state.tokens = [token()];
    mount();
    openCloud();
    fireEvent.click(cloudSwitch());
    expect(screen.getByRole("checkbox", { name: "one" }).getAttribute("aria-checked")).toBe(
      "false",
    );
    save();
    await waitFor(() => expect(updates()).toHaveLength(1));
    expect(updates()[0]?.input).toEqual({ id: "existing", allowExternal: true });
  });

  it("edits per-pool choices as a draft and saves them once", async () => {
    state.tokens = [
      token({
        allowExternal: true,
        allowlist: { ...token().allowlist, externalModelPoolIds: ["one", "two"] },
      }),
    ];
    mount();
    expect(screen.getByText("dashboard:tokens.cloudAccess.onPools")).toBeTruthy();
    openCloud();
    fireEvent.click(screen.getByRole("checkbox", { name: "two" }));
    expect(updates()).toHaveLength(0);
    save();
    await waitFor(() => expect(updates()).toHaveLength(1));
    expect(updates()[0]?.input).toEqual({
      id: "existing",
      allowExternal: true,
      externalModelPoolIds: ["one"],
    });
  });

  it("does not offer a pool without cloud providers", () => {
    state.tokens = [
      token({
        allowExternal: true,
        allowlist: { ...token().allowlist, modelPoolIds: ["one", "local"], modelPoolCount: 2 },
      }),
    ];
    mount();
    openCloud();
    expect(screen.getByRole("checkbox", { name: "one" }).hasAttribute("data-disabled")).toBe(false);
    expect(screen.getByRole("checkbox", { name: /^local/ }).hasAttribute("data-disabled")).toBe(
      true,
    );
    expect(screen.getByText("dashboard:tokens.cloudAccess.noProviders")).toBeTruthy();
  });

  it("says so when no pool on an allowlist token has cloud providers", () => {
    state.tokens = [
      token({
        allowExternal: true,
        allowlist: { ...token().allowlist, modelPoolIds: ["local"], modelPoolCount: 1 },
      }),
    ];
    mount();
    openCloud();
    expect(screen.getByText("dashboard:tokens.cloudAccess.noPools")).toBeTruthy();
  });

  it("turns cloud access off without rewriting per-pool choices or the wait", async () => {
    state.tokens = [
      token({
        allowExternal: true,
        externalAfterWaitMs: 2000,
        allowlist: { ...token().allowlist, externalModelPoolIds: ["one"] },
      }),
    ];
    mount();
    openCloud();
    fireEvent.click(cloudSwitch());
    save();
    await waitFor(() => expect(updates()).toHaveLength(1));
    expect(updates()[0]?.input).toEqual({ id: "existing", allowExternal: false });
  });

  it("saves the wait with the consent, clears it to the pool default, and validates it only when on", async () => {
    state.tokens = [
      token({ scopeMode: "ALL_VISIBLE", allowExternal: true, externalAfterWaitMs: 2000 }),
    ];
    mount();
    openCloud();
    const wait = screen.getByLabelText("dashboard:tokens.externalWait.label");
    fireEvent.change(wait, { target: { value: "not a number" } });
    save();
    expect(await screen.findByText("dashboard:tokens.externalWait.invalid")).toBeTruthy();
    expect(updates()).toHaveLength(0);
    fireEvent.change(wait, { target: { value: "" } });
    save();
    await waitFor(() => expect(updates()).toHaveLength(1));
    expect(updates()[0]?.input).toEqual({
      id: "existing",
      allowExternal: true,
      externalAfterWaitMs: null,
    });
  });

  it("does not validate a hidden invalid wait when access is turned off", async () => {
    state.tokens = [token({ scopeMode: "ALL_VISIBLE", allowExternal: true })];
    mount();
    openCloud();
    fireEvent.change(screen.getByLabelText("dashboard:tokens.externalWait.label"), {
      target: { value: "-5" },
    });
    fireEvent.click(cloudSwitch());
    save();
    await waitFor(() => expect(updates()).toHaveLength(1));
    expect(updates()[0]?.input).toEqual({ id: "existing", allowExternal: false });
  });

  it("blocks granting cloud access when providers are off but allows withdrawing it", async () => {
    state.providerEgressEnabled = false;
    state.tokens = [
      token({ id: "off" }),
      token({
        id: "on",
        name: "On",
        allowExternal: true,
        allowlist: { ...token().allowlist, externalModelPoolIds: ["one"] },
      }),
    ];
    mount();
    const buttons = screen.getAllByRole("button", {
      name: /dashboard:tokens\.cloudAccess\.button/,
    });
    fireEvent.click(buttons[0]!);
    expect(screen.getByText("dashboard:tokens.cloudAccess.disabledDeployment")).toBeTruthy();
    expect(cloudSwitch().hasAttribute("data-disabled")).toBe(true);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(buttons[1]!);
    // A saved pool may be removed; a pool not yet included cannot be added.
    expect(screen.getByRole("checkbox", { name: "one" }).hasAttribute("data-disabled")).toBe(false);
    expect(screen.getByRole("checkbox", { name: "two" }).hasAttribute("data-disabled")).toBe(true);
    fireEvent.click(cloudSwitch());
    save();
    await waitFor(() => expect(updates()).toHaveLength(1));
    expect(updates()[0]?.input).toEqual({ id: "on", allowExternal: false });
  });
});

describe("token list", () => {
  it("loads revoked tokens only behind a switch and offers them no cloud access", async () => {
    state.tokens = [
      token({ id: "live", name: "Live" }),
      token({ id: "gone", name: "Gone", revokedAt: new Date(0) }),
    ];
    mount();
    expect(screen.queryByText("Gone")).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "dashboard:tokens.showRevoked" }));
    expect(await screen.findByText("Gone")).toBeTruthy();
    // The live token is listed once, not again from the revoked query.
    expect(screen.getAllByText("Live")).toHaveLength(1);
    expect(
      screen.getAllByRole("button", { name: /dashboard:tokens\.cloudAccess\.button/ }),
    ).toHaveLength(1);
  });

  it("shows when each token expires", () => {
    state.tokens = [
      token({ id: "never", name: "Never" }),
      token({ id: "past", name: "Past", expiresAt: new Date(Date.now() - 1000) }),
    ];
    mount();
    expect(screen.getByText("dashboard:tokens.neverExpires")).toBeTruthy();
    expect(screen.getByText("dashboard:tokens.expired")).toBeTruthy();
  });
});

it("centres each stacked preview badge in a non-wrapping 44px row so hit areas do not overlap", async () => {
  mount();
  openCreate();
  const badges = await screen.findAllByRole("button", {
    name: "dashboard:pools.fallbackBadge.label",
  });
  expect(badges.length).toBeGreaterThanOrEqual(2);
  for (const badge of badges) {
    const row = badge.parentElement?.className.split(/\s+/) ?? [];
    expect(row).toEqual(expect.arrayContaining(["min-h-11", "items-center"]));
    expect(row).not.toContain("flex-wrap");
  }
});
