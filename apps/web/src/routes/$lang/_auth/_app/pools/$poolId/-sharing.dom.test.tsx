// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Pool · Sharing: the owner sees this pool's shares and invites (nothing of other pools), shares
 * it by e-mail, edits a share's settings, and removes contributed models by person. Anyone else
 * sees their own grant, read-only, or nothing.
 */

const state = vi.hoisted(() => ({
  calls: [] as Array<{ name: string; input: unknown }>,
  pool: null as Record<string, unknown> | null,
  shares: { byMe: [], withMe: [], invites: [] } as Record<string, unknown[]>,
  createAnswer: null as unknown,
  createError: null as unknown,
  revokeError: null as unknown,
  toastError: [] as string[],
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
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
  toast: {
    success: vi.fn(),
    error: (message: string) => state.toastError.push(message),
    warning: vi.fn(),
  },
}));

// Plain dialogs (the real ones need matchMedia and portals).
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

vi.mock("@/components/access/confirm-action", () => ({
  ConfirmAction: ({
    open,
    title,
    confirmLabel,
    onConfirm,
  }: {
    open: boolean;
    title: string;
    confirmLabel: string;
    onConfirm: () => void;
  }) =>
    open ? (
      <div role="alertdialog" aria-label={title}>
        <button type="button" onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    ) : null,
}));

// The refusal's reason stands in for its localized copy.
vi.mock("@/lib/refusal-text", () => ({
  refusalText: (error: { data?: { reason?: string } }) =>
    `refusal:${error?.data?.reason ?? "none"}`,
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
      pools: {
        key: () => ["pools"],
        get: query(["pools", "get"], () => {
          if (!state.pool) throw Object.assign(new Error("not found"), { code: "NOT_FOUND" });
          return state.pool;
        }),
        members: {
          removeContributed: mutation("pools.members.removeContributed", () => ({ ok: true })),
        },
      },
      access: {
        shares: {
          list: query(["access", "shares", "list"], () => state.shares),
          create: mutation("access.shares.create", () => {
            if (state.createError) throw state.createError;
            return state.createAnswer;
          }),
          update: mutation("access.shares.update", () => ({})),
          delete: mutation("access.shares.delete", () => ({ ok: true })),
        },
        invites: {
          resend: mutation("access.invites.resend", () => ({})),
          revoke: mutation("access.invites.revoke", () => {
            if (state.revokeError) throw state.revokeError;
            return { ok: true };
          }),
        },
      },
      runtimes: {
        get: { key: () => ["runtimes", "get"] },
        shares: { list: { key: () => ["runtimes", "shares", "list"] } },
      },
    },
  };
});

import { Route } from "./sharing";

