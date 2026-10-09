import { describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/ui/components/sileo", () => ({ toast: { error: vi.fn() } }));
vi.mock("@/utils/friendly-error", () => ({
  friendly: (_error: unknown, fallback?: string) => fallback ?? "generic",
}));

import { refusalMessage, refusalReasonOf } from "./refusal";

const copy: Record<string, string> = {
  "dashboard:refusals.trust_relay": "relay copy",
  "dashboard:runtime.refusals.trust_relay": "runtime relay copy",
  "dashboard:runtime.refusals.port_range_in_use": "port range copy",
};
const t = ((keys: string | string[], options?: { defaultValue?: string }) => {
  const found = [keys].flat().find((key) => key in copy);
  return found ? copy[found] : (options?.defaultValue ?? String(keys));
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
});
