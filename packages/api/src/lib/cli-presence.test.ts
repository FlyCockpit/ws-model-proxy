import { describe, expect, it } from "vitest";
import {
  CLI_HEARTBEAT_STALE_AFTER_MS,
  cliDeviceIsOnline,
  effectiveEndpointStatus,
  endpointEffectiveStatusWhere,
} from "./cli-presence";

const now = new Date("2026-09-29T12:00:00.000Z");
const ago = (ms: number) => new Date(now.getTime() - ms);

describe("cli presence", () => {
  const rows: {
    name: string;
    device: { status: string; lastHeartbeatAt: Date | null };
    online: boolean;
  }[] = [
    {
      name: "fresh connected",
      device: { status: "CONNECTED", lastHeartbeatAt: ago(1_000) },
      online: true,
    },
    {
      name: "heartbeat exactly at the stale boundary",
      device: { status: "CONNECTED", lastHeartbeatAt: ago(CLI_HEARTBEAT_STALE_AFTER_MS) },
      online: false,
    },
    {
      name: "just inside the window",
      device: { status: "CONNECTED", lastHeartbeatAt: ago(CLI_HEARTBEAT_STALE_AFTER_MS - 1) },
      online: true,
    },
    {
      name: "connected, never heartbeat",
      device: { status: "CONNECTED", lastHeartbeatAt: null },
      online: false,
    },
    {
      name: "disconnected, fresh heartbeat",
      device: { status: "DISCONNECTED", lastHeartbeatAt: ago(1_000) },
      online: false,
    },
    {
      name: "stale status",
      device: { status: "STALE", lastHeartbeatAt: ago(1_000) },
      online: false,
    },
    { name: "revoked", device: { status: "REVOKED", lastHeartbeatAt: ago(1_000) }, online: false },
  ];

  it.each(rows)("device online: $name", ({ device, online }) => {
    expect(cliDeviceIsOnline(device, now)).toBe(online);
    expect(effectiveEndpointStatus("ONLINE", device, now)).toBe(online ? "ONLINE" : "OFFLINE");
  });

  it("keeps a reported non-ONLINE status while the device is online", () => {
    const device = { status: "CONNECTED", lastHeartbeatAt: ago(1_000) };
    expect(effectiveEndpointStatus("DEGRADED", device, now)).toBe("DEGRADED");
    expect(effectiveEndpointStatus("UNKNOWN", device, now)).toBe("UNKNOWN");
  });

  it("builds list filters that mirror the derived status", () => {
    const fresh = {
      status: "CONNECTED",
      lastHeartbeatAt: { gt: ago(CLI_HEARTBEAT_STALE_AFTER_MS) },
    };
    expect(endpointEffectiveStatusWhere("ONLINE", now)).toEqual({
      status: "ONLINE",
      CliDevice: { is: fresh },
    });
    expect(endpointEffectiveStatusWhere("OFFLINE", now)).toEqual({
      OR: [
        { status: "OFFLINE" },
        {
          CliDevice: {
            is: {
              OR: [
                { status: { not: "CONNECTED" } },
                { lastHeartbeatAt: null },
                { lastHeartbeatAt: { lte: ago(CLI_HEARTBEAT_STALE_AFTER_MS) } },
              ],
            },
          },
        },
      ],
    });
  });
});
