// @vitest-environment jsdom

import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A signed-out visitor's typed email and password survive the tab regaining focus. Better Auth
 * refetches the session on focus and marks every request of an empty session `isPending` again
 * (`dist/client/query.mjs`, `onRequest`: `isPending: currentValue.data === null`): the same
 * snapshot as the first load. These tests drive the real `useAuthSession` through that snapshot
 * sequence with the real sign-in card and sign-up page, and check the typed values stay in the
 * same input nodes (React kept the form mounted) across a refetch and a failed refetch.
 */
type Snapshot = {
  data: { user: { id: string; name: string; email: string } } | null;
  isPending: boolean;
  isRefetching: boolean;
  error: unknown;
};

const store = vi.hoisted(() => {
  let snapshot: Snapshot = { data: null, isPending: true, isRefetching: false, error: null };
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
  };
});

const availability = vi.hoisted(() => ({ fail: false }));
const config = vi.hoisted(() => ({
  signupEnabled: true,
  adminBootstrapSignupEnabled: false,
  emailEnabled: false,
}));
const routeSearch = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en-US" } }),
}));
vi.mock("@ws-model-proxy/ui/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: () => {
      const snapshot = useSyncExternalStore(store.subscribe, store.get, store.get);
      return { ...snapshot, refetch: vi.fn() };
    },
    signIn: { email: vi.fn() },
    signUp: { email: vi.fn() },
    twoFactor: { verifyOtp: vi.fn(), verifyTotp: vi.fn(), sendOtp: vi.fn() },
    oauth2: {
      publicClientPrelogin: vi.fn(async () => ({ data: { client_id: "client-1" }, error: null })),
    },
  },
}));
vi.mock("@/hooks/use-network-status", () => ({ useNetworkStatus: () => true }));
vi.mock("@/utils/orpc", () => ({
  orpc: {
    app: {
      config: {
        queryOptions: () => ({
          queryKey: ["appConfig"],
          queryFn: async () => {
            if (availability.fail) throw new Error("refetch unavailable");
            return config;
          },
          initialData: config,
        }),
      },
    },
    auth: {
      verifyEmailTransport: { call: vi.fn() },
      inviteInfo: {
        queryOptions: () => ({ queryKey: ["inviteInfo"], queryFn: async () => null }),
      },
    },
  },
}));
vi.mock("@/server/auth-session", () => ({
  getRouteSession: vi.fn(async () => ({ status: "resolved", session: null })),
}));
vi.mock("@/server/mcp-availability", () => ({ getMcpWebAvailability: vi.fn() }));
vi.mock("@/server/mcp-reauth", () => ({ getMcpReauthStatus: vi.fn() }));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: Record<string, unknown>) => ({
    options,
    useParams: () => ({ lang: "en-US" }),
    useSearch: () => routeSearch.value,
  }),
  redirect: (options: unknown) => ({ redirect: options }),
  Link: (props: { to?: string; children: ReactNode }) => <a href={props.to}>{props.children}</a>,
  useNavigate: () => vi.fn(),
}));

const { resetAuthSessionMemoryForTests, useAuthSession } = await import("@/hooks/use-auth-session");
const {
  confirmDocumentIdentityFresh,
  connectIdentityPeers,
  identityVerificationGeneration,
  isDocumentIdentityUnverified,
  isDocumentReplaced,
  observeDocumentIdentity,
  resetDocumentIdentityForTests,
} = await import("@/lib/document-identity");
const { SignInCard } = await import("./sign-in-card");
const { AuthCard } = await import("./auth-card");
const { AuthRetryCard } = await import("./auth-retry-card");
const { Route: SignupRoute } = await import("@/routes/$lang/signup");
// The router plugin code-splits route components (`lazyRouteComponent`): load the real page first
// so it renders without suspending.
const SignupPage = (
  SignupRoute as unknown as {
    options: { component: (() => ReactNode) & { preload?: () => Promise<void> } };
  }
).options.component;
await SignupPage.preload?.();
const { Route: ForgotRoute } = await import("@/routes/$lang/forgot-password");
const { Route: VerifyRoute } = await import("@/routes/$lang/verify-email");
const ForgotPage = (
  ForgotRoute as unknown as {
    options: { component: (() => ReactNode) & { preload?: () => Promise<void> } };
  }
).options.component;
const VerifyPage = (
  VerifyRoute as unknown as {
    options: { component: (() => ReactNode) & { preload?: () => Promise<void> } };
  }
).options.component;
await ForgotPage.preload?.();
await VerifyPage.preload?.();
const { Route: McpRoute } = await import("@/routes/$lang/mcp-login");
const McpPage = (
  McpRoute as unknown as {
    options: { component: (() => ReactNode) & { preload?: () => Promise<void> } };
  }
).options.component;
await McpPage.preload?.();

