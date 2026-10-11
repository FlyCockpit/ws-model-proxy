// @vitest-environment jsdom

import {
  createBrowserHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The reset page under the REAL router and browser history: the router patches
 * `history.replaceState`, so cleaning `?token=` out of the address bar re-reads the
 * route search. A valid link must still show the form and submit the token it arrived with.
 */

const resetPasswordMock = vi.hoisted(() => vi.fn());

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en-US" } }),
}));
vi.mock("@ws-model-proxy/ui/components/sileo", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/auth-client", () => ({
  authClient: { resetPassword: resetPasswordMock },
}));

import { parseResetPasswordSearch } from "@/lib/reset-password-search";
import { ResetPasswordCard } from "./reset-password-card";

const TOKEN = "AbC123xyz0AbC123xyz0AbCd";

function setup(url: string) {
  window.history.replaceState(null, "", url);
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const resetRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/$lang/reset-password",
    validateSearch: parseResetPasswordSearch,
    // Same wiring as routes/$lang/reset-password.tsx.
    component: function Page() {
      const { lang } = resetRoute.useParams();
      const { token, error } = resetRoute.useSearch();
      return <ResetPasswordCard lang={lang} token={token} error={error} />;
    },
  });
  const loginRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/$lang/login",
    component: () => <p>login page</p>,
  });
  const forgotRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/$lang/forgot-password",
    component: () => <p>forgot page</p>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([resetRoute, loginRoute, forgotRoute]),
    history: createBrowserHistory(),
  });
  render(<RouterProvider router={router} />);
  return router;
}

describe("ResetPasswordCard under the real router", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("keeps a valid link's form after the token leaves the address bar, and submits that token", async () => {
    const router = setup(`/en-US/reset-password?token=${TOKEN}`);
    const password = await screen.findByLabelText("auth:resetPassword.newPassword");

    // The address bar and the router's search no longer carry the token...
    await waitFor(() => expect(window.location.search).not.toContain("token"));
    await waitFor(() =>
      expect((router.state.location.search as { token?: string }).token).toBeUndefined(),
    );
    // ...and the page still shows the form, not the invalid-link branch.
    expect(screen.queryByText("auth:resetPassword.invalidTitle")).toBeNull();

    resetPasswordMock.mockResolvedValueOnce({ data: { status: true }, error: null });
    const user = userEvent.setup();
    await user.type(password, "new-password-1");
    await user.type(screen.getByLabelText("auth:resetPassword.confirmPassword"), "new-password-1");
    await user.click(screen.getByRole("button", { name: "auth:resetPassword.submit" }));

    await waitFor(() =>
      expect(resetPasswordMock).toHaveBeenCalledWith({
        newPassword: "new-password-1",
        token: TOKEN,
      }),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe("/en-US/login"));
  });

  it("refuses mismatched passwords without calling the server", async () => {
    setup(`/en-US/reset-password?token=${TOKEN}`);
    const user = userEvent.setup();
    await user.type(
      await screen.findByLabelText("auth:resetPassword.newPassword"),
      "new-password-1",
    );
    await user.type(screen.getByLabelText("auth:resetPassword.confirmPassword"), "new-password-2");
    await user.click(screen.getByRole("button", { name: "auth:resetPassword.submit" }));

    expect(await screen.findByText("auth:resetPassword.mismatch")).toBeTruthy();
    expect(resetPasswordMock).not.toHaveBeenCalled();
  });

  it("shows the invalid-link page for Better Auth's error redirect", async () => {
    setup("/en-US/reset-password?error=INVALID_TOKEN");
    expect(await screen.findByText("auth:resetPassword.invalidTitle")).toBeTruthy();
    expect(screen.getByText("auth:resetPassword.requestNew")).toBeTruthy();
  });

  it("switches to the invalid-link page when the server refuses the token", async () => {
    setup(`/en-US/reset-password?token=${TOKEN}`);
    resetPasswordMock.mockResolvedValueOnce({
      data: null,
      error: { status: 400, code: "INVALID_TOKEN", message: "Invalid token" },
    });
    const user = userEvent.setup();
    await user.type(
      await screen.findByLabelText("auth:resetPassword.newPassword"),
      "new-password-1",
    );
    await user.type(screen.getByLabelText("auth:resetPassword.confirmPassword"), "new-password-1");
    await user.click(screen.getByRole("button", { name: "auth:resetPassword.submit" }));

    expect(await screen.findByText("auth:resetPassword.invalidTitle")).toBeTruthy();
  });
});
