// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key} ${JSON.stringify(options)}` : key,
  }),
}));

import { FillMeter } from "./fill-meter";
import { Help } from "./help";
import { SlotMeter } from "./slot-meter";

afterEach(cleanup);

describe("SlotMeter", () => {
  it("draws one segment per slot and the waiting queue", () => {
    render(<SlotMeter active={3} slots={4} waiting={2} />);
    const meter = screen.getByRole("meter");
    expect(meter.getAttribute("aria-valuenow")).toBe("3");
    expect(meter.getAttribute("aria-valuemax")).toBe("4");
    expect(meter.children).toHaveLength(4);
    expect(screen.getByText(/dashboard:slots.waiting/)).toBeTruthy();
  });

  it("switches to one bar for large engines and caps the value at the limit", () => {
    render(<SlotMeter active={300} slots={256} />);
    const meter = screen.getByRole("meter");
    expect(meter.children).toHaveLength(1);
    expect(meter.getAttribute("aria-valuenow")).toBe("256");
    expect(screen.queryByText(/dashboard:slots.waiting/)).toBeNull();
  });

  it("marks a pool's kept slots at the end of the meter, capped at the limit", () => {
    render(<SlotMeter active={1} slots={4} kept={6} />);
    const meter = screen.getByRole("meter");
    expect(meter.getAttribute("aria-label")).toContain('dashboard:slots.kept {"count":4}');
    expect(
      [...meter.children].filter((slot) => slot.className.includes("border-dashed")),
    ).toHaveLength(4);
    expect(screen.getByText('dashboard:slots.kept {"count":4}')).toBeTruthy();
  });

  it("states running requests when the runtime has no limit", () => {
    render(<SlotMeter active={2} slots={null} />);
    expect(screen.queryByRole("meter")).toBeNull();
    expect(screen.getByText(/dashboard:slots.unlimited/)).toBeTruthy();
  });
});

describe("FillMeter", () => {
  it("fills to the fraction, clamped to 0..100, and shows its label", () => {
    render(<FillMeter fraction={1.4} label="All of it" />);
    const meter = screen.getByRole("meter", { name: "All of it" });
    expect(meter.getAttribute("aria-valuenow")).toBe("100");
    expect(screen.getByText("All of it")).toBeTruthy();
  });
});

describe("Help", () => {
  it("opens its explanation on click, which also works on touch screens", async () => {
    render(<Help>Slots are requests in flight.</Help>);
    expect(screen.queryByText("Slots are requests in flight.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "dashboard:help.ariaLabel" }));
    expect(await screen.findByText("Slots are requests in flight.")).toBeTruthy();
  });
});
