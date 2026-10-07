// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Access → Shares: a runtime definition is shared like a pool. Without a proved mailbox the
 * answer is an invite, and its link is shown once when no e-mail went out.
 */

const state = vi.hoisted(() => ({
  calls: [] as Array<{ name: string; input: unknown }>,
  invites: [] as Array<Record<string, unknown>>,
  runtimeAnswer: null as Record<string, unknown> | null,
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

// A plain dialog (the real one needs matchMedia).
vi.mock("@ws-model-proxy/ui/components/responsive-dialog", () => ({
  ResponsiveDialog: ({
    open,
    title,
    children,
  }: {
    open: boolean;
    title: string;
    children: ReactNode;
  }) =>
    open ? (
      <div role="dialog" aria-label={title}>
        {children}
      </div>
    ) : null,
}));

vi.mock("@/components/access/secret-reveal", () => ({
  SecretReveal: ({ value }: { value: string }) => <output>{value}</output>,
}));

vi.mock("@/utils/orpc", () => {
  const query = (path: string[], data: () => unknown) => ({
    key: () => path,
    queryOptions: () => ({ queryKey: path, queryFn: async () => data() }),
  });
  const mutation = (name: string, answer: () => unknown) => ({
    mutationOptions: (options?: Record<string, unknown>) => ({
      ...options,
      mutationFn: async (input: unknown) => {
        state.calls.push({ name, input });
        return answer();
      },
    }),
  });
  return {
    orpc: {
      access: {
        shares: {
          list: query(["access", "shares", "list"], () => ({
            byMe: [],
            withMe: [],
            invites: state.invites,
          })),
          create: mutation("access.shares.create", () => ({ kind: "share" })),
          update: mutation("access.shares.update", () => ({})),
          delete: mutation("access.shares.delete", () => ({ ok: true })),
        },
        invites: {
          resend: mutation("access.invites.resend", () => ({})),
          revoke: mutation("access.invites.revoke", () => ({ ok: true })),
        },
      },
      pools: { list: query(["pools", "list"], () => ({ pools: [] })) },
      runtimes: {
        key: () => ["runtimes"],
        get: { key: () => ["runtimes", "get"] },
        list: query(["runtimes", "list"], () => ({ runtimes: [{ id: "rt-1", name: "Qwen" }] })),
        shares: {
          list: query(["runtimes", "shares", "list"], () => ({
            sharedByMe: [],
            sharedWithMe: [],
          })),
          create: mutation("runtimes.shares.create", () => state.runtimeAnswer),
          delete: mutation("runtimes.shares.delete", () => ({ ok: true })),
        },
      },
    },
  };
});

import { Route } from "./shares";

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
  await screen.findByText("access:shares.invitesTitle");
}

function runtimeInvite(overrides: Record<string, unknown> = {}) {
  return {
    id: "inv-1",
    target: { kind: "runtime", runtimeId: "rt-1", name: "Qwen" },
    email: "friend@example.test",
    canUse: true,
    canContribute: false,
    priorityClass: null,
    createdAt: "2026-10-07T00:00:00.000Z",
    expiresAt: "2026-10-21T00:00:00.000Z",
    emailSentAt: null,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  state.calls = [];
  state.invites = [];
  state.runtimeAnswer = null;
});

describe("Access → Shares: runtime definitions", { timeout: 30_000 }, () => {
  it("shares a runtime and shows the invite link once when no e-mail went out", async () => {
    const link =
      "https://proxy.example.com/en-US/signup?invite=wsmp_inv_ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    state.runtimeAnswer = { kind: "invite", invite: runtimeInvite(), link };
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "access:shares.create" }));
    const dialog = await screen.findByRole("dialog", { name: "access:shares.createTitle" });
    fireEvent.click(within(dialog).getByRole("button", { name: "access:shares.whatRuntime" }));
    fireEvent.click(await within(dialog).findByRole("radio", { name: "Qwen" }));
    // The pool-only settings are gone for a runtime definition.
    expect(within(dialog).queryByText("access:shares.canContribute")).toBeNull();
    fireEvent.change(within(dialog).getByLabelText("access:shares.email"), {
      target: { value: "Friend@Example.test" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "access:shares.create" }));
    await waitFor(() =>
      expect(state.calls).toEqual([
        {
          name: "runtimes.shares.create",
          input: { runtimeId: "rt-1", email: "friend@example.test" },
        },
      ]),
    );
    const reveal = await screen.findByRole("dialog", { name: "access:shares.inviteLinkTitle" });
    expect(within(reveal).getByText(link)).toBeTruthy();
  });

  it("lists a pending runtime invite with its runtime definition", async () => {
    state.invites = [runtimeInvite()];
    await mount();
    expect(await screen.findByText("friend@example.test")).toBeTruthy();
    expect(screen.getByText("access:shares.runtimeTarget:Qwen")).toBeTruthy();
  });
});
