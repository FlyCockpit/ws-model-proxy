// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Shared-login parity tests (MCP plan Phase 6): the ONE SignInCard serves the
 * ordinary login route (mode "standard") and the MCP login route (mode
 * "mcp") without behavior drift — email/password, SSO, email-OTP, and
 * TOTP/2FA branches are the same component, and mcp mode only changes the
 * header strings, hides the signup hint, and prefers the server-issued OAuth
 * continuation after sign-in.
 */

const signInEmailMock = vi.hoisted(() => vi.fn());
const navigateMock = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({
  authStatus: "anonymous" as string,
  config: {} as Record<string, unknown>,
}));
const assignMock = vi.hoisted(() => vi.fn());

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts && typeof opts.client === "string") return `${key}:${opts.client}`;
      if (opts && typeof opts.provider === "string") return `${key}:${opts.provider}`;
      return key;
    },
    i18n: { language: "en-US" },
  }),
}));

vi.mock("@ws-model-proxy/ui/components/sileo", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    signIn: { email: signInEmailMock },
    twoFactor: { verifyOtp: vi.fn(), verifyTotp: vi.fn(), sendOtp: vi.fn() },
  },
}));

vi.mock("@/hooks/use-auth-session", () => ({
  useAuthSession: () => ({ state: { status: state.authStatus } }),
}));

vi.mock("@/utils/orpc", () => ({
  orpc: {
    appConfig: {
      queryOptions: () => ({
        queryKey: ["appConfig"],
        queryFn: async () => state.config,
        initialData: state.config,
      }),
    },
    auth: {},
  },
}));

vi.mock("@tanstack/react-router", () => ({
  Link: (props: { to?: string; children: ReactNode }) => <a href={props.to}>{props.children}</a>,
  useNavigate: () => navigateMock,
}));

import { SignInCard } from "./sign-in-card";

function renderCard(props: Partial<Parameters<typeof SignInCard>[0]> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <SignInCard lang="en-US" mode="standard" {...props} />
    </QueryClientProvider>,
  );
}

async function submitCredentials(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("auth:fields.email"), "user@example.com");
  await user.type(screen.getByLabelText("auth:fields.password"), "hunter2hunter2");
  await user.click(screen.getByRole("button", { name: "auth:login.signIn" }));
}

beforeAll(() => {
  Object.defineProperty(window, "location", {
    value: {
      ...window.location,
      href: "https://app.example.com/en-US/mcp-login?client_id=c&sig=s",
      assign: assignMock,
    },
    writable: true,
  });
});