const FIRST_LOAD: Snapshot = { data: null, isPending: true, isRefetching: false, error: null };
const ANONYMOUS: Snapshot = { data: null, isPending: false, isRefetching: false, error: null };
const REFETCH: Snapshot = { data: null, isPending: true, isRefetching: true, error: null };
const FAILED_REFETCH: Snapshot = {
  data: null,
  isPending: false,
  isRefetching: false,
  error: { status: 503 },
};

function ConfigProbe() {
  const query = useQuery({
    queryKey: ["appConfig"],
    queryFn: async () => {
      if (availability.fail) throw new Error("refetch unavailable");
      return config;
    },
  });
  return (
    <output hidden data-testid="config-status">
      {query.status}
    </output>
  );
}

function SessionProbe() {
  const { state } = useAuthSession();
  return (
    <output data-testid="session-status">{`${state.status}:${state.session?.user.id ?? ""}`}</output>
  );
}

function renderPage(page: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    ...render(
      <QueryClientProvider client={client}>
        {page}
        <ConfigProbe />
      </QueryClientProvider>,
    ),
    client,
  };
}

beforeEach(() => {
  availability.fail = false;
  config.emailEnabled = false;
  vi.clearAllMocks();
  resetAuthSessionMemoryForTests();
  resetDocumentIdentityForTests(() => undefined);
  routeSearch.value = {};
  store.set(FIRST_LOAD);
});
afterEach(() => {
  cleanup();
  resetDocumentIdentityForTests(() => undefined);
});

describe.each([
  ["sign-in card", () => <SignInCard lang="en-US" mode="standard" />],
  ["MCP sign-in card", () => <SignInCard lang="en-US" mode="mcp" />],
  ["sign-up page", () => <SignupPage />],
  ["MCP login page", () => <McpPage />],
])("%s across a refocus refetch", (_name, page) => {
  beforeEach(() => {
    routeSearch.value = { client_id: "client-1", sig: "signed-query" };
  });
  it("shows the skeleton only on the first load", () => {
    renderPage(page());
    expect(screen.queryByLabelText("auth:fields.email")).toBeNull();
    act(() => store.set(ANONYMOUS));
    expect(screen.getByLabelText("auth:fields.email")).toBeTruthy();
  });

  it("keeps the typed values and the same inputs through a refetch and a failed refetch", async () => {
    const user = userEvent.setup();
    renderPage(page());
    act(() => store.set(ANONYMOUS));
    const email = screen.getByLabelText("auth:fields.email") as HTMLInputElement;
    const password = screen.getByLabelText("auth:fields.password") as HTMLInputElement;
    await user.type(email, "user@example.com");
    await user.type(password, "hunter2hunter2");

    for (const snapshot of [REFETCH, ANONYMOUS, REFETCH, FAILED_REFETCH, ANONYMOUS]) {
      act(() => store.set(snapshot));
      expect(screen.getByLabelText("auth:fields.email")).toBe(email);
      expect(screen.getByLabelText("auth:fields.password")).toBe(password);
      expect(email.value).toBe("user@example.com");
      expect(password.value).toBe("hunter2hunter2");
      expect(screen.queryByText("auth:login.unableToConnect")).toBeNull();
    }
  });
});

