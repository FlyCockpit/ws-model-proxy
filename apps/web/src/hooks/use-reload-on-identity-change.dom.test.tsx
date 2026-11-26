// @vitest-environment jsdom

import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthSessionState } from "@/lib/auth-session-state";

const boundary = vi.hoisted(() => ({
  state: { status: "pending", session: null } as AuthSessionState["state"],
  refetch: vi.fn(),
}));
vi.mock("@/hooks/use-auth-session", () => ({
  useAuthSession: () => ({ state: boundary.state, actions: { refetch: boundary.refetch } }),
}));

import {
  markExplicitSignOut,
  onDocumentReplaced,
  resetDocumentIdentityForTests,
} from "@/lib/document-identity";
import { sessionIdentity, useReloadOnIdentityChange } from "./use-reload-on-identity-change";

const reload = vi.fn();
const user = (id: string): AuthSessionState["state"] => ({
  status: "authenticated",
  session: { user: { id, name: id, email: `${id}@example.test` } },
});
const anonymous = { status: "anonymous", session: null } as const;

class FakeChannel {
  static open: FakeChannel[] = [];
  posted = 0;
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor() {
    FakeChannel.open.push(this);
  }
  postMessage() {
    this.posted++;
  }
}

beforeEach(() => {
  FakeChannel.open = [];
  resetDocumentIdentityForTests(() => new FakeChannel());
  boundary.state = { status: "pending", session: null };
  boundary.refetch.mockReset();
  document.documentElement.style.removeProperty("display");
  Object.defineProperty(window, "location", { configurable: true, value: { reload } });
  reload.mockReset();
});
afterEach(cleanup);

function setup() {
  const view = renderHook(() => useReloadOnIdentityChange());
  const update = (state: AuthSessionState["state"]) => {
    boundary.state = state;
    view.rerender();
  };
  return Object.assign(update, { unmount: view.unmount });
}

describe("sessionIdentity", () => {
  it("maps session states to identities", () => {
    expect(sessionIdentity(user("u1"))).toBe("u1");
    expect(sessionIdentity(anonymous)).toBeNull();
    expect(sessionIdentity({ status: "pending", session: null })).toBeUndefined();
  });
});

describe("useReloadOnIdentityChange", () => {
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
  it("reloads on cross-tab sign-out or session expiry, hiding the page and sealing the cache first", () => {
    const seal = vi.fn(() => expect(reload).not.toHaveBeenCalled());
    onDocumentReplaced(seal);
    const update = setup();
    update(user("u1"));
    update(anonymous);
    expect(seal).toHaveBeenCalledOnce();
    expect(document.documentElement.style.display).toBe("none");
    expect(reload).toHaveBeenCalledTimes(1);
  });
  it("reloads on an account switch and on impersonation starting", () => {
    const update = setup();
    update(user("admin"));
    update(user("other"));
    expect(reload).toHaveBeenCalledTimes(1);
  });
  it("A → sign-out elsewhere → B: the document stays on its way out", () => {
    const update = setup();
    update(user("a"));
    update(anonymous);
    update(user("b"));
    expect(reload).toHaveBeenCalledTimes(2);
  });
  it("remembers whose data is in memory across a remount (an error reset of the root)", () => {
    const update = setup();
    update(user("a"));
    update.unmount();
    boundary.state = user("b");
    renderHook(() => useReloadOnIdentityChange());
    expect(reload).toHaveBeenCalledTimes(1);
  });
  it("leaves an explicit sign-out's own page load alone, until it is undone", () => {
    const update = setup();
    update(user("u1"));
    const undo = markExplicitSignOut();
    update({ status: "error", session: null, error: new Error("offline") });
    update(user("u1"));
    expect(reload).not.toHaveBeenCalled();
    undo();
    update(anonymous);
    expect(reload).toHaveBeenCalledTimes(1);
  });
  it("a sign-out seen during an explicit sign-out quarantines without reloading; a failed undo reloads", () => {
    const update = setup();
    update(user("u1"));
    const undo = markExplicitSignOut();
    update(anonymous);
    expect(document.documentElement.style.display).toBe("none");
    expect(reload).not.toHaveBeenCalled();
    // This tab's own request then fails (another tab signed out first).
    undo();
    expect(reload).toHaveBeenCalledTimes(1);
  });
  it("tells the other tabs about a sign-in, and checks the session on theirs", () => {
    const update = setup();
    update(anonymous);
    const [channel] = FakeChannel.open;
    expect(channel?.posted).toBe(1);
    update(user("a"));
    expect(channel?.posted).toBe(2);
    update(user("a"));
    expect(channel?.posted).toBe(2);
    channel?.onmessage?.({} as MessageEvent);
    expect(boundary.refetch).toHaveBeenCalledTimes(1);
    // The channel is the document's, not the component's: it stays the one.
    update.unmount();
    channel?.onmessage?.({} as MessageEvent);
    expect(boundary.refetch).toHaveBeenCalledTimes(1);
    expect(FakeChannel.open).toHaveLength(1);
  });
});

describe("quarantine", () => {
  it("takes the whole page out of rendering, so a pane that sets itself visible stays hidden", () => {
    // The active terminal pane carries `visibility: visible`, which would beat an inherited
    // `visibility: hidden`; nothing renders under an undisplayed root.
    const pane = document.createElement("div");
    pane.style.visibility = "visible";
    document.body.append(pane);
    const update = setup();
    update(user("a"));
    update(user("b"));
    expect(document.documentElement.style.getPropertyValue("display")).toBe("none");
    expect(document.documentElement.style.getPropertyPriority("display")).toBe("important");
    pane.remove();
  });
});
