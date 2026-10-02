/**
 * The relay protocols this server speaks, oldest first. The single source for
 * both the server's hello gate and the device card's refusal wording.
 *
 * Last cut release (v0.3.1) spoke 2.3. Unreleased work that had been numbered
 * 2.4–2.9 (terminal identity, supervised commands, engine facts / node
 * telemetry, MCP node file tools, custom engine adapters) ships as 2.4. An
 * older CLI is refused at hello. 2.5 and above are too new.
 */
export const RELAY_PROTOCOL_VERSIONS = ["2.4"] as const;
export type RelayProtocolVersion = (typeof RELAY_PROTOCOL_VERSIONS)[number];
export const RELAY_MIN_PROTOCOL_VERSION: RelayProtocolVersion = "2.4";

/**
 * Why a hello claiming `protocolVersion` was refused: `cli_too_new` when it is
 * above the newest protocol this server speaks (the server must be upgraded),
 * otherwise `cli_too_old` (the CLI must be upgraded). A missing or malformed
 * version is treated as too old, like `relayProtocolAtLeast`.
 */
export function refusedRelayProtocolReason(
  protocolVersion: string | null | undefined,
): "cli_too_old" | "cli_too_new" {
  const newest = RELAY_PROTOCOL_VERSIONS[RELAY_PROTOCOL_VERSIONS.length - 1];
  const actual = parseRelayProtocolVersion(protocolVersion);
  const top = parseRelayProtocolVersion(newest);
  if (!actual || !top) return "cli_too_old";
  const newer = actual.major !== top.major ? actual.major > top.major : actual.minor > top.minor;
  return newer ? "cli_too_new" : "cli_too_old";
}

/**
 * Numeric comparison for relay protocol versions such as "2.4" or "2.10".
 * Returns false for a missing or malformed version.
 */
export function relayProtocolAtLeast(
  version: string | null | undefined,
  minimum: `${number}.${number}`,
): boolean {
  const actual = parseRelayProtocolVersion(version);
  const floor = parseRelayProtocolVersion(minimum);
  if (!actual || !floor) return false;
  if (actual.major !== floor.major) return actual.major > floor.major;
  return actual.minor >= floor.minor;
}

function parseRelayProtocolVersion(
  version: string | null | undefined,
): { major: number; minor: number } | null {
  const match = /^(\d{1,4})\.(\d{1,4})$/.exec(version ?? "");
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]) };
}
