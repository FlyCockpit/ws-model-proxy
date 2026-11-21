// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  signOut: vi.fn(),
  mark: vi.fn(),
  undo: vi.fn(),
  assign: vi.fn(),
}));
vi.mock("@/lib/auth-client", () => ({ authClient: { signOut: boundary.signOut } }));
vi.mock("@/hooks/use-reload-on-identity-change", () => ({ markExplicitSignOut: boundary.mark }));
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
vi.mock("@ws-model-proxy/ui/components/dropdown-menu", () => {
  const Container = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return {
    DropdownMenu: Container,
    DropdownMenuContent: Container,
    DropdownMenuGroup: Container,
    DropdownMenuLabel: Container,
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuTrigger: Container,
    DropdownMenuItem: ({ children, onClick }: { children: ReactNode; onClick: () => void }) => (
      <button type="button" onClick={onClick}>
        {children}
      </button>
    ),
  };
});

import UserMenuContent from "./user-menu-content";

beforeEach(() => {
  boundary.mark.mockReturnValue(boundary.undo);
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { assign: boundary.assign },
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
describe("UserMenuContent sign-out", () => {
  it("marks explicit sign-out before the request and fully loads the localized login", async () => {
    boundary.signOut.mockImplementationOnce(
      async ({ fetchOptions }: { fetchOptions: { onSuccess: () => void } }) => {
        expect(boundary.mark).toHaveBeenCalledOnce();
        fetchOptions.onSuccess();
        return { error: null };
      },
    );
    render(<UserMenuContent />);
    fireEvent.click(screen.getByRole("button", { name: "userMenu.signOut" }));
    await waitFor(() => expect(boundary.assign).toHaveBeenCalledWith("/es-MX/login"));
    expect(boundary.undo).not.toHaveBeenCalled();
  });
  it("undoes the reload suppression on an auth error without navigating", async () => {
    boundary.signOut.mockImplementationOnce(
      async ({ fetchOptions }: { fetchOptions: { onError: () => void } }) => {
        fetchOptions.onError();
        return { error: { code: "FAILED" } };
      },
    );
    render(<UserMenuContent />);
    fireEvent.click(screen.getByRole("button", { name: "userMenu.signOut" }));
    await waitFor(() => expect(boundary.undo).toHaveBeenCalled());
    expect(boundary.assign).not.toHaveBeenCalled();
  });
  it("undoes the reload suppression when sign-out throws", async () => {
    boundary.signOut.mockRejectedValueOnce(new Error("offline"));
    render(<UserMenuContent />);
    fireEvent.click(screen.getByRole("button", { name: "userMenu.signOut" }));
    await waitFor(() => expect(boundary.undo).toHaveBeenCalledOnce());
    expect(boundary.assign).not.toHaveBeenCalled();
  });
});
