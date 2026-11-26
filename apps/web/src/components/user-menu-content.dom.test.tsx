// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  signOut: vi.fn(),
  mark: vi.fn(),
  undo: vi.fn(),
  leave: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock("@/lib/auth-client", () => ({ authClient: { signOut: boundary.signOut } }));
vi.mock("@/lib/document-identity", () => ({
  markExplicitSignOut: boundary.mark,
  leaveDocument: boundary.leave,
}));
vi.mock("@ws-model-proxy/ui/lib/toast", () => ({ toast: { error: boundary.toastError } }));
vi.mock("@/hooks/use-auth-session", () => ({
  useAuthSession: () => ({
    state: { session: { user: { id: "u1", name: "User", email: "user@example.test" } } },
  }),
}));
vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ lang: "es-MX" }),
  useNavigate: () => vi.fn(),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@ws-model-proxy/ui/components/dropdown-menu", async () => {
  const { cloneElement } = await import("react");
  const Container = ({
    children,
    className,
    align,
  }: {
    children: ReactNode;
    className?: string;
    align?: string;
  }) => (
    <div className={className} data-align={align}>
      {children}
    </div>
  );
  return {
    DropdownMenu: Container,
    DropdownMenuContent: Container,
    DropdownMenuGroup: Container,
    DropdownMenuLabel: Container,
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuTrigger: ({
      children,
      render,
      ...props
    }: {
      children: ReactNode;
      render: ReactElement<{ "aria-label"?: string }>;
      "aria-label"?: string;
    }) => cloneElement(render, props, children),
    DropdownMenuItem: ({
      children,
      onClick,
      inset,
    }: {
      children: ReactNode;
      onClick: () => void;
      inset?: boolean;
    }) => (
      <button type="button" onClick={onClick} data-inset={inset ? "" : undefined}>
        {children}
      </button>
    ),
  };
});

import UserMenuContent from "./user-menu-content";

beforeEach(() => {
  boundary.mark.mockReturnValue(boundary.undo);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
describe("UserMenuContent sign-out", () => {
  it("marks explicit sign-out before the request and leaves for the localized login", async () => {
    boundary.signOut.mockImplementationOnce(
      async ({ fetchOptions }: { fetchOptions: { onSuccess: () => void } }) => {
        expect(boundary.mark).toHaveBeenCalledOnce();
        fetchOptions.onSuccess();
        return { error: null };
      },
    );
    render(<UserMenuContent />);
    fireEvent.click(screen.getByRole("button", { name: "userMenu.signOut" }));
    // A quarantined full load (lib/document-identity.ts), not a client navigate.
    await waitFor(() => expect(boundary.leave).toHaveBeenCalledWith("/es-MX/login"));
    expect(boundary.undo).not.toHaveBeenCalled();
    expect(boundary.toastError).not.toHaveBeenCalled();
  });
  it("undoes the mark and says so on an auth error, without leaving", async () => {
    boundary.signOut.mockResolvedValueOnce({ error: { code: "FAILED" } });
    render(<UserMenuContent />);
    fireEvent.click(screen.getByRole("button", { name: "userMenu.signOut" }));
    await waitFor(() => expect(boundary.toastError).toHaveBeenCalledOnce());
    expect(boundary.undo).toHaveBeenCalledOnce();
    expect(boundary.leave).not.toHaveBeenCalled();
  });
  it("undoes the mark and says so when sign-out throws", async () => {
    boundary.signOut.mockRejectedValueOnce(new Error("offline"));
    render(<UserMenuContent />);
    fireEvent.click(screen.getByRole("button", { name: "userMenu.signOut" }));
    await waitFor(() => expect(boundary.toastError).toHaveBeenCalledOnce());
    expect(boundary.undo).toHaveBeenCalledOnce();
    expect(boundary.leave).not.toHaveBeenCalled();
  });
});
describe("UserMenuContent layout", () => {
  it("is at least 224px wide and truncates the email with the full address in its title", () => {
    render(<UserMenuContent />);
    const email = screen.getByText("user@example.test");
    expect(email.classList.contains("truncate")).toBe(true);
    expect(email.getAttribute("title")).toBe("user@example.test");
    expect(email.closest(".min-w-56")).not.toBeNull();
  });
  it("aligns the menu's trailing edge with the trigger's", () => {
    render(<UserMenuContent />);
    const email = screen.getByText("user@example.test");
    expect(email.closest(".min-w-56")?.getAttribute("data-align")).toBe("end");
  });
  it("caps and truncates the trigger's name at md+, with the full name in its title", () => {
    render(<UserMenuContent />);
    const trigger = screen.getByRole("button", { name: "userMenu.open" });
    for (const className of ["md:min-w-11", "md:max-w-48", "md:shrink"])
      expect(trigger.classList.contains(className)).toBe(true);
    expect(trigger.getAttribute("title")).toBe(trigger.querySelector(".truncate")?.textContent);
  });
  it("puts Sign Out on the menu's label line (inset), like the icon rows", () => {
    render(<UserMenuContent />);
    expect(
      screen.getByRole("button", { name: "userMenu.signOut" }).hasAttribute("data-inset"),
    ).toBe(true);
  });
});
