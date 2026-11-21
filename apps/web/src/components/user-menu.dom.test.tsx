// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthSessionState } from "@/lib/auth-session-state";

const boundary = vi.hoisted(() => ({
  state: { status: "anonymous", session: null } as AuthSessionState["state"],
}));
vi.mock("@/hooks/use-auth-session", () => ({ useAuthSession: () => ({ state: boundary.state }) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ lang: "en-US" }),
  Link: ({
    to,
    params,
    search: _search,
    ...props
  }: ComponentProps<"a"> & { to: string; params: { lang: string }; search?: object }) => (
    <a href={to.replace("$lang", params.lang)} {...props} />
  ),
}));
vi.mock("@/utils/orpc", () => ({
  orpc: {
    app: {
      config: {
        queryOptions: () => ({
          queryKey: ["config"],
          queryFn: async () => ({ signupEnabled: true }),
          initialData: { signupEnabled: true },
        }),
      },
    },
  },
}));
vi.mock("./user-menu-content", () => ({ default: () => <div role="menu">Open account</div> }));

import UserMenu from "./user-menu";

const signedIn = (id: string): AuthSessionState["state"] => ({
  status: "authenticated",
  session: { user: { id, name: id, email: `${id}@example.test` } },
});
afterEach(() => {
  cleanup();
  boundary.state = { status: "anonymous", session: null };
});
function setup() {
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(<UserMenu />, { wrapper });
}
describe("UserMenu", () => {
  it("keeps both signed-out actions accessible as links with a compact phone sign-up", () => {
    const view = setup();
    const signup = screen.getByRole("link", { name: "userMenu.signUp" });
    expect(signup.getAttribute("href")).toBe("/en-US/signup");
    expect(signup.classList.contains("w-11")).toBe(true);
    expect(screen.getByRole("link", { name: "userMenu.signIn" })).toBeTruthy();
    expect(view.container.querySelector("a button")).toBeNull();
  });
  it("shows a neutral disabled account button during an error carrying a known session", () => {
    boundary.state = { status: "error", session: signedIn("u1").session, error: new Error("429") };
    setup();
    expect(screen.getByRole("button", { name: "userMenu.open" }).hasAttribute("disabled")).toBe(
      true,
    );
    expect(screen.queryByRole("link", { name: "userMenu.signUp" })).toBeNull();
  });
  it("shows signed-out actions for a session error with no known identity", () => {
    boundary.state = { status: "error", session: null, error: new Error("offline") };
    setup();
    expect(screen.getByRole("link", { name: "userMenu.signIn" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "userMenu.signUp" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "userMenu.open" })).toBeNull();
  });
  it("keeps a neutral account button when an error follows a known signed-in identity", () => {
    boundary.state = signedIn("u1");
    const view = setup();
    boundary.state = { status: "error", session: null, error: new Error("offline") };
    view.rerender(<UserMenu />);
    expect(screen.getByRole("button", { name: "userMenu.open" }).hasAttribute("disabled")).toBe(
      true,
    );
    expect(screen.queryByRole("link", { name: "userMenu.signIn" })).toBeNull();
  });
  it("does not auto-open the lazy menu for a different identity", async () => {
    boundary.state = signedIn("u1");
    const view = setup();
    fireEvent.click(screen.getByRole("button", { name: "userMenu.open" }));
    expect(await screen.findByRole("menu")).toBeTruthy();
    boundary.state = signedIn("u2");
    view.rerender(<UserMenu />);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("button", { name: "userMenu.open" })).toBeTruthy();
  });
});
