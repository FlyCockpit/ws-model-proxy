// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * A hard reload of a signed-in page: what shows while the layout still checks something is the
 * real app frame (the sidebar, the page frame) with only the page as a skeleton.
 */

const shell = vi.hoisted(() => ({ clientSession: null as null | { user: { role: string } } }));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    createFileRoute:
      () => (options: { component: ComponentType; pendingComponent: ComponentType }) => ({
        options,
        useParams: () => ({ lang: "en-US" }),
        useRouteContext: () => ({ session: { user: { id: "u1", twoFactorEnabled: false } } }),
      }),
    Outlet: () => <div data-testid="page" />,
    Link: ({ children }: { children: ReactNode }) => <a href="/x">{children}</a>,
    // The route guard already resolved the session (it is in the `_auth` match's context).
    useRouterState: ({
      select,
    }: {
      select: (state: { matches: unknown[]; location: { pathname: string } }) => unknown;
    }) =>
      select({
        location: { pathname: "/en-US/nodes" },
        matches: [
          { routeId: "__root__", context: {} },
          { routeId: "/$lang/_auth", context: { session: { user: { role: "user" } } } },
          {
            routeId: "/$lang/_auth/_app/nodes/",
            context: {},
            staticData: { pendingShape: "list" },
          },
        ],
      }),
    useMatch: ({ select }: { select: (match: { routeId: string }) => unknown }) =>
      select({ routeId: "/$lang/_auth" }),
  };
});
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en-US" } }),
}));
// The browser session is still loading, as on the first frame of a reload.
vi.mock("@/hooks/use-auth-session", () => ({
  useAuthSession: () => ({
    state: shell.clientSession
      ? { status: "authenticated", session: shell.clientSession }
      : { status: "pending", session: null },
  }),
}));
vi.mock("@/hooks/use-needs-you-count", () => ({ useNeedsYouCount: () => 0 }));
vi.mock("@/hooks/use-totp-enrollment", () => ({ useTotpEnrollment: () => ({ state: {} }) }));
vi.mock("@/server/auth-session", () => ({ getRouteSession: async () => null }));
vi.mock("@/utils/orpc", () => ({
  orpc: {
    settings: {
      // Never answers: the 2FA probe stays pending.
      get: {
        queryOptions: () => ({ queryKey: ["settings"], queryFn: () => new Promise(() => {}) }),
      },
    },
  },
}));

import { Route } from "./_auth";

type Options = { component: ComponentType; pendingComponent: ComponentType };
const options = (Route as unknown as { options: Options }).options;

/** Awaited: a first render that suspends (a module still loading) must be allowed to finish. */
async function mount(Component: ComponentType) {
  await act(async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Component />
      </QueryClientProvider>,
    );
  });
}

afterEach(() => {
  cleanup();
  shell.clientSession = null;
});

describe("/$lang/_auth loading states", () => {
  it("draws the app frame with its sidebar links while the 2FA probe runs", async () => {
    await mount(options.component);
    const sidebar = await waitFor(() => {
      const found = document.querySelector('[data-app-nav="sidebar"]');
      if (!found) throw new Error("no sidebar yet");
      return found;
    });
    expect(sidebar).toBeTruthy();
    // The signed-in navigation is there already (from the route guard's session).
    expect(sidebar?.querySelectorAll("a").length).toBeGreaterThan(0);
    expect(document.querySelector("[data-page-skeleton]")).toBeTruthy();
    // In the page's own shape: the nodes page is a list (its route's staticData).
    expect(
      document.querySelector("[data-route-skeleton]")?.getAttribute("data-route-skeleton"),
    ).toBe("list");
    expect(document.querySelector('[data-testid="page"]')).toBeNull();
  });

  it("draws the same frame while the session check itself is pending", async () => {
    await mount(options.pendingComponent);
    await waitFor(() => expect(document.querySelector('[data-app-nav="sidebar"]')).toBeTruthy());
    expect(document.querySelector("[data-page-skeleton]")).toBeTruthy();
  });
});
