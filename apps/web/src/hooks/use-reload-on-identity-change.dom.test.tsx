// @vitest-environment jsdom

import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthSessionState } from "@/lib/auth-session-state";

const boundary = vi.hoisted(() => ({
  state: { status: "pending", session: null } as AuthSessionState["state"],
  refetch: vi.fn(),
  /** What the atom holds right after a refetch (`readSessionIdentity`). */
  checked: undefined as string | null | undefined,
  inFlight: false,
}));
vi.mock("@/hooks/use-auth-session", () => ({
  useAuthSession: (options?: { unmasked?: boolean }) => ({
    // The watcher must read the raw session: a masked read here would see only `pending`, and
    // every identity test below would fail.
    state: options?.unmasked === true ? boundary.state : { status: "pending", session: null },
    actions: { refetch: boundary.refetch },
    meta: { isDegraded: false, isRefetching: false },
  }),
  readSessionIdentity: () => boundary.checked,
  isSessionFetchInFlight: () => boundary.inFlight,
}));

import {
  admitRouteIdentity,
  isDocumentIdentityUnverified,
  markExplicitSignOut,
  onDocumentReplaced,
  reportSessionRejected,
  resetDocumentIdentityForTests,
} from "@/lib/document-identity";
import { resetSessionRetryForTests } from "@/lib/session-retry";
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
  resetSessionRetryForTests();
  FakeChannel.open = [];
  resetDocumentIdentityForTests(() => new FakeChannel());
  boundary.state = { status: "pending", session: null };
  boundary.refetch.mockReset();
  boundary.checked = undefined;
  boundary.inFlight = false;
  document.documentElement.style.removeProperty("display");
  Object.defineProperty(window, "location", { configurable: true, value: { reload } });
  reload.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const settle = async () => {
  for (let i = 0; i < 24; i++) await Promise.resolve();
};
const fire = (target: EventTarget, type: string) => target.dispatchEvent(new Event(type));

/** A signed-in page, then the root watcher goes away (an error reset) and a peer announces. */
function announcedWhileUnmounted() {
  const update = setup();
  update(user("a"));
  const [channel] = FakeChannel.open;
  update.unmount();
  channel?.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
  expect(isDocumentIdentityUnverified()).toBe(true);
  return channel;
}

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
  it.each(["focus", "visibilitychange", "online"])(
    "settled anonymous ignores watcher %s until a peer invalidates its identity",
    async (event) => {
      await admitRouteIdentity({ status: "resolved", session: null });
      boundary.checked = null;
      setup()(anonymous);
      const target = event === "visibilitychange" ? document : window;
      fire(target, event);
      await settle();
      expect(boundary.refetch).not.toHaveBeenCalled();
      const [channel] = FakeChannel.open;
      boundary.checked = undefined;
      channel?.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
      await settle();
      expect(boundary.refetch).toHaveBeenCalledTimes(1);
      boundary.checked = null;
      fire(target, event);
      await settle();
      expect(boundary.refetch).toHaveBeenCalledTimes(2);
      expect(isDocumentIdentityUnverified()).toBe(false);
      fire(target, event);
      await settle();
      expect(boundary.refetch).toHaveBeenCalledTimes(2);
    },
  );

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
    // Still on its way out when B is confirmed: one reload is enough.
    update(user("b"));
    expect(reload).toHaveBeenCalledTimes(1);
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
  it("tells the other tabs about a sign-in, and checks the session on theirs", async () => {
    const update = setup();
    boundary.checked = null;
    update(anonymous);
    const [channel] = FakeChannel.open;
    expect(channel?.posted).toBe(1);
    boundary.checked = "a";
    update(user("a"));
    expect(channel?.posted).toBe(2);
    update(user("a"));
    expect(channel?.posted).toBe(2);
    channel?.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
    await settle();
    expect(boundary.refetch).toHaveBeenCalledTimes(1);
    // The channel is the document's, not the component's: it stays the one.
    update.unmount();
    channel?.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
    expect(boundary.refetch).toHaveBeenCalledTimes(1);
    expect(FakeChannel.open).toHaveLength(1);
  });
});

