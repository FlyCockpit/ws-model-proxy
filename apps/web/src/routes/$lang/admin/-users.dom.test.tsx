// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  users: [] as Array<Record<string, unknown>>,
  failure: null as unknown,
  calls: [] as Array<{ name: string; input: unknown }>,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    createFileRoute: () => (options: { component: ComponentType }) => ({
      options,
      useRouteContext: () => ({ session: { user: { id: "admin-id" } } }),
    }),
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@ws-model-proxy/ui/components/sileo", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/hooks/use-haptics", () => ({
  useHaptics: () => ({ trigger: () => undefined }),
}));

vi.mock("@/components/segmented-control", () => ({
  SegmentedControl: () => null,
}));

// The menu's own behavior is not under test: render every item as a button.
vi.mock("@ws-model-proxy/ui/components/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: () => null,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    disabled,
    onClick,
  }: {
    children: ReactNode;
    disabled?: boolean;
    onClick?: () => void;
  }) => (
    <button type="button" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/confirm-delete-dialog", () => ({
  ConfirmDeleteDialog: ({ open, onConfirm }: { open: boolean; onConfirm: () => void }) =>
    open ? (
      <button type="button" onClick={onConfirm}>
        confirm delete
      </button>
    ) : null,
}));

vi.mock("@/utils/orpc", () => {
  const mutation = (name: string) => ({
    mutationOptions: (options?: Record<string, unknown>) => ({
      ...options,
      mutationFn: async (input: unknown) => {
        state.calls.push({ name, input });
        if (state.failure) throw state.failure;
        return { success: true, pending: false };
      },
    }),
  });
  return {
    orpc: {
      users: {
        key: () => ["users"],
        list: {
          queryOptions: () => ({
            queryKey: ["users", "list"],
            queryFn: async () => ({ users: state.users }),
          }),
        },
        invite: mutation("invite"),
        setRole: mutation("setRole"),
        archive: mutation("archive"),
        unarchive: mutation("unarchive"),
        remove: mutation("remove"),
      },
    },
  };
});

import { toast } from "@ws-model-proxy/ui/components/sileo";
import { createAppMutationCache } from "@/utils/mutation-error-toast";
import { Route } from "./users";

function user(overrides: Record<string, unknown> = {}) {
  return {
    id: "user-1",
    email: "ada@example.com",
    name: "Ada",
    role: "user",
    emailVerified: true,
    banned: false,
    banReason: null,
    deletionRequestedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function conflict(reason: string) {
  return { status: 409, code: "CONFLICT", message: "raw server message", data: { reason } };
}

async function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    mutationCache: createAppMutationCache((key) => `t(${key})`),
  });
  // Route components are code-split; load this one before rendering.
  const Component = Route.options.component as ComponentType & {
    preload?: () => Promise<unknown>;
  };
  await Component.preload?.();
  render(
    <QueryClientProvider client={client}>
      <Component />
    </QueryClientProvider>,
  );
  await screen.findByText("Ada");
}

afterEach(() => {
  cleanup();
  state.users = [];
  state.failure = null;
  state.calls = [];
  vi.mocked(toast.error).mockClear();
});

// The first test pays the cold load of the code-split route; under a full workspace run that
// alone can pass the 5 s default.
describe("admin users deletion conflicts", { timeout: 30_000 }, () => {
  it("shows the retained-history copy when removing a user is refused", async () => {
    state.users = [user()];
    state.failure = conflict("retained_history");
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "users.deleteAction" }));
    fireEvent.click(screen.getByRole("button", { name: "confirm delete" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("t(errors:deletionConflict.retainedHistory.user)"),
    );
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(state.calls).toEqual([{ name: "remove", input: { userId: "user-1" } }]);
  });

  it("shows the deletion-in-progress copy when restoring a user being deleted", async () => {
    state.users = [user({ banned: true, deletionRequestedAt: "2026-01-02T00:00:00.000Z" })];
    state.failure = conflict("deletion_in_progress");
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "users.restoreUser" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("t(errors:deletionConflict.deletionInProgress)"),
    );
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(state.calls).toEqual([{ name: "unarchive", input: { userId: "user-1" } }]);
  });

  it("falls back to the action's own copy for a failure without a deletion reason", async () => {
    state.users = [user()];
    state.failure = { status: 500, code: "INTERNAL_SERVER_ERROR", message: "raw" };
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "users.deleteAction" }));
    fireEvent.click(screen.getByRole("button", { name: "confirm delete" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("t(admin:users.deleteFailed)"));
  });
});
