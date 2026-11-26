// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

/** Providers → "Add account": one kind of control per choice, the quick path first. */

const state = vi.hoisted(() => ({
  calls: [] as unknown[],
  probes: [] as unknown[],
  probe: { ok: false, status: 401, detail: "invalid_credential" } as unknown,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    createFileRoute: () => (options: { component: ComponentType }) => ({
      options,
      useParams: () => ({ lang: "en-US" }),
    }),
    Link: ({ children }: { children: ReactNode }) => <a href="/">{children}</a>,
    useNavigate: () => async () => undefined,
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}(${JSON.stringify(options)})` : key,
  }),
}));
vi.mock("@ws-model-proxy/ui/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
// The dialog's body and its pinned footer, rendered in place.
vi.mock("@ws-model-proxy/ui/components/responsive-dialog", () => ({
  ResponsiveDialog: ({
    open,
    onOpenChange,
    title,
    children,
    footer,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: ReactNode;
    children: ReactNode;
    footer?: ReactNode;
  }) =>
    open ? (
      <div role="dialog" aria-label={String(title)}>
        <button type="button" onClick={() => onOpenChange(false)}>
          close
        </button>
        {children}
        <div data-testid="footer">{footer}</div>
      </div>
    ) : null,
}));
vi.mock("@/components/page-stub", () => ({ PageHeading: () => <h1>Providers</h1> }));
vi.mock("@/utils/orpc", () => ({
  orpc: {
    providers: {
      key: () => ["providers"],
      accounts: {
        list: {
          queryOptions: () => ({
            queryKey: ["providers", "accounts"],
            queryFn: async () => ({ accounts: [] }),
          }),
        },
        create: {
          mutationOptions: () => ({
            mutationFn: async (input: unknown) => {
              state.calls.push(input);
              return { id: "acc-1" };
            },
          }),
        },
      },
      credentials: {
        test: {
          mutationOptions: () => ({
            mutationFn: async (input: unknown) => {
              state.probes.push(input);
              return state.probe;
            },
          }),
        },
      },
    },
  },
}));

import { toast } from "@ws-model-proxy/ui/lib/toast";

import { Route } from "./index";

async function openDialog() {
  const Page = (Route as unknown as { options: { component: ComponentType } }).options.component;
  // Awaited: a first render that suspends (a module still loading) must be allowed to finish.
  await act(async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Page />
      </QueryClientProvider>,
    );
  });
  fireEvent.click(await screen.findByRole("button", { name: "dashboard:providers.add" }));
  return screen.findByRole("dialog", { name: "dashboard:providers.add" });
}

afterEach(() => {
  cleanup();
  state.calls = [];
  state.probes = [];
});

describe("Add account dialog", () => {
  it("starts on OpenRouter with the connection folded away and data collection Off in words", async () => {
    const dialog = await openDialog();
    // Provider is a segmented choice, never a native select next to Base UI controls.
    expect(dialog.querySelector("select")).toBeNull();
    expect(within(dialog).getByRole("button", { name: "OpenRouter" })).toBeTruthy();
    // The base URL and key type are under a collapsed "Connection details" with what they are.
    const details = dialog.querySelector(
      'details[data-slot="advanced-section"]',
    ) as HTMLDetailsElement;
    expect(details).toBeTruthy();
    expect(details.open).toBe(false);
    expect(details.textContent).toContain("https://openrouter.ai/api/v1");
    // The data-collection switch says its state.
    const collection = within(dialog).getByRole("switch", {
      name: /dashboard:providers\.form\.dataCollection/,
    });
    expect(collection.getAttribute("aria-checked")).toBe("false");
    expect(collection.closest("label")?.textContent).toContain("common:switchState.off");
    fireEvent.click(collection);
    expect(collection.closest("label")?.textContent).toContain("common:switchState.on");
    // Create stays in the pinned footer.
    expect(
      within(screen.getByTestId("footer")).getByRole("button", {
        name: "dashboard:providers.addButton",
      }),
    ).toBeTruthy();
  });

  it("keeps the folded connection summary on the URL that will be used", async () => {
    const dialog = await openDialog();
    const details = dialog.querySelector(
      'details[data-slot="advanced-section"]',
    ) as HTMLDetailsElement;
    details.open = true;
    fireEvent.change(within(dialog).getByLabelText("dashboard:providers.form.baseUrl"), {
      target: { value: "https://eu.openrouter.ai/api/v1" },
    });
    details.open = false;
    expect(details.querySelector("summary")?.textContent).toContain(
      "https://eu.openrouter.ai/api/v1",
    );
  });

  it("shows the connection up front for an OpenAI-compatible account, without data collection", async () => {
    const dialog = await openDialog();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "dashboard:providers.form.generic" }),
    );
    expect(dialog.querySelector('details[data-slot="advanced-section"]')).toBeNull();
    expect(
      (within(dialog).getByLabelText("dashboard:providers.form.baseUrl") as HTMLInputElement).value,
    ).toBe("");
    expect(within(dialog).queryByRole("switch")).toBeNull();
  });

  it("moves focus to the first invalid field on a failed add", async () => {
    const dialog = await openDialog();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "dashboard:providers.form.generic" }),
    );
    fireEvent.click(
      within(screen.getByTestId("footer")).getByRole("button", {
        name: "dashboard:providers.addButton",
      }),
    );
    const label = within(dialog).getByLabelText("dashboard:providers.form.label");
    await waitFor(() => expect(document.activeElement).toBe(label));
    expect(label.getAttribute("aria-invalid")).toBe("true");
    expect(state.calls).toEqual([]);
  });

  it("never keeps a pasted key after the dialog closes", async () => {
    let dialog = await openDialog();
    fireEvent.change(within(dialog).getByLabelText("dashboard:providers.form.key"), {
      target: { value: "sk-or-secret" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "dashboard:providers.add" }));
    dialog = await screen.findByRole("dialog", { name: "dashboard:providers.add" });
    expect(
      (within(dialog).getByLabelText("dashboard:providers.form.key") as HTMLInputElement).value,
    ).toBe("");
  });
  it("tests the key right after adding, and says what a refused key means", async () => {
    const dialog = await openDialog();
    fireEvent.change(within(dialog).getByLabelText("dashboard:providers.form.key"), {
      target: { value: "sk-or-v1-fake" },
    });
    fireEvent.click(
      within(screen.getByTestId("footer")).getByRole("button", {
        name: "dashboard:providers.addButton",
      }),
    );
    await waitFor(() => expect(state.probes).toEqual([{ accountId: "acc-1" }]));
    await waitFor(() =>
      expect(vi.mocked(toast.warning)).toHaveBeenCalledWith(
        expect.stringContaining("dashboard:providers.addedKeyFailed"),
      ),
    );
    expect(vi.mocked(toast.warning).mock.calls[0]?.[0]).toContain("testNext.invalid_credential");
  });
});
