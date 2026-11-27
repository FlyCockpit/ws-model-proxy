// @vitest-environment jsdom
import { ORPCError, os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { BatchHandlerPlugin } from "@orpc/server/plugins";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn<typeof fetch>());
vi.mock("@ws-model-proxy/env/web", () => ({ env: { VITE_SERVER_URL: "https://app.test" } }));

const state = vi.hoisted(() => ({
  client: { status: "pending", session: null } as {
    status: string;
    session: null | { user: { role?: string | null } };
  },
  matches: [] as Array<{ context: unknown; routeId?: string }>,
  pathname: undefined as string | undefined,
}));

vi.mock("@tanstack/react-router", () => ({
  useRouterState: ({
    select,
  }: {
    select: (router: { matches: unknown[]; location?: { pathname: string } }) => unknown;
  }) =>
    select({
      matches: state.matches,
      ...(state.pathname ? { location: { pathname: state.pathname } } : {}),
    }),
}));
vi.mock("@/hooks/use-auth-session", async () => {
  const { useSyncExternalStore } = await import("react");
  const identity = await import("@/lib/document-identity");
  return {
    useAuthSession: () => ({ state: state.client }),
    // The real verification state, read as the real hook reads it.
    useIdentityUnverified: () =>
      useSyncExternalStore(
        identity.subscribeIdentityVerification,
        identity.isDocumentIdentityUnverified,
        () => false,
      ),
  };
});

import {
  confirmDocumentIdentityFresh,
  connectIdentityPeers,
  identityVerificationGeneration,
  needsAuthoritativeSessionCheck,
  reportSessionRejected,
  resetDocumentIdentityForTests,
} from "@/lib/document-identity";
import { useNeedsYouCount } from "./use-needs-you-count";
import { useShellIdentity } from "./use-shell-identity";

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});
afterEach(() => {
  cleanup();
  resetDocumentIdentityForTests(() => undefined);
  state.client = { status: "pending", session: null };
  state.matches = [];
  state.pathname = undefined;
  vi.unstubAllGlobals();
});

describe("useShellIdentity", () => {
  it("uses the route guard's session while the browser session loads", () => {
    state.matches = [{ context: {} }, { context: { session: { user: { role: "admin" } } } }];
    expect(renderHook(() => useShellIdentity()).result.current).toEqual({
      signedIn: true,
      role: "admin",
    });
  });

  it("never draws a guard's (possibly previous) account while the identity is unverified", () => {
    // A's guard context is still matched; another tab's change (here a 401 with no watcher
    // connected) is unchecked, so the masked session is pending.
    state.matches = [{ context: { session: { user: { role: "admin" } } } }];
    reportSessionRejected();
    const view = renderHook(() => useShellIdentity());
    expect(view.result.current).toEqual({ signedIn: false, role: null });
    // A fresh check confirms the document's account: the guard's session stands in again.
    act(() => confirmDocumentIdentityFresh(identityVerificationGeneration()));
    expect(view.result.current).toEqual({ signedIn: true, role: "admin" });
  });

  it("lets the browser session decide once it is known", () => {
    state.matches = [{ context: { session: { user: { role: "admin" } } } }];
    state.client = { status: "authenticated", session: { user: { role: "user" } } };
    expect(renderHook(() => useShellIdentity()).result.current).toEqual({
      signedIn: true,
      role: "user",
    });
    // Signed out in the browser: the stale route session never keeps the shell signed in.
    state.client = { status: "anonymous", session: null };
    expect(renderHook(() => useShellIdentity()).result.current.signedIn).toBe(false);
  });

  it("is signed out while loading on a page no guard vouched for", () => {
    expect(renderHook(() => useShellIdentity()).result.current).toEqual({
      signedIn: false,
      role: null,
    });
  });
  it("draws the signed-in nav while a signed-in layout's guard is still checking", () => {
    // A reload: the `_auth` match exists but its beforeLoad has not answered yet.
    state.matches = [
      { routeId: "__root__", context: {} },
      { routeId: "/$lang/_auth", context: {} },
    ];
    expect(renderHook(() => useShellIdentity()).result.current).toEqual({
      signedIn: true,
      role: null,
    });
    // Before any match exists, a signed-in path draws it too (and a public one never does).
    state.matches = [];
    state.pathname = "/en-US/pools";
    expect(renderHook(() => useShellIdentity()).result.current.signedIn).toBe(true);
    state.pathname = "/en-US/login";
    expect(renderHook(() => useShellIdentity()).result.current.signedIn).toBe(false);
    state.pathname = undefined;
    // A public page never does.
    state.matches = [{ routeId: "/$lang/login", context: {} }];
    expect(renderHook(() => useShellIdentity()).result.current.signedIn).toBe(false);
  });

  it.each([
    { pathname: "/en-US/missing", matches: [] },
    {
      pathname: "/en-US/missing",
      matches: [
        { routeId: "__root__", context: {} },
        { routeId: "/$lang", context: {} },
      ],
    },
    { pathname: "/es-MX/future-public/child", matches: [] },
  ])("keeps cold unknown $pathname public with $matches", async ({ pathname, matches }) => {
    const count = vi.fn(() => {
      throw new ORPCError("UNAUTHORIZED");
    });
    const handler = new RPCHandler(
      { activity: { needsYou: { count: os.handler(count) } } },
      { plugins: [new BatchHandlerPlugin()] },
    );
    const sessionProbe = vi.fn();
    fetchMock.mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (request.url.includes("/get-session")) {
        sessionProbe();
        return Response.json(null);
      }
      const result = await handler.handle(request, { prefix: "/rpc" });
      if (!result.response) throw new Error("Unmatched fixture RPC");
      return result.response;
    });
    const disconnect = connectIdentityPeers(() =>
      fetch("https://app.test/api/auth/get-session?disableCookieCache=true"),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    state.pathname = pathname;
    state.matches = matches;
    const view = renderHook(() => useNeedsYouCount(useShellIdentity().signedIn), { wrapper });
    try {
      // Drain the same transport batch queue used below for the positive control.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(view.result.current).toBe(0);
      expect(count).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(sessionProbe).not.toHaveBeenCalled();
      expect(needsAuthoritativeSessionCheck()).toBe(false);

      // A real private pending route still enables the actual consumer. The fixture's 401
      // proves the extra authoritative probe would have been observed on the unknown path.
      state.pathname = "/en-US/pools";
      view.rerender();
      await waitFor(() => expect(count).toHaveBeenCalledOnce());
      await waitFor(() => expect(sessionProbe).toHaveBeenCalledOnce());
      expect(needsAuthoritativeSessionCheck()).toBe(true);
    } finally {
      view.unmount();
      disconnect();
      client.clear();
    }
  });

  it("keeps anonymous private routes signed out and trusts a settled session on unknown paths", () => {
    state.pathname = "/en-US/pools";
    state.client = { status: "anonymous", session: null };
    const view = renderHook(() => useShellIdentity());
    expect(view.result.current.signedIn).toBe(false);
    state.pathname = "/en-US/missing";
    state.client = { status: "authenticated", session: { user: { role: "user" } } };
    view.rerender();
    expect(view.result.current).toEqual({ signedIn: true, role: "user" });
  });
});
