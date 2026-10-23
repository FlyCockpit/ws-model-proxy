import { describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/ui/components/sileo", () => ({ toast: { error: vi.fn() } }));
vi.mock("@/utils/friendly-error", () => ({
  friendly: (_error: unknown, fallback?: string) => fallback ?? "generic",
}));

import { refusalReservationOf } from "@/lib/refusal-text";
import { refusalMessage, refusalReasonOf } from "./refusal";

const copy: Record<string, string> = {
  "dashboard:runtime.refusals.not_enough_memory": "memory copy",
  "dashboard:refusals.trust_relay": "relay copy",
  "dashboard:runtime.refusals.trust_relay": "runtime relay copy",
  "dashboard:runtime.refusals.port_range_in_use": "port range copy",
};
const t = ((keys: string | string[], options?: Record<string, unknown>) => {
  // The reservation copy: its key with the values it interpolates.
  if (
    keys === "dashboard:runtime.reservationRefusal" ||
    keys === "dashboard:runtime.reservationRefusalNode"
  )
    return `${keys} ${JSON.stringify(options)}`;
  const found = [keys].flat().find((key) => key in copy);
  return found ? copy[found] : ((options?.defaultValue as string | undefined) ?? String(keys));
}) as never;

describe("refusal copy", () => {
  it("reads data.reason only when it is a reason-shaped code", () => {
    expect(refusalReasonOf({ data: { reason: "trust_relay" } })).toBe("trust_relay");
    expect(refusalReasonOf({ data: { reason: "<b>x</b>" } })).toBeNull();
    expect(refusalReasonOf({ message: "trust_relay" })).toBeNull();
  });

  it("uses the reason's copy, else the friendly fallback", () => {
    expect(refusalMessage(t, { data: { reason: "trust_relay" } })).toBe("relay copy");
    expect(refusalMessage(t, { data: { reason: "port_range_in_use" } })).toBe("port range copy");
    expect(refusalMessage(t, { data: { reason: "unknown_reason" } }, "fallback.key")).toBe(
      "fallback.key",
    );
  });

  it("says which reservation a placement refusal is about (labels, node), localized", () => {
    const error = {
      data: {
        reason: "not_enough_memory",
        subjectId: "node-2",
        reservation: { index: 1, labels: ["ds-worker", "fast"], nodeSlug: "w2" },
      },
    };
    expect(refusalMessage(t, error)).toBe(
      `dashboard:runtime.reservationRefusalNode ${JSON.stringify({
        number: 2,
        labels: "ds-worker, fast",
        node: "w2",
        reason: "memory copy",
      })}`,
    );
    const noNode = {
      data: { ...error.data, reservation: { index: 0, labels: ["x"], nodeSlug: null } },
    };
    expect(refusalMessage(t, noNode)).toContain("dashboard:runtime.reservationRefusal ");
    // Without a reservation: the reason's copy alone.
    expect(refusalMessage(t, { data: { reason: "not_enough_memory" } })).toBe("memory copy");
  });

  it("reads a reservation only in its exact shape", () => {
    expect(
      refusalReservationOf({ reservation: { index: 0, labels: ["a"], nodeSlug: null } }),
    ).toEqual({ index: 0, labels: ["a"], nodeSlug: null });
    expect(refusalReservationOf({ data: { reservation: { index: -1, labels: [] } } })).toBeNull();
    expect(refusalReservationOf({ data: { reservation: { index: 0, labels: [1] } } })).toBeNull();
    expect(refusalReservationOf({ data: { reservation: "x" } })).toBeNull();
    expect(refusalReservationOf(null)).toBeNull();
  });
});
