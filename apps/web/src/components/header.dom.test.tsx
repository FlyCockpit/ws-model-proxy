// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The header row's flex contract. jsdom has no layout, so the widths are pinned
 * through the classes; the real widths are checked in a browser. The app name
 * is the first thing in the row to give way, at every width, so a long name
 * cannot push the controls past the trailing line.
 */
const fixture = vi.hoisted(() => ({
  status: "anonymous" as "anonymous" | "pending" | "error" | "authenticated",
}));

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
vi.mock("@/hooks/use-auth-session", () => ({
  useAuthSession: () => ({
    state: {
      status: fixture.status,
      session: fixture.status === "authenticated" ? { user: { id: "u1", name: "Riley" } } : null,
    },
  }),
}));
vi.mock("./language-switcher", () => ({
  LanguageSwitcher: () => <button type="button">Language</button>,
}));
vi.mock("./main-nav", () => ({ MainNav: () => null }));
vi.mock("./mode-toggle", () => ({ ModeToggle: () => <button type="button">Theme</button> }));
vi.mock("./user-menu", () => ({ default: () => <button type="button">Account</button> }));

import Header from "./header";

afterEach(cleanup);

const SESSIONS = ["anonymous", "pending", "error", "authenticated"] as const;

function controlsGroup(container: HTMLElement) {
  const group = container.querySelector("div.ml-auto");
  if (!group) throw new Error("controls group not rendered");
  return [...group.classList];
}

describe("header row", () => {
  it.each(SESSIONS)("the app name gives way first at every width while %s", (status) => {
    fixture.status = status;
    const view = render(<Header />);
    const brand = screen.getByRole("link", { name: "A long model proxy application name" });
    // Always the landing page, signed in or not.
    expect(brand.getAttribute("href")).toBe("/en-US");
    expect(brand.getAttribute("title")).toBe("A long model proxy application name");
    const classes = [...brand.classList];
    // A zero basis, so it only grows into what the controls leave (up to its
    // own width), never below a 44px target. No shrink factor (any factor
    // leaks a fraction of a pixel to the controls) and no breakpoint variant
    // of these.
    expect(classes).toEqual(
      expect.arrayContaining([
        "inline-flex",
        "min-h-11",
        "items-center",
        "basis-0",
        "grow",
        "max-w-fit",
        "min-w-11",
      ]),
    );
    expect(classes.filter((c) => /shrink|:(basis|grow|max-w|min-w)/.test(c))).toEqual([]);
    // The ellipsis needs a block box: `truncate` on the inline-flex link only
    // clips. The caps sit on the span, so a long name leaves the MainNav room.
    expect(classes).not.toContain("truncate");
    const [logo, span] = [...brand.children];
    expect(logo?.tagName).toBe("IMG");
    expect(span?.tagName).toBe("SPAN");
    expect([...(span?.classList ?? [])].sort()).toEqual(
      ["lg:max-w-80", "max-w-40", "sm:max-w-56", "truncate"].sort(),
    );
    expect(span?.textContent).toBe("A long model proxy application name");
    expect(view.container.firstElementChild?.classList.contains("min-w-0")).toBe(true);
    expect(view.container.querySelector("[style]")).toBeNull();
  });

  it.each(SESSIONS)("starts with the logo, named once, while %s", (status) => {
    fixture.status = status;
    render(<Header />);
    const brand = screen.getByRole("link", { name: "A long model proxy application name" });
    // The image is the link's name; the visible name is aria-hidden, so a
    // screen reader hears the app name once, not twice.
    const logo = screen.getByRole("img", { name: "A long model proxy application name" });
    expect(brand.firstElementChild).toBe(logo);
    expect(brand.querySelector("span")?.getAttribute("aria-hidden")).toBe("true");
    // Generated from assets/logo.png (pwa-assets.config.ts): a declared 32px
    // box, so nothing moves when it loads, with 32/64/128 files picked by drawn size × density, never shrunk.
    expect(logo.getAttribute("src")).toBe("/pwa-32x32.png");
    expect(logo.getAttribute("srcset")).toBe(
      "/pwa-32x32.png 32w, /pwa-64x64.png 64w, /pwa-128x128.png 128w",
    );
    expect(logo.getAttribute("sizes")).toBe("48px");
    expect(logo.getAttribute("width")).toBe("32");
    expect(logo.getAttribute("height")).toBe("32");
    expect([...logo.classList]).toEqual(expect.arrayContaining(["size-8", "shrink-0"]));
  });

  it.each(["anonymous", "pending", "error"] as const)(
    "never shrinks the controls while %s (nothing in them can)",
    (status) => {
      fixture.status = status;
      const controls = controlsGroup(render(<Header />).container);
      expect(controls).toEqual(expect.arrayContaining(["min-w-0", "shrink-0"]));
      expect(controls.filter((c) => c.includes(":shrink"))).toEqual([]);
    },
  );

  it("lets the signed-in controls give way once the app name is down to 44px", () => {
    fixture.status = "authenticated";
    const controls = controlsGroup(render(<Header />).container);
    expect(controls).toContain("min-w-0");
    expect(controls.filter((c) => c.includes("shrink"))).toEqual([]);
  });
});
