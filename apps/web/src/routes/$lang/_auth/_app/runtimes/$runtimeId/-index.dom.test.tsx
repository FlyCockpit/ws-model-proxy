// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/** Runtime overview: an instance whose stop is not confirmed offers Mark as stopped. */

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    createFileRoute: () => (options: { component: ComponentType }) => ({
      options,
      useParams: () => ({ lang: "en-US", runtimeId: "rt-1" }),
    }),
    Link: ({ children }: { children: ReactNode }) => <a href="/x">{children}</a>,
    useNavigate: () => vi.fn(),
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en-US" } }),
}));

vi.mock("@ws-model-proxy/ui/components/sileo", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// Dialogs are not under test here (they need matchMedia and portals).
vi.mock("@ws-model-proxy/ui/components/responsive-dialog", () => ({
  ResponsiveDialog: () => null,
}));
vi.mock("@/components/access/confirm-action", () => ({ ConfirmAction: () => null }));

function instance(id: string, overrides: Record<string, unknown>) {
  return {
    id,
    handle: `i-${id}`,
    versionNumber: 1,
    desiredState: "STOPPED",
    phase: "STOPPING",
    phaseReason: null,
    phaseChangedAt: "2026-10-07T10:00:00.000Z",
    needsOperator: null,
    ranks: [],
    openSteps: [],
    ...overrides,
  };
}

vi.mock("@/utils/orpc", () => ({
  orpc: {
    runtimes: {
      key: () => ["runtimes"],
      get: {
        queryOptions: () => ({
          queryKey: ["runtimes", "get"],
          queryFn: async () => ({
            id: "rt-1",
            name: "LLM",
            slug: "llm",
            kind: "STARTABLE",
            service: false,
            origin: "SERVER",
            currentVersion: { version: 1 },
            servedModels: [],
            instanceList: [
              instance("stuck", { needsOperator: "MARK_STOPPED" }),
              instance("stopping", {}),
              instance("ready", { phase: "READY", desiredState: "RUNNING" }),
            ],
          }),
        }),
      },
      stop: { mutationOptions: () => ({ mutationFn: async () => ({}) }) },
      delete: { mutationOptions: () => ({ mutationFn: async () => ({}) }) },
      instances: {
        markStopped: { mutationOptions: () => ({ mutationFn: async () => ({}) }) },
      },
    },
    nodes: { key: () => ["nodes"] },
    pools: { key: () => ["pools"] },
    models: { key: () => ["models"] },
  },
}));

import { Route } from "./index";

const Component = Route.options.component as ComponentType & {
  preload?: () => Promise<unknown>;
};

beforeAll(async () => {
  await Component.preload?.();
}, 30_000);

afterEach(cleanup);

describe("runtime overview instances", () => {
  it("shows Stop not confirmed, its explanation and Mark as stopped only on that instance", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Component />
      </QueryClientProvider>,
    );
    const stuck = (await screen.findByText("i-stuck")).closest("li");
    if (!stuck) throw new Error("no row");
    expect(within(stuck).getByText("dashboard:runtime.needsOperator.MARK_STOPPED")).toBeTruthy();
    expect(within(stuck).getByRole("button", { name: "dashboard:help.ariaLabel" })).toBeTruthy();
    expect(
      within(stuck).getByRole("button", { name: "dashboard:runtime.markStopped.action" }),
    ).toBeTruthy();
    // One action in the whole list: the other stopping and the ready instance have none.
    expect(
      screen.getAllByRole("button", { name: "dashboard:runtime.markStopped.action" }),
    ).toHaveLength(1);
    expect(screen.queryAllByText("dashboard:runtime.needsOperator.MARK_STOPPED")).toHaveLength(1);
  });
});
