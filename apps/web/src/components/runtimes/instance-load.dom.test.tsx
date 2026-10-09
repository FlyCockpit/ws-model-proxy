// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key} ${JSON.stringify(options)}` : key,
  }),
}));

import { InstanceLoad } from "./instance-load";

afterEach(cleanup);

const KNOWN = { running: 3, waiting: 2, kvUsage: 0.624, slots: 8, at: "2026-10-08T12:00:00.000Z" };

describe("InstanceLoad", () => {
  it("draws slots in use, the waiting queue and the KV cache meter", () => {
    render(<InstanceLoad live={KNOWN} />);
    const [slots, kv] = screen.getAllByRole("meter");
    expect(slots?.getAttribute("aria-valuenow")).toBe("3");
    expect(kv?.getAttribute("aria-valuenow")).toBe("62");
    expect(screen.getByText(/dashboard:slots.waiting/)).toBeTruthy();
    expect(screen.getByText(/dashboard:runtime.kvUsage/)).toBeTruthy();
  });

  it("draws nothing while the load is unknown", () => {
    const { container } = render(
      <InstanceLoad live={{ ...KNOWN, running: null, waiting: null, kvUsage: null }} />,
    );
    expect(container.childElementCount).toBe(0);
  });

  it("leaves the KV meter out when the engine does not report it", () => {
    render(<InstanceLoad live={{ ...KNOWN, kvUsage: null }} />);
    expect(screen.getAllByRole("meter")).toHaveLength(1);
    expect(screen.queryByText(/dashboard:runtime.kvUsage/)).toBeNull();
  });
});
