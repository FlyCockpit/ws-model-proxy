// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({ useRouterState: () => "/" }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { PageHeading } from "./page-stub";

afterEach(cleanup);
it("demotes a sub-page heading while preserving its title and description", () => {
  render(<PageHeading page="poolSharing" level={2} />);
  expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(
    "dashboard:pages.poolSharing.title",
  );
  expect(screen.getByText("dashboard:pages.poolSharing.description")).toBeTruthy();
});
it("keeps standalone pages at heading level one", () => {
  render(<PageHeading page="pools" />);
  expect(screen.getByRole("heading", { level: 1 })).toBeTruthy();
});
