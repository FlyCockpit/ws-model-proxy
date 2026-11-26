// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * MCP tombstone-reauth sign-out hook (Phase 6, Part H pass 2):
 * exact signOut args, a quarantined reload of the exact signed URL, failure
 * surfacing (R83/R84 F4), single-flight re-entry guard (R83/R84 F8), and the
 * tombstone-probe cache dropped on sign-out (R83/R84 F5: the sealed cache).
 */

type SignOutResult = { data: object | null; error: object | null };
const signOutMock = vi.hoisted(() =>
  vi.fn(async (): Promise<SignOutResult> => ({ data: {}, error: null })),
);

vi.mock("@/lib/auth-client", () => ({
  authClient: { signOut: signOutMock },
}));

const reload = vi.fn();
const assign = vi.fn();
const undoSignOutMark = vi.hoisted(() => vi.fn());
const markSignOut = vi.hoisted(() => vi.fn(() => undoSignOutMark));
vi.mock("@/lib/document-identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/document-identity")>()),
  markExplicitSignOut: markSignOut,
}));
beforeEach(() => {
  document.documentElement.style.removeProperty("display");
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { href: "https://example.test/en-US/mcp-login?oauth_query=signed", reload, assign },
  });
});

import {
  onDocumentReplaced,
  resetDocumentIdentityForTests,
  sealQueryClient,
} from "@/lib/document-identity";
import { MCP_REAUTH_STATUS_QUERY_KEY } from "@/lib/mcp-oauth-search";
import { useMcpReauthSignOut } from "./use-mcp-reauth-sign-out";

function renderHookWithClient() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidateSpy = vi.spyOn(client, "invalidateQueries");
  resetDocumentIdentityForTests(() => undefined);
  onDocumentReplaced(() => sealQueryClient(client));
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

  it("signs out with disableRedirect, seals the cache, and reloads the exact signed URL", async () => {
    signOutMock.mockImplementationOnce((async (options: {
      fetchOptions: { onSuccess: () => void };
    }) => {
      options.fetchOptions.onSuccess();
      return { data: {}, error: null };
    }) as never);
    const { result, client } = renderHookWithClient();
    client.setQueryData([MCP_REAUTH_STATUS_QUERY_KEY, "s1", "c", "f"], { status: "continue" });
    expect(result.current.isSigningOut).toBe(false);
    expect(result.current.signOutFailed).toBe(false);

    await act(async () => {
      await result.current.signOutForReauth();
    });

    // disableRedirect: true and NO callbackURL — the signed oauth_query stays
    // in the current URL; nothing may navigate away from it.
    expect(signOutMock).toHaveBeenCalledTimes(1);
    expect(signOutMock).toHaveBeenCalledWith({
      disableRedirect: true,
      fetchOptions: { onSuccess: expect.any(Function) },
    });
    expect(result.current.isSigningOut).toBe(false);
    expect(result.current.signOutFailed).toBe(false);
    expect(markSignOut).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledOnce();
    expect(assign).not.toHaveBeenCalled();
    expect(window.location.href).toBe("https://example.test/en-US/mcp-login?oauth_query=signed");
    // The document is quarantined before the reload: the cache is sealed, so
    // the NEXT session can never reuse this session's cached reauth/continue
    // decision.
    expect(client.getQueryCache().getAll()).toHaveLength(0);
    expect(document.documentElement.style.display).toBe("none");
  });

  it("surfaces a resolved { error } sign-out as a localized-failure state (R83/R84 F4)", async () => {
    signOutMock.mockResolvedValueOnce({ data: null, error: { code: "INTERNAL_SERVER_ERROR" } });
    const { result, invalidateSpy } = renderHookWithClient();
    await act(async () => {
      await result.current.signOutForReauth();
    });
    expect(result.current.signOutFailed).toBe(true);
    expect(result.current.isSigningOut).toBe(false);
    expect(undoSignOutMark).toHaveBeenCalledOnce();
    expect(reload).not.toHaveBeenCalled();
    // A failed sign-out keeps the session (and its cache).
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
    expect(undoSignOutMark).toHaveBeenCalledOnce();
    expect(reload).not.toHaveBeenCalled();
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
    await waitFor(() => expect(signOutMock).toHaveBeenCalledTimes(1));

    // The auth client is imported dynamically: the request starts a few ticks later.
    await waitFor(() => expect(release).not.toBeNull());
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

describe("useMcpReauthSignOut status", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("moves idle -> signing -> done, with the flags derived from that one status", async () => {
    let release: (() => void) | null = null;
    signOutMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ data: {}, error: null });
        }),
    );
    const { result } = renderHookWithClient();
    expect(result.current.status).toBe("idle");
    let flight: Promise<void> = Promise.resolve();
    act(() => {
      flight = result.current.signOutForReauth();
    });
    expect(result.current.status).toBe("signing");
    expect(result.current.isSigningOut).toBe(true);
    expect(result.current.signOutFailed).toBe(false);
    // The auth client is imported dynamically: the request starts a few ticks later.
    await waitFor(() => expect(release).not.toBeNull());
    await act(async () => {
      release?.();
      await flight;
    });
    expect(result.current.status).toBe("done");
    expect(result.current.isSigningOut).toBe(false);
    expect(result.current.signOutFailed).toBe(false);
  });

  it("moves to failed, then a retry passes through signing again (never failed and signing at once)", async () => {
    signOutMock.mockResolvedValueOnce({ data: null, error: {} });
    const { result } = renderHookWithClient();
    await act(async () => {
      await result.current.signOutForReauth();
    });
    expect(result.current.status).toBe("failed");

    let release: (() => void) | null = null;
    signOutMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ data: {}, error: null });
        }),
    );
    let flight: Promise<void> = Promise.resolve();
    act(() => {
      flight = result.current.signOutForReauth();
    });
    expect(result.current.status).toBe("signing");
    expect(result.current.signOutFailed).toBe(false);
    // The auth client is imported dynamically: the request starts a few ticks later.
    await waitFor(() => expect(release).not.toBeNull());
    await act(async () => {
      release?.();
      await flight;
    });
    expect(result.current.status).toBe("done");
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

    // …and a prefix invalidation marks every generation stale:
    // the next fetch of the SAME key re-runs the probe.
    await client.invalidateQueries({ queryKey: [MCP_REAUTH_STATUS_QUERY_KEY] });
    await client.fetchQuery({ queryKey: keyA, queryFn: probe, staleTime: 0 });
    expect(probe).toHaveBeenCalledTimes(4);
  });
});
