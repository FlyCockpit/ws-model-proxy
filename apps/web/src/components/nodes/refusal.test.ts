import { describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/ui/components/sileo", () => ({ toast: { error: vi.fn() } }));
vi.mock("@/utils/friendly-error", () => ({
  friendly: (_error: unknown, fallback?: string) => fallback ?? "generic",
}));

import { refusalMessage, refusalReasonOf } from "./refusal";

const t = ((key: string, options?: { defaultValue?: string }) =>
  key === "dashboard:refusals.trust_relay"
    ? "relay copy"
    : (options?.defaultValue ?? key)) as never;

describe("refusal copy", () => {
  it("reads data.reason only when it is a reason-shaped code", () => {
    expect(refusalReasonOf({ data: { reason: "trust_relay" } })).toBe("trust_relay");
    expect(refusalReasonOf({ data: { reason: "<b>x</b>" } })).toBeNull();
    expect(refusalReasonOf({ message: "trust_relay" })).toBeNull();
  });

  it("uses the reason's copy, else the friendly fallback", () => {
    expect(refusalMessage(t, { data: { reason: "trust_relay" } })).toBe("relay copy");
    expect(refusalMessage(t, { data: { reason: "unknown_reason" } }, "fallback.key")).toBe(
      "fallback.key",
    );
  });
});
