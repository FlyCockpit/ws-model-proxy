// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const atom = vi.hoisted(() => {
  type Snapshot = { data: null; isPending: boolean; isRefetching: boolean; error: unknown };
  let snapshot: Snapshot = { data: null, isPending: true, isRefetching: true, error: null };
  const listeners = new Set<() => void>();
  return {
    get: () => snapshot,
    set(next: Snapshot) {
      snapshot = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refetch: vi.fn(),
  };
});
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: () => ({
      ...useSyncExternalStore(atom.subscribe, atom.get),
      refetch: atom.refetch,
    }),
    $store: { atoms: { session: { get: atom.get } } },
  },
}));
vi.mock("@/hooks/use-network-status", () => ({ useNetworkStatus: () => true }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: { signupEnabled: true }, isPending: false }),
}));
vi.mock("@/utils/orpc", () => ({ orpc: { app: { config: { queryOptions: () => ({}) } } } }));
vi.mock("@tanstack/react-router", () => ({ useParams: () => ({ lang: "en-US" }) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/lib/explicit-sign-out", () => ({
  signOutAndLeave: vi.fn(),
  signOutFailureKey: () => "userMenu.signOutOffline",
}));

import { resetAuthSessionMemoryForTests } from "@/hooks/use-auth-session";
import { resetDocumentIdentityForTests } from "@/lib/document-identity";
import { recordSessionRetryAfter, resetSessionRetryForTests } from "@/lib/session-retry";
import UserMenu from "./user-menu";

beforeEach(() => {
  vi.useFakeTimers();
  resetAuthSessionMemoryForTests();
  resetSessionRetryForTests();
  resetDocumentIdentityForTests(() => undefined);
  atom.refetch
    .mockReset()
    .mockImplementation(async () =>
      atom.set({ data: null, isPending: false, isRefetching: false, error: { status: 503 } }),
    );
  atom.set({ data: null, isPending: false, isRefetching: false, error: { status: 429 } });
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
});
afterEach(() => {
  cleanup();
  resetSessionRetryForTests();
  vi.useRealTimers();
});
describe("header session unavailable", () => {
  it("429 shows Retry and Sign out, keeps Retry during pending, and honors Retry-After", async () => {
    recordSessionRetryAfter(new Response(null, { status: 429, headers: { "Retry-After": "10" } }));
    render(
      <>
        <UserMenu />
        <UserMenu />
      </>,
    );
    expect(screen.getAllByRole("button", { name: "userMenu.accountUnavailable" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "userMenu.signOut" })).toHaveLength(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9999);
    });
    expect(atom.refetch).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(atom.refetch).toHaveBeenCalledOnce();
    act(() => atom.set({ data: null, isPending: true, isRefetching: true, error: null }));
    expect(
      screen
        .getAllByRole("button", { name: "userMenu.accountUnavailable" })[0]
        ?.hasAttribute("disabled"),
    ).toBe(true);
  });
  it("shares one 2→4-second retry across mounted controls and allows manual Retry", async () => {
    render(
      <>
        <UserMenu />
        <UserMenu />
      </>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1999);
    });
    expect(atom.refetch).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(atom.refetch).toHaveBeenCalledOnce();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3999);
    });
    expect(atom.refetch).toHaveBeenCalledOnce();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(atom.refetch).toHaveBeenCalledTimes(2);
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "userMenu.accountUnavailable" })[0]!);
    });
    expect(atom.refetch).toHaveBeenCalledTimes(3);
  });
});
