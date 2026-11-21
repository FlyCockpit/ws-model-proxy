// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WideContent } from "@/components/wide-content";

const originalScrollIntoView = Element.prototype.scrollIntoView;
const route = vi.hoisted(() => ({ pathname: "/first" }));
vi.mock("@tanstack/react-router", () => ({ useRouterState: () => route.pathname }));

import { useActiveTabScroll } from "./use-active-tab-scroll";

function Tabs({ left, right }: { left: number; right: number }) {
  const ref = useActiveTabScroll();
  return (
    <WideContent
      ref={(element) => {
        ref.current = element;
        if (!element) return;
        Object.defineProperty(element, "clientWidth", { configurable: true, value: 300 });
        element.getBoundingClientRect = () => ({ left: 10, right: 310 }) as DOMRect;
        const active = element.querySelector<HTMLElement>("[data-status=active]");
        if (active) active.getBoundingClientRect = () => ({ left, right }) as DOMRect;
      }}
      data-testid="strip"
    >
      <a href="#active" data-status="active">
        Active
      </a>
    </WideContent>
  );
}

afterEach(() => {
  cleanup();
  Element.prototype.scrollIntoView = originalScrollIntoView;
  route.pathname = "/first";
});
describe("useActiveTabScroll", () => {
  it("reveals a clipped right tab on mount without vertical scrolling", () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    render(<Tabs left={390} right={470} />);
    const strip = screen.getByTestId("strip");
    expect(strip.scrollLeft).toBe(160);
    expect(strip.scrollTop).toBe(0);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
  it("reveals a clipped left tab after the path changes", () => {
    const view = render(<Tabs left={390} right={470} />);
    route.pathname = "/second";
    view.rerender(<Tabs left={-50} right={30} />);
    expect(screen.getByTestId("strip").scrollLeft).toBe(100);
  });
  it("does not move an already visible active tab", () => {
    render(<Tabs left={25} right={125} />);
    expect(screen.getByTestId("strip").scrollLeft).toBe(0);
  });
});
