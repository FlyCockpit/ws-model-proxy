// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  endOfLocalDay,
  latestMcpPatCustomDate,
  MCP_PAT_NO_EXPIRY_DISABLED_REASON,
  mcpPatClientExpiryCapMs,
  mcpPatExpiryRejection,
} from "@ws-model-proxy/auth/mcp-pat-limits";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  listResult: [] as unknown[],
  listError: null as Error | null,
  listPending: true,
  listInputs: [] as unknown[],
  revokeCalls: [] as unknown[],
  createCalls: [] as unknown[],
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
          queryOptions: (options?: { input?: unknown }) => {
            // Captured at queryOptions-call time so tests can assert the
            // input the panel passed (includeRevoked toggling).
            state.listInputs.push(options?.input);
            return {
              queryKey: [...listQueryKey, options?.input],
              queryFn: async () => {
                while (state.listPending) {
                  await new Promise<never>(() => {});
                }
                if (state.listError) throw state.listError;
                return state.listResult;
              },
            };
          },
        },
        create: {
          mutationOptions: (options?: Record<string, unknown>) => ({
            mutationFn: async (input: unknown) => {
              state.createCalls.push(input);
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

const usedToken = {
  ...token,
  id: "token-2",
  name: "CI runner",
  lastUsedAt: new Date("2026-08-15T10:30:00.000Z"),
};

const expiringToken = {
  ...token,
  id: "token-3",
  name: "Quarterly token",
  expiresAt: new Date("2099-06-15T00:00:00.000Z"),
};

const expiredToken = {
  ...token,
  id: "token-4",
  name: "Stale token",
  expiresAt: new Date("2020-01-01T00:00:00.000Z"),
};

const revokedToken = {
  ...token,
  id: "token-5",
  name: "Old laptop",
  lastUsedAt: new Date("2026-07-30T09:00:00.000Z"),
  revokedAt: new Date("2026-08-01T00:00:00.000Z"),
};

function renderPanel(createEnabled = true, allowNoExpiry = true) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <McpTokensPanel createEnabled={createEnabled} allowNoExpiry={allowNoExpiry} />
    </QueryClientProvider>,
  );
}

async function chooseExpiryOption(user: ReturnType<typeof userEvent.setup>, optionName: string) {
  await user.click(screen.getByRole("combobox"));
  await user.click(await screen.findByRole("option", { name: optionName }));
}

function expectAboutNinetyDays(expiresAt: string | null) {
  expect(typeof expiresAt).toBe("string");
  const delta = new Date(expiresAt as string).getTime() - Date.now();
  expect(Math.abs(delta - 90 * 86_400_000)).toBeLessThan(5_000);
}

function localDateInput(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  state.listResult = [];
  state.listError = null;
  state.listPending = true;
  state.listInputs = [];
  state.revokeCalls = [];
  state.createCalls = [];
  state.createError = null;
});

describe("McpTokensPanel CLI commands", () => {
  it("shows the CLI commands checkbox only while write is checked and clears it with write", async () => {
    state.listPending = false;
    state.listResult = [];
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText("settings:mcp.tokens.empty");
    await user.click(screen.getByRole("button", { name: "settings:mcp.tokens.create" }));
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).queryByRole("checkbox", { name: "settings:mcp.tokens.allowCliCommands" }),
    ).not.toBeTruthy();
    await user.click(
      within(dialog).getByRole("checkbox", { name: "settings:mcp.tokens.allowWrite" }),
    );
    const cliCommands = within(dialog).getByRole("checkbox", {
      name: "settings:mcp.tokens.allowCliCommands",
    });
    await user.click(cliCommands);
    expect(cliCommands.getAttribute("aria-checked")).toBe("true");
    await user.click(
      within(dialog).getByRole("checkbox", { name: "settings:mcp.tokens.allowWrite" }),
    );
    expect(
      within(dialog).queryByRole("checkbox", { name: "settings:mcp.tokens.allowCliCommands" }),
    ).not.toBeTruthy();
    await user.click(
      within(dialog).getByRole("checkbox", { name: "settings:mcp.tokens.allowWrite" }),
    );
    const restored = within(dialog).getByRole("checkbox", {
      name: "settings:mcp.tokens.allowCliCommands",
    });
    expect(restored.getAttribute("aria-checked")).not.toBe("true");
  });

  it("warns when a never-expiring token also allows CLI commands", async () => {
    state.listPending = false;
    state.listResult = [];
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText("settings:mcp.tokens.empty");
    await user.click(screen.getByRole("button", { name: "settings:mcp.tokens.create" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByRole("status")).not.toBeTruthy();
    await user.click(
      within(dialog).getByRole("checkbox", { name: "settings:mcp.tokens.allowWrite" }),
    );
    await user.click(
      within(dialog).getByRole("checkbox", { name: "settings:mcp.tokens.allowCliCommands" }),
    );
    expect(
      within(dialog).queryByText("settings:mcp.tokens.allowCliCommandsNoExpiryWarning"),
    ).not.toBeTruthy();
    await chooseExpiryOption(user, "settings:mcp.tokens.noExpiryOption");
    expect(
      within(dialog).getByText("settings:mcp.tokens.allowCliCommandsNoExpiryWarning"),
    ).toBeTruthy();
    await chooseExpiryOption(user, "settings:mcp.tokens.days90");
    expect(
      within(dialog).queryByText("settings:mcp.tokens.allowCliCommandsNoExpiryWarning"),
    ).not.toBeTruthy();
  });

  it("sends allowCliCommands only with write and badges tokens that have it", async () => {
    state.listPending = false;
    state.listResult = [{ ...token, allowCliCommands: true }];
    const user = userEvent.setup();
    renderPanel();
    expect(await screen.findByText("settings:mcp.tokens.allowCliCommandsBadge")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "settings:mcp.tokens.create" }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByLabelText("settings:mcp.tokens.name"), "Grok laptop");
    await user.click(
      within(dialog).getByRole("checkbox", { name: "settings:mcp.tokens.allowWrite" }),
    );
    await user.click(
      within(dialog).getByRole("checkbox", { name: "settings:mcp.tokens.allowCliCommands" }),
    );
    await user.click(within(dialog).getByRole("button", { name: "settings:mcp.tokens.create" }));
    await waitFor(() => {
      expect(state.createCalls).toHaveLength(1);
    });
    const input = state.createCalls[0] as {
      name: string;
      allowWrite: boolean;
      allowCliCommands: boolean;
      expiresAt: string | null;
    };
    expect(input.name).toBe("Grok laptop");
    expect(input.allowWrite).toBe(true);
    expect(input.allowCliCommands).toBe(true);
    expectAboutNinetyDays(input.expiresAt);
  });
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
    await waitFor(() => {
      expect(state.createCalls).toHaveLength(1);
    });
    const input = state.createCalls[0] as {
      name: string;
      allowWrite: boolean;
      allowCliCommands: boolean;
      expiresAt: string | null;
    };
    expect(input).toMatchObject({
      name: "Grok laptop",
      allowWrite: false,
      allowCliCommands: false,
    });
    expectAboutNinetyDays(input.expiresAt);
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

  it("maps a flag-off FORBIDDEN to the no-expiry-disabled toast", async () => {
    state.listPending = false;
    state.listResult = [];
    state.createError = Object.assign(new Error("no-expiry tokens are disabled"), {
      code: "FORBIDDEN",
      data: { reason: MCP_PAT_NO_EXPIRY_DISABLED_REASON },
    });
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText("settings:mcp.tokens.empty");
    await openDialogTypeAndSubmit(user);
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("settings:mcp.tokens.noExpiryDisabled");
    });
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it("maps an expiry validation BAD_REQUEST to the expiry-invalid toast", async () => {
    state.listPending = false;
    state.listResult = [];
    state.createError = Object.assign(new Error("Input validation failed"), {
      code: "BAD_REQUEST",
      data: { issues: [{ path: ["expiresAt"], message: "Expiry must be in the future." }] },
    });
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText("settings:mcp.tokens.empty");
    await openDialogTypeAndSubmit(user);
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("settings:mcp.tokens.expiryInvalid");
    });
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it("maps other FORBIDDEN and non-expiry BAD_REQUEST failures to the generic toast", async () => {
    state.listPending = false;
    state.listResult = [];
    state.createError = Object.assign(new Error("MCP personal tokens cannot be created"), {
      code: "FORBIDDEN",
    });
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText("settings:mcp.tokens.empty");
    await openDialogTypeAndSubmit(user);
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("settings:mcp.tokens.createFailed");
    });
    expect(toast.error).not.toHaveBeenCalledWith("settings:mcp.tokens.noExpiryDisabled");
  });

  it("maps a non-expiry BAD_REQUEST to the generic toast", async () => {
    state.listPending = false;
    state.listResult = [];
    state.createError = Object.assign(new Error("Input validation failed"), {
      code: "BAD_REQUEST",
      data: { issues: [{ path: ["name"], message: "Too big" }] },
    });
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText("settings:mcp.tokens.empty");
    await openDialogTypeAndSubmit(user);
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("settings:mcp.tokens.createFailed");
    });
    expect(toast.error).not.toHaveBeenCalledWith("settings:mcp.tokens.expiryInvalid");
  });

  it("rejects a whitespace-only name before calling create", async () => {
    state.listPending = false;
    state.listResult = [];
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText("settings:mcp.tokens.empty");
    await user.click(screen.getByRole("button", { name: "settings:mcp.tokens.create" }));
    const dialog = screen.getByRole("dialog");
    await user.type(await screen.findByLabelText("settings:mcp.tokens.name"), "   ");
    expect(screen.getByText("settings:mcp.tokens.nameInvalid")).toBeTruthy();
    const submit = within(dialog).getByRole("button", {
      name: "settings:mcp.tokens.create",
    }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(state.createCalls).toEqual([]);
  });

  it("defaults the expiry selector to 90 days while No expiry is still offered", async () => {
    state.listPending = false;
    state.listResult = [];
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText("settings:mcp.tokens.empty");
    await user.click(screen.getByRole("button", { name: "settings:mcp.tokens.create" }));
    const dialog = screen.getByRole("dialog");
    await user.type(await screen.findByLabelText("settings:mcp.tokens.name"), "Grok laptop");
    const trigger = within(dialog).getByRole("combobox");
    expect(trigger.textContent).toContain("settings:mcp.tokens.days90");
    expect(trigger.textContent).not.toContain("settings:mcp.tokens.noExpiryOption");
    await user.click(trigger);
    expect(
      await screen.findByRole("option", { name: "settings:mcp.tokens.noExpiryOption" }),
    ).toBeTruthy();
    await user.click(await screen.findByRole("option", { name: "settings:mcp.tokens.days90" }));
    await user.click(within(dialog).getByRole("button", { name: "settings:mcp.tokens.create" }));
    await waitFor(() => {
      expect(state.createCalls).toHaveLength(1);
    });
    const input = state.createCalls[0] as {
      name: string;
      allowWrite: boolean;
      expiresAt: string | null;
    };
    expect(input.name).toBe("Grok laptop");
    expectAboutNinetyDays(input.expiresAt);
  });

  it("sends a null expiresAt when No expiry is selected", async () => {
    state.listPending = false;
    state.listResult = [];
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText("settings:mcp.tokens.empty");
    await user.click(screen.getByRole("button", { name: "settings:mcp.tokens.create" }));
    const dialog = screen.getByRole("dialog");
    await user.type(await screen.findByLabelText("settings:mcp.tokens.name"), "Grok laptop");
    await chooseExpiryOption(user, "settings:mcp.tokens.noExpiryOption");
    await user.click(within(dialog).getByRole("button", { name: "settings:mcp.tokens.create" }));
    await waitFor(() => {
      expect(state.createCalls).toHaveLength(1);
    });
    const input = state.createCalls[0] as { expiresAt: string | null };
    expect(input.expiresAt).toBeNull();
  });

  it("hides the No-expiry option and defaults to 90 days when allowNoExpiry is false", async () => {
    state.listPending = false;
    state.listResult = [];
    const user = userEvent.setup();
    renderPanel(true, false);
    await screen.findByText("settings:mcp.tokens.empty");
    await user.click(screen.getByRole("button", { name: "settings:mcp.tokens.create" }));
    const dialog = screen.getByRole("dialog");
    const trigger = within(dialog).getByRole("combobox");
    expect(trigger.textContent).toContain("settings:mcp.tokens.days90");
    await user.click(trigger);
    expect(await screen.findByRole("option", { name: "settings:mcp.tokens.days90" })).toBeTruthy();
    expect(
      screen.queryByRole("option", { name: "settings:mcp.tokens.noExpiryOption" }),
    ).not.toBeTruthy();
    await user.click(screen.getByRole("option", { name: "settings:mcp.tokens.customOption" }));
    await user.type(within(dialog).getByLabelText("settings:mcp.tokens.name"), "Grok laptop");
    // Without a custom date filled, submit stays disabled — no call yet.
    const submit = within(dialog).getByRole("button", {
      name: "settings:mcp.tokens.create",
    }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(state.createCalls).toEqual([]);
  });

  it("sends a truthy expiresAt from a custom date choice", async () => {
    state.listPending = false;
    state.listResult = [];
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText("settings:mcp.tokens.empty");
    await user.click(screen.getByRole("button", { name: "settings:mcp.tokens.create" }));
    const dialog = screen.getByRole("dialog");
    await user.type(await screen.findByLabelText("settings:mcp.tokens.name"), "Grok laptop");
    await chooseExpiryOption(user, "settings:mcp.tokens.customOption");
    const dateInput = within(dialog).getByLabelText("settings:mcp.tokens.customDateLabel");
    expect(dateInput).toBeTruthy();
    const chosenDate = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);
    // jsdom cannot userEvent.type into a native date input; change is the
    // standard deterministic escape hatch.
    fireEvent.change(dateInput, { target: { value: localDateInput(chosenDate) } });
    await user.click(within(dialog).getByRole("button", { name: "settings:mcp.tokens.create" }));
    await waitFor(() => {
      expect(state.createCalls).toHaveLength(1);
    });
    const input = state.createCalls[0] as { expiresAt: string | null };
    expect(input.expiresAt).toBeTruthy();
    // End of the chosen local day, always in the future.
    expect(new Date(input.expiresAt as string).getTime()).toBeGreaterThan(
      Date.now() + 59 * 24 * 60 * 60 * 1000,
    );
  });

  it("submits the maximum custom date inside the server cap", async () => {
    state.listPending = false;
    state.listResult = [];
    const before = new Date();
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText("settings:mcp.tokens.empty");
    await user.click(screen.getByRole("button", { name: "settings:mcp.tokens.create" }));
    const dialog = screen.getByRole("dialog");
    await user.type(await screen.findByLabelText("settings:mcp.tokens.name"), "Grok laptop");
    await chooseExpiryOption(user, "settings:mcp.tokens.customOption");
    const dateInput = within(dialog).getByLabelText(
      "settings:mcp.tokens.customDateLabel",
    ) as HTMLInputElement;
    const after = new Date();
    const allowed = [before, after].map((instant) =>
      localDateInput(latestMcpPatCustomDate(instant)),
    );
    expect(allowed).toContain(dateInput.max);
    const maxDate = dateInput.max;
    const [year, month, day] = maxDate.split("-").map(Number);
    if (year === undefined || month === undefined || day === undefined) {
      throw new Error(`Unexpected max date ${maxDate}`);
    }
    const nextDay = localDateInput(new Date(year, month - 1, day + 1));
    fireEvent.change(dateInput, { target: { value: nextDay } });
    const submit = within(dialog).getByRole("button", {
      name: "settings:mcp.tokens.create",
    }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(dateInput, { target: { value: maxDate } });
    expect(submit.disabled).toBe(false);
    await user.click(submit);
    await waitFor(() => {
      expect(state.createCalls).toHaveLength(1);
    });
    const input = state.createCalls[0] as { expiresAt: string };
    const end = endOfLocalDay(new Date(year, month - 1, day));
    expect(input.expiresAt).toBe(end.toISOString());
    expect(end.getTime()).toBeLessThanOrEqual(mcpPatClientExpiryCapMs(Date.now()));
    expect(mcpPatExpiryRejection(new Date(input.expiresAt).getTime(), Date.now())).toBeNull();
  });

  it("keeps the 365-day preset inside the server cap", async () => {
    state.listPending = false;
    state.listResult = [];
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText("settings:mcp.tokens.empty");
    await user.click(screen.getByRole("button", { name: "settings:mcp.tokens.create" }));
    const dialog = screen.getByRole("dialog");
    await user.type(await screen.findByLabelText("settings:mcp.tokens.name"), "Grok laptop");
    await chooseExpiryOption(user, "settings:mcp.tokens.days365");
    await user.click(within(dialog).getByRole("button", { name: "settings:mcp.tokens.create" }));
    await waitFor(() => {
      expect(state.createCalls).toHaveLength(1);
    });
    const input = state.createCalls[0] as { expiresAt: string };
    const expiresAt = new Date(input.expiresAt);
    const deltaMs = expiresAt.getTime() - Date.now();
    expect(deltaMs).toBeGreaterThan(364 * 24 * 60 * 60 * 1000);
    expect(deltaMs).toBeLessThanOrEqual(365 * 24 * 60 * 60 * 1000);
    expect(mcpPatExpiryRejection(expiresAt.getTime(), Date.now())).toBeNull();
  });

  it("renders last-used, future-expiry, no-expiry, and muted expired rows", async () => {
    state.listPending = false;
    state.listResult = [token, usedToken, expiringToken, expiredToken];
    renderPanel();
    await screen.findByText("Laptop Grok");
    expect(
      within(screen.getByText("Laptop Grok").closest("li") as HTMLElement).getByText(
        /settings:mcp\.tokens\.neverUsed/,
      ),
    ).toBeTruthy();
    expect(
      within(screen.getByText("CI runner").closest("li") as HTMLElement).getByText(
        /settings:mcp\.tokens\.lastUsed:/,
      ),
    ).toBeTruthy();
    expect(
      within(screen.getByText("Quarterly token").closest("li") as HTMLElement).getByText(
        /settings:mcp\.tokens\.expires:/,
      ),
    ).toBeTruthy();
    // Future-expiry row is not muted; past-expiry row is.
    expect(screen.getByText("Quarterly token").closest("li")?.className).not.toContain(
      "opacity-60",
    );
    expect(screen.getByText("Stale token").closest("li")?.className).toContain("opacity-60");
    expect(screen.getByText("settings:mcp.tokens.expiredBadge")).toBeTruthy();
    expect(
      within(screen.getByText("Stale token").closest("li") as HTMLElement).getByRole("button", {
        name: "settings:mcp.tokens.revoke",
      }),
    ).toHaveProperty("disabled", false);
  });

  it("refetches with includeRevoked and renders revoked rows muted with a badge", async () => {
    state.listPending = false;
    state.listResult = [token];
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText("Laptop Grok");
    expect(screen.queryByText("settings:mcp.tokens.revokedBadge")).not.toBeTruthy();
    expect(state.listInputs[state.listInputs.length - 1]).toEqual({ includeRevoked: false });
    // Flip the mocked result set to the revoked-inclusive payload, then
    // toggle — the new query key refetches with the new input.
    state.listResult = [token, revokedToken];
    await user.click(screen.getByRole("checkbox", { name: "settings:mcp.tokens.showRevoked" }));
    expect(await screen.findByText("Old laptop")).toBeTruthy();
    expect(screen.getByText("settings:mcp.tokens.revokedBadge")).toBeTruthy();
    expect(state.listInputs[state.listInputs.length - 1]).toEqual({ includeRevoked: true });
    expect(screen.getByText("Old laptop").closest("li")?.className).toContain("opacity-60");
    expect(screen.getByText("Laptop Grok").closest("li")?.className).not.toContain("opacity-60");
    expect(
      within(screen.getByText("Old laptop").closest("li") as HTMLElement).getByRole("button", {
        name: "settings:mcp.tokens.revoke",
      }),
    ).toHaveProperty("disabled", true);
    expect(
      within(screen.getByText("Laptop Grok").closest("li") as HTMLElement).getByRole("button", {
        name: "settings:mcp.tokens.revoke",
      }),
    ).toHaveProperty("disabled", false);
  });
});
