// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  pending: false,
  name: "gpu-box",
  path: "/definition",
  poolOptions: { queryKey: ["pool"] },
  runtimeOptions: { queryKey: ["runtime"] },
  query: vi.fn(),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: unknown) => {
    boundary.query(options);
    return {
      isPending: boundary.pending,
      data: boundary.pending ? undefined : { name: boundary.name },
    };
  },
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: { component: ComponentType }) => ({
    options,
    useParams: () => ({ lang: "en-US", poolId: "p1", runtimeId: "r1" }),
  }),
  Link: ({ children }: { children: ReactNode }) => <a href="#tab">{children}</a>,
  Outlet: () => <section>{boundary.path}</section>,
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/components/page-stub", () => ({ SectionTabs: () => <nav>Tabs</nav> }));
vi.mock("@/utils/orpc", () => ({
  orpc: {
    pools: { get: { queryOptions: () => boundary.poolOptions } },
    runtimes: { get: { queryOptions: () => boundary.runtimeOptions } },
  },
}));

import { Route as RuntimeRoute } from "../runtimes/$runtimeId";
import { Route as PoolRoute } from "./$poolId";

afterEach(() => {
  cleanup();
  boundary.pending = false;
  boundary.query.mockClear();
});
describe.each([
  { name: "pool", Component: PoolRoute.options.component, options: boundary.poolOptions },
  { name: "runtime", Component: RuntimeRoute.options.component, options: boundary.runtimeOptions },
])("$name layout", ({ Component, options }) => {
  if (!Component) throw new Error("Missing layout component");
  beforeAll(async () => {
    await Component.preload?.();
  });
  it.each(["/", "/sharing", "/advanced", "/definition"])(
    "keeps one entity h1 above the tabs on %s",
    (path) => {
      boundary.path = path;
      render(<Component />);
      const headings = screen.getAllByRole("heading", { level: 1 });
      expect(headings).toHaveLength(1);
      expect(headings[0].textContent).toBe("gpu-box");
      expect(
        headings[0].compareDocumentPosition(screen.getByRole("navigation")) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    },
  );
  it("reserves the heading's geometry while loading", () => {
    boundary.pending = true;
    render(<Component />);
    expect(
      screen.getByRole("heading", { level: 1 }).querySelector('[data-slot="skeleton"]'),
    ).toBeTruthy();
  });
  it("uses the shared query options without overriding error-toast metadata", () => {
    render(<Component />);
    expect(boundary.query.mock.lastCall?.[0]).toBe(options);
  });
});