describe.each([
  ["sign-in card", () => <SignInCard lang="en-US" mode="standard" />],
  ["MCP sign-in card", () => <SignInCard lang="en-US" mode="mcp" />],
  ["sign-up page", () => <SignupPage />],
  ["MCP login page", () => <McpPage />],
])("%s during peer verification", (_name, page) => {
  it("keeps typed inputs while the session is masked, until the same identity is confirmed", async () => {
    routeSearch.value = { client_id: "client-1", sig: "signed-query" };
    const channel = {
      postMessage: vi.fn(),
      onmessage: null as ((event: MessageEvent) => void) | null,
    };
    resetDocumentIdentityForTests(() => channel);
    observeDocumentIdentity(null);
    let finish!: () => void;
    const check = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const disconnect = connectIdentityPeers(check);
    store.set(ANONYMOUS);
    const user = userEvent.setup();
    renderPage(
      <>
        {page()}
        <SessionProbe />
      </>,
    );
    const email = screen.getByLabelText("auth:fields.email") as HTMLInputElement;
    const password = screen.getByLabelText("auth:fields.password") as HTMLInputElement;
    await user.type(email, "user@example.com");
    await user.type(password, "hunter2hunter2");

    const expectPreserved = () => {
      expect(screen.getByLabelText("auth:fields.email")).toBe(email);
      expect(screen.getByLabelText("auth:fields.password")).toBe(password);
      expect(email.value).toBe("user@example.com");
      expect(password.value).toBe("hunter2hunter2");
    };
    act(() => channel.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent));
    const since = identityVerificationGeneration();
    expect(screen.getByTestId("session-status").textContent).toBe("pending:");
    expectPreserved();
    act(() => store.set(REFETCH));
    expectPreserved();
    act(() => channel.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent));
    expect(check).toHaveBeenCalledOnce();
    act(() => confirmDocumentIdentityFresh(since));
    expect(isDocumentIdentityUnverified()).toBe(true);
    expectPreserved();

    await act(async () => {
      store.set(ANONYMOUS);
      expect(observeDocumentIdentity(null)).toBe(false);
      confirmDocumentIdentityFresh(identityVerificationGeneration());
      finish();
    });
    expect(isDocumentReplaced()).toBe(false);
    expect(screen.getByTestId("session-status").textContent).toBe("anonymous:");
    expectPreserved();
    disconnect();
  });
});

describe("one real h1 per auth page", () => {
  function expectOneH1(title: string) {
    const headings = document.querySelectorAll("h1");
    expect(headings).toHaveLength(1);
    expect(headings[0]?.textContent).toBe(title);
    expect(document.querySelectorAll('[role="heading"]')).toHaveLength(0);
  }

  it("the sign-in card", () => {
    store.set(ANONYMOUS);
    renderPage(<SignInCard lang="en-US" mode="standard" />);
    expectOneH1("auth:login.signinTitle");
  });

  it("the MCP sign-in card", () => {
    store.set(ANONYMOUS);
    renderPage(<SignInCard lang="en-US" mode="mcp" />);
    expectOneH1("auth:mcpLogin.title");
  });

  it("the sign-up page", () => {
    store.set(ANONYMOUS);
    renderPage(<SignupPage />);
    expectOneH1("auth:login.createAccount");
  });

  it("the shared auth card (forgot password, verify email)", () => {
    render(
      <AuthCard title="Forgot password" description="d">
        <p>body</p>
      </AuthCard>,
    );
    expectOneH1("Forgot password");
  });

  it("the unable-to-connect card", () => {
    render(<AuthRetryCard title="Unable to connect" description="d" onRetry={() => {}} />);
    expectOneH1("Unable to connect");
  });
});

describe.each([
  ["sign-in card", () => <SignInCard lang="en-US" mode="standard" />],
  ["sign-up page", () => <SignupPage />],
  ["forgot-password page", () => <ForgotPage />],
  ["verify-email page", () => <VerifyPage />],
])("%s config refetch errors", (_name, page) => {
  it("keeps the mounted form and typed values when cached config refetch fails", async () => {
    config.emailEnabled = true;
    store.set(ANONYMOUS);
    const user = userEvent.setup();
    const view = renderPage(page());
    const email = screen.getByLabelText("auth:fields.email") as HTMLInputElement;
    await user.type(email, "user@example.com");
    availability.fail = true;
    await act(async () => {
      await view.client.refetchQueries({ queryKey: ["appConfig"] });
    });
    await waitFor(() => expect(screen.getByTestId("config-status").textContent).toBe("error"));
    expect(view.client.getQueryState(["appConfig"])?.status).toBe("error");
    expect(screen.getByLabelText("auth:fields.email")).toBe(email);
    expect(email.value).toBe("user@example.com");
    expect(screen.queryByText("auth:login.unableToConnect")).toBeNull();
  });
});