describe("SignInCard mode parity", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    state.authStatus = "anonymous";
    state.config = {};
  });

  it("standard mode renders the standard title, credentials form, and signup hint", () => {
    renderCard({ mode: "standard", redirectTo: undefined });
    expect(screen.getByText("auth:login.signinTitle")).toBeTruthy();
    expect(screen.getByLabelText("auth:fields.email")).toBeTruthy();
    expect(screen.getByLabelText("auth:fields.password")).toBeTruthy();
    expect(screen.getByText("auth:login.signupHint")).toBeTruthy();
    expect(screen.queryByText("auth:mcpLogin.title")).toBeNull();
  });

  it("mcp mode renders the MCP title/description and NO signup hint, same form", () => {
    renderCard({ mode: "mcp" });
    expect(screen.getByText("auth:mcpLogin.title")).toBeTruthy();
    expect(screen.getByText("auth:mcpLogin.description")).toBeTruthy();
    expect(screen.getByLabelText("auth:fields.email")).toBeTruthy();
    expect(screen.getByLabelText("auth:fields.password")).toBeTruthy();
    expect(screen.queryByText("auth:login.signupHint")).toBeNull();
  });

  it("mcp mode prefers the mcpDescription when provided (prelogin client data)", () => {
    renderCard({ mode: "mcp", mcpDescription: "auth:mcpLogin.clientDescription:Example Client" });
    expect(screen.getByText("auth:mcpLogin.clientDescription:Example Client")).toBeTruthy();
  });

  it("mcp mode constrains the CardDescription GRID CHILD itself (untrusted client name, R87/R88 P3)", () => {
    // The reviewers' Chromium control measured a 1,868–3,964px description
    // inside a 311px card when containment sat on an inline span; the fix
    // must place it on the [data-slot="card-description"] element itself
    // (the actual CardHeader grid child; packages/ui card.tsx merges the
    // className pass-through).
    const { container } = renderCard({
      mode: "mcp",
      mcpDescription: "auth:mcpLogin.clientDescription:LongUnbrokenClientName",
    });
    const description = container.querySelector('[data-slot="card-description"]');
    expect(description).toBeTruthy();
    expect(description?.className).toContain("min-w-0");
    expect(description?.className).toContain("max-w-full");
    expect(description?.className).toContain("break-words");
    // The text itself renders inside the constrained grid child (no
    // unconstrained inline wrapper carries it instead).
    expect(description?.textContent).toBe("auth:mcpLogin.clientDescription:LongUnbrokenClientName");
  });

  it("forceSso renders the SSO button and no credentials form in both modes", () => {
    state.config = { ssoEnabled: true, forceSso: true, ssoProviderName: "Acme" };
    const { unmount } = renderCard({ mode: "standard" });
    expect(screen.getByText("auth:login.ssoContinue:Acme")).toBeTruthy();
    expect(screen.queryByLabelText("auth:fields.email")).toBeNull();
    unmount();

    renderCard({ mode: "mcp" });
    expect(screen.getByText("auth:login.ssoContinue:Acme")).toBeTruthy();
    expect(screen.queryByLabelText("auth:fields.email")).toBeNull();
  });

  it("routes a twoFactorRedirect response into the shared 2FA branch (mcp mode)", async () => {
    const user = userEvent.setup();
    signInEmailMock.mockResolvedValueOnce({ data: { twoFactorRedirect: true }, error: null });
    state.config = { emailEnabled: true };
    renderCard({ mode: "mcp" });
    await submitCredentials(user);
    await waitFor(() => {
      expect(screen.getByText("auth:twoFactor.title")).toBeTruthy();
    });
    // Email-OTP affordance present when SMTP is enabled.
    expect(screen.getByText("auth:twoFactor.emailMeCode")).toBeTruthy();
  });

  it("standard mode navigates with the safe redirect after sign-in (no oauth url)", async () => {
    const user = userEvent.setup();
    signInEmailMock.mockResolvedValueOnce({ data: { user: { id: "u1" } }, error: null });
    renderCard({ mode: "standard", redirectTo: undefined });
    await submitCredentials(user);
    // The dashboard destination keeps its historical SPA navigation.
    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith({
        to: "/$lang/dashboard",
        params: { lang: "en-US" },
      });
    });
    expect(assignMock).not.toHaveBeenCalled();
  });

  it("mcp mode prefers the server-issued OAuth continuation url after sign-in", async () => {
    const user = userEvent.setup();
    signInEmailMock.mockResolvedValueOnce({
      data: { user: { id: "u1" }, redirect: true, url: "https://client.example/cb?code=abc" },
      error: null,
    });
    renderCard({ mode: "mcp" });
    await submitCredentials(user);
    await waitFor(() => {
      expect(assignMock).toHaveBeenCalledWith("https://client.example/cb?code=abc");
    });
  });

  it("mcp mode falls back to reloading the current page (signed query preserved)", async () => {
    const user = userEvent.setup();
    signInEmailMock.mockResolvedValueOnce({ data: { user: { id: "u1" } }, error: null });
    renderCard({ mode: "mcp" });
    await submitCredentials(user);
    await waitFor(() => {
      expect(assignMock).toHaveBeenCalledWith(
        "https://app.example.com/en-US/mcp-login?client_id=c&sig=s",
      );
    });
  });
});
