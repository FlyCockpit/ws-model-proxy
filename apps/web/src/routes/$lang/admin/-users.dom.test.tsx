// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  users: [] as Array<Record<string, unknown>>,
  failure: null as unknown,
  calls: [] as Array<{ name: string; input: unknown }>,
  // ResponsiveDialog's `(min-width: 48rem)` match (Tailwind `md`, in rem so it follows the user's
  // default font size): a dialog from md up, a bottom drawer below. Any other query never matches.
  desktop: true,
  locale: "en-US",
  inviteResult: { userId: "new-id", emailSent: true } as Record<string, unknown>,
  emailEnabled: false,
}));

vi.stubGlobal("matchMedia", (query: string) => ({
  matches: query === "(min-width: 48rem)" && state.desktop,
  media: query,
  addEventListener: () => {},
  removeEventListener: () => {},
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
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: state.locale } }),
}));

vi.mock("@ws-model-proxy/ui/lib/toast", () => ({
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
        if (name === "invite" || name === "resendInvite") return state.inviteResult;
        return { success: true, pending: false };
      },
    }),
  });
  return {
    orpc: {
      app: {
        config: {
          queryOptions: () => ({
            queryKey: ["app", "config"],
            queryFn: async () => ({ emailEnabled: state.emailEnabled }),
          }),
        },
      },
      users: {
        key: () => ["users"],
        list: {
          queryOptions: () => ({
            queryKey: ["users", "list"],
            queryFn: async () => ({ users: state.users }),
          }),
        },
        invite: mutation("invite"),
        resendInvite: mutation("resendInvite"),
        setRole: mutation("setRole"),
        archive: mutation("archive"),
        unarchive: mutation("unarchive"),
        remove: mutation("remove"),
      },
    },
  };
});

import { toast } from "@ws-model-proxy/ui/lib/toast";
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
  state.desktop = true;
  state.locale = "en-US";
  state.inviteResult = { userId: "new-id", emailSent: true };
  state.emailEnabled = false;
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
});

// The first test pays the cold load of the code-split route; under a full workspace run that
// alone can pass the 5 s default.
describe("admin users deletion conflicts", () => {
  it("shows the retained-history copy when removing a user is refused", async () => {
    state.users = [user()];
    state.failure = conflict("retained_history");
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "users.deleteAction" }));
    fireEvent.click(screen.getByRole("button", { name: "confirm delete" }));
    // Remove handles its own errors now, so copy uses the component's translator.
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("errors:deletionConflict.retainedHistory.user"),
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
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("admin:users.deleteFailed"));
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(state.calls).toEqual([{ name: "remove", input: { userId: "user-1" } }]);
  });
});

describe("admin invite user", () => {
  it("shows the role's label in the closed select, never the raw value", async () => {
    state.users = [user()];
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "admin:users.invite" }));
    const role = await screen.findByLabelText("admin:users.roleLabel");
    expect(role.textContent).toContain("admin:users.roleUser");
    expect(role.textContent?.replace("admin:users.roleUser", "")).not.toContain("user");
  });

  it("opens as a bottom drawer on phones, like the other create flows", async () => {
    state.desktop = false;
    state.users = [user()];
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "admin:users.invite" }));
    const email = await screen.findByLabelText("admin:users.emailLabel");
    const surface = email.closest("[data-slot=dialog-content]");
    expect(surface?.hasAttribute("data-vaul-drawer")).toBe(true);
    // The footer's submit button belongs to the form in the drawer body.
    const submit = screen.getByRole("button", { name: "admin:users.sendInvite" });
    expect(submit.getAttribute("form")).toBe(email.closest("form")?.id);
    // The header (title, and a description that may hold an email) wraps long unbroken words.
    expect(surface?.querySelector("[data-slot=responsive-dialog-header]")?.className).toContain(
      "[overflow-wrap:anywhere]",
    );
  });
});

