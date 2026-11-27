import { useRouterState } from "@tanstack/react-router";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { useTranslation } from "react-i18next";
import { AppNameLink } from "@/components/app-name-link";
import { AuthScreenSkeleton } from "@/components/auth/auth-form-skeleton";
import { McpPageSkeleton } from "@/components/mcp/mcp-page-skeleton";
import { PageSkeleton } from "@/components/page-skeleton";
import { useMountEffect } from "@/hooks/use-mount-effect";
import { DEFAULT_LOCALE, isSupportedLocale } from "@/i18n/config";
import { markAppShellHydrated } from "@/lib/app-shell-hydration";

/** `/$lang/<page>` pages a signed-out person sees: no app frame around them. */
const AUTH_PAGES = new Set([
  "login",
  "signup",
  "forgot-password",
  "reset-password",
  "verify-email",
]);

/** Top-level segments under `/$lang/_auth` and `/$lang/admin` in routeTree.gen.ts. */
const SIGNED_IN_PAGES = new Set([
  "access",
  "activity",
  "admin",
  "models",
  "nodes",
  "overview",
  "pools",
  "profiles",
  "providers",
  "runtimes",
  "settings",
  "terminals",
  "test",
  "welcome",
]);
const MCP_PAGES = new Set(["mcp-login", "mcp-consent"]);

/**
 * The parts of the app frame a path is drawn in once it loads: signed-in pages have the bottom
 * nav on phones, and all but the admin pages (their own tab strip) have the sidebar from `md`.
 */
export function shellPartsOf(pathname: string): { sidebar: boolean; bottomNav: boolean } {
  const [, lang = "", page = ""] = pathname.split("/");
  const signedIn = isSupportedLocale(lang) && SIGNED_IN_PAGES.has(page);
  return { sidebar: signedIn && page !== "admin", bottomNav: signedIn };
}

/**
 * What the document shows before the app has rendered (the server's HTML, then the root route's
 * pending state): the shell's own geometry (the header row, the sidebar column from `md`, the
 * page padding and the bottom nav on phones) with skeletons in place of what needs the session,
 * so the first paint is already the app's frame and nothing moves when it loads. The theme is
 * right too: the inline theme script has set it before this paints.
 */
export function ShellSkeleton() {
  const { t } = useTranslation("nav");
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const segment = pathname.split("/")[1];
  const lang = isSupportedLocale(segment) ? segment : DEFAULT_LOCALE;
  const parts = shellPartsOf(pathname);
  const page = pathname.split("/")[2] ?? "";
  const authPage = isSupportedLocale(segment) && AUTH_PAGES.has(page);
  const mcpPage = isSupportedLocale(segment) && MCP_PAGES.has(page);
  // The first effect of the hydrated (or client-rendered) skeleton: from here on a route guard
  // may change the URL (lib/app-shell-hydration.ts).
  useMountEffect(markAppShellHydrated);
  return (
    <>
      {/* The same landmarks as the loaded shell (root route): a skip link to <main>. */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:inline-flex focus:min-h-11 focus:items-center focus:bg-background focus:px-4 focus:text-foreground focus:ring-2 focus:ring-ring"
      >
        {t("skipToContent")}
      </a>
      <div
        data-shell-skeleton=""
        // APP_SHELL_ATTRIBUTE: what a guard looks for to know a server-rendered shell may still be
        // hydrating.
        data-app-shell=""
        className="grid h-svh min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[auto_1fr_auto] pb-[calc(3.5rem_+_var(--safe-area-bottom))] md:grid-rows-[auto_1fr] md:pb-0"
        style={{
          paddingTop: "var(--safe-area-top)",
          paddingLeft: "var(--safe-area-left)",
          paddingRight: "var(--safe-area-right)",
        }}
      >
        <div data-app-header="" className="min-w-0">
          <div className="flex min-w-0 flex-row items-center gap-4 px-4 py-2">
            <AppNameLink lang={lang} />
            <div aria-hidden="true" className="ml-auto flex shrink-0 items-center gap-2">
              <Skeleton className="size-11 rounded-md" />
              <Skeleton className="size-11 rounded-md" />
              <Skeleton className="h-11 w-11 rounded-md md:w-28" />
            </div>
          </div>
          <hr />
        </div>
        {/* Fixed to the bottom, so its place in the document is free: right after the header, it
            arrives with the first bytes of a slow load instead of last. */}
        {parts.bottomNav ? (
          <div
            aria-hidden="true"
            data-bottom-nav=""
            className="fixed right-0 bottom-0 left-0 z-50 border-t bg-background/80 md:hidden"
            style={{ paddingBottom: "var(--safe-area-bottom)" }}
          >
            <div className="flex h-(--bottom-nav-bar) items-center justify-around">
              {Array.from({ length: 5 }, (_, index) => (
                <Skeleton key={index} className="h-9 w-12 rounded-md" />
              ))}
            </div>
          </div>
        ) : null}
        <main
          id="main-content"
          tabIndex={-1}
          aria-busy="true"
          className="relative min-h-0 min-w-0 overflow-x-clip overflow-y-auto overscroll-contain outline-none [container-type:size]"
        >
          <div className="flex min-h-full min-w-0 flex-col md:flex-row">
            {parts.sidebar ? (
              <div
                aria-hidden="true"
                className="hidden w-60 shrink-0 flex-col gap-1 self-stretch border-e border-sidebar-border bg-sidebar p-2 md:flex"
              >
                <div className="flex justify-end pb-1">
                  <Skeleton className="size-11 rounded-md" />
                </div>
                {Array.from({ length: 8 }, (_, index) => (
                  <Skeleton key={index} className="h-11 w-full rounded-md" />
                ))}
              </div>
            ) : null}
            <div className="flex min-h-0 min-w-0 max-w-full flex-1 flex-col">
              {parts.sidebar ? (
                <div className="container mx-auto flex min-w-0 max-w-6xl flex-col px-4 py-4 md:py-6">
                  <PageSkeleton />
                </div>
              ) : authPage ? (
                <AuthScreenSkeleton />
              ) : mcpPage ? (
                <McpPageSkeleton />
              ) : (
                // Admin and other public pages draw their own containers.
                <PageSkeleton pageContainer />
              )}
            </div>
          </div>
        </main>
      </div>
    </>
  );
}
