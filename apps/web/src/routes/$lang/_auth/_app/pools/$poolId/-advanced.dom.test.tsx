// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { poolFixture } from "./-pool-fixture";

const state = vi.hoisted(() => ({
  update: vi.fn(),
  remove: vi.fn(),
  navigate: vi.fn(),
  updateError: null as unknown,
  toastError: vi.fn(),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useNavigate: () => state.navigate,
    createFileRoute: () => (options: { component: ComponentType }) => ({
      options,
      useParams: () => ({ lang: "en-US", poolId: "pool-1" }),
    }),
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${Object.values(options).map(String).join("|")}` : key,
    i18n: { language: "en-US" },
  }),
}));

vi.mock("@ws-model-proxy/ui/components/sileo", () => ({
  toast: { success: vi.fn(), error: (message: string) => state.toastError(message) },
}));

vi.mock("@ws-model-proxy/ui/components/responsive-dialog", () => ({
  ResponsiveDialog: ({
    open,
    title,
    children,
    footer,
  }: {
    open: boolean;
    title: ReactNode;
    children: ReactNode;
    footer?: ReactNode;
  }) =>
    open ? (
      <div role="dialog" aria-label={String(title)}>
        {children}
        {footer}
      </div>
    ) : null,
}));

vi.mock("@/utils/orpc", () => ({
  orpc: {
    pools: {
      key: () => ["pools"],
      get: {
        queryOptions: () => ({ queryKey: ["pools", "get"], queryFn: async () => poolFixture() }),
      },
      update: {
        mutationOptions: () => ({
          mutationFn: async (input: unknown) => {
            state.update(input);
            if (state.updateError) throw state.updateError;
            return poolFixture();
          },
        }),
      },
      delete: {
        mutationOptions: () => ({
          mutationFn: async (input: unknown) => {
            state.remove(input);
            return { ok: true };
          },
        }),
      },
      rules: { delete: { mutationOptions: () => ({ mutationFn: async () => ({ ok: true }) }) } },
    },
    models: { key: () => ["models"] },
    runtimes: { key: () => ["runtimes"] },
  },
}));

import { Route } from "./advanced";

const Component = Route.options.component as ComponentType & {
  preload?: () => Promise<unknown>;
};

beforeAll(async () => {
  await Component.preload?.();
}, 30_000);

async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Component />
    </QueryClientProvider>,
  );
  await screen.findByText("dashboard:pool.danger.title");
}

afterEach(() => {
  cleanup();
  state.update.mockReset();
  state.remove.mockReset();
  state.navigate.mockReset();
  state.toastError.mockReset();
  state.updateError = null;
});

async function openSlugDialog() {
  fireEvent.click(screen.getByRole("button", { name: "dashboard:pool.danger.slugButton" }));
  return screen.findByRole("dialog");
}

describe("pool advanced danger zone", () => {
  it("warns that the callable ID changes and needs the new slug typed twice", async () => {
    await mount();
    const dialog = await openSlugDialog();
    expect(dialog.getAttribute("aria-label")).toBe("dashboard:pool.danger.slugTitle");
    const slug = within(dialog).getByLabelText("dashboard:pool.danger.newSlug");
    const confirm = within(dialog).getByLabelText("dashboard:pool.danger.slugConfirm");
    const submit = within(dialog).getByRole("button", {
      name: "dashboard:pool.danger.slugButton",
    }) as HTMLButtonElement;

    fireEvent.change(slug, { target: { value: "team-chat" } });
    expect(within(dialog).getByText("dashboard:pool.danger.newId:ann/team-chat")).toBeTruthy();
    fireEvent.change(confirm, { target: { value: "team-cha" } });
    expect(submit.disabled).toBe(true);

    fireEvent.change(slug, { target: { value: "chat" } });
    fireEvent.change(confirm, { target: { value: "chat" } });
    fireEvent.click(submit);
    await within(dialog).findByText("dashboard:pool.danger.slugSame");
    expect(state.update).not.toHaveBeenCalled();

    fireEvent.change(slug, { target: { value: "team-chat" } });
    fireEvent.change(confirm, { target: { value: "team-chat" } });
    fireEvent.click(submit);
    await waitFor(() =>
      expect(state.update).toHaveBeenCalledWith({ poolId: "pool-1", slug: "team-chat" }),
    );
  });

  it("explains a slug an alias already uses", async () => {
    state.updateError = Object.assign(new Error("shadowed"), {
      data: { reason: "alias_shadowed", subjectId: null },
    });
    await mount();
    const dialog = await openSlugDialog();
    fireEvent.change(within(dialog).getByLabelText("dashboard:pool.danger.newSlug"), {
      target: { value: "gpt" },
    });
    fireEvent.change(within(dialog).getByLabelText("dashboard:pool.danger.slugConfirm"), {
      target: { value: "gpt" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "dashboard:pool.danger.slugButton" }),
    );
    await waitFor(() =>
      expect(state.toastError).toHaveBeenCalledWith("dashboard:pool.danger.slugAliased"),
    );
  });

  it("deletes the pool from here and leaves for the pool list", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "dashboard:pool.delete" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "common:actions.delete" }));
    await waitFor(() => expect(state.remove).toHaveBeenCalledWith({ poolId: "pool-1" }));
    await waitFor(() =>
      expect(state.navigate).toHaveBeenCalledWith({
        to: "/$lang/pools",
        params: { lang: "en-US" },
      }),
    );
  });
});
