// @vitest-environment jsdom

import {
  createBrowserHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentType, ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AuthSessionState } from "@/lib/auth-session-state";

const shell = vi.hoisted(() => ({
  hidden: false,
  realOutlet: false,
  identityHook: vi.fn(),
  refetch: vi.fn(),
  resetPassword: vi.fn(),
  checked: null as string | null | undefined,
  authState: { status: "anonymous", session: null } as AuthSessionState["state"],
}));
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const original = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...original,
    createRootRouteWithContext: () => (options: { component: ComponentType }) => ({ options }),
    Outlet: () => (shell.realOutlet ? <original.Outlet /> : <p>Page content</p>),
  };
});
vi.mock("@tanstack/react-query-devtools", () => ({ ReactQueryDevtools: () => null }));
vi.mock("@tanstack/react-router-devtools", () => ({ TanStackRouterDevtools: () => null }));
vi.mock("@ws-model-proxy/env/web", () => ({ env: { VITE_APP_NAME: "Proxy" } }));
vi.mock("@ws-model-proxy/ui/components/sileo", () => ({ Toaster: () => null }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  I18nextProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("@/i18n/I18nReady", () => ({
  I18nReady: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/ui-labels-bridge", () => ({
  UiLabelsBridge: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/theme-provider", () => ({
  ThemeProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/header", () => ({ default: () => <header>Header</header> }));
vi.mock("@/components/bottom-nav", () => ({ default: () => null }));
vi.mock("@/components/theme-color-sync", () => ({ ThemeColorSync: () => null }));
vi.mock("@/components/file-drop-guard", () => ({ FileDropGuard: () => null }));
vi.mock("@/components/error-state", () => ({ default: () => null }));
vi.mock("@/hooks/use-reload-on-identity-change", () => ({
  useReloadOnIdentityChange: shell.identityHook,
}));
vi.mock("@/hooks/use-auth-session", async () => {
  const { useSyncExternalStore } = await import("react");
  const identity = await import("@/lib/document-identity");
  return {
    useAuthSession: () => ({
      state: shell.authState,
      actions: { refetch: shell.refetch },
      meta: { isDegraded: false, isRefetching: false },
    }),
    readSessionIdentity: () => shell.checked,
    isSessionFetchInFlight: () => false,
    // The real verification state, read as the real hook reads it.
    useIdentityUnverified: () =>
      useSyncExternalStore(
        identity.subscribeIdentityVerification,
        identity.isDocumentIdentityUnverified,
        () => false,
      ),
  };
});
vi.mock("@/components/page-skeleton", () => ({ PageSkeleton: () => <p>Page skeleton</p> }));
vi.mock("@/hooks/use-app-update", () => ({ useAppUpdate: () => undefined }));
vi.mock("@/hooks/use-stale-build-recovery", () => ({ useStaleBuildRecovery: () => undefined }));
vi.mock("@/hooks/use-document-lang", () => ({ useDocumentLang: () => undefined }));
vi.mock("@/hooks/use-hash-target-scroll", () => ({ useHashTargetScroll: () => undefined }));
vi.mock("@/hooks/use-user-locale-sync", () => ({ useUserLocaleSync: () => undefined }));
vi.mock("@/hooks/use-node-live-updates", () => ({ useNodeLiveUpdates: () => undefined }));
vi.mock("@/hooks/use-mobile-keyboard", () => ({ useMobileKeyboard: () => false }));
vi.mock("@/stores/app-chrome", () => ({ useAppChrome: () => shell.hidden }));
vi.mock("@/utils/orpc", () => ({ orpc: {} }));
vi.mock("@/lib/auth-client", () => ({
  authClient: { resetPassword: shell.resetPassword },
}));
vi.mock("@ws-model-proxy/ui/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { ResetPasswordCard } from "@/components/auth/reset-password-card";
import {
  admitRouteIdentity,
  confirmDocumentIdentityFresh,
  identityVerificationGeneration,
  isDocumentIdentityUnverified,
  markAnonymousOnlyRoute,
  onDocumentReplaced,
  reportSessionRejected,
  resetDocumentIdentityForTests,
} from "@/lib/document-identity";
import { parseResetPasswordSearch } from "@/lib/reset-password-search";
import { resetSessionRetryForTests } from "@/lib/session-retry";
import { Route } from "./__root";

const locationDescriptor = Object.getOwnPropertyDescriptor(window, "location");
const Component = Route.options.component as ComponentType & { preload?: () => Promise<unknown> };
beforeAll(async () => {
  await Component.preload?.();
});
afterEach(() => {
  cleanup();
  if (locationDescriptor) Object.defineProperty(window, "location", locationDescriptor);
  document.documentElement.style.removeProperty("display");
  resetSessionRetryForTests();
  resetDocumentIdentityForTests(() => undefined);
  shell.hidden = false;
  shell.realOutlet = false;
  shell.authState = { status: "anonymous", session: null };
  shell.checked = null;
  shell.identityHook.mockReset();
  shell.refetch.mockReset();
  vi.clearAllMocks();
});
describe("root shell", () => {
  it("holds the matched page as a skeleton while the identity is unverified, keeping the watcher", () => {
    // A 401 while no watcher was connected (the root's error state, before an error reset
    // re-renders the previous account's retained matches without their guards).
    reportSessionRejected();
    render(<Component />);
    expect(screen.getByRole("paragraph")).toBe(screen.getByText("Page skeleton"));
    expect(screen.getByText("Page skeleton")).toBeTruthy();
    expect(shell.identityHook).toHaveBeenCalled();
    // The watcher's check confirms the document's account: the page comes back.
    act(() => confirmDocumentIdentityFresh(identityVerificationGeneration()));
    expect(screen.getByText("Page content")).toBeTruthy();
  });
  it.each([
    { owner: "a", checked: "a" },
    { owner: null, checked: null },
    { owner: "a", checked: "b" },
    { owner: "a", checked: null },
    { owner: null, checked: "b" },
  ])(
    "retains a reset form through peer verification, then admits only its owner ($owner → $checked)",
    async ({ owner, checked }) => {
      const { useReloadOnIdentityChange } = await vi.importActual<
        typeof import("@/hooks/use-reload-on-identity-change")
      >("@/hooks/use-reload-on-identity-change");
      shell.identityHook.mockImplementation(useReloadOnIdentityChange);
      shell.realOutlet = true;
      shell.authState =
        owner === null
          ? { status: "anonymous", session: null }
          : {
              status: "authenticated",
              session: { user: { id: owner, name: "A", email: "a@example.test" } },
            };
      shell.checked = owner;
      const peer = {
        postMessage: vi.fn(),
        onmessage: null as ((event: MessageEvent) => void) | null,
      };
      resetDocumentIdentityForTests(() => peer);
      await admitRouteIdentity({
        status: "resolved",
        session: owner === null ? null : { user: { id: owner } },
      });
      let finish!: () => void;
      shell.refetch.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      const token = "AbC123xyz0AbC123xyz0AbCd";
      window.history.replaceState(null, "", `/en-US/reset-password?token=${token}`);
      const root = createRootRoute({ component: () => <Component /> });
      const reset = createRoute({
        getParentRoute: () => root,
        path: "/$lang/reset-password",
        validateSearch: parseResetPasswordSearch,
        component: function ResetPage() {
          markAnonymousOnlyRoute();
          const { lang } = reset.useParams();
          const { token, error } = reset.useSearch();
          return <ResetPasswordCard lang={lang} token={token} error={error} />;
        },
      });
      const login = createRoute({
        getParentRoute: () => root,
        path: "/$lang/login",
        component: () => <p>Login page</p>,
      });
      const router = createRouter({
        routeTree: root.addChildren([reset, login]),
        history: createBrowserHistory(),
      });
      render(<RouterProvider router={router} />);
      const password = await screen.findByLabelText<HTMLInputElement>(
        "auth:resetPassword.newPassword",
      );
      const confirmation = screen.getByLabelText<HTMLInputElement>(
        "auth:resetPassword.confirmPassword",
      );
      await waitFor(() => {
        expect(window.location.search).not.toContain("token");
        expect((router.state.location.search as { token?: string }).token).toBeUndefined();
      });
      const user = userEvent.setup();
      await user.type(password, "new-password-1");
      await user.type(confirmation, "new-password-1");
      const since = identityVerificationGeneration();
      await act(async () => {
        // Both hints for a switch share one fresh check, even if the owner is unchanged.
        peer.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
        peer.onmessage?.({ data: { kind: "identity", id: "b" } } as MessageEvent);
      });
      expect(shell.refetch).toHaveBeenCalledTimes(1);
      expect(identityVerificationGeneration()).toBeGreaterThan(since);
      expect(password.isConnected).toBe(true);
      expect(password.value).toBe("new-password-1");
      expect(confirmation.isConnected).toBe(true);
      expect(confirmation.value).toBe("new-password-1");
      expect(screen.queryByRole("button", { name: "auth:resetPassword.submit" })).toBeNull();
      expect(screen.getByText("Page skeleton")).toBeTruthy();
      act(() => confirmDocumentIdentityFresh(since));
      expect(isDocumentIdentityUnverified()).toBe(true);
      expect(screen.queryByRole("button", { name: "auth:resetPassword.submit" })).toBeNull();
      const reload = vi.fn();
      const seal = vi.fn(() => expect(reload).not.toHaveBeenCalled());
      onDocumentReplaced(seal);
      if (checked !== owner) {
        Object.defineProperty(window, "location", {
          configurable: true,
          value: { ...window.location, reload },
        });
      }
      await act(async () => {
        shell.checked = checked;
        finish();
      });
      expect(shell.refetch).toHaveBeenCalledTimes(1);
      if (checked !== owner) {
        expect(seal).toHaveBeenCalledTimes(1);
        expect(reload).toHaveBeenCalledTimes(1);
        expect(document.documentElement.style.display).toBe("none");
        expect(shell.resetPassword).not.toHaveBeenCalled();
        return;
      }
      expect(seal).not.toHaveBeenCalled();
      expect(isDocumentIdentityUnverified()).toBe(false);
      expect(screen.queryByText("Page skeleton")).toBeNull();
      expect(screen.queryByText("auth:resetPassword.invalidTitle")).toBeNull();
      expect(screen.getByLabelText("auth:resetPassword.newPassword")).toBe(password);
      shell.resetPassword.mockResolvedValueOnce({ data: { status: true }, error: null });
      await user.click(screen.getByRole("button", { name: "auth:resetPassword.submit" }));
      await waitFor(() =>
        expect(shell.resetPassword).toHaveBeenCalledExactlyOnceWith({
          newPassword: "new-password-1",
          token,
        }),
      );
      await waitFor(() => expect(router.state.location.pathname).toBe("/en-US/login"));
    },
  );
  it("bounds its single grid column and owns contained vertical scrolling", () => {
    render(<Component />);
    const main = screen.getByRole("main");
    expect(main.parentElement?.classList.contains("grid-cols-[minmax(0,1fr)]")).toBe(true);
    for (const token of ["overflow-y-auto", "overflow-x-clip", "overscroll-contain"]) {
      expect(main.classList.contains(token)).toBe(true);
    }
    // No reserved gutter: full-bleed rules inside main reach the viewport edge (docs/ui.md § Shell rules).
    expect(main.className).not.toContain("scrollbar-gutter");
    expect(shell.identityHook).toHaveBeenCalledOnce();
  });
  it("puts an accessible skip link before the grid and makes main focusable", () => {
    render(<Component />);
    const link = screen.getByRole("link", { name: "skipToContent" });
    const main = screen.getByRole("main");
    expect(link.getAttribute("href")).toBe("#main-content");
    expect(link.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(main.id).toBe("main-content");
    expect(main.tabIndex).toBe(-1);
    expect(main.classList.contains("outline-none")).toBe(true);
  });
  it("leaves the maximized terminal all available width without a scrollbar gutter", () => {
    shell.hidden = true;
    render(<Component />);
    const main = screen.getByRole("main");
    expect(main.className).not.toContain("scrollbar-gutter");
    expect(main.parentElement?.classList.contains("grid-rows-[1fr]")).toBe(true);
    expect(screen.queryByText("Header")).toBeNull();
  });
  it("focuses main and prevents navigation when the skip link is activated by keyboard or pointer", () => {
    render(<Component />);
    const link = screen.getByRole("link", { name: "skipToContent" });
    const main = screen.getByRole("main");
    const historyLength = window.history.length;
    const url = window.location.href;
    for (const detail of [0, 1]) {
      main.scrollTop = 250;
      link.focus();
      // Keyboard activation dispatches a click with detail 0.
      expect(fireEvent.click(link, { detail })).toBe(false);
      expect(document.activeElement).toBe(main);
      expect(main.scrollTop).toBe(0);
      expect(window.history.length).toBe(historyLength);
      expect(window.location.href).toBe(url);
    }
  });
});
