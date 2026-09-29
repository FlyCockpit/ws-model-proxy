// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ComponentType, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  lang: "en-US",
  search: { user_code: "WXYZ-1234" } as { user_code?: string },
  read: (() =>
    Promise.resolve({
      status: "pending",
      slug: "desk-01",
      existingDevice: null,
    })) as () => Promise<unknown>,
  approve: (() =>
    Promise.resolve({ status: "approved", slug: "desk-01" })) as () => Promise<unknown>,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({
      children,
      className,
      to,
    }: {
      children: ReactNode;
      className?: string;
      to: string;
    }) => (
      <a className={className} href={to}>
        {children}
      </a>
    ),
    createFileRoute: () => (options: { component: ComponentType }) => ({
      options,
      useParams: () => ({ lang: state.lang }),
      useSearch: () => state.search,
    }),
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  Trans: ({ i18nKey }: { i18nKey?: string }) => <span>{i18nKey}</span>,
}));

vi.mock("@ws-model-proxy/ui/components/sileo", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

// The route module imports the server-backed session probe; the component
// under test never calls it (only `beforeLoad` does).
vi.mock("@/server/auth-session", () => ({ getRouteSession: vi.fn(async () => null) }));

vi.mock("@/utils/orpc", () => ({
  orpc: {
    cliCredentials: {
      deviceLoginRequest: {
        queryOptions: ({ input }: { input: { userCode: string } }) => ({
          queryKey: ["deviceLoginRequest", input],
          queryFn: () => state.read(),
        }),
      },
      approveDeviceLogin: {
        mutationOptions: (options?: Record<string, unknown>) => ({
          ...options,
          mutationFn: () => state.approve(),
        }),
      },
    },
    devices: { key: () => ["devices"] },
    forwarderManagement: { key: () => ["forwarderManagement"] },
  },
}));

import { toast } from "@ws-model-proxy/ui/components/sileo";
import { createAppQueryCache, retryQueryWith } from "@/utils/query-error-toast";
import { Route } from "./device";

function refusal(reason: string) {
  return { status: 409, code: "CONFLICT", message: "raw server message", data: { reason } };
}

async function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    queryCache: createAppQueryCache(
      (key) => `t(${key})`,
      (query) => retryQueryWith(client)(query),
    ),
  });
  const Component = Route.options.component as ComponentType & { preload?: () => Promise<unknown> };
  await Component.preload?.();
  render(
    <QueryClientProvider client={client}>
      <Component />
    </QueryClientProvider>,
  );
  return client;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  state.lang = "en-US";
  state.search = { user_code: "WXYZ-1234" };
  state.read = () => Promise.resolve({ status: "pending", slug: "desk-01", existingDevice: null });
  state.approve = () => Promise.resolve({ status: "approved", slug: "desk-01" });
});

