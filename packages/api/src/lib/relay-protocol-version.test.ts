import { describe, expect, it } from "vitest";
import { relayProtocolAtLeast } from "./relay-protocol-version";

describe("relayProtocolAtLeast", () => {
  it("compares major and minor numerically", () => {
    expect(relayProtocolAtLeast("2.4", "2.4")).toBe(true);
    expect(relayProtocolAtLeast("2.5", "2.4")).toBe(true);
    expect(relayProtocolAtLeast("2.10", "2.4")).toBe(true);
    expect(relayProtocolAtLeast("3.0", "2.5")).toBe(true);
    expect(relayProtocolAtLeast("2.3", "2.4")).toBe(false);
    expect(relayProtocolAtLeast("1.9", "2.4")).toBe(false);
  });

  it("treats a missing or malformed version as too old", () => {
    expect(relayProtocolAtLeast(null, "2.4")).toBe(false);
    expect(relayProtocolAtLeast(undefined, "2.4")).toBe(false);
    expect(relayProtocolAtLeast("", "2.4")).toBe(false);
    expect(relayProtocolAtLeast("2.4.1", "2.4")).toBe(false);
    expect(relayProtocolAtLeast("v2.5", "2.4")).toBe(false);
  });
});
