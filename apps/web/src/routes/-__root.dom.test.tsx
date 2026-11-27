// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const shell = vi.hoisted(() => ({ hidden: false, identityHook: vi.fn() }));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createRootRouteWithContext: () => (options: { component: ComponentType }) => ({ options }),
  Outlet: () => <p>Page content</p>,
}));
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
    useAuthSession: () => ({ state: { session: null } }),
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

import {
  confirmDocumentIdentityFresh,
  identityVerificationGeneration,
  reportSessionRejected,
  resetDocumentIdentityForTests,
} from "@/lib/document-identity";
import { Route } from "./__root";

const Component = Route.options.component as ComponentType & { preload?: () => Promise<unknown> };
beforeAll(async () => {
  await Component.preload?.();
});
afterEach(() => {
  cleanup();
  resetDocumentIdentityForTests(() => undefined);
  shell.hidden = false;
  vi.clearAllMocks();
});
describe("root shell", () => {
  it("holds the matched page as a skeleton while the identity is unverified, keeping the watcher", () => {
    // A 401 while no watcher was connected (the root's error state, before an error reset
    // re-renders the previous account's retained matches without their guards).
    reportSessionRejected();
    render(<Component />);
    expect(screen.queryByText("Page content")).toBeNull();
    expect(screen.getByText("Page skeleton")).toBeTruthy();
    expect(shell.identityHook).toHaveBeenCalled();
    // The watcher's check confirms the document's account: the page comes back.
    act(() => confirmDocumentIdentityFresh(identityVerificationGeneration()));
    expect(screen.getByText("Page content")).toBeTruthy();
  });
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
