// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ pathname: "/en-US/nodes", inFrame: false }));

vi.mock("@tanstack/react-router", () => ({
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: state.pathname } }),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/components/app-frame", () => ({
  useInAppFrame: () => state.inFrame,
  AppFrame: ({ lang, children }: { lang: string; children: ReactNode }) => (
    <div data-testid="frame" data-lang={lang}>
      {children}
    </div>
  ),
}));

import { RoutePending } from "./route-pending";

afterEach(() => {
  cleanup();
  state.pathname = "/en-US/nodes";
  state.inFrame = false;
});

describe("RoutePending", () => {
  it("draws the app frame around the skeleton when no frame is on screen yet", () => {
    state.pathname = "/es-MX/runtimes";
    render(<RoutePending />);
    const frame = screen.getByTestId("frame");
    expect(frame.dataset.lang).toBe("es-MX");
    expect(frame.querySelector("[data-page-skeleton]")).toBeTruthy();
  });

  it("is only the page's skeleton inside the frame, never a second frame", () => {
    state.inFrame = true;
    render(<RoutePending />);
    expect(screen.queryByTestId("frame")).toBeNull();
    expect(document.querySelector("[data-page-skeleton]")).toBeTruthy();
  });

  it("keeps the page padding but no sidebar frame on admin and public pages", () => {
    for (const path of ["/en-US/admin/users", "/en-US/login"]) {
      state.pathname = path;
      const { unmount } = render(<RoutePending />);
      expect(screen.queryByTestId("frame")).toBeNull();
      expect(document.querySelector("[data-page-skeleton]")?.parentElement?.className).toContain(
        "px-4",
      );
      unmount();
    }
  });
});
