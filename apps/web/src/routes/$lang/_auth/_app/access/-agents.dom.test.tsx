// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

/** Access → Agents: scopes and node access can be edited for either credential kind. */

const state = vi.hoisted(() => ({
  connections: [] as Array<Record<string, unknown>>,
  tokens: [] as Array<Record<string, unknown>>,
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

vi.mock("@ws-model-proxy/ui/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

// The token dialog is not under test (it needs matchMedia).
vi.mock("@ws-model-proxy/ui/components/responsive-dialog", () => ({
  ResponsiveDialog: ({
    open,
    title,
    children,
    footer,
  }: {
    open: boolean;
    title: string;
    children: ReactNode;
    footer?: ReactNode;
  }) =>
    open ? (
      <div role="dialog" aria-label={title}>
        {children}
        {footer}
      </div>
    ) : null,
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
      mutationFn: async (input: {
        grantId?: string;
        agentTokenId?: string;
        scopes?: string[];
        nodeIds?: string[] | null;
      }) => {
        state.calls.push({ name, input });
        const row = input.grantId
          ? state.connections.find((entry) => entry.grantId === input.grantId)
          : state.tokens.find((entry) => entry.id === input.agentTokenId);
        if (row && input.scopes)
          Object.assign(row, { scopes: input.scopes, nodeIds: input.nodeIds });
        return { ok: true };
      },
    }),
  });
  return {
    orpc: {
      nodes: {
        list: {
          queryOptions: () => ({
            queryKey: ["nodes", "list"],
            queryFn: async () => ({ nodes: [{ id: "node-1", slug: "own-node", name: null }] }),
          }),
        },
      },
      app: {
        flags: {
          queryOptions: () => ({
            queryKey: ["app", "flags"],
            queryFn: async () => ({
              mcpEnabled: true,
              agentTokenNoExpiryAllowed: false,
              agentTokenMaxLifetimeDays: 90,
            }),
          }),
        },
      },
      access: {
        agentTokens: {
          list: {
            key: () => ["access", "agentTokens", "list"],
            queryOptions: () => ({
              queryKey: ["access", "agentTokens", "list"],
              queryFn: async () => ({
                tokens: state.tokens.map((row) => ({ ...row })),
                mcpUrl: "https://proxy.example.com/mcp",
              }),
            }),
          },
          create: mutation("agentTokens.create"),
          revoke: mutation("agentTokens.revoke"),
          setAccess: mutation("agentTokens.setAccess"),
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
          setAccess: mutation("oauthGrants.setAccess"),
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
    scopes: ["read"],
    nodeIds: null,
    availableScopes: ["read", "files", "commands"],
    currentSession: true,
    createdAt: "2026-10-01T00:00:00.000Z",
    revokedAt: null,
    ...overrides,
  };
}

async function mount() {
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
  return screen.findByRole("button", { name: "access:agents.edit" });
}

afterEach(() => {
  cleanup();
  state.connections = [];
  state.tokens = [];
  state.calls = [];
});

describe("Access → Agents access editing", () => {
  it("renders permissions and nodes inline with a separator attached to the node label", async () => {
    state.connections = [connection({ nodeIds: ["node-1"] })];
    await mount();
    const names = await screen.findByTitle("own-node");
    const summary = names.closest("p");
    expect(summary?.textContent).toBe("access:agents.scopes.read.name ·own-node");
    expect(names.parentElement?.classList.contains("inline-flex")).toBe(true);
    expect(names.parentElement?.querySelector('[aria-hidden="true"]')?.textContent).toBe("·");
    expect(names.classList.contains("truncate")).toBe(true);
  });

  it("warns before removing a scope, then sends setAccess on Save", async () => {
    state.connections = [connection({ scopes: ["read", "files"] })];
    fireEvent.click(await mount());
    const dialog = await screen.findByRole("dialog", { name: "access:agents.editTitle:Claude" });
    expect(within(dialog).queryByRole("alert")).toBeNull();
    fireEvent.click(
      within(dialog).getByRole("checkbox", { name: /access:agents.scopes.files.name/ }),
    );
    expect(within(dialog).getByRole("alert").textContent).toContain("access:agents.narrowWarning");
    expect(state.calls).toEqual([]);
    fireEvent.click(within(dialog).getByRole("button", { name: "access:agents.save" }));
    await waitFor(() =>
      expect(state.calls).toEqual([
        {
          name: "oauthGrants.setAccess",
          input: { grantId: "grant-1", scopes: ["read"], nodeIds: null },
        },
      ]),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("uses the OAuth connection's ceiling and permits broadening without a narrowing warning", async () => {
    state.connections = [connection({ availableScopes: ["read", "files"] })];
    fireEvent.click(await mount());
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getAllByRole("checkbox")).toHaveLength(2);
    fireEvent.click(within(dialog).getByRole("radio", { name: "access:agents.presets.full.name" }));
    expect(within(dialog).queryByRole("alert")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "access:agents.save" }));
    await waitFor(() =>
      expect(state.calls).toEqual([
        {
          name: "oauthGrants.setAccess",
          input: { grantId: "grant-1", scopes: ["read", "files"], nodeIds: null },
        },
      ]),
    );
  });

  it("edits token scopes and narrows all nodes to an explicit empty list", async () => {
    state.tokens = [
      {
        id: "token-1",
        name: "My token",
        scopes: ["read"],
        nodeIds: null,
        lookupPrefix: "wsmp_agt_abc",
        createdAt: "2026-10-01T00:00:00.000Z",
        lastUsedAt: null,
        expiresAt: null,
        revokedAt: null,
      },
    ];
    fireEvent.click(await mount());
    const dialog = await screen.findByRole("dialog", { name: "access:agents.editTitle:My token" });
    fireEvent.click(
      within(dialog).getByRole("checkbox", { name: /access:agents.scopes.commands.name/ }),
    );
    fireEvent.click(within(dialog).getByRole("radio", { name: "access:agents.onlyNodes" }));
    expect(within(dialog).getByRole("alert")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "access:agents.save" }));
    await waitFor(() =>
      expect(state.calls).toEqual([
        {
          name: "agentTokens.setAccess",
          input: { agentTokenId: "token-1", scopes: ["read", "commands"], nodeIds: [] },
        },
      ]),
    );
  });

  it("warns when an existing node is removed from a restricted list", async () => {
    state.connections = [connection({ nodeIds: ["node-1"] })];
    fireEvent.click(await mount());
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(await within(dialog).findByRole("checkbox", { name: "own-node" }));
    expect(within(dialog).getByRole("alert")).toBeTruthy();
  });
});
