// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePointerReorder } from "./use-pointer-reorder";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** Three 100px-wide items in a row: 0-100, 100-200, 200-300. */
function List({
  onMove,
  onClick,
  touchDelayMs,
}: {
  onMove: (from: number, to: number) => void;
  onClick: (index: number) => void;
  touchDelayMs?: number;
}) {
  const reorder = usePointerReorder({ axis: "x", onMove, touchDelayMs });
  return (
    <div>
      {["a", "b", "c"].map((name, index) => (
        <button
          key={name}
          type="button"
          ref={reorder.itemRef(index)}
          {...reorder.handleProps(index)}
          data-drag={reorder.drag?.from === index ? "from" : reorder.drag?.to === index ? "to" : ""}
          onClick={() => onClick(index)}
        >
          {name}
        </button>
      ))}
    </div>
  );
}

beforeEach(() => {
  // jsdom lays nothing out: give each item a box by its text.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const left = { a: 0, b: 100, c: 200 }[this.textContent ?? ""] ?? 0;
    return {
      left,
      right: left + 100,
      top: 0,
      bottom: 40,
      width: 100,
      height: 40,
      x: left,
      y: 0,
    } as DOMRect;
  });
});

const pointer = (type: string, element: Element, x: number, pointerType = "mouse") =>
  fireEvent(
    element,
    Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
      pointerId: 1,
      pointerType,
      button: 0,
      clientX: x,
      clientY: 10,
    }),
  );

describe("usePointerReorder", () => {
  it("moves an item dragged past others and swallows the click that ends the drag", () => {
    const onMove = vi.fn();
    const onClick = vi.fn();
    render(<List onMove={onMove} onClick={onClick} />);
    const a = screen.getByText("a");
    pointer("pointerdown", a, 50);
    pointer("pointermove", a, 60);
    pointer("pointermove", a, 250);
    expect(screen.getByText("c").dataset.drag).toBe("to");
    expect(a.dataset.drag).toBe("from");
    pointer("pointerup", a, 250);
    fireEvent.click(a);
    expect(onMove).toHaveBeenCalledWith(0, 2);
    expect(onClick).not.toHaveBeenCalled();
    expect(a.dataset.drag).toBe("");
  });

  it("treats a press that barely moves as a click", () => {
    const onMove = vi.fn();
    const onClick = vi.fn();
    render(<List onMove={onMove} onClick={onClick} />);
    const b = screen.getByText("b");
    pointer("pointerdown", b, 150);
    pointer("pointermove", b, 152);
    pointer("pointerup", b, 152);
    fireEvent.click(b);
    expect(onMove).not.toHaveBeenCalled();
    expect(onClick).toHaveBeenCalledWith(1);
  });

  it("starts a touch drag only after the long press, and a swipe before it scrolls", () => {
    vi.useFakeTimers();
    const onMove = vi.fn();
    render(<List onMove={onMove} onClick={vi.fn()} touchDelayMs={300} />);
    const c = screen.getByText("c");
    // A swipe: moves before the press is long enough.
    pointer("pointerdown", c, 250, "touch");
    pointer("pointermove", c, 150, "touch");
    act(() => vi.advanceTimersByTime(400));
    pointer("pointerup", c, 150, "touch");
    expect(onMove).not.toHaveBeenCalled();
    // A long press, then a drag.
    pointer("pointerdown", c, 250, "touch");
    act(() => vi.advanceTimersByTime(400));
    pointer("pointermove", c, 20, "touch");
    pointer("pointerup", c, 20, "touch");
    expect(onMove).toHaveBeenCalledWith(2, 0);
  });

  it("drops nothing when the gesture is cancelled", () => {
    const onMove = vi.fn();
    render(<List onMove={onMove} onClick={vi.fn()} />);
    const a = screen.getByText("a");
    pointer("pointerdown", a, 50);
    pointer("pointermove", a, 250);
    pointer("pointercancel", a, 250);
    pointer("pointerup", a, 250);
    expect(onMove).not.toHaveBeenCalled();
  });
});
