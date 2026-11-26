// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ maxLifetimeDays: 90, allowNoExpiry: false, create: vi.fn() }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts?.count !== undefined
        ? `${key}:${opts.count}`
        : opts?.days !== undefined
          ? `${key}:${opts.days}`
          : key,
  }),
}));
vi.mock("@ws-model-proxy/ui/components/responsive-dialog", () => ({
  ResponsiveDialog: ({
    children,
    open,
    title,
    footer,
  }: {
    children: ReactNode;
    open: boolean;
    title: string;
    footer?: ReactNode;
  }) =>
    open ? (
      <div role="dialog" aria-label={title}>
        {children}
        {footer}
      </div>
    ) : null,
}));
vi.mock("@/components/access/secret-reveal", () => ({
  SecretReveal: ({ value }: { value: string }) => <p>{value}</p>,
}));
vi.mock("@/utils/orpc", () => ({
  orpc: {
    app: {
      flags: {
        queryOptions: () => ({
          queryKey: ["flags"],
          queryFn: async () => ({
            agentTokenNoExpiryAllowed: state.allowNoExpiry,
            agentTokenMaxLifetimeDays: state.maxLifetimeDays,
          }),
        }),
      },
    },
    nodes: {
      list: {
        queryOptions: () => ({
          queryKey: ["nodes"],
          queryFn: async () => ({ nodes: [{ id: "node-1", slug: "my-node", name: null }] }),
        }),
      },
    },
    access: {
      agentTokens: {
        create: { mutationOptions: () => ({ mutationFn: state.create }) },
        list: { key: () => ["tokens"] },
      },
    },
  },
}));

import { CreateAgentTokenDialog } from "./create-agent-token-dialog";

async function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <CreateAgentTokenDialog open onOpenChange={vi.fn()} mcpUrl={null} />
    </QueryClientProvider>,
  );
  return screen.findByLabelText("access:fields.name");
}

afterEach(() => {
  cleanup();
  state.maxLifetimeDays = 90;
  state.allowNoExpiry = false;
  state.create.mockReset();
});

describe("Create agent token", () => {
  it("states the maximum, hides longer presets and defaults to the allowed maximum", async () => {
    state.maxLifetimeDays = 20;
    state.create.mockResolvedValue({ secret: "new-secret" });
    const name = await mount();
    expect(screen.getByText("access:agents.maxLifetime:20")).toBeTruthy();
    expect(screen.getByRole("button", { name: "access:agents.expiryDays:7" })).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "access:agents.expiryDays:20" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.queryByRole("button", { name: "access:agents.expiryDays:30" })).toBeNull();
    expect(screen.queryByRole("button", { name: "access:agents.noExpiry" })).toBeNull();
    fireEvent.change(name, { target: { value: " My agent " } });
    const before = Date.now();
    fireEvent.click(screen.getByRole("button", { name: "access:agents.create" }));
    await waitFor(() => expect(state.create).toHaveBeenCalledOnce());
    const input = state.create.mock.calls[0]?.[0];
    expect(input).toMatchObject({ name: "My agent", scopes: ["read"], nodeIds: null });
    expect(new Date(input.expiresAt).getTime()).toBeGreaterThanOrEqual(before + 20 * 86_400_000);
    expect(new Date(input.expiresAt).getTime()).toBeLessThanOrEqual(Date.now() + 20 * 86_400_000);
    expect(await screen.findByText("new-secret")).toBeTruthy();
  });

  it("offers No expiry only when allowed and sends null with selected scopes and nodes", async () => {
    state.allowNoExpiry = true;
    state.create.mockResolvedValue({ secret: "new-secret" });
    fireEvent.change(await mount(), { target: { value: "Agent" } });
    fireEvent.click(screen.getByRole("button", { name: "access:agents.noExpiry" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /access:agents.scopes.files.name/ }));
    fireEvent.click(screen.getByRole("radio", { name: "access:agents.onlyNodes" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "my-node" }));
    fireEvent.click(screen.getByRole("button", { name: "access:agents.create" }));
    await waitFor(() =>
      expect(state.create).toHaveBeenCalledWith(
        { name: "Agent", scopes: ["read", "files"], nodeIds: ["node-1"], expiresAt: null },
        expect.anything(),
      ),
    );
  });

  it("validates a custom date before sending a request", async () => {
    fireEvent.change(await mount(), { target: { value: "Agent" } });
    fireEvent.click(screen.getByRole("button", { name: "access:agents.customDate" }));
    const date = screen.getByLabelText("access:agents.customDate");
    fireEvent.change(date, { target: { value: "2000-01-01" } });
    const form = date.closest("form");
    if (!form) throw new Error("Missing form");
    fireEvent.submit(form);
    await screen.findByText("access:agents.expiryInvalid:90");
    expect(state.create).not.toHaveBeenCalled();
    expect(date.getAttribute("aria-invalid")).toBe("true");
  });

  it("starts on Read only with the permissions folded away, and a preset sends its scopes", async () => {
    state.create.mockResolvedValue({ secret: "new-secret" });
    const name = await mount();
    const readOnly = screen.getByRole<HTMLInputElement>("radio", {
      name: "access:agents.presets.readOnly.name",
    });
    expect(readOnly.checked).toBe(true);
    const files = screen.getByRole("checkbox", { name: /access:agents.scopes.files.name/ });
    expect(files.closest("details")?.open).toBe(false);
    fireEvent.click(screen.getByRole("radio", { name: "access:agents.presets.models.name" }));
    fireEvent.change(name, { target: { value: "Agent" } });
    fireEvent.click(screen.getByRole("button", { name: "access:agents.create" }));
    await waitFor(() =>
      expect(state.create).toHaveBeenCalledWith(
        expect.objectContaining({ scopes: ["read", "pools", "runtimes", "models:test"] }),
        expect.anything(),
      ),
    );
  });

  it("says what will be created next to the Create button", async () => {
    await mount();
    const summary = screen.getByTestId("agent-token-summary");
    expect(summary.textContent).toContain("access:agents.presets.readOnly.name");
    expect(summary.textContent).toContain("access:agents.allNodes");
    expect(summary.textContent).toContain("access:agents.summary.expiresOn");
    fireEvent.click(screen.getByRole("radio", { name: "access:agents.presets.full.name" }));
    expect(summary.textContent).toContain("access:agents.presets.full.name");
    const create = screen.getByRole("button", { name: "access:agents.create" });
    expect(create.closest('[data-slot="sheet-footer"]')).toContain(summary);
  });

  it("shows the name error next to the field and moves focus there", async () => {
    const name = await mount();
    fireEvent.click(screen.getByRole("button", { name: "access:agents.create" }));
    await screen.findByText("access:fields.nameRequired");
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(name.getAttribute("aria-describedby")).toContain("agent-token-name-error");
    await waitFor(() => expect(document.activeElement).toBe(name));
    expect(state.create).not.toHaveBeenCalled();
  });
});
