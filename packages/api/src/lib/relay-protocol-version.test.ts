import { describe, expect, it } from "vitest";
import {
  RELAY_MIN_PROTOCOL_VERSION,
  refusedRelayProtocolReason,
  relayProtocolAtLeast,
} from "./relay-protocol-version";

const [currentMajor, currentMinor] = RELAY_MIN_PROTOCOL_VERSION.split(".").map(Number);
const nextRelayProtocol = `${currentMajor}.${currentMinor! + 1}`;

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

describe("refusedRelayProtocolReason", () => {
  it("calls a CLI above the newest protocol too new, numerically", () => {
    expect(refusedRelayProtocolReason(nextRelayProtocol)).toBe("cli_too_new");
    expect(refusedRelayProtocolReason("3.0")).toBe("cli_too_new");
  });

  it("calls anything at or below it, or unreadable, too old", () => {
    expect(refusedRelayProtocolReason(RELAY_MIN_PROTOCOL_VERSION)).toBe("cli_too_old");
    expect(refusedRelayProtocolReason("2.9")).toBe("cli_too_old");
    expect(refusedRelayProtocolReason("2.4")).toBe("cli_too_old");
    expect(refusedRelayProtocolReason("2.3")).toBe("cli_too_old");
    expect(refusedRelayProtocolReason("2.0")).toBe("cli_too_old");
    expect(refusedRelayProtocolReason("1.99")).toBe("cli_too_old");
    expect(refusedRelayProtocolReason(null)).toBe("cli_too_old");
    expect(refusedRelayProtocolReason(undefined)).toBe("cli_too_old");
    expect(refusedRelayProtocolReason("2.4.1")).toBe("cli_too_old");
    expect(refusedRelayProtocolReason("next")).toBe("cli_too_old");
  });
});
