// @vitest-environment jsdom

import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Reauth decision freshness tests (Part H pass 3 — R85/R86 N1, adapted from
 * the reviewers' actual-route probes; pass 4 — R87/R88 P2 failed/paused
 * refetch class): the MCP login page's authenticated branch (McpReauthBranch
 * — the route passes the SESSION through) must act ONLY on a tombstone
 * decision fetched for the CURRENT (session id, client, transaction) key —
 * never on a decision keyed to the user id, never on retained cache data
 * while a fresh probe is in flight, and never after a fresh probe FAILED or
 * went offline-paused (installed query-core retains previous data in both
 * states with isFetching === false).
 */

const h = vi.hoisted(() => ({
  probe: vi.fn(),
  assign: vi.fn(),
}));

vi.mock("@/server/mcp-reauth", () => ({ getMcpReauthStatus: h.probe }));
vi.mock("@/lib/auth-client", () => ({
  authClient: { signOut: vi.fn() },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts && typeof opts.client === "string") return `${key}:${opts.client}`;
      return key;
    },
  }),
}));

import { mcpReauthStatusQueryKey, mcpSearchFingerprint } from "@/lib/mcp-oauth-search";
import { McpReauthBranch } from "./mcp-reauth-branch";

const FINGERPRINT = mcpSearchFingerprint({ client_id: "c", sig: "s" });

function freshClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

type BranchProps = React.ComponentProps<typeof McpReauthBranch>;

