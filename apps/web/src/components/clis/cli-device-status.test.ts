import { describe, expect, it } from "vitest";
import {
  type CliDevice,
  cliDeviceMatchesFilter,
  cliDeviceNeedsAttention,
  cliDeviceOnline,
} from "./cli-device-status";

function device(overrides: Partial<CliDevice> = {}) {
  return {
    status: "CONNECTED",
    isStale: false,
    upgradeRequired: null,
    endpoints: [{ status: "ONLINE", failureReasonCode: null }],
    ...overrides,
  } as unknown as CliDevice;
}

describe("CLI device filters", () => {
  it("treats only a connected, responsive machine as online", () => {
    expect(cliDeviceOnline(device())).toBe(true);
    expect(cliDeviceOnline(device({ isStale: true }))).toBe(false);
    expect(cliDeviceOnline(device({ status: "DISCONNECTED" }))).toBe(false);
  });

  it("flags upgrades, unresponsive links and failing servers on a connected machine", () => {
    expect(cliDeviceNeedsAttention(device())).toBe(false);
    expect(
      cliDeviceNeedsAttention(device({ upgradeRequired: {} as CliDevice["upgradeRequired"] })),
    ).toBe(true);
    expect(cliDeviceNeedsAttention(device({ isStale: true }))).toBe(true);
    const failing = device({
      endpoints: [{ status: "OFFLINE", failureReasonCode: "connect_refused" }],
    } as Partial<CliDevice>);
    expect(cliDeviceNeedsAttention(failing)).toBe(true);
    // A machine that is simply offline is not also flagged for its servers.
    expect(cliDeviceNeedsAttention({ ...failing, status: "DISCONNECTED" } as CliDevice)).toBe(
      false,
    );
  });

  it("filters machines, not their servers", () => {
    const online = device();
    const offline = device({ status: "DISCONNECTED" });
    expect([online, offline].filter((d) => cliDeviceMatchesFilter(d, "online"))).toEqual([online]);
    expect([online, offline].filter((d) => cliDeviceMatchesFilter(d, "offline"))).toEqual([
      offline,
    ]);
    expect([online, offline].filter((d) => cliDeviceMatchesFilter(d, "all"))).toHaveLength(2);
  });
});
