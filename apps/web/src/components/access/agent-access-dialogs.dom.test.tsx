// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/utils/orpc", () => ({
  orpc: {
    app: {
      flags: {
        queryOptions: () => ({
          queryKey: ["flags"],
          queryFn: async () => ({ agentTokenNoExpiryAllowed: true, agentTokenMaxLifetimeDays: 90 }),
        }),
      },
    },
    nodes: {
      list: { queryOptions: () => ({ queryKey: ["nodes"], queryFn: async () => ({ nodes: [] }) }) },
    },
    access: {
      agentTokens: {
        create: { mutationOptions: () => ({ mutationFn: vi.fn() }) },
        list: { key: () => ["tokens"] },
      },
    },
  },
}));

import { CreateAgentTokenDialog } from "./create-agent-token-dialog";
import { EditAgentAccessDialog } from "./edit-agent-access-dialog";

let desktop = false;
beforeEach(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(min-width: 768px)" && desktop,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  desktop = false;
});
function mount(children: ReactNode) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {children}
    </QueryClientProvider>,
  );
}

describe("Agent dialogs scroll ownership", () => {
  it.each(["create", "edit"])(
    "%s uses only the ResponsiveDialog body scroller on phones",
    async (kind) => {
      const close = vi.fn();
      mount(
        kind === "create" ? (
          <CreateAgentTokenDialog open mcpUrl={null} onOpenChange={close} />
        ) : (
          <EditAgentAccessDialog
            name="Agent"
            access={{ scopes: ["read"], nodeIds: null }}
            onSave={vi.fn()}
            onClose={close}
          />
        ),
      );
      await screen.findByRole("button", { name: "common:actions.cancel" });
      const dialog = screen.getByRole("dialog");
      expect(dialog.getAttribute("data-slot")).toBe("drawer-content");
      expect(dialog.classList.contains("overflow-y-auto")).toBe(false);
      const scrollers = dialog.querySelectorAll(".overflow-y-auto");
      expect(scrollers).toHaveLength(1);
      expect(scrollers[0]?.classList.contains("overflow-x-hidden")).toBe(true);
      expect(scrollers[0]?.querySelector("form")).toBeTruthy();
      expect(scrollers[0]?.querySelector('[data-slot="drawer-header"]')).toBeNull();
      const footer = dialog.querySelector('[data-slot="drawer-footer"]');
      const cancel = screen.getByRole("button", { name: "common:actions.cancel" });
      expect(footer?.contains(cancel)).toBe(true);
      expect(scrollers[0]?.contains(cancel)).toBe(false);
      const submit = footer?.querySelector<HTMLButtonElement>('button[type="submit"]');
      expect(submit?.form).toBe(scrollers[0]?.querySelector("form"));
      fireEvent.click(screen.getByRole("radio", { name: "access:agents.onlyNodes" }));
      await screen.findByText("access:agents.noNodes");
      expect(dialog.querySelectorAll(".overflow-y-auto")).toHaveLength(1);
      fireEvent.click(screen.getByRole("button", { name: "common:actions.cancel" }));
      expect(close).toHaveBeenCalledOnce();
      if (kind === "create") expect(close).toHaveBeenCalledWith(false);
    },
  );

  it.each(["create", "edit"])("%s retains a bounded desktop scroller", async (kind) => {
    desktop = true;
    mount(
      kind === "create" ? (
        <CreateAgentTokenDialog open mcpUrl={null} onOpenChange={vi.fn()} />
      ) : (
        <EditAgentAccessDialog
          name="Agent"
          access={{ scopes: ["read"], nodeIds: null }}
          onSave={vi.fn()}
          onClose={vi.fn()}
        />
      ),
    );
    await screen.findByRole("button", { name: "common:actions.cancel" });
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("data-slot")).toBe("dialog-content");
    expect(dialog.classList.contains("md:overflow-y-auto")).toBe(false);
    const scrollers = dialog.querySelectorAll(".md\\:overflow-y-auto");
    expect(scrollers).toHaveLength(1);
    expect(scrollers[0]?.classList.contains("md:overflow-x-hidden")).toBe(true);
    const footer = dialog.querySelector('[data-slot="dialog-footer"]');
    const cancel = screen.getByRole("button", { name: "common:actions.cancel" });
    expect(footer?.contains(cancel)).toBe(true);
    expect(scrollers[0]?.contains(cancel)).toBe(false);
    expect(dialog.classList.contains("md:grid-rows-[auto_minmax(0,1fr)_auto]")).toBe(true);
    expect(dialog.className).toContain("md:max-h-[calc(100dvh-2rem)]");
  });

  it("keeps every expiry preset visible in a wrapping grid with touch targets", async () => {
    mount(<CreateAgentTokenDialog open mcpUrl={null} onOpenChange={vi.fn()} />);
    const presets = await screen.findByRole("group", { name: "access:fields.expiry" });
    expect(presets.classList.contains("grid")).toBe(true);
    expect(presets.classList.contains("grid-cols-2")).toBe(true);
    expect(presets.closest(".overflow-x-auto")).toBeNull();
    expect(presets.querySelectorAll("button")).toHaveLength(5);
    for (const button of presets.querySelectorAll("button")) {
      expect(button.classList.contains("whitespace-normal")).toBe(true);
      expect(button.classList.contains("min-h-11")).toBe(true);
    }
    expect(screen.getByRole("button", { name: "access:agents.noExpiry" })).toBeTruthy();
    const selected = presets.querySelector('[aria-pressed="true"]');
    expect(selected?.classList.contains("aria-pressed:border-primary")).toBe(true);
    expect(selected?.classList.contains("aria-pressed:ring-primary")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "access:agents.noExpiry" }));
    expect(selected?.getAttribute("aria-pressed")).toBe("false");
    expect(
      screen.getByRole("button", { name: "access:agents.noExpiry" }).getAttribute("aria-pressed"),
    ).toBe("true");
  });
});
