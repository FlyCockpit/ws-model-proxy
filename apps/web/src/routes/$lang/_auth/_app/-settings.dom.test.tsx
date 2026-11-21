// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { ComponentProps, ComponentType } from "react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: { component: ComponentType }) => ({
    options,
    useParams: () => ({ lang: "en-US" }),
  }),
  Link: ({
    to,
    activeProps,
    activeOptions: _options,
    params: _params,
    ...props
  }: ComponentProps<"a"> & {
    to: string;
    activeProps: { className: string };
    activeOptions: object;
    params: object;
  }) => <a href={to} {...props} data-active-classes={activeProps.className} />,
  Outlet: () => null,
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { Route } from "./settings";

const Component = Route.options.component as ComponentType & { preload?: () => Promise<unknown> };
beforeAll(async () => {
  await Component.preload?.();
});
afterEach(cleanup);
it("keeps settings links at least 44px tall in their active and inactive states", () => {
  const view = render(<Component />);
  for (const link of screen.getAllByRole("link")) {
    expect(link.classList.contains("min-h-11")).toBe(true);
    expect(link.getAttribute("data-active-classes")).toContain("min-h-11");
  }
  expect(view.container.querySelector("[style]")).toBeNull();
});
