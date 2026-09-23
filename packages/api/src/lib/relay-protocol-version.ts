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
