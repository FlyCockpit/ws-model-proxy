import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  admitRouteIdentity,
  confirmDocumentIdentityFresh,
  connectIdentityPeers,
  fetchWithExpectedIdentity,
  identityVerificationGeneration,
  isDocumentIdentityUnverified,
  isDocumentReplaced,
  markAnonymousOnlyRoute,
  observeDocumentIdentity,
  replaceDocument,
  reportSessionRejected,
  resetDocumentIdentityForTests,
  skipErrorToastForIdentity,
  withExpectedIdentity,
} from "./document-identity";

const reload = vi.fn();
/** The root element's inline style, as `hidePage` writes it. */
const root = {
  style: {
    display: "",
    priority: "",
    setProperty(name: string, value: string, priority: string) {
      if (name === "display") Object.assign(this, { display: value, priority });
    },
  },
};
const hidden = () => root.style.display === "none" && root.style.priority === "important";

beforeEach(() => {
  resetDocumentIdentityForTests(() => undefined);
  reload.mockReset();
  Object.assign(root.style, { display: "", priority: "" });
  vi.stubGlobal("window", {
    location: { reload },
  });
  vi.stubGlobal("document", { documentElement: root });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const resolved = (id: string | null) =>
  ({ status: "resolved", session: id === null ? null : { user: { id } } }) as const;

describe("fetchWithExpectedIdentity", () => {
  it.each([
    "/api/internal/media",
    "/api/internal/media/admin/purge-expired",
    "/api/internal/chat-test/chat/completions",
  ])("intercepts %s identity conflicts before callbacks", async (url) => {
    await admitRouteIdentity(resolved("a"));
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ code: "IDENTITY_CHANGED" }, { status: 409 }));
    vi.stubGlobal("fetch", transport);
    const success = vi.fn();
    const error = vi.fn();
    void fetchWithExpectedIdentity(url, { method: "POST" }).then(success, error);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(reload).toHaveBeenCalledOnce();
    expect(hidden()).toBe(true);
    expect(new Headers(transport.mock.calls[0]?.[1]?.headers).get("X-Expected-User")).toBe("a");
    expect(success).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});

describe("superseded guard answers", () => {
  it("an obsolete guard answer on a public anonymous document records and announces nothing", async () => {
    const channel = {
      postMessage: vi.fn(),
      onmessage: null as ((event: MessageEvent) => void) | null,
    };
    resetDocumentIdentityForTests(() => channel);
    await admitRouteIdentity(resolved(null));
    channel.postMessage.mockClear();
    const since = identityVerificationGeneration();
    // B is newer than the in-flight A probe, with no watcher mounted here.
    channel.onmessage?.({ data: { kind: "identity", id: "b" } } as MessageEvent);
    await admitRouteIdentity(resolved("a"), since);
    expect(channel.postMessage).not.toHaveBeenCalled();
    expect(withExpectedIdentity().has("X-Expected-User")).toBe(false);
    expect(isDocumentIdentityUnverified()).toBe(true);
    expect(reload).not.toHaveBeenCalled();
    await admitRouteIdentity(resolved("b"));
    expect(channel.postMessage).toHaveBeenCalledExactlyOnceWith({ kind: "identity", id: "b" });
    expect(withExpectedIdentity().get("X-Expected-User")).toBe("b");
    expect(isDocumentIdentityUnverified()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("expected document identity", () => {
  it("uses the baseline even after an unrelated cookie change, preserving other headers", () => {
    expect(withExpectedIdentity().has("X-Expected-User")).toBe(false);
    observeDocumentIdentity(null);
    expect(withExpectedIdentity().has("X-Expected-User")).toBe(false);
    observeDocumentIdentity("a");
    const headers = withExpectedIdentity({ "x-csrf-token": "token" });
    expect(headers.get("X-Expected-User")).toBe("a");
    expect(headers.get("x-csrf-token")).toBe("token");
  });
  it("recognizes a server-confirmed identity conflict in the global toast filters", () => {
    observeDocumentIdentity("a");
    expect(skipErrorToastForIdentity({ status: 409, code: "IDENTITY_CHANGED" }, "mutation")).toBe(
      true,
    );
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe("confirmed peer messages", () => {
  function channel() {
    const peer = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      postMessage: vi.fn(),
    };
    resetDocumentIdentityForTests(() => peer);
    return { receive: (data: unknown) => peer.onmessage?.({ data } as MessageEvent) };
  }
  it.each(["b", null])("a different peer identity (%s) waits for a server check", async (id) => {
    const peer = channel();
    observeDocumentIdentity("a");
    let finish!: () => void;
    const check = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    connectIdentityPeers(check);
    peer.receive({ kind: "identity", id });
    expect(reload).not.toHaveBeenCalled();
    expect(check).toHaveBeenCalledTimes(1);
    expect(isDocumentIdentityUnverified()).toBe(true);
    // Only the check's server answer can decide to replace the document.
    if (observeDocumentIdentity(id)) replaceDocument();
    finish();
    await Promise.resolve();
    expect(reload).toHaveBeenCalledTimes(1);
  });
  it("same identity is ignored and does not certify an unverified cookie", () => {
    const peer = channel();
    observeDocumentIdentity("a");
    reportSessionRejected();
    const check = vi.fn();
    connectIdentityPeers(check);
    peer.receive({ kind: "identity", id: "a" });
    expect(check).not.toHaveBeenCalled();
    expect(isDocumentIdentityUnverified()).toBe(true);
    expect(reload).not.toHaveBeenCalled();
  });
  it("a matching peer identity leaves local sign-in navigation on /login alone", () => {
    const peer = channel();
    window.location.pathname = "/en-US/login";
    markAnonymousOnlyRoute();
    observeDocumentIdentity(null);
    // Local sign-in confirms A before the router finishes leaving /login.
    observeDocumentIdentity("a");
    reportSessionRejected();
    const check = vi.fn();
    connectIdentityPeers(check);
    const since = identityVerificationGeneration();
    peer.receive({ kind: "identity", id: "a" });
    expect(reload).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
    expect(identityVerificationGeneration()).toBe(since);
    expect(isDocumentIdentityUnverified()).toBe(true);
    expect(withExpectedIdentity().get("X-Expected-User")).toBe("a");
  });
  it("every relevant announcement invalidates pending answers while sharing the check", async () => {
    const peer = channel();
    observeDocumentIdentity("a");
    let finish!: () => void;
    const check = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    connectIdentityPeers(check);
    peer.receive({ kind: "session-changed" });
    peer.receive({ kind: "session-changed" });
    expect(check).toHaveBeenCalledTimes(1);
    const since = identityVerificationGeneration();
    peer.receive({ kind: "identity", id: "b" });
    expect(reload).not.toHaveBeenCalled();
    expect(identityVerificationGeneration()).toBe(since + 1);
    confirmDocumentIdentityFresh(since);
    expect(isDocumentIdentityUnverified()).toBe(true);
    expect(check).toHaveBeenCalledTimes(1);
    finish();
    await Promise.resolve();
  });
  it("a delayed hint confirming the local sign-in keeps its pending /login navigation", async () => {
    const peer = channel();
    window.location.pathname = "/en-US/login";
    markAnonymousOnlyRoute();
    observeDocumentIdentity(null);
    observeDocumentIdentity("b");
    const check = vi.fn(async () => {
      const since = identityVerificationGeneration();
      await Promise.resolve();
      if (observeDocumentIdentity("b")) replaceDocument();
      else confirmDocumentIdentityFresh(since);
    });
    connectIdentityPeers(check);
    peer.receive({ kind: "session-changed" });
    expect(isDocumentIdentityUnverified()).toBe(true);
    await check.mock.results[0]?.value;
    expect(check).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
    expect(isDocumentReplaced()).toBe(false);
    expect(isDocumentIdentityUnverified()).toBe(false);
    expect(withExpectedIdentity().get("X-Expected-User")).toBe("b");
  });
  it.each(["login", "signup", "forgot-password", "reset-password"])(
    "peer sign-in checks before replacing the anonymous-only %s page",
    (route) => {
      const peer = channel();
      window.location.pathname = `/en-US/${route}`;
      markAnonymousOnlyRoute();
      observeDocumentIdentity(null);
      const check = vi.fn();
      connectIdentityPeers(check);
      peer.receive({ kind: "identity", id: "b" });
      expect(reload).not.toHaveBeenCalled();
      expect(check).toHaveBeenCalledTimes(1);
      expect(isDocumentIdentityUnverified()).toBe(true);
      if (observeDocumentIdentity("b")) replaceDocument();
      expect(reload).toHaveBeenCalledTimes(1);
    },
  );
  it("a sign-in found by a hinted check replaces an anonymous-only form", async () => {
    const peer = channel();
    window.location.pathname = "/en-US/login";
    markAnonymousOnlyRoute();
    observeDocumentIdentity(null);
    connectIdentityPeers(() => {
      if (observeDocumentIdentity("b")) replaceDocument();
    });
    peer.receive({ kind: "session-changed" });
    expect(reload).toHaveBeenCalledTimes(1);
  });
  it("the anonymous-only marker does not affect a later public page", () => {
    const peer = channel();
    window.location.pathname = "/en-US/login";
    markAnonymousOnlyRoute();
    observeDocumentIdentity(null);
    window.location.pathname = "/en-US/about";
    const check = vi.fn();
    connectIdentityPeers(check);
    peer.receive({ kind: "identity", id: "b" });
    expect(reload).not.toHaveBeenCalled();
    expect(check).toHaveBeenCalledTimes(1);
  });
});
