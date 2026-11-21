// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MCP_FINE_SCOPES } from "@ws-model-proxy/auth/agent-scopes";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const FULL_OAUTH_SCOPE = `mcp:read ${MCP_FINE_SCOPES.join(" ")}`;

/** Consent failures stay terminal; only signature/expiry errors use the invalid-request copy. */

const consentMock = vi.hoisted(() => vi.fn());
const publicClientMock = vi.hoisted(() => vi.fn());
const connectionsMock = vi.hoisted(() => vi.fn());
const assignMock = vi.hoisted(() => vi.fn());

vi.mock("@/utils/orpc", () => ({
  orpc: {
    access: {
      oauthGrants: {
        list: { queryOptions: () => ({ queryKey: ["connections"], queryFn: connectionsMock }) },
      },
    },
    nodes: {
      list: {
        queryOptions: () => ({
          queryKey: ["nodes", "list"],
          queryFn: async () => ({ nodes: [{ id: "own-node", slug: "my-node", name: null }] }),
        }),
      },
    },
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts && typeof opts.client === "string") return `${key}:${opts.client}`;
      if (opts && typeof opts.scope === "string") return `${key}:${opts.scope}`;
      if (opts && typeof opts.scopes === "string") return `${key}:${opts.scopes}`;
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

beforeEach(() => {
  connectionsMock.mockResolvedValue({ connections: [] });
});

const USABLE_SEARCH = {
  client_id: "mcp-client-1",
  scope: "mcp:read",
  sig: "sig-1",
};

/** The raw URL as the authorize endpoint signs it: every signed name listed in ba_param. */
function signedRawSearch(redirectUri: string | null, extra = "") {
  const params = new URLSearchParams({ client_id: "mcp-client-1", scope: "mcp:read" });
  if (redirectUri !== null) params.set("redirect_uri", redirectUri);
  for (const name of [...params.keys(), "ba_param"].sort()) params.append("ba_param", name);
  params.append("sig", "sig-1");
  return `?${params.toString()}${extra}`;
}
const SIGNED_RAW_SEARCH = signedRawSearch("https://client.example/cb");

function renderPage(
  search: Record<string, unknown> = USABLE_SEARCH,
  rawSearch: string = SIGNED_RAW_SEARCH,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  // jsdom's Location methods are non-configurable, so the whole location
  // global is stubbed (probe-verified working in this environment).
  vi.stubGlobal("location", {
    assign: assignMock,
    search: rawSearch,
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

  it("renders a generic failure card when the consent call throws", async () => {
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
      expect(screen.getByText("auth:mcpConsent.failedTitle")).toBeTruthy();
    });
    expect(screen.queryByText("auth:mcpConsent.accept")).toBeNull();
  });

  it("renders a generic failure card when an APPROVAL response carries no redirect", async () => {
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
      expect(screen.getByText("auth:mcpConsent.failedTitle")).toBeTruthy();
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
    vi.stubGlobal("location", { assign: assignMock, search: SIGNED_RAW_SEARCH });
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

describe("McpConsentPage redirect host", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("shows the signed redirect_uri host, never the client's self-declared client_uri", async () => {
    publicClientMock.mockResolvedValue({
      data: {
        client_id: "mcp-client-1",
        client_name: "Client",
        client_uri: "https://trusted-looking.example",
      },
      error: null,
    });
    renderPage(USABLE_SEARCH, signedRawSearch("https://client.example:8443/cb?x=1"));
    const host = await screen.findByTestId("redirect-host");
    expect(host.textContent).toBe("client.example:8443");
    expect(screen.queryByText(/trusted-looking/)).toBeNull();
  });

  it("reads the raw URL the consent call forwards, not an unsigned copy appended to it", async () => {
    publicClientMock.mockResolvedValue({
      data: { client_id: "mcp-client-1", client_name: "Client" },
      error: null,
    });
    renderPage(USABLE_SEARCH, signedRawSearch(null, "&redirect_uri=https%3A%2F%2Fevil.example"));
    await waitFor(() => {
      expect(screen.getByText("auth:mcpConsent.invalidTitle")).toBeTruthy();
    });
    expect(screen.queryByText("auth:mcpConsent.accept")).toBeNull();
    expect(screen.queryByText(/evil\.example/)).toBeNull();
  });

  it("treats a repeated redirect_uri as an invalid request", async () => {
    publicClientMock.mockResolvedValue({
      data: { client_id: "mcp-client-1", client_name: "Client" },
      error: null,
    });
    renderPage(
      USABLE_SEARCH,
      signedRawSearch("https://client.example/cb", "&redirect_uri=https%3A%2F%2Fevil.example"),
    );
    await waitFor(() => {
      expect(screen.getByText("auth:mcpConsent.invalidTitle")).toBeTruthy();
    });
    expect(screen.queryByText("auth:mcpConsent.accept")).toBeNull();
  });
});

describe("McpConsentPage access choice", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  const FULL_SEARCH = { client_id: "mcp-client-1", scope: FULL_OAUTH_SCOPE, sig: "sig-1" };

  function approveResponds() {
    publicClientMock.mockResolvedValue({
      data: { client_id: "mcp-client-1", client_name: "Client" },
      error: null,
    });
    consentMock.mockResolvedValue({
      data: { redirect: true, url: "https://client.example/cb?code=x" },
      error: null,
    });
  }

  it("starts with fixed read only even when all permissions were requested", async () => {
    approveResponds();
    renderPage(FULL_SEARCH);
    const read = await screen.findByRole("checkbox", { name: /access:agents.scopes.read.name/ });
    expect(read.getAttribute("aria-checked")).toBe("true");
    expect(read.getAttribute("aria-disabled")).toBe("true");
    expect(
      screen
        .getByRole("checkbox", { name: /access:agents.scopes.files.name/ })
        .getAttribute("aria-checked"),
    ).toBe("false");
    await userEvent.setup().click(screen.getByText("auth:mcpConsent.accept"));
    await waitFor(() =>
      expect(consentMock).toHaveBeenCalledWith({ accept: true, scopes: ["read"], nodeIds: null }),
    );
  });

  it("Everything selects all seven scopes, with a chosen node allowlist", async () => {
    approveResponds();
    renderPage(FULL_SEARCH);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "access:agents.everything" }));
    await user.click(screen.getByRole("radio", { name: "access:agents.onlyNodes" }));
    await user.click(await screen.findByRole("checkbox", { name: "my-node" }));
    await user.click(screen.getByText("auth:mcpConsent.accept"));
    await waitFor(() =>
      expect(consentMock).toHaveBeenCalledWith({
        accept: true,
        scopes: ["read", "pools", "runtimes", "nodes:manage", "commands", "files", "models:test"],
        nodeIds: ["own-node"],
      }),
    );
  });

  it("ignores access the client put in the authorization URL", async () => {
    approveResponds();
    renderPage({
      ...FULL_SEARCH,
      scopes: ["read", "files"],
      nodeIds: ["own-node"],
      level: "FULL",
    });
    await userEvent.setup().click(await screen.findByText("auth:mcpConsent.accept"));
    await waitFor(() =>
      expect(consentMock).toHaveBeenCalledWith({ accept: true, scopes: ["read"], nodeIds: null }),
    );
  });

  it("offers only read for a read-only request", async () => {
    approveResponds();
    renderPage();
    await screen.findByText("auth:mcpConsent.requestedCeiling:access:agents.scopes.read.name");
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "access:agents.everything" })).toBeNull();
  });

  it("limits Everything and individual choices to a fine scope ceiling", async () => {
    approveResponds();
    renderPage({ ...FULL_SEARCH, scope: "mcp:read mcp:files mcp:models:test" });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "access:agents.everything" }));
    expect(screen.getAllByRole("checkbox")).toHaveLength(3);
    await user.click(screen.getByRole("radio", { name: "access:agents.onlyNodes" }));
    await user.click(screen.getByText("auth:mcpConsent.accept"));
    await waitFor(() =>
      expect(consentMock).toHaveBeenCalledWith({
        accept: true,
        scopes: ["read", "files", "models:test"],
        nodeIds: [],
      }),
    );
  });

  it("still explains offline access and unknown OAuth scopes alongside the chooser", async () => {
    approveResponds();
    renderPage({ ...FULL_SEARCH, scope: "mcp:read mcp:files offline_access custom:scope" });
    await screen.findByText("auth:mcpConsent.scopes.offline_access.description");
    expect(screen.getByText("auth:mcpConsent.scopes.additionalName:custom:scope")).toBeTruthy();
    expect(screen.queryByText("auth:mcpConsent.scopes.additionalName:mcp:files")).toBeNull();
  });

  it("a denial carries no access", async () => {
    approveResponds();
    renderPage(FULL_SEARCH);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "access:agents.everything" }));
    await user.click(screen.getByText("auth:mcpConsent.deny"));
    await waitFor(() => expect(consentMock).toHaveBeenCalledWith({ accept: false }));
  });
});

