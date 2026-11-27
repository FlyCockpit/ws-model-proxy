import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const atom = vi.hoisted(() => ({
  snapshot: undefined as
    | {
        data: { user: { id: string } } | null;
        error: { status?: number } | null;
        isPending: boolean;
        isRefetching: boolean;
      }
    | undefined,
}));

// The atom still holds the previous account (another tab switched). One snapshot, as the atom
// returns until it changes.
const stale = vi.hoisted(() => ({
  data: { user: { id: "a", name: "Previous Account", email: "a@example.test" } },
  isPending: false,
  isRefetching: false,
  error: null,
  refetch: async () => {},
}));
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    $store: { atoms: { session: { get: () => atom.snapshot } } },
    useSession: () => stale,
  },
}));
vi.mock("./use-network-status", () => ({ useNetworkStatus: () => true }));
// Static rendering reads a store's server snapshot; read the client one, as the client-rendered
// app does.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
}));

const { readSessionIdentity, useAuthSession } = await import("./use-auth-session");
const identity = await import("@/lib/document-identity");

function Who({ unmasked = false }: { unmasked?: boolean }) {
  const { state } = useAuthSession({ unmasked });
  return <span>{state.status === "authenticated" ? state.session.user.name : state.status}</span>;
}

describe("useAuthSession", () => {
  it("reports the atom's account while the document's identity is not in question", () => {
    expect(renderToStaticMarkup(<Who />)).toContain("Previous Account");
  });

  it("shows nobody while another tab's identity change is unchecked here; the watcher still sees it", () => {
    identity.resetDocumentIdentityForTests(() => ({ postMessage: () => {}, onmessage: null }));
    vi.stubGlobal("window", {});
    try {
      identity.announceDocumentIdentity("a"); // opens the document's channel
      identity.reportSessionRejected(); // no watcher mounted: unverified
      expect(identity.isDocumentIdentityUnverified()).toBe(true);
      const masked = renderToStaticMarkup(<Who />);
      expect(masked).toContain("pending");
      expect(masked).not.toContain("Previous Account");
      expect(renderToStaticMarkup(<Who unmasked />)).toContain("Previous Account");
      identity.confirmDocumentIdentityFresh(identity.identityVerificationGeneration());
      expect(renderToStaticMarkup(<Who />)).toContain("Previous Account");
    } finally {
      vi.unstubAllGlobals();
      identity.resetDocumentIdentityForTests(() => undefined);
    }
  });

  it("reads only a successful, settled answer as a confirmed identity", () => {
    const snap = (over: Partial<NonNullable<typeof atom.snapshot>>) => {
      atom.snapshot = { data: null, error: null, isPending: false, isRefetching: false, ...over };
      return readSessionIdentity();
    };
    expect(snap({ data: { user: { id: "b" } } })).toBe("b");
    expect(snap({})).toBeNull();
    // A 401 confirms the session is gone.
    expect(snap({ error: { status: 401 } })).toBeNull();
    // A 503 confirms nothing: not with A's answer retained, not when the document was anonymous.
    expect(snap({ data: { user: { id: "a" } }, error: { status: 503 } })).toBeUndefined();
    expect(snap({ error: { status: 503 } })).toBeUndefined();
    // In flight: not yet an answer.
    expect(snap({ data: { user: { id: "a" } }, isRefetching: true })).toBeUndefined();
    expect(snap({ isPending: true })).toBeUndefined();
    atom.snapshot = undefined;
    expect(readSessionIdentity()).toBeUndefined();
  });
});
