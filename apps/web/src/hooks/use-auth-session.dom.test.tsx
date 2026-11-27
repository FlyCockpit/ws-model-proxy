// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const atom = vi.hoisted(() => {
  const refetch = async () => {};
  return {
    refetch,
    snapshot: { data: null, isPending: true, isRefetching: true, error: null, refetch } as {
      data: { user: { id: string; name: string; email: string } } | null;
      isPending: boolean;
      isRefetching: boolean;
      error: null;
      refetch: () => Promise<void>;
    },
  };
});
vi.mock("@/lib/auth-client", () => ({ authClient: { useSession: () => atom.snapshot } }));
vi.mock("./use-network-status", () => ({ useNetworkStatus: () => true }));

const { useAuthSession } = await import("./use-auth-session");

describe("useAuthSession actions", () => {
  it("keeps one refetch across the atom's snapshots, so the watcher's checks are not restarted by the refetch they start", () => {
    const view = renderHook(() => useAuthSession({ unmasked: true }));
    const first = view.result.current.actions.refetch;
    atom.snapshot = {
      ...atom.snapshot,
      data: { user: { id: "a", name: "A", email: "a@example.test" } },
      isPending: false,
      isRefetching: false,
    };
    view.rerender();
    expect(view.result.current.state.status).toBe("authenticated");
    expect(view.result.current.actions.refetch).toBe(first);
  });
});
