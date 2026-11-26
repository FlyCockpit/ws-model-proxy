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
    matches: query === "(min-width: 48rem)" && desktop,
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

describe("Agent sheets scroll ownership", () => {
  it.each([
    ["create", false],
    ["edit", false],
    ["create", true],
    ["edit", true],
  ] as const)(
    "%s is a side sheet with one body scroller and a pinned footer (desktop: %s)",
    async (kind, wide) => {
      desktop = wide;
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
      expect(dialog.getAttribute("data-slot")).toBe("sheet-content");
      expect(dialog.getAttribute("data-size")).toBe("wide");
      expect(dialog.classList.contains("overflow-y-auto")).toBe(false);
      const scrollers = dialog.querySelectorAll(".overflow-y-auto");
      expect(scrollers).toHaveLength(1);
      expect(scrollers[0]?.getAttribute("data-slot")).toBe("sheet-body");
      expect(scrollers[0]?.classList.contains("overflow-x-hidden")).toBe(true);
      const form = scrollers[0]?.querySelector("form");
      expect(form).toBeTruthy();
      expect(scrollers[0]?.querySelector('[data-slot="sheet-header"]')).toBeNull();
      const footer = dialog.querySelector('[data-slot="sheet-footer"]');
      const cancel = screen.getByRole("button", { name: "common:actions.cancel" });
      expect(footer?.contains(cancel)).toBe(true);
      expect(scrollers[0]?.contains(cancel)).toBe(false);
      const submit = footer?.querySelector<HTMLButtonElement>('button[type="submit"]');
      expect(submit?.form).toBe(form);
      fireEvent.click(screen.getByRole("radio", { name: "access:agents.onlyNodes" }));
      await screen.findByText("access:agents.noNodes");
      expect(dialog.querySelectorAll(".overflow-y-auto")).toHaveLength(1);
      fireEvent.click(screen.getByRole("button", { name: "common:actions.cancel" }));
      expect(close).toHaveBeenCalledOnce();
      if (kind === "create") expect(close).toHaveBeenCalledWith(false);
    },
  );

  it("keeps every expiry preset visible in a wrapping grid with touch targets", async () => {
    mount(<CreateAgentTokenDialog open mcpUrl={null} onOpenChange={vi.fn()} />);
    const expiry = await screen.findByRole("group", { name: "access:fields.expiry" });
    const presets = expiry.querySelector<HTMLElement>(".grid");
    if (!presets) throw new Error("no expiry grid");
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
