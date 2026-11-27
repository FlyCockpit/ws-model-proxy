// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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
  identityVerificationGeneration,
  reportSessionRejected,
  resetDocumentIdentityForTests,
} from "@/lib/document-identity";
import { useShellIdentity } from "./use-shell-identity";

afterEach(() => {
  resetDocumentIdentityForTests(() => undefined);
  state.client = { status: "pending", session: null };
  state.matches = [];
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
});