function renderBranch(props: Partial<BranchProps> = {}, client: QueryClient = freshClient()) {
  const view = render(
    <QueryClientProvider client={client}>
      <McpReauthBranch
        session={{ id: "session-A" }}
        clientId="c"
        lang="en-US"
        fingerprint={FINGERPRINT}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { client, view };
}

describe("McpReauthBranch decision freshness (R85/R86 N1)", () => {
  afterEach(() => {
    onlineManager.setOnline(true);
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("same user with a REPLACED session id probes again and does not reuse the old decision", async () => {
    h.probe.mockResolvedValue({ status: "reauth" });
    // The sessions share the user; only ids differ (the branch never sees a
    // user id — the key can only derive from session.id).
    const { client, view } = renderBranch({ session: { id: "session-A" } });

    await waitFor(() => expect(view.getByText("auth:mcpLogin.reauthTitle")).toBeTruthy());
    expect(h.probe).toHaveBeenCalledTimes(1);

    // Same user, NEW session → a different grant generation: the branch must
    // re-probe under the new session id key (a user-keyed cache — the pass-2
    // defect — would have skipped the second probe).
    view.rerender(
      <QueryClientProvider client={client}>
        <McpReauthBranch
          session={{ id: "session-B" }}
          clientId="c"
          lang="en-US"
          fingerprint={FINGERPRINT}
        />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(h.probe).toHaveBeenCalledTimes(2));
  });

  it("does NOT navigate on retained cached 'continue' while the fresh probe is in flight (isFetching)", async () => {
    vi.stubGlobal("location", { assign: h.assign, search: "?client_id=c&sig=s" });
    // Seed retained cache exactly as the reviewers' probe did — the branch
    // must still hold navigation back until the CURRENT probe resolves.
    const client = freshClient();
    client.setQueryData(mcpReauthStatusQueryKey("session-A", "c", FINGERPRINT), {
      status: "continue",
    });
    let releaseProbe: (value: { status: "continue" }) => void = () => {};
    h.probe.mockImplementation(
      () => new Promise<{ status: "continue" }>((resolve) => (releaseProbe = resolve)),
    );

    renderBranch({}, client);
    await waitFor(() => expect(h.probe).toHaveBeenCalledTimes(1));
    // The fresh probe is fetching: navigation must NOT fire on the retained
    // decision (pass-2 defect: isPending === false while isFetching === true
    // let the cached "continue" navigate immediately).
    expect(h.assign).not.toHaveBeenCalled();

    await act(async () => {
      releaseProbe({ status: "continue" });
    });
    // Only after the CURRENT-key probe resolves may navigation fire.
    await waitFor(() =>
      expect(h.assign).toHaveBeenCalledWith("/en-US/mcp-consent?client_id=c&sig=s"),
    );
    expect(h.assign).toHaveBeenCalledTimes(1);
  });

  it("revocation between SAME-CLIENT remounts yields a FRESH decision (no cached 'continue' reuse)", async () => {
    vi.stubGlobal("location", { assign: h.assign, search: "?client_id=c&sig=s" });
    // R87/R88 P2: the re-entry test must REUSE the same QueryClient —
    // installed query-core schedules gcTime: 0 eviction asynchronously
    // (removable.cjs scheduleGc → timeoutManager.setTimeout), so the second
    // mount can still observe the retained "continue" decision.
    const client = freshClient();
    h.probe.mockResolvedValue({ status: "continue" });
    const first = renderBranch({}, client);
    await waitFor(() => expect(h.probe).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(h.assign).toHaveBeenCalledTimes(1));
    first.view.unmount();

    // Revocation happens between mounts: the second mount (same client,
    // retained data possible) MUST re-probe and honor the new "reauth" —
    // never act on the retained "continue".
    h.probe.mockResolvedValue({ status: "reauth" });
    const second = renderBranch({}, client);
    await waitFor(() => expect(second.view.getByText("auth:mcpLogin.reauthTitle")).toBeTruthy());
    expect(h.probe).toHaveBeenCalledTimes(2);
    expect(h.assign).toHaveBeenCalledTimes(1); // no second navigation
    second.view.unmount();
  });

  it("retained 'continue' + FAILED fresh probe: invalid card, ZERO navigations (R87/R88 P2a)", async () => {
    vi.stubGlobal("location", { assign: h.assign, search: "?client_id=c&sig=s" });
    const client = freshClient();
    client.setQueryData(mcpReauthStatusQueryKey("session-A", "c", FINGERPRINT), {
      status: "continue",
    });
    // The fresh probe fails; query-core RETAINS the previous data with
    // fetchStatus "idle" — the old !isFetching gate navigated from it.
    h.probe.mockRejectedValue(new Error("probe failed"));
    const { view } = renderBranch({}, client);

    await waitFor(() => expect(h.probe).toHaveBeenCalledTimes(1));
    // The invalid card renders (fresh failure), NOT a navigation.
    await waitFor(() => expect(view.getByText("auth:mcpLogin.invalidTitle")).toBeTruthy());
    expect(h.assign).not.toHaveBeenCalled();
  });

  it("retained 'continue' + OFFLINE pause: pending skeleton, zero probes, zero navigations, zero actions (R87/R88 P2b)", async () => {
    vi.stubGlobal("location", { assign: h.assign, search: "?client_id=c&sig=s" });
    onlineManager.setOnline(false);
    const client = freshClient();
    client.setQueryData(mcpReauthStatusQueryKey("session-A", "c", FINGERPRINT), {
      status: "continue",
    });
    h.probe.mockRejectedValue(new Error("must not run while paused"));
    const { view } = renderBranch({}, client);

    // Paused queries have fetchStatus "paused" (not "fetching"): the fresh
    // probe never runs, so the page must stay on pending UI and act on
    // nothing — least of all the retained "continue".
    await waitFor(() =>
      expect(view.container.querySelector('[data-slot="skeleton"]')).toBeTruthy(),
    );
    await act(async () => {});
    expect(view.container.querySelector('[data-slot="skeleton"]')).toBeTruthy();
    expect(view.queryByText("auth:mcpLogin.invalidTitle")).toBeNull();
    expect(view.queryByText("auth:mcpLogin.reauthTitle")).toBeNull();
    expect(h.probe).not.toHaveBeenCalled();
    expect(h.assign).not.toHaveBeenCalled();

    // Settle the offline → online resume INSIDE this test: the paused query
    // resumes (and rejects) here so its probe call cannot leak into the
    // NEXT test's call counts after the afterEach clearAllMocks.
    onlineManager.setOnline(true);
    await waitFor(() => expect(view.getByText("auth:mcpLogin.invalidTitle")).toBeTruthy());
  });

  it("retained 'reauth' + fresh fetch in flight: skeleton (no sign-out action) until fresh success (R87/R88 P2c)", async () => {
    vi.stubGlobal("location", { assign: h.assign, search: "?client_id=c&sig=s" });
    // The prior test went offline; restore connectivity explicitly so this
    // mount FETCHES (the paused-resume notification from the afterEach
    // onlineManager.setOnline(true) is asynchronous relative to the next
    // test's mount).
    onlineManager.setOnline(true);
    const client = freshClient();
    client.setQueryData(mcpReauthStatusQueryKey("session-A", "c", FINGERPRINT), {
      status: "reauth",
    });
    let releaseProbe: (value: { status: "reauth" }) => void = () => {};
    h.probe.mockImplementation(
      () => new Promise<{ status: "reauth" }>((resolve) => (releaseProbe = resolve)),
    );
    const { view } = renderBranch({}, client);

    // While the fresh validation is in flight, the retained "reauth" must
    // not expose an actionable sign-out button.
    await waitFor(() => expect(h.probe).toHaveBeenCalledTimes(1));
    expect(view.container.querySelector('[data-slot="skeleton"]')).toBeTruthy();
    expect(view.queryByRole("button", { name: "auth:mcpLogin.reauthConfirm" })).toBeNull();
    expect(h.assign).not.toHaveBeenCalled();

    await act(async () => {
      releaseProbe({ status: "reauth" });
    });
    // Fresh success re-enables the action.
    const button = await view.findByRole("button", { name: "auth:mcpLogin.reauthConfirm" });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(h.assign).not.toHaveBeenCalled();
  });
});
