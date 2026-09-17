// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  listResult: [] as unknown[],
  listError: null as Error | null,
  listPending: true,
  listCalls: 0,
  revokeCalls: [] as unknown[],
  revokeError: null as Error | null,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (options?.client !== undefined) return `${key}:${String(options.client)}`;
      if (options?.count !== undefined) return `${key}:${String(options.count)}`;
      return key;
    },
  }),
}));

vi.mock("@ws-model-proxy/ui/components/sileo", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/utils/orpc", () => {
  const listQueryKey = ["mcpGrants", "listMine"];
  return {
    orpc: {
      mcpGrants: {
        listMine: {
          queryKey: () => listQueryKey,
          queryOptions: () => ({
            queryKey: listQueryKey,
            queryFn: async () => {
              state.listCalls += 1;
              // Stay pending until the test releases the fixture.
              while (state.listPending) {
                await new Promise<never>(() => {});
              }
              if (state.listError) throw state.listError;
              return state.listResult;
            },
          }),
        },
        revokeMine: {
          mutationOptions: (options?: Record<string, unknown>) => ({
            mutationFn: async (input: unknown) => {
              state.revokeCalls.push(input);
              if (state.revokeError) throw state.revokeError;
              return { revoked: true };
            },
            ...options,
          }),
        },
      },
    },
  };
});

import { toast } from "@ws-model-proxy/ui/components/sileo";
import { McpGrantsPanel } from "./mcp-grants-panel";

const connection = {
  clientRecordId: "record-a",
  clientId: "client-a",
  name: "Relay Agent",
  uri: "https://relay.example.com",
  scopes: ["mcp:read", "mcp:write"],
  firstAuthorizedAt: new Date("2026-05-01T00:00:00.000Z"),
  lastAuthorizedAt: new Date("2026-06-01T00:00:00.000Z"),
  rollingExpiryAt: new Date("2026-06-04T00:00:00.000Z"),
  activeRefreshCount: 2,
  dpop: "some" as const,
};

function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
  const rendered = render(
    <QueryClientProvider client={queryClient}>
      <McpGrantsPanel />
    </QueryClientProvider>,
  );
  return { queryClient, invalidateSpy, ...rendered };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  state.listResult = [];
  state.listError = null;
  state.listPending = true;
  state.listCalls = 0;
  state.revokeCalls = [];
  state.revokeError = null;
});

describe("McpGrantsPanel", () => {
  it("renders layout-matching skeletons while the grant list is pending", () => {
    state.listPending = true;
    const { container } = renderPanel();
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    expect(screen.queryByText("settings:mcp.empty")).not.toBeTruthy();
    // No revoke affordance exists before data resolves.
    expect(screen.queryByRole("button", { name: "settings:mcp.revoke" })).not.toBeTruthy();
  });

  it("renders a safe empty state when no connections exist", async () => {
    state.listPending = false;
    state.listResult = [];
    renderPanel();
    expect(await screen.findByText("settings:mcp.empty")).toBeTruthy();
    expect(screen.getByText("settings:mcp.title")).toBeTruthy();
  });

  it("renders one card per client with the safe projection fields", async () => {
    state.listPending = false;
    state.listResult = [
      connection,
      { ...connection, clientRecordId: "record-b", clientId: "client-b", name: null, uri: null },
    ];
    renderPanel();

    expect(await screen.findByText("Relay Agent")).toBeTruthy();
    expect(screen.getByText("client-a")).toBeTruthy();
    expect(screen.getByText("https://relay.example.com")).toBeTruthy();
    const card = screen.getByText("Relay Agent").closest('[data-slot="card"]');
    expect(card).not.toBeNull();
    const cardScopeNames = within(card as HTMLElement).getAllByText(/mcp:(read|write)/);
    expect(cardScopeNames).toHaveLength(2);
    expect(within(card as HTMLElement).getByText(/activeRefreshCount:2/)).toBeTruthy();
    expect(within(card as HTMLElement).getByText("settings:mcp.dpop.some")).toBeTruthy();
    // Fallback title when the client has no display name (title + code).
    expect(screen.getAllByText("client-b")).toHaveLength(2);
  });

  it("never renders remote client icons (no <img> elements on the page)", async () => {
    state.listPending = false;
    state.listResult = [connection];
    const { container } = renderPanel();
    await screen.findByText("Relay Agent");
    expect(container.querySelector("img")).toBeNull();
    expect(document.body.querySelector("img")).toBeNull();
  });

  it("shows an inline retry (no client data) when the grant list fails to load", async () => {
    state.listPending = false;
    state.listError = new Error("boom");
    renderPanel();
    expect(await screen.findByText("settings:mcp.loadFailed")).toBeTruthy();
    expect(screen.queryByText("Relay Agent")).not.toBeTruthy();
  });

  it("revokes through a 44px-target AlertDialog and invalidates ONLY the grant-list query", async () => {
    const user = userEvent.setup();
    state.listPending = false;
    state.listResult = [connection];
    const { invalidateSpy } = renderPanel();

    const revokeButton = await screen.findByRole("button", { name: "settings:mcp.revoke" });
    expect(revokeButton.className).toContain("min-h-[44px]");
    await user.click(revokeButton);

    expect(await screen.findByText("settings:mcp.revokeTitle")).toBeTruthy();
    expect(screen.getByText(/settings:mcp.revokeDescription:Relay Agent/)).toBeTruthy();

    const confirmButton = screen.getByRole("button", { name: "settings:mcp.revokeConfirm" });
    expect(confirmButton.className).toContain("min-h-[44px]");
    expect(screen.getByRole("button", { name: "common:actions.cancel" }).className).toContain(
      "min-h-[44px]",
    );
    await user.click(confirmButton);

    await waitFor(() => {
      expect(state.revokeCalls).toEqual([{ clientRecordId: "record-a", confirm: "REVOKE" }]);
    });
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith("settings:mcp.revoked");
    });
    // ONLY the grant-list query key is invalidated.
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["mcpGrants", "listMine"],
    });
  });

  it("surfaces a revoke failure without invalidating the grant list", async () => {
    const user = userEvent.setup();
    state.listPending = false;
    state.listResult = [connection];
    state.revokeError = new Error("revoke failed");
    const { invalidateSpy } = renderPanel();

    await user.click(await screen.findByRole("button", { name: "settings:mcp.revoke" }));
    await user.click(await screen.findByRole("button", { name: "settings:mcp.revokeConfirm" }));

    await waitFor(() => {
      expect(state.revokeCalls).toHaveLength(1);
    });
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("settings:mcp.revokeFailed");
    });
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});
