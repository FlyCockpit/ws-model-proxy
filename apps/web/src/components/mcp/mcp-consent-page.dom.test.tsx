// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Consent failure-state tests (Phase 6, Part H pass 2 — R83/R84 F4):
 * the "invalid" phase (consent API error, thrown failure, approval response
 * without a redirect) must render the LOCALIZED terminal invalid-request
 * card — the approval buttons may never reappear for a transaction that can
 * no longer be completed.
 */

const consentMock = vi.hoisted(() => vi.fn());
const publicClientMock = vi.hoisted(() => vi.fn());
const assignMock = vi.hoisted(() => vi.fn());

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts && typeof opts.client === "string") return `${key}:${opts.client}`;
      if (opts && typeof opts.scope === "string") return `${key}:${opts.scope}`;
      return key;
    },
    i18n: { language: "en-US" },
  }),
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    oauth2: { consent: consentMock, publicClient: publicClientMock },
  },
}));

import { McpConsentPage } from "./mcp-consent-page";

const USABLE_SEARCH = {
  client_id: "mcp-client-1",
  scope: "mcp:read",
  sig: "sig-1",
};

function renderPage(search: Record<string, unknown> = USABLE_SEARCH) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  // jsdom's Location methods are non-configurable, so the whole location
  // global is stubbed (probe-verified working in this environment).
  vi.stubGlobal("location", {
    assign: assignMock,
    search: window.location.search,
  });
  return {
    client,
    renderResult: render(
      <QueryClientProvider client={client}>
        <McpConsentPage search={search} />
      </QueryClientProvider>,
    ),
  };
}

