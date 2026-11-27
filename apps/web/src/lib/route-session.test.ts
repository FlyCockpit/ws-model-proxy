import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RouteSessionResolution } from "./route-session-access";

vi.mock("@/lib/app-shell-hydration", () => ({ appShellHydrated: () => Promise.resolve() }));
vi.mock("@/server/auth-session", () => ({ getRouteSession: vi.fn() }));

import { getRouteSession } from "@/server/auth-session";
import {
  admitRouteIdentity,
  connectIdentityPeers,
  isDocumentIdentityUnverified,
  resetDocumentIdentityForTests,
  withExpectedIdentity,
} from "./document-identity";
import { resolveRouteSession } from "./route-session";
import { decideProtectedRouteAccess } from "./route-session-access";

const resolved = (id: string): RouteSessionResolution => ({
  status: "resolved",
  session: {
    user: {
      id,
      name: `Name ${id}`,
      email: `${id}@example.test`,
      emailVerified: true,
    },
  },
});
const channel = { postMessage: vi.fn(), onmessage: null as ((event: MessageEvent) => void) | null };
const invalidate = () =>
  channel.onmessage?.({ data: { kind: "identity", id: "b" } } as MessageEvent);

beforeEach(async () => {
  vi.stubGlobal("window", { location: { pathname: "/en-US/settings/profile" } });
  channel.onmessage = null;
  channel.postMessage.mockClear();
  resetDocumentIdentityForTests(() => channel);
  vi.mocked(getRouteSession).mockReset();
  await admitRouteIdentity({ status: "resolved", session: null });
});
afterEach(() => vi.unstubAllGlobals());

describe("resolveRouteSession", () => {
  it("re-probes after a peer invalidates A, so settings consumes only B's profile", async () => {
    let finish!: (resolution: RouteSessionResolution) => void;
    vi.mocked(getRouteSession)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValueOnce(resolved("b"));
    const guard = resolveRouteSession();
    invalidate();
    finish(resolved("a"));
    const decision = decideProtectedRouteAccess(await guard);
    expect(decision.kind).toBe("allow");
    if (decision.kind !== "allow") throw new Error("Expected settings access");
    // This is the profile a settings form pre-fills, not just admission state.
    expect(decision.session.user.name).toBe("Name b");
    expect(withExpectedIdentity().get("X-Expected-User")).toBe("b");
    expect(getRouteSession).toHaveBeenCalledTimes(2);
    expect(isDocumentIdentityUnverified()).toBe(false);
    expect(channel.postMessage).not.toHaveBeenCalledWith({ kind: "identity", id: "a" });
  });

  it("bounds repeated invalidations to three probes and never returns their obsolete sessions", async () => {
    // Keep the peer listener but prevent its optional watcher probe from running.
    const disconnect = connectIdentityPeers(() => {});
    disconnect();
    vi.mocked(getRouteSession).mockImplementation(async () => {
      invalidate();
      return resolved("a");
    });
    expect(await resolveRouteSession()).toEqual({ status: "error" });
    expect(getRouteSession).toHaveBeenCalledTimes(3);
    expect(withExpectedIdentity().has("X-Expected-User")).toBe(false);
    expect(isDocumentIdentityUnverified()).toBe(true);
  });
});