describe("renewed consent", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  function saved(overrides: Record<string, unknown> = {}) {
    return {
      clientId: "mcp-client-1",
      scopes: ["read", "files"],
      nodeIds: ["own-node"],
      availableScopes: ["read", "files", "commands"],
      currentSession: true,
      revokedAt: null,
      ...overrides,
    };
  }
  function setup(connections: ReturnType<typeof saved>[], scope = FULL_OAUTH_SCOPE) {
    publicClientMock.mockResolvedValue({
      data: { client_id: "mcp-client-1", client_name: "Client" },
      error: null,
    });
    consentMock.mockResolvedValue({
      data: { redirect: true, url: "https://client.example/cb?code=x" },
      error: null,
    });
    connectionsMock.mockResolvedValue({ connections });
    return renderPage({ ...USABLE_SEARCH, scope });
  }

  it("preserves the active matching connection and its node restriction when approved unchanged", async () => {
    setup([
      saved({ clientId: "other-client", nodeIds: null }),
      saved({ revokedAt: "2026-11-01T00:00:00.000Z", nodeIds: null }),
      saved(),
    ]);
    expect(
      (await screen.findByRole<HTMLInputElement>("radio", { name: "access:agents.onlyNodes" }))
        .checked,
    ).toBe(true);
    expect(
      (await screen.findByRole("checkbox", { name: "my-node" })).getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen
        .getByRole("checkbox", { name: /access:agents.scopes.files.name/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(screen.queryByText("auth:mcpConsent.narrowWarning")).toBeNull();
    expect(screen.queryByText("auth:mcpConsent.widenNotice")).toBeNull();
    await userEvent.setup().click(screen.getByText("auth:mcpConsent.accept"));
    await waitFor(() =>
      expect(consentMock).toHaveBeenCalledWith({
        accept: true,
        scopes: ["read", "files"],
        nodeIds: ["own-node"],
      }),
    );
  });

  it("clips saved scopes to the request ceiling and warns about the resulting narrowing", async () => {
    setup([saved({ scopes: ["read", "files", "commands"] })], "mcp:read mcp:files");
    await screen.findByText("auth:mcpConsent.narrowWarning");
    expect(
      screen
        .getByRole("checkbox", { name: /access:agents.scopes.files.name/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(screen.queryByRole("checkbox", { name: /commands.name/ })).toBeNull();
    expect(
      screen.getByText(
        "auth:mcpConsent.requestedCeiling:access:agents.scopes.read.name, access:agents.scopes.files.name",
      ),
    ).toBeTruthy();
    await userEvent.setup().click(screen.getByText("auth:mcpConsent.accept"));
    await waitFor(() =>
      expect(consentMock).toHaveBeenCalledWith({
        accept: true,
        scopes: ["read", "files"],
        nodeIds: ["own-node"],
      }),
    );
  });

  it.each(["scope", "all nodes", "added node"])("shows a widening notice for %s", async (kind) => {
    setup([saved({ nodeIds: kind === "added node" ? [] : ["own-node"] })]);
    const user = userEvent.setup();
    await screen.findByText("auth:mcpConsent.accept");
    if (kind === "scope")
      await user.click(
        screen.getByRole("checkbox", { name: /access:agents.scopes.commands.name/ }),
      );
    else if (kind === "all nodes")
      await user.click(screen.getByRole("radio", { name: "access:agents.allNodes" }));
    else await user.click(await screen.findByRole("checkbox", { name: "my-node" }));
    expect(screen.getByRole("status").textContent).toBe("auth:mcpConsent.widenNotice");
    expect(screen.queryByText("auth:mcpConsent.narrowWarning")).toBeNull();
  });

  it("shows the existing narrowing warning when the person removes a scope or node", async () => {
    setup([saved()]);
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("checkbox", { name: /access:agents.scopes.files.name/ }),
    );
    expect(screen.getByRole("alert").textContent).toBe("auth:mcpConsent.narrowWarning");
    await user.click(screen.getByRole("checkbox", { name: /access:agents.scopes.files.name/ }));
    expect(screen.queryByRole("alert")).toBeNull();
    await user.click(await screen.findByRole("checkbox", { name: "my-node" }));
    expect(screen.getByRole("alert").textContent).toBe("auth:mcpConsent.narrowWarning");
  });

  it("ignores revoked connections, other clients and other sessions, preserving first-consent defaults", async () => {
    setup([
      saved({ revokedAt: "2026-11-01T00:00:00.000Z" }),
      saved({ clientId: "other-client" }),
      // Another browser session's connection: this approval writes a new one, not that one.
      saved({ currentSession: false, scopes: ["read", "files", "commands"], nodeIds: null }),
    ]);
    await userEvent.setup().click(await screen.findByText("auth:mcpConsent.accept"));
    await waitFor(() =>
      expect(consentMock).toHaveBeenCalledWith({ accept: true, scopes: ["read"], nodeIds: null }),
    );
  });

  it("waits for saved access rather than offering a default approval during loading", async () => {
    publicClientMock.mockResolvedValue({
      data: { client_id: "mcp-client-1", client_name: "Client" },
      error: null,
    });
    let release: (value: unknown) => void = () => {};
    connectionsMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    renderPage({ ...USABLE_SEARCH, scope: FULL_OAUTH_SCOPE });
    await act(async () => {});
    expect(screen.queryByText("auth:mcpConsent.accept")).toBeNull();
    await act(async () => {
      release({ connections: [saved()] });
    });
    expect(await screen.findByRole("radio", { name: "access:agents.onlyNodes" })).toBeTruthy();
  });

  it("waits for a fresh connection lookup even when Access left cached defaults", async () => {
    publicClientMock.mockResolvedValue({
      data: { client_id: "mcp-client-1", client_name: "Client" },
      error: null,
    });
    let release: (value: unknown) => void = () => {};
    connectionsMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["connections"], { connections: [] });
    vi.stubGlobal("location", { assign: assignMock, search: SIGNED_RAW_SEARCH });
    render(
      <QueryClientProvider client={client}>
        <McpConsentPage search={{ ...USABLE_SEARCH, scope: FULL_OAUTH_SCOPE }} />
      </QueryClientProvider>,
    );
    await act(async () => {});
    expect(screen.queryByText("auth:mcpConsent.accept")).toBeNull();
    await act(async () => {
      release({ connections: [saved()] });
    });
    expect(
      (await screen.findByRole<HTMLInputElement>("radio", { name: "access:agents.onlyNodes" }))
        .checked,
    ).toBe(true);
  });

  it("keeps the chooser stable when saved access is refreshed in the background", async () => {
    const { client } = setup([saved()]);
    await screen.findByRole("checkbox", { name: "my-node" });
    await act(async () => {
      client.setQueryData(["connections"], {
        connections: [saved({ scopes: ["read"], nodeIds: null })],
      });
    });
    expect(
      screen.getByRole<HTMLInputElement>("radio", { name: "access:agents.onlyNodes" }).checked,
    ).toBe(true);
    expect(
      screen
        .getByRole("checkbox", { name: /access:agents.scopes.files.name/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("shows both notices when adding a scope while removing a node", async () => {
    setup([saved()]);
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("checkbox", { name: /access:agents.scopes.commands.name/ }),
    );
    await user.click(await screen.findByRole("checkbox", { name: "my-node" }));
    expect(screen.getByRole("alert").textContent).toBe("auth:mcpConsent.narrowWarning");
    expect(screen.getByRole("status").textContent).toBe("auth:mcpConsent.widenNotice");
  });

  it("blocks approval when saved access cannot be loaded", async () => {
    publicClientMock.mockResolvedValue({
      data: { client_id: "mcp-client-1", client_name: "Client" },
      error: null,
    });
    connectionsMock.mockRejectedValue(new Error("network"));
    renderPage();
    await screen.findByText("auth:mcpConsent.connectionsFailed");
    expect(screen.queryByText("auth:mcpConsent.accept")).toBeNull();
  });

  it.each([
    { code: "BAD_REQUEST", status: 400 },
    { error: "invalid_scope" },
    { error: "server_error", status: 500 },
  ])("does not call an ordinary consent failure an expired signature: %j", async (error) => {
    setup([]);
    consentMock.mockResolvedValue({ data: null, error });
    await userEvent.setup().click(await screen.findByText("auth:mcpConsent.accept"));
    await screen.findByText("auth:mcpConsent.failedDescription");
    expect(screen.queryByText("auth:mcpConsent.invalidDescription")).toBeNull();
    expect(assignMock).not.toHaveBeenCalled();
  });

  it("recognizes the provider's error field for signature or expiry rejection", async () => {
    setup([]);
    consentMock.mockResolvedValue({
      data: null,
      error: { error: "invalid_signature", status: 400 },
    });
    await userEvent.setup().click(await screen.findByText("auth:mcpConsent.accept"));
    await screen.findByText("auth:mcpConsent.invalidDescription");
    expect(screen.queryByText("auth:mcpConsent.failedDescription")).toBeNull();
  });
});