describe("McpConsentPage failure states (R83/R84 F4)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("renders the localized terminal invalid card when the consent API resolves an error (invalid_signature)", async () => {
    publicClientMock.mockResolvedValue({
      data: { client_id: "mcp-client-1", client_name: "Client", client_uri: "https://c" },
      error: null,
    });
    consentMock.mockResolvedValue({ data: null, error: { code: "invalid_signature" } });
    renderPage();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText("auth:mcpConsent.accept")).toBeTruthy();
    });
    await user.click(screen.getByText("auth:mcpConsent.accept"));

    // The terminal invalid card replaces the approval buttons entirely.
    await waitFor(() => {
      expect(screen.getByText("auth:mcpConsent.invalidTitle")).toBeTruthy();
    });
    expect(screen.queryByText("auth:mcpConsent.accept")).toBeNull();
    expect(screen.queryByText("auth:mcpConsent.deny")).toBeNull();
    expect(screen.getByText("auth:mcpConsent.invalidDescription")).toBeTruthy();
    // No navigation happened — the transaction cannot be completed.
    expect(assignMock).not.toHaveBeenCalled();
  });

  it("renders the terminal invalid card when the consent call throws", async () => {
    publicClientMock.mockResolvedValue({
      data: { client_id: "mcp-client-1", client_name: "Client", client_uri: "https://c" },
      error: null,
    });
    consentMock.mockRejectedValue(new Error("network down"));
    renderPage();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText("auth:mcpConsent.accept")).toBeTruthy();
    });
    await user.click(screen.getByText("auth:mcpConsent.accept"));

    await waitFor(() => {
      expect(screen.getByText("auth:mcpConsent.invalidTitle")).toBeTruthy();
    });
    expect(screen.queryByText("auth:mcpConsent.accept")).toBeNull();
  });

  it("renders the terminal invalid card when an APPROVAL response carries no redirect", async () => {
    publicClientMock.mockResolvedValue({
      data: { client_id: "mcp-client-1", client_name: "Client", client_uri: "https://c" },
      error: null,
    });
    // Approval (accept: true) without { redirect: true, url } — the
    // reviewers' no-redirect-approval probe.
    consentMock.mockResolvedValue({ data: {}, error: null });
    renderPage();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText("auth:mcpConsent.accept")).toBeTruthy();
    });
    await user.click(screen.getByText("auth:mcpConsent.accept"));

    await waitFor(() => {
      expect(screen.getByText("auth:mcpConsent.invalidTitle")).toBeTruthy();
    });
    expect(screen.queryByText("auth:mcpConsent.accept")).toBeNull();
    expect(assignMock).not.toHaveBeenCalled();
  });

  it("navigates on the server-issued redirect contract for APPROVAL", async () => {
    publicClientMock.mockResolvedValue({
      data: { client_id: "mcp-client-1", client_name: "Client", client_uri: "https://c" },
      error: null,
    });
    consentMock.mockResolvedValue({
      data: { redirect: true, url: "https://client.example/cb?code=x" },
      error: null,
    });
    renderPage();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText("auth:mcpConsent.accept")).toBeTruthy();
    });
    await user.click(screen.getByText("auth:mcpConsent.accept"));
    await waitFor(() => {
      expect(assignMock).toHaveBeenCalledWith("https://client.example/cb?code=x");
    });
  });

  it("genuinely exercises DENIAL: clicking deny navigates through the same redirect contract (R85 coverage note)", async () => {
    publicClientMock.mockResolvedValue({
      data: { client_id: "mcp-client-1", client_name: "Client", client_uri: "https://c" },
      error: null,
    });
    // Better Auth's denial response: the client's redirect_uri with
    // error=access_denied, still { redirect: true, url }.
    consentMock.mockResolvedValue({
      data: { redirect: true, url: "https://client.example/cb?error=access_denied" },
      error: null,
    });
    renderPage();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText("auth:mcpConsent.deny")).toBeTruthy();
    });
    await user.click(screen.getByText("auth:mcpConsent.deny"));
    await waitFor(() => {
      expect(assignMock).toHaveBeenCalledWith("https://client.example/cb?error=access_denied");
    });
    // The DENY button drove this navigation — the consent call carried
    // accept: false.
    expect(consentMock).toHaveBeenCalledWith({ accept: false });
  });

  it("StrictMode effect replay does not kill a LIVE submission (R87/R88 P1)", async () => {
    // The app mounts under root <StrictMode> (apps/web/src/client.tsx): dev
    // effect replay runs setup → cleanup → setup on the SAME hook instance.
    // The pass-3 cleanup-only disposed flag stayed true after that replay,
    // discarding the redirect response of a genuine live submission.
    publicClientMock.mockResolvedValue({
      data: { client_id: "mcp-client-1", client_name: "Client", client_uri: "https://c" },
      error: null,
    });
    consentMock.mockResolvedValue({
      data: { redirect: true, url: "https://client.example/cb?code=x" },
      error: null,
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    vi.stubGlobal("location", { assign: assignMock, search: window.location.search });
    render(
      <StrictMode>
        <QueryClientProvider client={client}>
          <McpConsentPage search={USABLE_SEARCH} />
        </QueryClientProvider>
      </StrictMode>,
    );
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText("auth:mcpConsent.accept")).toBeTruthy();
    });
    await user.click(screen.getByText("auth:mcpConsent.accept"));

    // Exactly one consent request, and the LIVE submission still completes:
    // the redirect contract navigates instead of leaving the page stuck on
    // the submitting skeleton.
    await waitFor(() => {
      expect(assignMock).toHaveBeenCalledWith("https://client.example/cb?code=x");
    });
    expect(consentMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("auth:mcpConsent.invalidTitle")).toBeNull();
  });

  it("replaces the transaction (new sig): the old terminal phase is discarded and buttons return (R85 N2)", async () => {
    publicClientMock.mockResolvedValue({
      data: { client_id: "mcp-client-1", client_name: "Client", client_uri: "https://c" },
      error: null,
    });
    consentMock.mockResolvedValue({ data: null, error: { code: "invalid_signature" } });
    const { renderResult } = renderPage();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText("auth:mcpConsent.accept")).toBeTruthy();
    });
    await user.click(screen.getByText("auth:mcpConsent.accept"));
    // Old transaction lands in its terminal invalid card.
    await waitFor(() => {
      expect(screen.getByText("auth:mcpConsent.invalidTitle")).toBeTruthy();
    });

    // A FRESH transaction replaces the expired one (new sig in the URL):
    // the page must not stay stuck in the old transaction's invalid phase.
    renderResult.rerender(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <McpConsentPage search={{ client_id: "mcp-client-1", scope: "mcp:read", sig: "sig-2" }} />
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(screen.getByText("auth:mcpConsent.accept")).toBeTruthy();
    });
    expect(screen.queryByText("auth:mcpConsent.invalidTitle")).toBeNull();
  });

  it("obsolete completion after transaction replacement: no setState, no navigation (R85 N2)", async () => {
    vi.stubGlobal("location", { assign: assignMock, search: "?client_id=mcp-client-1&sig=sig-1" });
    publicClientMock.mockResolvedValue({
      data: { client_id: "mcp-client-1", client_name: "Client" },
      error: null,
    });
    let releaseOld: (value: unknown) => void = () => {};
    consentMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseOld = resolve;
        }),
    );
    const { renderResult } = renderPage();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText("auth:mcpConsent.accept")).toBeTruthy();
    });
    await user.click(screen.getByText("auth:mcpConsent.accept"));

    // The transaction is REPLACED while the old consent call is in flight.
    renderResult.rerender(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <McpConsentPage search={{ client_id: "mcp-client-1", scope: "mcp:read", sig: "sig-2" }} />
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(screen.getByText("auth:mcpConsent.accept")).toBeTruthy();
    });

    // The old transaction's completion arrives with a redirect contract —
    // it must be ignored: no navigation, and the fresh review UI stays.
    await act(async () => {
      releaseOld({ data: { redirect: true, url: "https://old.example/cb" }, error: null });
    });
    expect(assignMock).not.toHaveBeenCalled();
    expect(screen.getByText("auth:mcpConsent.accept")).toBeTruthy();
  });

  it("pending completion after UNMOUNT: no navigation, no setState (R85 N2)", async () => {
    vi.stubGlobal("location", { assign: assignMock, search: "?client_id=mcp-client-1&sig=sig-1" });
    publicClientMock.mockResolvedValue({
      data: { client_id: "mcp-client-1", client_name: "Client" },
      error: null,
    });
    let release: (value: unknown) => void = () => {};
    consentMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const { renderResult } = renderPage();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText("auth:mcpConsent.accept")).toBeTruthy();
    });
    await user.click(screen.getByText("auth:mcpConsent.accept"));
    renderResult.unmount();

    await act(async () => {
      release({ data: { redirect: true, url: "https://old-client.example/cb" }, error: null });
    });
    expect(assignMock).not.toHaveBeenCalled();
  });
});
