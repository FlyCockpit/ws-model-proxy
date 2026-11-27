import { ORPCError } from "@orpc/client";
import { toast } from "@ws-model-proxy/ui/lib/toast";
import { createInstance } from "i18next";
import type { ReactNode, RefObject } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import enAdmin from "@/locales/en-US/admin.json";
import enCommon from "@/locales/en-US/common.json";
import esAdmin from "@/locales/es-MX/admin.json";
import esCommon from "@/locales/es-MX/common.json";

import { friendly } from "@/utils/friendly-error";

// No browser/DOM dependency: render the real route and dialog with inert UI
// primitives, drive their captured event handlers, then render the next state.
// These tests assert props and markup only, not browser focus movement, focus
// restoration, Escape/backdrop dispatch, or measured viewport fit.
type Control = {
  children?: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
  className?: string;
  ref?: RefObject<HTMLButtonElement | null>;
};
type MutationOptions = {
  mutationKey: [string, ...string[]];
  onSuccess?: () => void;
  onError?: (error: unknown) => void;
  meta?: { skipGlobalErrorToast?: boolean };
};
const fixture = vi.hoisted(() => ({
  states: [] as unknown[],
  cursor: 0,
  buttons: [] as Control[],
  items: [] as Control[],
  dialog: undefined as { open: boolean; onOpenChange: (open: boolean) => void } | undefined,
  popup: undefined as { initialFocus: unknown; showCloseButton: boolean } | undefined,
  role: { mutate: vi.fn(), reset: vi.fn(), isPending: false, error: null as Error | null },
  success: undefined as (() => void) | undefined,
  mutations: {} as Record<string, MutationOptions>,
  user: {
    id: "target-id",
    name: "Ana García",
    email: "ana@example.com",
    role: "user",
    emailVerified: true,
    invitePending: false,
    banned: false,
    banReason: null,
    createdAt: "2026-01-01T00:00:00Z",
  },
}));
const i18n = createInstance();
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = fixture.cursor++;
    if (!(index in fixture.states)) fixture.states[index] = initial;
    return [
      fixture.states[index],
      (next: unknown) => {
        fixture.states[index] = next;
      },
    ];
  },
}));
vi.mock("react-i18next", () => ({
  useTranslation: (ns: string | string[]) => ({ t: i18n.getFixedT(null, ns), i18n }),
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: { component: () => ReactNode }) => ({
    options,
    useRouteContext: () => ({ session: { user: { id: "actor-id" } } }),
    useParams: () => ({ lang: "en-US" }),
  }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useQuery: () => ({ data: { users: [fixture.user], total: 1 }, isPending: false, isError: false }),
  useMutation: (options: MutationOptions) => {
    fixture.mutations[options.mutationKey[0]] = options;
    if (options.mutationKey[0] === "setRole") {
      fixture.success = options.onSuccess;
      return fixture.role;
    }
    if (options.mutationKey[0] === "setRole") {
      fixture.success = options.onSuccess;
      return fixture.role;
    }
    return { mutate: vi.fn(), isPending: false };
  },
}));
vi.mock("@tanstack/react-form", () => ({
  useForm: () => ({ Field: () => null, Subscribe: () => null }),
}));
vi.mock("@/utils/orpc", () => {
  const mutation = (key: string) => ({
    mutationOptions: (options = {}) => ({ ...options, mutationKey: [key] }),
  });
  return {
    orpc: {
      app: { config: { queryOptions: () => ({}) } },
      users: {
        key: () => ["users"],
        list: { queryOptions: () => ({}) },
        setRole: mutation("setRole"),
        archive: mutation("archive"),
        unarchive: mutation("unarchive"),
        remove: mutation("remove"),
        resendInvite: mutation("resendInvite"),
        invite: mutation("invite"),
      },
    },
  };
});
vi.mock("@/hooks/use-debounced-value", () => ({ useDebouncedValue: (value: string) => value }));
vi.mock("@/hooks/use-haptics", () => ({ useHaptics: () => ({ trigger: vi.fn() }) }));
vi.mock("@ws-model-proxy/ui/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/archive-undo", () => ({ announceArchivedWithUndo: vi.fn() }));
vi.mock("@/utils/friendly-error", async (original) => ({
  ...(await original<typeof import("@/utils/friendly-error")>()),
  friendly: vi.fn(() => "Unexpected error"),
}));
vi.mock("@/components/confirm-delete-dialog", () => ({ ConfirmDeleteDialog: () => null }));
vi.mock("@/components/page-shell", () => ({
  PageHeader: () => null,
  PageShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/query-boundary", () => ({
  QueryBoundary: ({ children }: { children: () => ReactNode }) => children(),
}));
vi.mock("@/components/load-more", () => ({ LoadMore: () => null }));
vi.mock("@/components/segmented-control", () => ({ SegmentedControl: () => null }));
vi.mock("@ws-model-proxy/ui/components/button", () => ({
  Button: (props: Control) => {
    fixture.buttons.push(props);
    return (
      <button type="button" disabled={props.disabled} className={props.className}>
        {props.children}
      </button>
    );
  },
}));
vi.mock("@ws-model-proxy/ui/components/dropdown-menu", () => {
  const Part = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    DropdownMenu: Part,
    DropdownMenuContent: Part,
    DropdownMenuTrigger: Part,
    DropdownMenuItem: (props: Control) => {
      fixture.items.push(props);
      return <div>{props.children}</div>;
    },
  };
});
vi.mock("@ws-model-proxy/ui/components/dialog", () => {
  const Part = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Dialog: (props: {
      open: boolean;
      onOpenChange: (open: boolean) => void;
      children: ReactNode;
    }) => {
      // Ignore the closed invite/reveal dialogs when inspecting the role dialog.
      fixture.dialog = props;
      return props.open ? <div role="dialog">{props.children}</div> : null;
    },
    DialogContent: (props: {
      initialFocus: unknown;
      showCloseButton: boolean;
      children: ReactNode;
    }) => {
      fixture.popup = props;
      return <div>{props.children}</div>;
    },
    DialogHeader: Part,
    DialogTitle: Part,
    DialogDescription: Part,
    DialogFooter: Part,
  };
});

