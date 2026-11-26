// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
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

const config = vi.hoisted(() => ({
  signupEnabled: true,
  adminBootstrapSignupEnabled: false,
  emailEnabled: false,
}));

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
  },
}));
vi.mock("@/hooks/use-network-status", () => ({ useNetworkStatus: () => true }));
vi.mock("@/utils/orpc", () => ({
  orpc: {
    app: {
      config: {
        queryOptions: () => ({
          queryKey: ["appConfig"],
          queryFn: async () => config,
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
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: Record<string, unknown>) => ({
    options,
    useParams: () => ({ lang: "en-US" }),
    useSearch: () => ({}),
  }),
  redirect: (options: unknown) => ({ redirect: options }),
  Link: (props: { to?: string; children: ReactNode }) => <a href={props.to}>{props.children}</a>,
  useNavigate: () => vi.fn(),
}));

const { resetAuthSessionMemoryForTests } = await import("@/hooks/use-auth-session");
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

const FIRST_LOAD: Snapshot = { data: null, isPending: true, isRefetching: false, error: null };
const ANONYMOUS: Snapshot = { data: null, isPending: false, isRefetching: false, error: null };
const REFETCH: Snapshot = { data: null, isPending: true, isRefetching: true, error: null };
const FAILED_REFETCH: Snapshot = {
  data: null,
  isPending: false,
  isRefetching: false,
  error: { status: 503 },
};

function renderPage(page: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{page}</QueryClientProvider>);
}

beforeEach(() => {
  resetAuthSessionMemoryForTests();
  store.set(FIRST_LOAD);
});
afterEach(() => {
  cleanup();
});

describe.each([
  ["sign-in card", () => <SignInCard lang="en-US" mode="standard" />],
  ["sign-up page", () => <SignupPage />],
])("%s across a refocus refetch", (_name, page) => {
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
