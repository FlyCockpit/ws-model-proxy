// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  tokens: [] as Array<Record<string, unknown>>,
  calls: [] as Array<{ name: string; input: Record<string, unknown> }>,
  failConsent: false,
  providerEgressEnabled: true,
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@ws-model-proxy/ui/components/sileo", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("@/utils/orpc", () => {
  const pools = ["one", "two"].map((id) => ({
    id,
    modelId: `owner/${id}`,
    name: id,
    effectiveProviderEgress: true,
    providerAccountLabels: ["Provider"],
  }));
  const query = (key: string, data: () => unknown) => ({
    queryOptions: () => ({ queryKey: [key], queryFn: async () => data(), initialData: data() }),
  });
  const mutation = (name: string) => ({
    mutationOptions: (options?: Record<string, unknown>) => ({
      ...options,
      mutationFn: async (input: Record<string, unknown>) => {
        state.calls.push({ name, input });
        if (name === "update" && state.failConsent) throw new Error("save failed");
        if (name === "create")
          return { token: { id: "new-token" }, secret: "test-one-time-secret" };
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
        list: query("tokens", () => state.tokens),
        preview: query("preview", () => ({
          providerEgressEnabled: state.providerEgressEnabled,
          directModels: [],
          modelPools: pools,
        })),
        create: mutation("create"),
        updateExternalAccess: mutation("update"),
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

import { toast } from "@ws-model-proxy/ui/components/sileo";
import { createAppMutationCache } from "@/utils/mutation-error-toast";
import { ModelApiTokensSection } from "./forwarder-dashboard-sections";

function mount() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({
          mutationCache: createAppMutationCache((key) => key),
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
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
  state.providerEgressEnabled = true;
  vi.clearAllMocks();
});

describe("human token external access", () => {
  it("starts empty and creates private-only by default", async () => {
    mount();
    expect(screen.getByText("dashboard:tokens.empty")).toBeTruthy();
    openCreate();
    expect(
      screen
        .getByRole("checkbox", { name: "dashboard:tokens.externalAccess.createAllow" })
        .getAttribute("aria-checked"),
    ).toBe("false");
    submit();
    await waitFor(() => expect(state.calls).toHaveLength(1));
    expect(state.calls[0]).toEqual({
      name: "create",
      input: { name: "Example", scopeMode: "ALL_VISIBLE", modelIds: [] },
    });
    fireEvent.click(await screen.findByRole("button", { name: "dashboard:actions.showSecret" }));
    expect(screen.getByText("test-one-time-secret")).toBeTruthy();
  });

  it("enables all-visible consent through the separate human-only operation", async () => {
    mount();
    openCreate();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "dashboard:tokens.externalAccess.createAllow" }),
    );
    submit();
    await waitFor(() => expect(state.calls).toHaveLength(2));
    expect(state.calls[1]).toEqual({
      name: "update",
      input: { id: "new-token", allowExternal: true },
    });
  });

  it("defaults allowlisted pools on and permits a per-pool opt-out", async () => {
    mount();
    openCreate();
    fireEvent.click(screen.getByRole("button", { name: "dashboard:tokens.allowlist" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /owner\/one/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /owner\/two/ }));
    fireEvent.click(
      screen.getByRole("checkbox", { name: "dashboard:tokens.externalAccess.createAllow" }),
    );
    expect(screen.getByRole("checkbox", { name: "one" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("checkbox", { name: "two" }));
    submit();
    await waitFor(() => expect(state.calls).toHaveLength(2));
    expect(state.calls[1]?.input).toEqual({
      id: "new-token",
      allowExternal: true,
      externalModelPoolIds: ["one"],
    });
  });

  it("retains the secret if saving consent fails and prevents duplicate creation", async () => {
    state.failConsent = true;
    mount();
    openCreate();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "dashboard:tokens.externalAccess.createAllow" }),
    );
    submit();
    expect(await screen.findByText("dashboard:tokens.externalAccess.createFailed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "dashboard:actions.showSecret" }));
    expect(screen.getByText("test-one-time-secret")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "dashboard:tokens.create" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(state.calls.filter((call) => call.name === "create")).toHaveLength(1);
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("preserves stored empty external choices when enabling an existing token", async () => {
    state.tokens = [
      {
        id: "existing",
        name: "Existing",
        allowExternal: false,
        scopeMode: "ALLOWLIST",
        allowlist: {
          directModelCount: 0,
          modelPoolCount: 2,
          modelPoolIds: ["one", "two"],
          externalModelPoolIds: [],
        },
        createdAt: new Date(0),
      },
    ];
    mount();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "dashboard:tokens.externalAccess.allow" }),
    );
    await waitFor(() => expect(state.calls).toHaveLength(1));
    expect(state.calls[0]?.input).toEqual({
      id: "existing",
      allowExternal: true,
    });
  });
});

it("edits per-pool consent without changing the remaining pools", async () => {
  state.tokens = [
    {
      id: "existing",
      name: "Existing",
      allowExternal: true,
      scopeMode: "ALLOWLIST",
      allowlist: {
        directModelCount: 0,
        modelPoolCount: 2,
        modelPoolIds: ["one", "two"],
        externalModelPoolIds: ["one", "two"],
      },
      createdAt: new Date(0),
    },
  ];
  mount();
  fireEvent.click(screen.getByRole("checkbox", { name: "one" }));
  await waitFor(() => expect(state.calls).toHaveLength(1));
  expect(state.calls[0]?.input).toEqual({
    id: "existing",
    allowExternal: true,
    externalModelPoolIds: ["two"],
  });
});

it("turns external access off without rewriting per-pool preferences", async () => {
  state.tokens = [
    {
      id: "existing",
      name: "Existing",
      allowExternal: true,
      scopeMode: "ALLOWLIST",
      allowlist: {
        directModelCount: 0,
        modelPoolCount: 1,
        modelPoolIds: ["one"],
        externalModelPoolIds: ["one"],
      },
      createdAt: new Date(0),
    },
  ];
  mount();
  fireEvent.click(screen.getByRole("checkbox", { name: "dashboard:tokens.externalAccess.allow" }));
  await waitFor(() => expect(state.calls).toHaveLength(1));
  expect(state.calls[0]?.input).toEqual({ id: "existing", allowExternal: false });
});

it("does not expose edits for revoked tokens", () => {
  state.tokens = [
    {
      id: "revoked",
      name: "Revoked",
      revokedAt: new Date(0),
      scopeMode: "ALL_VISIBLE",
      createdAt: new Date(0),
    },
  ];
  mount();
  expect(
    screen.queryByRole("checkbox", { name: "dashboard:tokens.externalAccess.allow" }),
  ).toBeNull();
});

function existingToken() {
  return {
    id: "existing",
    name: "Existing",
    allowExternal: true,
    scopeMode: "ALLOWLIST",
    createdAt: new Date(0),
    allowlist: {
      directModelCount: 0,
      modelPoolCount: 2,
      modelPoolIds: ["one", "two"],
      externalModelPoolIds: ["one", "two"],
    },
  };
}

it("restores per-pool opt-outs across disable, re-enable and reopening", async () => {
  state.tokens = [existingToken()];
  const view = mount();
  fireEvent.click(screen.getByRole("checkbox", { name: "two" }));
  await waitFor(() =>
    expect(screen.getByRole("checkbox", { name: "two" }).getAttribute("aria-checked")).toBe(
      "false",
    ),
  );
  fireEvent.click(screen.getByRole("checkbox", { name: "dashboard:tokens.externalAccess.allow" }));
  await waitFor(() => expect(screen.queryByRole("checkbox", { name: "two" })).toBeNull());
  view.unmount();
  mount();
  fireEvent.click(screen.getByRole("checkbox", { name: "dashboard:tokens.externalAccess.allow" }));
  await waitFor(() =>
    expect(screen.getByRole("checkbox", { name: "two" }).getAttribute("aria-checked")).toBe(
      "false",
    ),
  );
  expect(screen.getByRole("checkbox", { name: "one" }).getAttribute("aria-checked")).toBe("true");
  expect(state.calls.map((call) => call.input)).toEqual([
    { id: "existing", allowExternal: true, externalModelPoolIds: ["one"] },
    { id: "existing", allowExternal: false },
    { id: "existing", allowExternal: true },
  ]);
});

it("blocks granting external consent when providers are off but allows withdrawal", async () => {
  state.providerEgressEnabled = false;
  state.tokens = [existingToken()];
  mount();
  expect(
    screen.getAllByText("dashboard:tokens.externalAccess.disabledDeployment").length,
  ).toBeGreaterThan(0);

  const master = screen.getByRole("checkbox", { name: "dashboard:tokens.externalAccess.allow" });
  expect(master.getAttribute("aria-disabled")).not.toBe("true");
  fireEvent.click(master);
  await waitFor(() =>
    expect(state.calls.map((call) => call.input)).toContainEqual({
      id: "existing",
      allowExternal: false,
    }),
  );

  cleanup();
  state.calls = [];
  state.tokens = [
    {
      ...existingToken(),
      allowExternal: false,
      allowlist: {
        ...existingToken().allowlist,
        externalModelPoolIds: [],
      },
    },
  ];
  mount();
  const blockedMaster = screen.getByRole("checkbox", {
    name: "dashboard:tokens.externalAccess.allow",
  });
  expect(
    blockedMaster.getAttribute("aria-disabled") === "true" ||
      blockedMaster.hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.click(blockedMaster);
  expect(state.calls).toEqual([]);

  cleanup();
  state.tokens = [existingToken()];
  mount();
  const poolTwo = screen.getByRole("checkbox", { name: "two" });
  expect(poolTwo.getAttribute("aria-disabled")).not.toBe("true");
  fireEvent.click(poolTwo);
  await waitFor(() =>
    expect(state.calls.map((call) => call.input)).toContainEqual({
      id: "existing",
      allowExternal: true,
      externalModelPoolIds: ["one"],
    }),
  );

  cleanup();
  state.calls = [];
  state.tokens = [
    {
      ...existingToken(),
      allowlist: {
        ...existingToken().allowlist,
        externalModelPoolIds: ["one"],
      },
    },
  ];
  mount();
  const blockedPool = screen.getByRole("checkbox", { name: "two" });
  expect(
    blockedPool.getAttribute("aria-disabled") === "true" || blockedPool.hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.click(blockedPool);
  expect(state.calls).toEqual([]);

  openCreate();
  const consent = screen.getByRole("checkbox", {
    name: "dashboard:tokens.externalAccess.createAllow",
  });
  expect(consent.getAttribute("aria-disabled") === "true" || consent.hasAttribute("disabled")).toBe(
    true,
  );
  fireEvent.click(consent);
  submit();
  await waitFor(() => expect(state.calls).toHaveLength(1));
  expect(state.calls[0]?.name).toBe("create");
});