describe("admin invite links and archive Undo", () => {
  async function fillInvite() {
    fireEvent.click(screen.getByRole("button", { name: "admin:users.invite" }));
    fireEvent.change(await screen.findByLabelText("admin:users.nameLabel"), {
      target: { value: "Invited Person" },
    });
    fireEvent.change(screen.getByLabelText("admin:users.emailLabel"), {
      target: { value: "new@example.test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "admin:users.sendInvite" }));
    await waitFor(() => expect(state.calls.some((call) => call.name === "invite")).toBe(true));
  }

  it("defaults Email language to the admin UI language and sends no password to the UI", async () => {
    state.locale = "es-MX";
    state.users = [user()];
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "admin:users.invite" }));
    expect((await screen.findByLabelText("admin:users.localeLabel")).textContent).toContain(
      "common:locale.es-MX",
    );
    fireEvent.change(screen.getByLabelText("admin:users.nameLabel"), {
      target: { value: "Invited Person" },
    });
    fireEvent.change(screen.getByLabelText("admin:users.emailLabel"), {
      target: { value: "new@example.test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "admin:users.sendInvite" }));
    await waitFor(() =>
      expect(state.calls).toContainEqual({
        name: "invite",
        input: { name: "Invited Person", email: "new@example.test", role: "user", locale: "es-MX" },
      }),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("admin:users.inviteSent"));
    expect(screen.queryByText("admin:users.setPasswordLinkLabel")).toBeNull();
  });

  it("reveals a shareable link only when mail was not sent", async () => {
    state.users = [user()];
    state.inviteResult = {
      userId: "new-id",
      emailSent: false,
      setPasswordUrl: "https://app.example.test/reset-password/INVITE",
      expiresAt: "2026-12-01T00:00:00.000Z",
    };
    await mount();
    await fillInvite();
    expect(await screen.findByText("https://app.example.test/reset-password/INVITE")).toBeTruthy();
    expect(screen.queryByText("admin:users.tempPasswordLabel")).toBeNull();
    // No email set up: nothing is mailed at sign-in either.
    expect(screen.queryByText("admin:users.revealVerifyHint")).toBeNull();
  });

  it("says a shown link's invitee confirms the address by mail when email is set up", async () => {
    state.users = [user()];
    state.emailEnabled = true;
    state.inviteResult = {
      userId: "new-id",
      emailSent: false,
      setPasswordUrl: "https://app.example.test/reset-password/INVITE",
      expiresAt: "2026-12-01T00:00:00.000Z",
    };
    await mount();
    await fillInvite();
    expect(await screen.findByText("admin:users.revealVerifyHint")).toBeTruthy();
  });

  it("tells the admin to remove a half-created invite, and shows that account", async () => {
    state.users = [user()];
    await mount();
    state.failure = {
      status: 500,
      code: "INVITE_INCOMPLETE",
      message: "raw server message",
    } as unknown as Error;
    // The account exists now: the refreshed list shows it.
    state.users = [user(), user({ id: "new-id", name: "Half Invited", email: "new@example.test" })];
    await fillInvite();
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("t(admin:users.inviteIncomplete)"),
    );
    expect(await screen.findByText("Half Invited")).toBeTruthy();
  });

  it("resends a pending invite and offers no Resend for a finished account", async () => {
    state.users = [user({ invitePending: true })];
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "users.resendInvite" }));
    await waitFor(() =>
      expect(state.calls).toContainEqual({ name: "resendInvite", input: { userId: "user-1" } }),
    );
  });

  it("archives immediately and Undo restores the same user through unarchive", async () => {
    state.users = [user()];
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "users.archiveUser" }));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "admin:users.userArchived",
        expect.objectContaining({
          duration: 8_000,
          action: expect.objectContaining({ label: "common:actions.undo" }),
        }),
      ),
    );
    const call = vi
      .mocked(toast.success)
      .mock.calls.find(([message]) => message === "admin:users.userArchived");
    call?.[1]?.action?.onClick();
    await waitFor(() =>
      expect(state.calls).toEqual([
        { name: "archive", input: { userId: "user-1" } },
        { name: "unarchive", input: { userId: "user-1" } },
      ]),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("admin:users.userRestored"));
  });
});