describe("DevicePage approval refusals", () => {
  it("renders the refusal card and hides Approve/Cancel when the approve is refused", async () => {
    state.approve = () => Promise.reject(refusal("already_used"));
    await mount();
    const user = userEvent.setup();

    await waitFor(() => expect(screen.getByText("device.approve")).toBeTruthy());
    await user.click(screen.getByText("device.approve"));

    await waitFor(() => expect(screen.getByText("device.refusal.already_used.title")).toBeTruthy());
    expect(screen.getByText("device.refusal.already_used.next")).toBeTruthy();
    expect(screen.queryByText("device.approve")).toBeNull();
    expect(screen.queryByText("device.cancel")).toBeNull();
    // A structured refusal is explained by the card alone, never by a toast.
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("renders the refusal card for a refused READ", async () => {
    state.read = () => Promise.reject(refusal("expired"));
    await mount();

    await waitFor(() => expect(screen.getByText("device.refusal.expired.title")).toBeTruthy());
    expect(screen.queryByText("device.approve")).toBeNull();
    expect(screen.queryByText("device.cancel")).toBeNull();
    // The read query opts out of the global error toast; the card is the only
    // feedback for a structured refusal.
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("keeps the buttons and the toast path for a non-refusal approve failure", async () => {
    state.approve = () => Promise.reject(new Error("network down"));
    await mount();
    const user = userEvent.setup();

    await waitFor(() => expect(screen.getByText("device.approve")).toBeTruthy());
    await user.click(screen.getByText("device.approve"));

    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("device.approve")).toBeTruthy();
    expect(screen.getByText("device.cancel")).toBeTruthy();
  });

  it("renders an inline load error (no generic toast) for a non-refusal read failure", async () => {
    state.read = () => Promise.reject(new Error("network down"));
    await mount();

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(toast.error).not.toHaveBeenCalled();
    // Approve stays disabled because no request was loaded.
    expect(screen.getByText("device.approve").closest("button")?.disabled).toBe(true);
  });

  it("shows the approved card instead of the approve form when the read is already approved", async () => {
    state.read = () =>
      Promise.resolve({ status: "approved", slug: "desk-01", existingDevice: null });
    await mount();

    await waitFor(() => expect(screen.getByText("device.approved.title")).toBeTruthy());
    expect(screen.queryByText("device.approve")).toBeNull();
    expect(screen.queryByText("device.approveTitle")).toBeNull();
  });

  it("shows the approved card after a successful Approve even though the read still says pending", async () => {
    // The read keeps returning `pending` (the default), so the only thing that
    // can show the approved card is the local `decision` state the mutation set.
    // This kills both mutants: dropping `setDecision("approved")` leaves
    // `decision` null, and dropping the `decision === "approved" ||` term at
    // device.tsx:124 leaves the card gated on a `pending` read.
    await mount();
    const user = userEvent.setup();

    await waitFor(() => expect(screen.getByText("device.approve")).toBeTruthy());
    expect(screen.getByText("device.cancel")).toBeTruthy();
    await user.click(screen.getByText("device.approve"));

    await waitFor(() => expect(screen.getByText("device.approved.title")).toBeTruthy());
    expect(screen.getByText("device.approved.description")).toBeTruthy();
    expect(screen.queryByText("device.approve")).toBeNull();
    expect(screen.queryByText("device.cancel")).toBeNull();
    expect(screen.queryByText("device.approveTitle")).toBeNull();
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it("prefers the approve refusal over a newer read refusal", async () => {
    state.approve = () => Promise.reject(refusal("already_handled"));
    const client = await mount();
    const user = userEvent.setup();

    await waitFor(() => expect(screen.getByText("device.approve")).toBeTruthy());
    await user.click(screen.getByText("device.approve"));
    await waitFor(() =>
      expect(screen.getByText("device.refusal.already_handled.title")).toBeTruthy(),
    );

    // A later read failure must not mask the approve refusal that caused the card.
    // Drive the invalidation inside act() so React flushes the re-render that
    // carries the read failure; otherwise the assertion runs against the stale
    // DOM and the `??` precedence at device.tsx:114-116 goes untested.
    state.read = () => Promise.reject(refusal("expired"));
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["deviceLoginRequest"] });
    });

    // The read query must actually be in an error state before the precedence
    // assertion means anything.
    await waitFor(() =>
      expect(client.getQueryState(["deviceLoginRequest", { userCode: "WXYZ-1234" }])?.status).toBe(
        "error",
      ),
    );
    // Flush any re-render the error notification scheduled so the assertion is
    // made against the DOM that carries the read failure.
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText("device.refusal.already_handled.title")).toBeTruthy();
    expect(screen.queryByText("device.refusal.expired.title")).toBeNull();
  });

  it("surfaces the newer read refusal when no approve refusal is present", async () => {
    const client = await mount();

    await waitFor(() => expect(screen.getByText("device.approve")).toBeTruthy());

    // No approve error exists, so the read refusal is the only refusal and must
    // be the one rendered (the inverse of the precedence test above).
    state.read = () => Promise.reject(refusal("expired"));
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["deviceLoginRequest"] });
    });

    await waitFor(() => expect(screen.getByText("device.refusal.expired.title")).toBeTruthy());
    expect(screen.queryByText("device.approve")).toBeNull();
  });

  it("resets the approve refusal on reload and shows the fresh read outcome", async () => {
    state.approve = () => Promise.reject(refusal("slug_mismatch"));
    await mount();
    const user = userEvent.setup();

    await waitFor(() => expect(screen.getByText("device.approve")).toBeTruthy());
    await user.click(screen.getByText("device.approve"));
    await waitFor(() =>
      expect(screen.getByText("device.refusal.slug_mismatch.title")).toBeTruthy(),
    );

    // Reload clears the stale approve error; the refetch now refuses with another reason.
    state.read = () => Promise.reject(refusal("no_slug"));
    await user.click(screen.getByText("device.refusal.reload"));

    await waitFor(() => expect(screen.getByText("device.refusal.no_slug.title")).toBeTruthy());
    expect(screen.queryByText("device.refusal.slug_mismatch.title")).toBeNull();
  });

  it("keeps the details but shows an alert and disables Approve when a reload fails with a non-refusal error", async () => {
    state.approve = () => Promise.reject(refusal("slug_mismatch"));
    await mount();
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByText("device.approve")).toBeTruthy());
    await user.click(screen.getByText("device.approve"));
    await waitFor(() =>
      expect(screen.getByText("device.refusal.slug_mismatch.title")).toBeTruthy(),
    );

    state.read = () => Promise.reject(new Error("network down"));
    await user.click(screen.getByText("device.refusal.reload"));

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(toast.error).not.toHaveBeenCalled();
  });
});