it.each(["returned", "thrown"])(
  "signup %s errors show a friendly toast and keep values",
  async (failure) => {
    const { authClient } = await import("@/lib/auth-client");
    const { toast } = await import("@ws-model-proxy/ui/lib/toast");
    const error = new TypeError("Failed to fetch");
    if (failure === "thrown") vi.mocked(authClient.signUp.email).mockRejectedValueOnce(error);
    else
      vi.mocked(authClient.signUp.email).mockResolvedValueOnce({
        data: null,
        error: { status: 503, statusText: "Unavailable", message: "Server unavailable" },
      });
    store.set(ANONYMOUS);
    renderPage(<SignupPage />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("auth:fields.name"), "Test Person");
    await user.type(screen.getByLabelText("auth:fields.slug"), "testperson");
    const email = screen.getByLabelText("auth:fields.email") as HTMLInputElement;
    const password = screen.getByLabelText("auth:fields.password") as HTMLInputElement;
    await user.type(email, "user@example.com");
    await user.type(password, "longpassword123");
    await user.click(screen.getByRole("button", { name: "auth:login.signUp" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledOnce());
    expect(screen.getByLabelText("auth:fields.email")).toBe(email);
    expect(email.value).toBe("user@example.com");
    expect(password.value).toBe("longpassword123");
    expect(toast.success).not.toHaveBeenCalled();
  },
);

describe("verify-email copy when resend is unavailable", () => {
  it("does not prompt to enter email on pending or invalid states when emailEnabled is false", () => {
    config.emailEnabled = false;
    store.set(ANONYMOUS);

    renderPage(<VerifyPage />);
    expect(screen.getByText("auth:verifyEmail.pendingDescriptionNoResend")).toBeTruthy();
    expect(screen.getByText("auth:verifyEmail.emailUnavailable")).toBeTruthy();
    expect(screen.queryByText("auth:verifyEmail.pendingDescription")).toBeNull();
    cleanup();

    routeSearch.value = { error: "INVALID_TOKEN" };
    renderPage(<VerifyPage />);
    expect(screen.getByText("auth:verifyEmail.invalidDescriptionNoResend")).toBeTruthy();
    expect(screen.getByText("auth:verifyEmail.emailUnavailable")).toBeTruthy();
    expect(screen.queryByText("auth:verifyEmail.invalidDescription")).toBeNull();
  });

  it("shows the resend prompt description when emailEnabled is true", () => {
    config.emailEnabled = true;
    store.set(ANONYMOUS);

    renderPage(<VerifyPage />);
    expect(screen.getByText("auth:verifyEmail.pendingDescription")).toBeTruthy();
    expect(screen.queryByText("auth:verifyEmail.emailUnavailable")).toBeNull();
    cleanup();

    routeSearch.value = { error: "INVALID_TOKEN" };
    renderPage(<VerifyPage />);
    expect(screen.getByText("auth:verifyEmail.invalidDescription")).toBeTruthy();
    expect(screen.queryByText("auth:verifyEmail.emailUnavailable")).toBeNull();
  });
});

describe("signup confirmation card without resend", () => {
  it("does not repeat emailUnavailable below accountCreatedNoEmail when mail becomes unavailable", async () => {
    const { authClient } = await import("@/lib/auth-client");
    vi.mocked(authClient.signUp.email).mockResolvedValueOnce({
      data: { user: { id: "u1", email: "user@example.com", name: "Test Person" }, token: null },
      error: null,
    });
    config.emailEnabled = true;
    store.set(ANONYMOUS);
    const view = renderPage(<SignupPage />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("auth:fields.name"), "Test Person");
    await user.type(screen.getByLabelText("auth:fields.slug"), "testperson");
    await user.type(screen.getByLabelText("auth:fields.email"), "user@example.com");
    await user.type(screen.getByLabelText("auth:fields.password"), "longpassword123");
    await user.click(screen.getByRole("button", { name: "auth:login.signUp" }));

    await waitFor(() => expect(screen.getByText("auth:verifyEmail.sentTitle")).toBeTruthy());
    expect(screen.getByRole("button", { name: "auth:verifyEmail.resend" })).toBeTruthy();

    await act(async () => {
      view.client.setQueryData(["appConfig"], { ...config, emailEnabled: false });
    });

    await waitFor(() =>
      expect(screen.getByText("auth:verifyEmail.accountCreatedNoEmail")).toBeTruthy(),
    );
    expect(screen.queryByText("auth:verifyEmail.emailUnavailable")).toBeNull();
    expect(screen.queryByRole("button", { name: "auth:verifyEmail.resend" })).toBeNull();
  });
});