describe("unverified identity", () => {
  it("coalesces a burst announced before the reserved probe starts, including focus", async () => {
    vi.useFakeTimers();
    const update = setup();
    update(user("a"));
    const answers: (() => void)[] = [];
    boundary.refetch.mockImplementation(
      () => new Promise<void>((resolve) => answers.push(resolve)),
    );
    const peer = FakeChannel.open[0];
    peer?.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
    peer?.onmessage?.({ data: { kind: "identity", id: "b" } } as MessageEvent);
    await settle();
    fire(window, "focus");
    boundary.checked = "a";
    answers[0]?.();
    await settle();
    await vi.advanceTimersByTimeAsync(1000);
    expect(boundary.refetch).toHaveBeenCalledTimes(1);
    expect(isDocumentIdentityUnverified()).toBe(false);
  });

  it.each(["a", "b"])(
    "drops pre-announcement A answers and coalesces one fresh probe for %s",
    async (freshIdentity) => {
      vi.useFakeTimers();
      const update = setup();
      update(user("a"));
      const answers: (() => void)[] = [];
      boundary.refetch.mockImplementation(
        () => new Promise<void>((resolve) => answers.push(resolve)),
      );
      const peer = FakeChannel.open[0];
      peer?.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
      await settle();
      peer?.onmessage?.({ data: { kind: "identity", id: "b" } } as MessageEvent);
      boundary.checked = "a";
      answers[0]?.();
      await settle();
      expect(isDocumentIdentityUnverified()).toBe(true);
      expect(reload).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(250);
      expect(answers).toHaveLength(2);
      boundary.checked = freshIdentity;
      answers[1]?.();
      await settle();
      expect(reload).toHaveBeenCalledTimes(freshIdentity === "b" ? 1 : 0);
      if (freshIdentity === "a") expect(isDocumentIdentityUnverified()).toBe(false);
      await vi.advanceTimersByTimeAsync(2000);
      expect(boundary.refetch).toHaveBeenCalledTimes(2);
    },
  );

  it("re-checks on mount after a peer's announcement with no watcher, and replaces for another account", async () => {
    announcedWhileUnmounted();
    boundary.checked = "b";
    setup();
    await settle();
    expect(boundary.refetch).toHaveBeenCalledTimes(1);
    await settle();
    expect(reload).toHaveBeenCalledTimes(1);
  });
  it("a 401 with no watcher mounted leaves it unverified, and the mount check settles it", async () => {
    const update = setup();
    update(user("a"));
    update.unmount();
    reportSessionRejected();
    expect(isDocumentIdentityUnverified()).toBe(true);
    boundary.checked = "a";
    setup()(user("a"));
    await settle();
    expect(isDocumentIdentityUnverified()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
  it("a failed check keeps it unverified; a guard's confirmation lifts it", async () => {
    announcedWhileUnmounted();
    setup();
    await settle();
    expect(isDocumentIdentityUnverified()).toBe(true);
    await admitRouteIdentity({ status: "resolved", session: { user: { id: "a" } } });
    expect(isDocumentIdentityUnverified()).toBe(false);
  });
  it("a failed mount check is retried on reconnect, focus or visibility, never left unverified", async () => {
    announcedWhileUnmounted();
    setup()(user("a"));
    await settle();
    expect(isDocumentIdentityUnverified()).toBe(true);
    fire(window, "online");
    await settle();
    expect(boundary.refetch).toHaveBeenCalledTimes(2);
    expect(isDocumentIdentityUnverified()).toBe(true);
    boundary.checked = "a";
    fire(window, "focus");
    await settle();
    expect(isDocumentIdentityUnverified()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    // Settled: visibility still performs a fresh session check.
    fire(document, "visibilitychange");
    await settle();
    expect(boundary.refetch).toHaveBeenCalledTimes(4);
  });
  it("a retried check that answers another account replaces the document", async () => {
    announcedWhileUnmounted();
    setup()(user("a"));
    await settle();
    boundary.checked = "b";
    fire(document, "visibilitychange");
    await settle();
    expect(reload).toHaveBeenCalledTimes(1);
  });
  it("a fetch in flight across an unmount and a newer invalidation can't settle it, even after a remount", async () => {
    const answers: (() => void)[] = [];
    boundary.refetch.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          answers.push(resolve);
        }),
    );
    const channel = announcedWhileUnmounted();
    // Check 1 starts; the watcher unmounts before it answers; another tab announces again.
    const firstWatcher = setup();
    await settle();
    firstWatcher.unmount();
    channel?.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
    // The watcher remounts: its new-generation check waits for check 1 to finish.
    setup();
    expect(answers).toHaveLength(1);
    boundary.checked = "a";
    answers[0]?.();
    await settle();
    expect(isDocumentIdentityUnverified()).toBe(true);
    expect(answers).toHaveLength(2);
    answers[1]?.();
    await settle();
    expect(isDocumentIdentityUnverified()).toBe(false);
  });
  it("a check superseded by an automatic refresh checks again once that settles", async () => {
    vi.useFakeTimers();
    announcedWhileUnmounted();
    boundary.inFlight = true;
    setup()(user("a"));
    await settle();
    expect(isDocumentIdentityUnverified()).toBe(true);
    boundary.inFlight = false;
    boundary.checked = "a";
    await vi.advanceTimersByTimeAsync(250);
    await settle();
    expect(boundary.refetch).toHaveBeenCalledTimes(2);
    expect(isDocumentIdentityUnverified()).toBe(false);
  });
  it("a superseded check follows up at most three times", async () => {
    vi.useFakeTimers();
    announcedWhileUnmounted();
    boundary.inFlight = true;
    setup();
    await settle();
    await vi.advanceTimersByTimeAsync(2000);
    expect(boundary.refetch).toHaveBeenCalledTimes(4);
    expect(isDocumentIdentityUnverified()).toBe(true);
  });
  it("overlapping superseded checks share one follow-up, and unmounting drops it", async () => {
    vi.useFakeTimers();
    announcedWhileUnmounted();
    boundary.inFlight = true;
    const update = setup();
    // The mount check and a focus retry are both superseded: each would schedule a follow-up.
    fire(window, "focus");
    await settle();
    expect(boundary.refetch).toHaveBeenCalledTimes(1);
    update.unmount();
    await vi.advanceTimersByTimeAsync(2000);
    expect(boundary.refetch).toHaveBeenCalledTimes(1);
  });
  it("unmounting drops a pending follow-up and the retry listeners", async () => {
    vi.useFakeTimers();
    announcedWhileUnmounted();
    boundary.inFlight = true;
    const update = setup();
    await settle();
    update.unmount();
    await vi.advanceTimersByTimeAsync(1000);
    fire(window, "focus");
    await settle();
    expect(boundary.refetch).toHaveBeenCalledTimes(1);
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
