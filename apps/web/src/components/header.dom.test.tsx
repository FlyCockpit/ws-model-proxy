// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/env/web", () => ({
  env: { VITE_APP_NAME: "A long model proxy application name" },
}));
vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ lang: "en-US" }),
  Link: ({
    to,
    params,
    ...props
  }: ComponentProps<"a"> & { to: string; params: { lang: string } }) => (
    <a href={to.replace("$lang", params.lang)} {...props} />
  ),
}));
vi.mock("./language-switcher", () => ({
  LanguageSwitcher: () => <button type="button">Language</button>,
}));
vi.mock("./main-nav", () => ({ MainNav: () => null }));
vi.mock("./mode-toggle", () => ({ ModeToggle: () => <button type="button">Theme</button> }));
vi.mock("./user-menu", () => ({ default: () => <button type="button">Account</button> }));

import Header from "./header";

afterEach(cleanup);
it("lets a long brand shrink and truncate while retaining a 44px link target", () => {
  const view = render(<Header />);
  const brand = screen.getByRole("link");
  for (const token of ["inline-flex", "min-h-11", "min-w-0", "items-center"]) {
    expect(brand.classList.contains(token)).toBe(true);
  }
  expect(brand.classList.contains("shrink-0")).toBe(false);
  expect(brand.firstElementChild?.classList.contains("truncate")).toBe(true);
  expect(view.container.firstElementChild?.classList.contains("min-w-0")).toBe(true);
  expect(view.container.querySelector("[style]")).toBeNull();
});
