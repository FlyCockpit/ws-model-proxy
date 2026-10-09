// @vitest-environment jsdom

import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useHashTargetScroll } from "./use-hash-target-scroll";

const scrolled: string[] = [];
const originalScrollIntoView = Element.prototype.scrollIntoView;

beforeEach(() => {
  scrolled.length = 0;
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this.id);
  };
});

afterEach(() => {
  cleanup();
  Element.prototype.scrollIntoView = originalScrollIntoView;
});

function Root() {
  useHashTargetScroll();
  return (
    <main data-scroll-restoration-id="app-main">
      <Outlet />
    </main>
  );
}

function setup() {
  const rootRoute = createRootRoute({ component: Root });
  const routes = [
    createRoute({ getParentRoute: () => rootRoute, path: "/a", component: () => <p>A</p> }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/b",
      component: () => (
        <>
          <a href="#second">jump</a>
          <button type="button" id="target">
            Target
          </button>
          <section id="second">Second</section>
        </>
      ),
    }),
  ];
  const router = createRouter({
    routeTree: rootRoute.addChildren(routes),
    history: createMemoryHistory({ initialEntries: ["/a"] }),
    scrollRestoration: true,
    defaultHashScrollIntoView: false,
  });
  render(<RouterProvider router={router} />);
  return router;
}

describe("useHashTargetScroll", () => {
  it("reveals and focuses the target of a router navigation with a hash", async () => {
    const router = setup();
    await waitFor(() => expect(router.state.location.pathname).toBe("/a"));
    await act(() => router.navigate({ href: "/b#target" }));
    await waitFor(() => expect(scrolled).toEqual(["target"]));
    expect(document.activeElement?.id).toBe("target");
  });

  it("leaves back and forward to scroll restoration", async () => {
    const router = setup();
    await waitFor(() => expect(router.state.location.pathname).toBe("/a"));
    await act(() => router.navigate({ href: "/b#target" }));
    await waitFor(() => expect(scrolled).toEqual(["target"]));
    await act(() => router.navigate({ href: "/a" }));
    await act(async () => {
      router.history.back();
    });
    await waitFor(() => expect(router.state.location.pathname).toBe("/b"));
    await act(() => router.invalidate());
    expect(scrolled).toEqual(["target"]);
  });

  it("turns a plain same-page #id link into a router push that reveals the target", async () => {
    const router = setup();
    await act(() => router.navigate({ href: "/b" }));
    const link = await vi.waitFor(() => {
      const element = document.querySelector<HTMLAnchorElement>('a[href="#second"]');
      if (!element) throw new Error("not rendered");
      return element;
    });
    const before = router.history.length;
    await act(async () => {
      link.click();
    });
    await waitFor(() => expect(router.state.location.hash).toBe("second"));
    expect(router.history.length).toBe(before + 1);
    await waitFor(() => expect(scrolled).toEqual(["second"]));
    // Clicking it again just reveals it again.
    await act(async () => {
      link.click();
    });
    expect(scrolled).toEqual(["second", "second"]);
    expect(router.history.length).toBe(before + 1);
  });
});
