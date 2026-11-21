// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import en from "@/locales/en-US/errors.json";
import es from "@/locales/es-MX/errors.json";

const boundary = vi.hoisted(() => ({ lang: "en-US", signedIn: false }));
vi.mock("@/hooks/use-auth-session", () => ({
  useAuthSession: () => ({ state: { session: boundary.signedIn ? { user: { id: "u1" } } : null } }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: keyof typeof en) => (boundary.lang === "es-MX" ? es : en)[key],
  }),
}));
vi.mock("@tanstack/react-router", () => ({
  useRouterState: () => boundary.lang,
  Link: ({
    to,
    params,
    search: _search,
    ...props
  }: ComponentProps<"a"> & { to: string; params: { lang: string }; search?: object }) => (
    <a href={to.replace("$lang", params.lang)} {...props} />
  ),
}));

import NotFound from "./not-found";

afterEach(() => {
  cleanup();
  boundary.signedIn = false;
});
describe.each(["en-US", "es-MX"])("NotFound %s", (lang) => {
  it("renders a localized heading and sign-in link for anonymous visitors", () => {
    boundary.lang = lang;
    render(<NotFound />);
    const strings = lang === "es-MX" ? es : en;
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(strings.notFound);
    expect(screen.getByRole("link", { name: strings.notFoundSignIn }).getAttribute("href")).toBe(
      `/${lang}/login`,
    );
  });
  it("links authenticated visitors back to Overview", () => {
    boundary.lang = lang;
    boundary.signedIn = true;
    render(<NotFound />);
    expect(screen.getByRole("link").getAttribute("href")).toBe(`/${lang}/overview`);
  });
});
