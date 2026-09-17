// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * MCP tombstone-reauth sign-out hook (MCP plan Phase 6, Part H pass 2):
 * exact signOut args, no navigation, failure surfacing (R83/R84 F4),
 * single-flight re-entry guard (R83/R84 F8), and tombstone-probe cache
 * invalidation on sign-out (R83/R84 F5).
 */

type SignOutResult = { data: object | null; error: object | null };
const signOutMock = vi.hoisted(() =>
  vi.fn(async (): Promise<SignOutResult> => ({ data: {}, error: null })),
);

vi.mock("@/lib/auth-client", () => ({
  authClient: { signOut: signOutMock },
}));

import { MCP_REAUTH_STATUS_QUERY_KEY } from "@/lib/mcp-oauth-search";
import { useMcpReauthSignOut } from "./use-mcp-reauth-sign-out";

function renderHookWithClient() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidateSpy = vi.spyOn(client, "invalidateQueries");
  const view = renderHook(() => useMcpReauthSignOut(), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  return { client, invalidateSpy, ...view };
}

describe("useMcpReauthSignOut", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("signs out with disableRedirect, never navigates, and invalidates the tombstone-probe cache", async () => {
    const { result, invalidateSpy } = renderHookWithClient();
    expect(result.current.isSigningOut).toBe(false);
    expect(result.current.signOutFailed).toBe(false);

    await act(async () => {
      await result.current.signOutForReauth();
    });

    // disableRedirect: true and NO callbackURL — the signed oauth_query stays
    // in the current URL; nothing may navigate away from it.
    expect(signOutMock).toHaveBeenCalledTimes(1);
    expect(signOutMock).toHaveBeenCalledWith({ disableRedirect: true });
    expect(result.current.isSigningOut).toBe(false);
    expect(result.current.signOutFailed).toBe(false);
    // The probe cache is invalidated by its prefix key so the NEXT session
    // can never reuse this session's cached reauth/continue decision.
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: [MCP_REAUTH_STATUS_QUERY_KEY],
    });
  });

  it("surfaces a resolved { error } sign-out as a localized-failure state (R83/R84 F4)", async () => {
    signOutMock.mockResolvedValueOnce({ data: null, error: { code: "INTERNAL_SERVER_ERROR" } });
    const { result, invalidateSpy } = renderHookWithClient();
    await act(async () => {
      await result.current.signOutForReauth();
    });
    expect(result.current.signOutFailed).toBe(true);
    expect(result.current.isSigningOut).toBe(false);
    // A failed sign-out keeps the session: no cache invalidation.
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("surfaces a thrown sign-out failure and resets the pending flag", async () => {
    signOutMock.mockRejectedValueOnce(new Error("offline"));
    const { result } = renderHookWithClient();
    await act(async () => {
      await result.current.signOutForReauth();
    });
    expect(result.current.isSigningOut).toBe(false);
    expect(result.current.signOutFailed).toBe(true);
  });

  it("clears the failure state on a subsequent successful retry", async () => {
    signOutMock.mockResolvedValueOnce({ data: null, error: {} });
    const { result } = renderHookWithClient();
    await act(async () => {
      await result.current.signOutForReauth();
    });
    expect(result.current.signOutFailed).toBe(true);

    signOutMock.mockResolvedValueOnce({ data: {}, error: null });
    await act(async () => {
      await result.current.signOutForReauth();
    });
    expect(result.current.signOutFailed).toBe(false);
  });

  it("is single-flight: invoking the callback twice before settlement performs ONE sign-out call (R83/R84 F8)", async () => {
    let release: (() => void) | null = null;
    signOutMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ data: {}, error: null });
        }),
    );
    const { result } = renderHookWithClient();

    const first = result.current.signOutForReauth();
    const second = result.current.signOutForReauth(); // re-entry before settle
    expect(signOutMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      release?.();
      await Promise.all([first, second]);
    });
    expect(signOutMock).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(result.current.isSigningOut).toBe(false);
    });
    // After settlement the guard re-arms — a later retry is a new flight
    // (mockResolvedValueOnce takes priority over the pending impl).
    signOutMock.mockResolvedValueOnce({ data: {}, error: null });
    await act(async () => {
      await result.current.signOutForReauth();
    });
    expect(signOutMock).toHaveBeenCalledTimes(2);
  });
});

describe("tombstone-probe query scoping (R83/R84 F5, QueryClient level)", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("two different session identities produce two probe calls; invalidation forces a refetch of the same key", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const probe = vi.fn(async () => ({ status: "continue" as const }));
    const keyA = ["mcp-reauth-status", "user-1", "c", "f"] as const;
    const keyB = ["mcp-reauth-status", "user-2", "c", "f"] as const;

    await client.fetchQuery({ queryKey: keyA, queryFn: probe, staleTime: 0 });
    await client.fetchQuery({ queryKey: keyB, queryFn: probe, staleTime: 0 });
    expect(probe).toHaveBeenCalledTimes(2); // session-scoped: no reuse

    // Re-fetching the same key after staleTime 0 remounts/refetches…
    await client.fetchQuery({ queryKey: keyA, queryFn: probe, staleTime: 0 });
    expect(probe).toHaveBeenCalledTimes(3);

    // …and the sign-out prefix invalidation marks every generation stale:
    // the next fetch of the SAME key re-runs the probe.
    await client.invalidateQueries({ queryKey: [MCP_REAUTH_STATUS_QUERY_KEY] });
    await client.fetchQuery({ queryKey: keyA, queryFn: probe, staleTime: 0 });
    expect(probe).toHaveBeenCalledTimes(4);
  });
});