const { Route } = await import("@/routes/$lang/admin/users");
await (Route.options.component as { preload?: () => Promise<void> })?.preload?.();

function render() {
  fixture.cursor = 0;
  fixture.buttons = [];
  fixture.items = [];
  fixture.popup = undefined;
  const Component = Route.options.component;
  if (!Component) throw new Error("Missing users route component");
  return renderToStaticMarkup(<Component />);
}
function label(control: Control) {
  return renderToStaticMarkup(control.children);
}
function button(text: string) {
  const found = fixture.buttons.find((control) => label(control) === text);
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}
function openRoleDialog() {
  render();
  const menuText = i18n.t(
    fixture.user.role === "admin" ? "admin:users.demoteToUser" : "admin:users.promoteToAdmin",
  );
  const item = fixture.items.find((control) => label(control).includes(menuText));
  if (!item) throw new Error("Missing role menu item");
  item.onClick?.();
  return render();
}

describe("RoleChangeDialog in the admin users menu", () => {
  beforeAll(async () => {
    await i18n.init({
      lng: "en-US",
      fallbackLng: "en-US",
      defaultNS: "admin",
      resources: {
        "en-US": { admin: enAdmin, common: enCommon },
        "es-MX": { admin: esAdmin, common: esCommon },
      },
      interpolation: { escapeValue: false },
    });
  });
  beforeEach(async () => {
    await i18n.changeLanguage("en-US");
    fixture.states = [];
    fixture.mutations = {};
    fixture.role.isPending = false;
    fixture.role.error = null;
    fixture.user.role = "user";
    fixture.user.name = "Ana García";
    fixture.user.email = "ana@example.com";
    vi.clearAllMocks();
  });

  it("opens from the menu, names the user and powers, and mutates only on confirm", () => {
    expect(render()).not.toContain('role="dialog"');
    const html = openRoleDialog();
    expect(html).toContain('role="dialog"');
    expect(html).toContain("Ana García (ana@example.com)");
    expect(html).toContain("manage users, roles, and app settings");
    expect(fixture.role.mutate).not.toHaveBeenCalled();
    expect(fixture.role.reset).toHaveBeenCalledOnce();
    button("Make Ana García an admin").onClick?.();
    expect(fixture.role.mutate).toHaveBeenCalledExactlyOnceWith({
      userId: "target-id",
      role: "admin",
    });
    fixture.success?.();
    expect(render()).not.toContain('role="dialog"');
  });

  it("passes Cancel as the initial-focus ref and cancels without changing a role", () => {
    openRoleDialog();
    expect(fixture.popup?.initialFocus).toBe(button("Cancel").ref);
    button("Cancel").onClick?.();
    expect(render()).not.toContain('role="dialog"');
    expect(fixture.role.mutate).not.toHaveBeenCalled();
  });

  it("confirms demotion with the user's identity and loss of access", () => {
    fixture.user.role = "admin";
    const html = openRoleDialog();
    expect(html).toContain("Ana García (ana@example.com)");
    expect(html).toContain("will lose access to the admin dashboard");
    expect(fixture.role.mutate).not.toHaveBeenCalled();
    button("Remove admin access").onClick?.();
    expect(fixture.role.mutate).toHaveBeenCalledExactlyOnceWith({
      userId: "target-id",
      role: "user",
    });
  });

  it("disables actions and ignores close callbacks and repeat confirms while pending", () => {
    openRoleDialog();
    fixture.role.isPending = true;
    render();
    expect(button("Cancel").disabled).toBe(true);
    expect(button("Updating role…").disabled).toBe(true);
    expect(fixture.popup?.showCloseButton).toBe(false);
    button("Cancel").onClick?.();
    fixture.dialog?.onOpenChange(false);
    button("Updating role…").onClick?.();
    expect(render()).toContain('role="dialog"');
    expect(fixture.role.mutate).not.toHaveBeenCalled();
  });

  it("keeps the dialog open with translated refusal copy after failure and allows retry", () => {
    openRoleDialog();
    button("Make Ana García an admin").onClick?.();
    fixture.role.error = new ORPCError("FORBIDDEN", {
      message: "server English must not leak",
      data: { reason: "LAST_ACTIVE_ADMIN" },
    });
    const html = render();
    expect(html).toContain('role="dialog"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("You cannot remove the last active admin.");
    expect(html).not.toContain("server English must not leak");
    expect(button("Make Ana García an admin").disabled).toBe(false);
  });

  it.each([
    ["en-US", "SELF_DEMOTION", "You cannot remove your own admin role."],
    ["en-US", "LAST_ACTIVE_ADMIN", "You cannot remove the last active admin."],
    ["en-US", "USER_NOT_FOUND", "This user was not found. Refresh the list and try again."],
    [
      "en-US",
      "USER_CHANGE_CONFLICT",
      "Another user change happened at the same time. Review the users and try again.",
    ],
    ["es-MX", "SELF_DEMOTION", "No puedes quitarte tu propio acceso de administrador."],
    ["es-MX", "LAST_ACTIVE_ADMIN", "No puedes quitar al último administrador activo."],
    [
      "es-MX",
      "USER_NOT_FOUND",
      "No se encontró a esta persona. Actualiza la lista e intenta de nuevo.",
    ],
    [
      "es-MX",
      "USER_CHANGE_CONFLICT",
      "Otra persona modificó una cuenta al mismo tiempo. Revisa la lista e intenta de nuevo.",
    ],
  ])("%s translates %s without displaying server copy", async (locale, reason, message) => {
    await i18n.changeLanguage(locale);
    openRoleDialog();
    fixture.role.error = new ORPCError("FORBIDDEN", {
      message: "server English must not leak",
      data: { reason },
    });
    const html = render();
    expect(html).toContain(message);
    expect(html).not.toContain("server English must not leak");
    expect(html).toContain('role="alert"');
  });

  it("formats unexpected failures without exposing raw exceptions", () => {
    openRoleDialog();
    fixture.role.error = new Error("private database details");
    const html = render();
    expect(html).toContain('role="dialog"');
    expect(html).toContain("Unexpected error");
    expect(html).not.toContain("private database details");
  });

  describe.each(["archive", "remove"])("%s errors", (operation) => {
    it.each([
      ["en-US", "LAST_ACTIVE_ADMIN", enAdmin.users.roleErrors.lastActiveAdmin],
      ["en-US", "USER_CHANGE_CONFLICT", enAdmin.users.roleErrors.conflict],
      ["en-US", "USER_NOT_FOUND", enAdmin.users.roleErrors.userNotFound],
      ["es-MX", "LAST_ACTIVE_ADMIN", esAdmin.users.roleErrors.lastActiveAdmin],
      ["es-MX", "USER_CHANGE_CONFLICT", esAdmin.users.roleErrors.conflict],
      ["es-MX", "USER_NOT_FOUND", esAdmin.users.roleErrors.userNotFound],
    ])("%s translates %s into an actionable toast", async (locale, reason, message) => {
      await i18n.changeLanguage(locale);
      render();
      const options = fixture.mutations[operation];
      if (!options) throw new Error(`Missing mutation: ${operation}`);
      const code =
        reason === "USER_CHANGE_CONFLICT"
          ? "CONFLICT"
          : reason === "USER_NOT_FOUND"
            ? "NOT_FOUND"
            : "FORBIDDEN";
      options.onError?.(
        new ORPCError(code, {
          message: "server English must not leak",
          data: { reason },
        }),
      );
      expect(toast.error).toHaveBeenCalledExactlyOnceWith(message);
      expect(options.meta?.skipGlobalErrorToast).toBe(true);
      expect(friendly).not.toHaveBeenCalled();
    });

    it.each([
      new Error("private database details"),
      new ORPCError("FORBIDDEN", { data: { reason: "UNKNOWN_REASON" } }),
    ])("uses a safe action-specific fallback for unexpected errors: %s", (error) => {
      render();
      const options = fixture.mutations[operation];
      if (!options) throw new Error(`Missing mutation: ${operation}`);
      options.onError?.(error);
      expect(friendly).toHaveBeenCalledExactlyOnceWith(
        error,
        operation === "archive" ? enAdmin.users.archiveFailed : enAdmin.users.deleteFailed,
      );
      expect(toast.error).toHaveBeenCalledExactlyOnceWith("Unexpected error");
      expect(options.meta?.skipGlobalErrorToast).toBe(true);
    });
  });

  it("keeps the captured target if the list refetches while the dialog is open", () => {
    openRoleDialog();
    fixture.user.name = "Changed name";
    fixture.user.email = "changed@example.com";
    expect(render()).toContain("Ana García (ana@example.com)");
  });

  it("renders Spanish copy and supplies wrapping classes for long identities and labels", async () => {
    await i18n.changeLanguage("es-MX");
    fixture.user.name = "Nombre".repeat(40);
    fixture.user.email = `${"correo".repeat(30)}@example.com`;
    const html = openRoleDialog();
    expect(html).toContain("podrá gestionar usuarios, roles y la configuración");
    const confirm = button(`Dar acceso de administrador a ${fixture.user.name}`);
    expect(confirm.className).toContain("whitespace-normal");
    expect(confirm.className).toContain("max-w-full");
    expect(html).toContain("[overflow-wrap:anywhere]");
  });
});
