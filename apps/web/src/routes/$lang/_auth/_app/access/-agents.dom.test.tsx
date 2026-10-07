// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

/** Access → Agents: each OAuth connection shows its level and a person can change it. */

const state = vi.hoisted(() => ({
  connections: [] as Array<Record<string, unknown>>,
  calls: [] as Array<{ name: string; input: unknown }>,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    createFileRoute: () => (options: { component: ComponentType }) => ({ options }),
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts && typeof opts.name === "string" ? `${key}:${opts.name}` : key,
    i18n: { language: "en-US" },
  }),
}));

vi.mock("@ws-model-proxy/ui/components/sileo", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

// The token dialog is not under test (it needs matchMedia).
vi.mock("@ws-model-proxy/ui/components/responsive-dialog", () => ({
  ResponsiveDialog: () => null,
}));

vi.mock("@/components/access/confirm-action", () => ({
  ConfirmAction: ({
    open,
    title,
    description,
    confirmLabel,
    onConfirm,
  }: {
    open: boolean;
    title: string;
    description: string;
    confirmLabel: string;
    onConfirm: () => void;
  }) =>
    open ? (
      <div role="dialog" aria-label={title}>
        <p>{description}</p>
        <button type="button" onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    ) : null,
}));

vi.mock("@/utils/orpc", () => {
  const mutation = (name: string) => ({
    mutationOptions: (options?: Record<string, unknown>) => ({
      ...options,
      mutationFn: async (input: { grantId: string; level?: string }) => {
        state.calls.push({ name, input });
        const row = state.connections.find((entry) => entry.grantId === input.grantId);
        if (row && input.level) row.level = input.level;
        return input.level ? { level: input.level } : { ok: true };
      },
    }),
  });
  return {
    orpc: {
      app: {
        flags: {
          queryOptions: () => ({
            queryKey: ["app", "flags"],
            queryFn: async () => ({ mcpEnabled: true, agentTokenNoExpiryAllowed: false }),
          }),
        },
      },
      access: {
        agentTokens: {
          list: {
            key: () => ["access", "agentTokens", "list"],
            queryOptions: () => ({
              queryKey: ["access", "agentTokens", "list"],
              queryFn: async () => ({ tokens: [], mcpUrl: "https://proxy.example.com/mcp" }),
            }),
          },
          create: mutation("agentTokens.create"),
          revoke: mutation("agentTokens.revoke"),
        },
        oauthGrants: {
          list: {
            key: () => ["access", "oauthGrants", "list"],
            queryOptions: () => ({
              queryKey: ["access", "oauthGrants", "list"],
              queryFn: async () => ({ connections: state.connections.map((row) => ({ ...row })) }),
            }),
          },
          revoke: mutation("oauthGrants.revoke"),
          setLevel: mutation("oauthGrants.setLevel"),
        },
      },
    },
  };
});

import { Route } from "./agents";

function connection(overrides: Record<string, unknown> = {}) {
  return {
    grantId: "grant-1",
    clientId: "https://client.example/meta",
    clientName: "Claude",
    redirectHost: "client.example",
    level: "READ",
    fullAvailable: true,
    createdAt: "2026-10-01T00:00:00.000Z",
    revokedAt: null,
    ...overrides,
  };
}

function levelGroup(): Promise<HTMLElement> {
  return screen.findByRole("group", { name: "access:agents.levelFor:Claude" });
}

async function mount(ready: () => Promise<HTMLElement> = levelGroup) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const Component = Route.options.component as ComponentType & {
    preload?: () => Promise<unknown>;
  };
  await Component.preload?.();
  render(
    <QueryClientProvider client={client}>
      <Component />
    </QueryClientProvider>,
  );
  return ready();
}

afterEach(() => {
  cleanup();
  state.connections = [];
  state.calls = [];
});

describe("Access → Agents connection level", { timeout: 30_000 }, () => {
  it("shows each connection's level and lowers to Read-only at once", async () => {
    state.connections = [connection({ level: "FULL" })];
    const group = await mount();
    const full = within(group).getByRole("button", { name: "access:agents.levelFull" });
    expect(full.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(group).getByRole("button", { name: "access:agents.levelRead" }));
    await waitFor(() =>
      expect(state.calls).toEqual([
        { name: "oauthGrants.setLevel", input: { grantId: "grant-1", level: "READ" } },
      ]),
    );
    await waitFor(() =>
      expect(
        within(group)
          .getByRole("button", { name: "access:agents.levelRead" })
          .getAttribute("aria-pressed"),
      ).toBe("true"),
    );
  });

  it("raises to Full only after the person confirms what Full allows", async () => {
    state.connections = [connection({ level: "READ" })];
    const group = await mount();
    fireEvent.click(within(group).getByRole("button", { name: "access:agents.levelFull" }));
    const dialog = await screen.findByRole("dialog", { name: "access:agents.raiseTitle:Claude" });
    expect(within(dialog).getByText("access:agents.levelFullHint")).toBeTruthy();
    expect(state.calls).toEqual([]);
    fireEvent.click(within(dialog).getByRole("button", { name: "access:agents.raiseConfirm" }));
    await waitFor(() =>
      expect(state.calls).toEqual([
        { name: "oauthGrants.setLevel", input: { grantId: "grant-1", level: "FULL" } },
      ]),
    );
  });

  it("does nothing when the current level is chosen again", async () => {
    state.connections = [connection({ level: "READ" })];
    const group = await mount();
    fireEvent.click(within(group).getByRole("button", { name: "access:agents.levelRead" }));
    expect(state.calls).toEqual([]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("offers no Full for a connection whose agent did not ask to make changes", async () => {
    state.connections = [connection({ level: "READ", fullAvailable: false })];
    await mount(() => screen.findByText("access:agents.fullUnavailable"));
    expect(screen.queryByRole("group", { name: "access:agents.levelFor:Claude" })).toBeNull();
    expect(screen.getByRole("button", { name: "access:agents.disconnect" })).toBeTruthy();
  });
});
