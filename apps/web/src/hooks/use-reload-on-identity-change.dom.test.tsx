// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthSessionState } from "@/lib/auth-session-state";

const boundary = vi.hoisted(() => ({
  state: { status: "pending", session: null } as AuthSessionState["state"],
}));
vi.mock("@/hooks/use-auth-session", () => ({ useAuthSession: () => ({ state: boundary.state }) }));

import { markExplicitSignOut, useReloadOnIdentityChange } from "./use-reload-on-identity-change";

const reload = vi.fn();
const user = (id: string): AuthSessionState["state"] => ({
  status: "authenticated",
  session: { user: { id, name: id, email: `${id}@example.test` } },
});
const anonymous = { status: "anonymous", session: null } as const;

beforeEach(() => {
  boundary.state = { status: "pending", session: null };
  markExplicitSignOut()();
  Object.defineProperty(window, "location", { configurable: true, value: { reload } });
  reload.mockReset();
});
afterEach(cleanup);

function setup() {
  const view = renderHook(() => useReloadOnIdentityChange());
  return (state: AuthSessionState["state"]) => {
    boundary.state = state;
    view.rerender();
  };
}

describe("useReloadOnIdentityChange", () => {
  it("reloads a pending explicit sign-out restored before anonymous is observed", () => {
    const update = setup();
    update(user("u1"));
    markExplicitSignOut();
    act(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    expect(reload).toHaveBeenCalledOnce();
    update(anonymous);
    expect(reload).toHaveBeenCalledOnce();
  });
  it("reloads after anonymous is observed during sign-out and bfcache restores before another user signs in", () => {
    const update = setup();
    update(user("u1"));
    markExplicitSignOut();
    update(anonymous);
    expect(reload).not.toHaveBeenCalled();
    act(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    expect(reload).toHaveBeenCalledOnce();
    update(user("u2"));
    expect(reload).toHaveBeenCalledOnce();
  });
  it("does not reload a bfcache restore without a pending explicit sign-out", () => {
    const update = setup();
    update(user("u1"));
    act(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    expect(reload).not.toHaveBeenCalled();
    update(user("u2"));
    expect(reload).toHaveBeenCalledOnce();
  });
  it("does not reload a bfcache restore after a failed explicit sign-out", () => {
    const update = setup();
    update(user("u1"));
    const undo = markExplicitSignOut();
    undo();
    act(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    expect(reload).not.toHaveBeenCalled();
    update(anonymous);
    expect(reload).toHaveBeenCalledOnce();
  });
  it("keeps explicit sign-out suppressed on an ordinary pageshow", () => {
    const update = setup();
    update(user("u1"));
    markExplicitSignOut();
    act(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: false })));
    update(anonymous);
    expect(reload).not.toHaveBeenCalled();
  });
  it("does not reload initial sessions or anonymous sign-in", () => {
    const update = setup();
    update(anonymous);
    update(user("u1"));
    expect(reload).not.toHaveBeenCalled();
  });
  it("keeps the known identity through pending and error blips", () => {
    const update = setup();
    update(user("u1"));
    update({ status: "error", session: null, error: new Error("offline") });
    update({ status: "pending", session: null });
    update(user("u1"));
    expect(reload).not.toHaveBeenCalled();
  });
  it("reloads on cross-tab sign-out or session expiry", () => {
    const update = setup();
    update(user("u1"));
    update(anonymous);
    expect(reload).toHaveBeenCalledTimes(1);
  });
  it("reloads on account switches and impersonation start and stop", () => {
    const update = setup();
    update(user("admin"));
    update(user("other"));
    update(user("admin"));
    expect(reload).toHaveBeenCalledTimes(2);
  });
  it("leaves explicit navigation alone and re-arms after a failed sign-out", () => {
    const update = setup();
    update(user("u1"));
    const undo = markExplicitSignOut();
    update(anonymous);
    expect(reload).not.toHaveBeenCalled();
    undo();
    update(user("u1"));
    update(anonymous);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
