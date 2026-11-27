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
const copyLocale = vi.hoisted(() => ({ language: "en-US" as "en-US" | "es-MX" }));

vi.mock("react-i18next", async () => {
  const en = (await import("../../locales/en-US/auth.json")).default;
  const es = (await import("../../locales/es-MX/auth.json")).default;
  return {
    useTranslation: () => ({
      t: (key: string) => {
        const copy = (copyLocale.language === "en-US" ? en : es).resetPassword;
        const field = key.replace("auth:resetPassword.", "");
        return [
          "success",
          "description",
          "retryableFailed",
          "retry",
          "invalidDescription",
        ].includes(field)
          ? copy[field as keyof typeof copy]
          : key;
      },
      i18n: { language: copyLocale.language },
    }),
  };
});
vi.mock("@ws-model-proxy/ui/lib/toast", () => ({
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
    validateSearch: (search) => ({
      ...parseResetPasswordSearch(search),
      invite: search.invite === "1" || search.invite === 1 ? (1 as const) : undefined,
    }),
    // Same wiring as routes/$lang/reset-password.tsx.
    component: function Page() {
      const { lang } = resetRoute.useParams();
      const { token, error, invite } = resetRoute.useSearch();
      return <ResetPasswordCard lang={lang} token={token} error={error} invite={invite === 1} />;
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
    copyLocale.language = "en-US";
    vi.clearAllMocks();
  });

  it.each([
    ["en-US", /agent tokens/, /will stop working/],
    ["es-MX", /tokens de agente/, /dejarán de funcionar/],
  ] as const)(
    "warns about destroyed credentials before resetting in %s",
    async (locale, agents, integrations) => {
      copyLocale.language = locale;
      setup(`/${locale}/reset-password?token=${TOKEN}`);
      await screen.findByLabelText("auth:resetPassword.newPassword");
      const warning = screen.getByText(integrations);
      expect(warning.textContent).toMatch(/API/);
      expect(warning.textContent).toMatch(/MCP\/OAuth/);
      expect(warning.textContent).toMatch(agents);
      expect(warning.textContent).toMatch(
        locale === "en-US"
          ? /Node logins and enrollment codes/
          : /accesos de nodos y los códigos de inscripción/,
      );
      expect(warning.textContent).toMatch(
        locale === "en-US"
          ? /fresh enrollment code or a Replace code/
          : /inscripción nuevo o un código de reemplazo/,
      );
      const resetCopy =
        locale === "en-US"
          ? await import("../../locales/en-US/auth.json")
          : await import("../../locales/es-MX/auth.json");
      expect(resetCopy.default.resetPassword.success).toMatch(
        locale === "en-US"
          ? /node logins, and enrollment codes were revoked/
          : /accesos de nodos y los códigos de inscripción/,
      );
      expect(resetCopy.default.resetPassword.success).toMatch(
        locale === "en-US"
          ? /fresh enrollment or Replace code/
          : /inscripción nuevo o de reemplazo/,
      );
      expect(resetPasswordMock).not.toHaveBeenCalled();
      const settings =
        locale === "en-US"
          ? await import("../../locales/en-US/settings.json")
          : await import("../../locales/es-MX/settings.json");
      const changeWarning = settings.default.security.changePasswordDescription;
      expect(changeWarning).toMatch(/API/);
      expect(changeWarning).toMatch(/MCP\/OAuth/);
      expect(changeWarning).toMatch(agents);
      expect(changeWarning).toMatch(integrations);
    },
  );

  it("keeps a valid link's form after the token leaves the address bar, and submits that token", async () => {
    const router = setup(`/en-US/reset-password?token=${TOKEN}`);
    const password = await screen.findByLabelText("auth:resetPassword.newPassword");

    for (const label of ["auth:resetPassword.newPassword", "auth:resetPassword.confirmPassword"]) {
      const input = screen.getByLabelText(label);
      for (const token of ["h-11", "text-base", "md:h-8", "md:text-xs"]) {
        expect(input.classList.contains(token)).toBe(true);
      }
    }
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

  it.each([
    [
      "en-US",
      "We couldn't finish securing your account. Your password hasn't changed. Try again.",
      "Try again",
    ],
    [
      "es-MX",
      "No pudimos terminar de proteger tu cuenta. Tu contraseña no ha cambiado. Inténtalo de nuevo.",
      "Intentar de nuevo",
    ],
  ] as const)(
    "keeps the password and link for a retry after a pre-sweep 503 in %s",
    async (locale, message, retry) => {
      copyLocale.language = locale;
      const router = setup(`/${locale}/reset-password?token=${TOKEN}`);
      resetPasswordMock.mockResolvedValueOnce({
        data: null,
        error: { status: 503, message: "Service unavailable" },
      });
      const user = userEvent.setup();
      const password = await screen.findByLabelText("auth:resetPassword.newPassword");
      const confirmation = screen.getByLabelText("auth:resetPassword.confirmPassword");
      await user.type(password, "new-password-1");
      await user.type(confirmation, "new-password-1");
      await user.click(screen.getByRole("button", { name: "auth:resetPassword.submit" }));

      expect((await screen.findByRole("alert")).textContent).toBe(message);
      expect((password as HTMLInputElement).value).toBe("new-password-1");
      expect((confirmation as HTMLInputElement).value).toBe("new-password-1");
      expect(screen.queryByText("auth:resetPassword.invalidTitle")).toBeNull();
      expect(window.location.search).not.toContain("token");
      resetPasswordMock.mockResolvedValueOnce({ data: { status: true }, error: null });
      await user.click(screen.getByRole("button", { name: retry }));
      await waitFor(() => expect(router.state.location.pathname).toBe(`/${locale}/login`));
      expect(resetPasswordMock).toHaveBeenCalledTimes(2);
      expect(resetPasswordMock).toHaveBeenNthCalledWith(2, {
        newPassword: "new-password-1",
        token: TOKEN,
      });
    },
  );

  it.each(["en-US", "es-MX"] as const)(
    "switches to the invalid-link page when the server refuses the token in %s",
    async (locale) => {
      copyLocale.language = locale;
      setup(`/${locale}/reset-password?token=${TOKEN}`);
      resetPasswordMock.mockResolvedValueOnce({
        data: null,
        error: { status: 400, code: "INVALID_TOKEN", message: "Invalid token" },
      });
      const user = userEvent.setup();
      await user.type(
        await screen.findByLabelText("auth:resetPassword.newPassword"),
        "new-password-1",
      );
      await user.type(
        screen.getByLabelText("auth:resetPassword.confirmPassword"),
        "new-password-1",
      );
      await user.click(screen.getByRole("button", { name: "auth:resetPassword.submit" }));

      expect(await screen.findByText("auth:resetPassword.invalidTitle")).toBeTruthy();
      const copy = (await import(`../../locales/${locale}/auth.json`)).default.resetPassword;
      expect(screen.getByText(copy.invalidDescription)).toBeTruthy();
      expect(screen.queryByLabelText("auth:resetPassword.newPassword")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
    },
  );
});

describe("reset and invite visible headings", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });
  it.each([
    [`/en-US/reset-password?token=${TOKEN}`, "auth:resetPassword.title"],
    ["/en-US/reset-password?error=INVALID_TOKEN", "auth:resetPassword.invalidTitle"],
    ["/en-US/reset-password", "auth:resetPassword.invalidTitle"],
    [`/es-MX/reset-password?invite=1&token=${TOKEN}`, "auth:setPassword.title"],
    ["/es-MX/reset-password?invite=1&error=INVALID_TOKEN", "auth:setPassword.invalidTitle"],
  ])("%s has exactly one real h1 equal to the visible title", async (url, title) => {
    setup(url);
    const heading = await screen.findByRole("heading", { level: 1, name: title });
    expect(heading.tagName).toBe("H1");
    expect(document.querySelectorAll("h1")).toHaveLength(1);
    expect(document.querySelector('[role="heading"]')).toBeNull();
    if (url.includes("invite=1")) {
      await waitFor(() => expect(window.location.search).not.toContain("token="));
      expect(heading.textContent).toBe(title);
    }
  });
});
