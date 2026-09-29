/**
 * The one definition of "is this CLI device reachable right now" and how that
 * projects onto the endpoints it serves. `Endpoint.status` is the inventory
 * status the CLI last reported at registration; it is not rewritten when the
 * device disconnects, so every user-facing view derives the shown status here.
 */
import type { Prisma } from "@ws-model-proxy/db";

export const CLI_HEARTBEAT_STALE_AFTER_MS = 60_000;

type EndpointStatusValue = "UNKNOWN" | "ONLINE" | "DEGRADED" | "OFFLINE";

export function cliHeartbeatStaleAt(lastHeartbeatAt: Date | null): Date | null {
  return lastHeartbeatAt
    ? new Date(lastHeartbeatAt.getTime() + CLI_HEARTBEAT_STALE_AFTER_MS)
    : null;
}

export function cliHeartbeatIsStale(lastHeartbeatAt: Date | null, now: Date): boolean {
  const staleAt = cliHeartbeatStaleAt(lastHeartbeatAt);
  return Boolean(staleAt && staleAt <= now);
}

/** Connected with a fresh heartbeat. A device that never heartbeat is not online. */
export function cliDeviceIsOnline(
  device: { status: string; lastHeartbeatAt: Date | null },
  now: Date,
): boolean {
  return (
    device.status === "CONNECTED" &&
    device.lastHeartbeatAt !== null &&
    !cliHeartbeatIsStale(device.lastHeartbeatAt, now)
  );
}

/** An endpoint of an unreachable device is OFFLINE whatever it last reported. */
export function effectiveEndpointStatus<S extends EndpointStatusValue>(
  reportedStatus: S,
  device: { status: string; lastHeartbeatAt: Date | null },
  now: Date,
): S | "OFFLINE" {
  return cliDeviceIsOnline(device, now) ? reportedStatus : "OFFLINE";
}

/**
 * Prisma filter matching endpoints whose {@link effectiveEndpointStatus} is
 * `status`, so list filters agree with the status the same list displays.
 */
export function endpointEffectiveStatusWhere(
  status: EndpointStatusValue,
  now: Date,
): Prisma.EndpointWhereInput {
  const freshSince = new Date(now.getTime() - CLI_HEARTBEAT_STALE_AFTER_MS);
  // Mirrors cliDeviceIsOnline: staleAt (heartbeat + window) must be after now.
  const deviceOnline: Prisma.CliDeviceWhereInput = {
    status: "CONNECTED",
    lastHeartbeatAt: { gt: freshSince },
  };
  if (status === "OFFLINE") {
    // Spelled out rather than NOT(deviceOnline): SQL three-valued logic would
    // drop devices whose lastHeartbeatAt is NULL.
    return {
      OR: [
        { status: "OFFLINE" },
        {
          CliDevice: {
            is: {
              OR: [
                { status: { not: "CONNECTED" } },
                { lastHeartbeatAt: null },
                { lastHeartbeatAt: { lte: freshSince } },
              ],
            },
          },
        },
      ],
    };
  }
  return { status, CliDevice: { is: deviceOnline } };
}
