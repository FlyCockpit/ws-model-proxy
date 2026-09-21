// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  listResult: [] as unknown[],
  listError: null as Error | null,
  listPending: true,
  revokeCalls: [] as unknown[],
  createError: null as Error | null,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (options?.name !== undefined) return `${key}:${String(options.name)}`;
      if (options?.date !== undefined) return `${key}:${String(options.date)}`;
      if (options?.origin !== undefined || options?.secret !== undefined) return key;
      return key;
    },
  }),
}));

vi.mock("@ws-model-proxy/ui/components/sileo", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/utils/orpc", () => {
  const listQueryKey = ["mcpTokens", "listMine"];
  return {
    orpc: {
      mcpTokens: {
        listMine: {
          queryKey: () => listQueryKey,
          queryOptions: () => ({
            queryKey: listQueryKey,
            queryFn: async () => {
              while (state.listPending) {
                await new Promise<never>(() => {});
              }
              if (state.listError) throw state.listError;
              return state.listResult;
            },
          }),
        },
        create: {
          mutationOptions: (options?: Record<string, unknown>) => ({
            mutationFn: async () => {
              if (state.createError) throw state.createError;
              return {
                token: { id: "token-1" },
                secret: "wsmp_mcp_secret",
              };
            },
            ...options,
          }),
        },
        revokeMine: {
          mutationOptions: (options?: Record<string, unknown>) => ({
            mutationFn: async (input: unknown) => {
              state.revokeCalls.push(input);
              return { id: "token-1" };
            },
            ...options,
          }),
        },
      },
    },
  };
});

import { McpTokensPanel } from "./mcp-tokens-panel";

const token = {
  id: "token-1",
  createdAt: new Date("2026-07-01T00:00:00.000Z"),
  updatedAt: new Date("2026-07-01T00:00:00.000Z"),
  name: "Laptop Grok",
  lookupPrefix: "wsmp_mcp_abcdefghijkl",
  scopes: ["mcp:read"],
  lastUsedAt: null,
  revokedAt: null,
  expiresAt: null,
};

function renderPanel(createEnabled = true) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <McpTokensPanel createEnabled={createEnabled} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  state.listResult = [];
  state.listError = null;
  state.listPending = true;
  state.revokeCalls = [];
  state.createError = null;
});

describe("McpTokensPanel", () => {
  it("renders layout-matching skeletons while the token list is pending", () => {
    state.listPending = true;
    const { container } = renderPanel();
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    expect(screen.queryByText("settings:mcp.tokens.empty")).not.toBeTruthy();
  });

  it("hides create when MCP is disabled and still lists tokens", async () => {
    state.listPending = false;
    state.listResult = [token];
    renderPanel(false);
    expect(await screen.findByText("Laptop Grok")).toBeTruthy();
    expect(screen.getByText("settings:mcp.tokens.createDisabled")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "settings:mcp.tokens.create" })).not.toBeTruthy();
  });

  it("revokes through a 44px-target AlertDialog", async () => {
    state.listPending = false;
    state.listResult = [token];
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText("Laptop Grok");
    await user.click(screen.getByRole("button", { name: "settings:mcp.tokens.revoke" }));
    expect(await screen.findByText("settings:mcp.tokens.revokeTitle")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "settings:mcp.tokens.revokeConfirm" }));
    expect(state.revokeCalls).toEqual([{ id: "token-1" }]);
  });

  async function openDialogTypeAndSubmit(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("button", { name: "settings:mcp.tokens.create" }));
    await user.type(await screen.findByLabelText("settings:mcp.tokens.name"), "Grok laptop");
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "settings:mcp.tokens.create" }));
  }

  it("shows the one-time secret, MCP endpoint, and Grok template after create", async () => {
    state.listPending = false;
    state.listResult = [];
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText("settings:mcp.tokens.empty");
    await openDialogTypeAndSubmit(user);
    expect(await screen.findByText("settings:mcp.tokens.secret")).toBeTruthy();
    expect(screen.getByText(`${window.location.origin}/mcp`)).toBeTruthy();
    expect(screen.getByText("settings:mcp.tokens.mcpUrl")).toBeTruthy();
    expect(screen.getByText("settings:mcp.tokens.mcpUrlHelp")).toBeTruthy();
    expect(screen.getByText("settings:mcp.tokens.grokConfig")).toBeTruthy();
    for (const reveal of screen.getAllByRole("button", { name: "settings:mcp.tokens.show" })) {
      await user.click(reveal);
    }
    expect(await screen.findByText("wsmp_mcp_secret")).toBeTruthy();
    expect(screen.getByText("settings:mcp.tokens.grokTemplate")).toBeTruthy();
  });

  it("maps an active-token cap CONFLICT to the cap-reached toast", async () => {
    state.listPending = false;
    state.listResult = [];
    state.createError = Object.assign(new Error("active token cap reached"), { code: "CONFLICT" });
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText("settings:mcp.tokens.empty");
    await openDialogTypeAndSubmit(user);
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("settings:mcp.tokens.capReached");
    });
    expect(toast.error).toHaveBeenCalledTimes(1);
  });
});
