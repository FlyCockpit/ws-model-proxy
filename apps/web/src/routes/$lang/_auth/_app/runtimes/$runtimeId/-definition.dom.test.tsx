// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  origin: "SERVER" as "NODE" | "SERVER",
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    createFileRoute: () => (options: { component: ComponentType }) => ({
      options,
      useParams: () => ({ runtimeId: "rt-1" }),
    }),
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@ws-model-proxy/ui/components/sileo", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/utils/orpc", () => ({
  orpc: {
    runtimes: {
      key: () => ["runtimes"],
      get: {
        queryOptions: () => ({
          queryKey: ["runtimes", "get", state.origin],
          queryFn: async () => ({
            id: "rt-1",
            kind: "STARTABLE",
            origin: state.origin,
            currentVersion: { id: "v-1" },
            current: { spec: { api: "openai" } },
          }),
        }),
      },
      versions: {
        list: {
          queryOptions: () => ({
            queryKey: ["runtimes", "versions"],
            queryFn: async () => ({ items: [] }),
          }),
        },
      },
      update: {
        mutationOptions: () => ({
          mutationFn: async () => ({}),
        }),
      },
    },
    pools: { key: () => ["pools"] },
    models: { key: () => ["models"] },
  },
}));

import { Route } from "./definition";

const Component = Route.options.component as ComponentType & {
  preload?: () => Promise<unknown>;
};

// Load the lazy page once, outside any test: a cold import under a parallel
// run can outlast a test's timeout, and a render that lands after that
// test's cleanup would leak into the next test.
beforeAll(async () => {
  await Component.preload?.();
}, 30_000);

async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Component />
    </QueryClientProvider>,
  );
  return (await screen.findByLabelText("dashboard:runtime.form.spec")) as HTMLTextAreaElement;
}

afterEach(cleanup);

describe("runtime definition page", () => {
  it("shows a node-origin definition read-only, with no way to save it", async () => {
    state.origin = "NODE";
    const spec = await mount();
    expect(spec.readOnly).toBe(true);
    expect(spec.value).toContain('"api": "openai"');
    expect(screen.getByText("dashboard:runtime.nodeOrigin")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "dashboard:runtime.saveVersion" })).toBeNull();
    expect(screen.queryByLabelText("dashboard:runtime.form.note")).toBeNull();
    // Nothing to submit: the definition is not inside a form.
    expect(spec.closest("form")).toBeNull();
    expect(spec.getAttribute("aria-describedby")).toBe("definition-node-origin");
  });

  it("keeps a server-origin definition editable", async () => {
    state.origin = "SERVER";
    const spec = await mount();
    expect(spec.readOnly).toBe(false);
    expect(spec.closest("form")).not.toBeNull();
    expect(screen.queryByText("dashboard:runtime.nodeOrigin")).toBeNull();
    expect(screen.getByRole("button", { name: "dashboard:runtime.saveVersion" })).toBeTruthy();
  });
});