function share(overrides: Record<string, unknown> = {}) {
  return {
    id: "share-1",
    poolId: "pool-1",
    callableId: "me/chat",
    ownerEmail: "me@example.test",
    granteeEmail: "ana@example.test",
    canUse: true,
    canContribute: true,
    priorityClass: null,
    protectionPercent: null,
    monthlyCap: null,
    ownKeyProviderModelId: null,
    ownKeyProtocolAdaptation: false,
    contributedMembers: 2,
    createdAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

function invite(overrides: Record<string, unknown> = {}) {
  return {
    id: "inv-1",
    target: { kind: "pool", poolId: "pool-1", callableId: "me/chat" },
    email: "bo@example.test",
    canUse: true,
    canContribute: false,
    priorityClass: "HIGH",
    createdAt: "2026-10-07T00:00:00.000Z",
    expiresAt: "2026-10-21T00:00:00.000Z",
    emailSentAt: null,
    ...overrides,
  };
}

function member(id: string, model: string, shareId: string | null, email: string | null) {
  return {
    id,
    kind: "LOCAL",
    state: "ACTIVE",
    status: "serving",
    weight: 1,
    runtimeModelId: `rm-${id}`,
    runtimeId: `rt-${id}`,
    runtimeSlug: "rt",
    upstreamModelId: model,
    shareId,
    contributorEmail: email,
    providerModelId: null,
    cloudOrder: null,
    health: "HEALTHY",
    live: { instances: 1, running: 0, waiting: 0, p95LatencyMs: null },
  };
}

function ownPool() {
  return {
    id: "pool-1",
    owner: { userId: "me", slug: "me", you: true },
    routing: { ownHardwareOnly: false },
    members: [
      member("m-own", "own-model", null, null),
      member("m-1", "qwen-7b", "share-1", "ana@example.test"),
      member("m-2", "llama-8b", "share-1", "ana@example.test"),
      member("m-3", "phi-4", "share-2", "cy@example.test"),
    ],
  };
}

async function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const Component = Route.options.component as ComponentType & {
    preload?: () => Promise<unknown>;
  };
  // The bundler splits route components: load it before rendering.
  await Component.preload?.();
  render(
    <QueryClientProvider client={client}>
      <Component />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  state.calls = [];
  state.pool = null;
  state.shares = { byMe: [], withMe: [], invites: [] };
  state.createAnswer = null;
  state.createError = null;
  state.revokeError = null;
  state.toastError = [];
});

describe("Pool · Sharing", { timeout: 30_000 }, () => {
  it("lists only this pool's shares and invites, and contributed models by person", async () => {
    state.pool = ownPool();
    state.shares = {
      byMe: [
        share({ protectionPercent: 25, priorityClass: "BACKGROUND" }),
        share({ id: "share-x", poolId: "pool-2", granteeEmail: "other-pool@example.test" }),
      ],
      withMe: [],
      invites: [
        invite(),
        invite({
          id: "inv-2",
          email: "elsewhere@example.test",
          target: { kind: "pool", poolId: "pool-2", callableId: "me/other" },
        }),
        invite({
          id: "inv-3",
          email: "runtime@example.test",
          target: { kind: "runtime", runtimeId: "rt-1", name: "Qwen" },
        }),
      ],
    };
    await mount();
    expect(await screen.findByText("bo@example.test", {}, { timeout: 10_000 })).toBeTruthy();
    // Once as a share, once as a contributor.
    expect(screen.getAllByText("ana@example.test")).toHaveLength(2);
    expect(screen.queryByText("other-pool@example.test")).toBeNull();
    expect(screen.queryByText("elsewhere@example.test")).toBeNull();
    expect(screen.queryByText("runtime@example.test")).toBeNull();
    // Priority and protection on the share; permission and priority on the invite.
    expect(
      screen.getByText(/access:shares\.protectionValue:25/, { exact: false }).textContent,
    ).toContain("access:shares.priorityValue:access:shares.priorityBackground");
    expect(
      screen.getByText(/access:shares\.priorityValue:access:shares\.priorityHigh/).textContent,
    ).toContain("access:shares.canUse");
    // The hardware-of-others notice, and models grouped by who contributed them.
    expect(screen.getByRole("note").textContent).toContain("dashboard:pool.sharing.othersHardware");
    expect(screen.getByText("cy@example.test")).toBeTruthy();
    expect(screen.getByText("qwen-7b")).toBeTruthy();
    expect(screen.getByText("llama-8b")).toBeTruthy();
    expect(screen.queryByText("own-model")).toBeNull();

    const row = screen.getByText("phi-4").closest("li");
    fireEvent.click(
      within(row as HTMLElement).getByRole("button", { name: "access:shares.remove" }),
    );
    const confirm = await screen.findByRole("alertdialog", {
      name: "dashboard:pool.sharing.removeContributedTitle:phi-4|cy@example.test",
    });
    fireEvent.click(within(confirm).getByRole("button", { name: "access:shares.remove" }));
    await waitFor(() =>
      expect(state.calls).toEqual([
        { name: "pools.members.removeContributed", input: { memberId: "m-3" } },
      ]),
    );
  });

  it("shares this pool by e-mail and shows the invite link once when no e-mail went out", async () => {
    state.pool = ownPool();
    const link = "https://proxy.example.com/en-US/signup?invite=wsmp_inv_ABCDEFGHIJKLMNOP";
    state.createAnswer = { kind: "invite", invite: invite(), link };
    await mount();
    fireEvent.change(await screen.findByLabelText("access:shares.email", {}, { timeout: 10_000 }), {
      target: { value: "Bo@Example.test" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: /^access:shares\.canContribute/ }));
    fireEvent.click(screen.getByRole("button", { name: "dashboard:pool.sharing.share" }));
    await waitFor(() =>
      expect(state.calls).toEqual([
        {
          name: "access.shares.create",
          input: {
            poolId: "pool-1",
            email: "bo@example.test",
            canUse: true,
            canContribute: true,
            priorityClass: null,
            protectionPercent: null,
            monthlyCap: null,
          },
        },
      ]),
    );
    const reveal = await screen.findByRole("dialog", { name: "access:shares.inviteLinkTitle" });
    expect(within(reveal).getByText(link)).toBeTruthy();
  });

  it("edits only the share settings that changed", async () => {
    state.pool = ownPool();
    state.shares = {
      byMe: [share({ monthlyCap: { limit: "10", currency: "USD", spentThisMonth: "2" } })],
      withMe: [],
      invites: [],
    };
    await mount();
    fireEvent.click(
      await screen.findByRole("button", { name: "access:shares.edit" }, { timeout: 10_000 }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "access:shares.editTitle:ana@example.test",
    });
    fireEvent.change(within(dialog).getByLabelText("access:shares.protection"), {
      target: { value: "40" },
    });
    fireEvent.change(within(dialog).getByLabelText("access:shares.capLimit"), {
      target: { value: "25.50" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "access:shares.save" }));
    await waitFor(() =>
      expect(state.calls).toEqual([
        {
          name: "access.shares.update",
          input: {
            shareId: "share-1",
            protectionPercent: 40,
            monthlyCap: { limit: "25.50", currency: "USD" },
          },
        },
      ]),
    );
  });

  it("names a pending invite to the same e-mail instead of calling it a share", async () => {
    state.pool = ownPool();
    state.createError = Object.assign(new Error("pending"), {
      code: "CONFLICT",
      status: 409,
      data: { reason: "invite_pending", subjectId: null },
    });
    await mount();
    fireEvent.change(await screen.findByLabelText("access:shares.email", {}, { timeout: 10_000 }), {
      target: { value: "bo@example.test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "dashboard:pool.sharing.share" }));
    await waitFor(() => expect(state.toastError).toEqual(["refusal:invite_pending"]));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("clears a cap with an empty limit, and sends nothing when nothing changed", async () => {
    state.pool = ownPool();
    state.shares = {
      byMe: [share({ monthlyCap: { limit: "12.5", currency: "EUR", spentThisMonth: "0" } })],
      withMe: [],
      invites: [],
    };
    await mount();
    const edit = await screen.findByRole(
      "button",
      { name: "access:shares.edit" },
      { timeout: 10_000 },
    );
    // Retyped with a trailing zero: the same cap, so no write.
    fireEvent.click(edit);
    let dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("access:shares.capLimit"), {
      target: { value: "12.50" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "access:shares.save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(state.calls).toEqual([]);
    // Emptied (with a currency left blank, which no cap needs): the cap goes.
    fireEvent.click(edit);
    dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("access:shares.capLimit"), {
      target: { value: "" },
    });
    fireEvent.change(within(dialog).getByLabelText("access:shares.capCurrency"), {
      target: { value: "" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "access:shares.save" }));
    await waitFor(() =>
      expect(state.calls).toEqual([
        { name: "access.shares.update", input: { shareId: "share-1", monthlyCap: null } },
      ]),
    );
  });

  it("says so when the invite was accepted before it could be withdrawn", async () => {
    state.pool = ownPool();
    state.shares = { byMe: [], withMe: [], invites: [invite()] };
    state.revokeError = Object.assign(new Error("accepted"), {
      code: "CONFLICT",
      status: 409,
      data: { reason: "invite_accepted", subjectId: null },
    });
    await mount();
    fireEvent.click(
      await screen.findByRole("button", { name: "access:shares.withdraw" }, { timeout: 10_000 }),
    );
    const confirm = await screen.findByRole("alertdialog", {
      name: "access:shares.withdrawTitle:bo@example.test",
    });
    fireEvent.click(within(confirm).getByRole("button", { name: "access:shares.withdraw" }));
    await waitFor(() => expect(state.toastError).toEqual(["refusal:invite_accepted"]));
  });

  it("shows a share holder their own grant, read-only", async () => {
    state.shares = {
      byMe: [],
      withMe: [share({ ownerEmail: "owner@example.test", priorityClass: "HIGH" })],
      invites: [],
    };
    await mount();
    expect(await screen.findByText("dashboard:pool.sharing.yourGrantTitle")).toBeTruthy();
    expect(screen.getByText("access:shares.from:owner@example.test")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByLabelText("access:shares.email")).toBeNull();
    // Not found is this page's expected answer for a share holder: no error toast.
    expect(state.toastError).toEqual([]);
  });

  it("shows nothing of a pool that is neither yours nor shared with you", async () => {
    await mount();
    expect(await screen.findByText("dashboard:pool.sharing.notYours")).toBeTruthy();
  });
});
