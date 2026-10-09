/**
 * IP literals shared by the contract, the node (`apps/cli/src/protocol/frames.rs`
 * `is_fabric_ip`) and the database (`wsmp_is_fabric_ip` in schema-hardening.sql). All three
 * accept exactly the canonical text form, so the same string means the same address
 * everywhere and nothing else (brackets, zone ids, prefixes, shell text) gets through. The
 * shared vectors live in `apps/cli/tests/fixtures/relay-3.0/rules/fabric-ip.json`.
 *
 * Pure (no `node:net`): contracts are also bundled for the browser.
 */

const IPV4_OCTET = /^(?:0|[1-9][0-9]{0,2})$/;

/** The four octets of a canonical dotted quad (no leading zeros), else null. */
function parseIpv4(text: string): number[] | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!IPV4_OCTET.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

/** The eight 16-bit groups of an IPv6 text without an embedded IPv4 part, else null. */
function parseIpv6(text: string): number[] | null {
  if (!/^[0-9a-fA-F:]{2,39}$/.test(text)) return null;
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const groups = (half: string) => (half === "" ? [] : half.split(":"));
  const head = groups(halves[0] ?? "");
  const tail = halves.length === 2 ? groups(halves[1] ?? "") : [];
  const all = [...head, ...tail];
  if (all.some((group) => !/^[0-9a-fA-F]{1,4}$/.test(group))) return null;
  if (halves.length === 1 && all.length !== 8) return null;
  if (halves.length === 2 && all.length > 7) return null;
  const zeros = 8 - all.length;
  return [
    ...head.map((group) => Number.parseInt(group, 16)),
    ...Array.from({ length: halves.length === 2 ? zeros : 0 }, () => 0),
    ...tail.map((group) => Number.parseInt(group, 16)),
  ];
}

/** RFC 5952 text: lower case, no leading zeros, the first longest run (≥ 2) of zero groups as `::`. */
function formatIpv6(groups: readonly number[]): string {
  let bestStart = -1;
  let bestLength = 0;
  for (let start = 0; start < 8; ) {
    if (groups[start] !== 0) {
      start += 1;
      continue;
    }
    let end = start;
    while (end < 8 && groups[end] === 0) end += 1;
    if (end - start > bestLength) {
      bestStart = start;
      bestLength = end - start;
    }
    start = end;
  }
  const hex = groups.map((group) => group.toString(16));
  if (bestLength < 2) return hex.join(":");
  return `${hex.slice(0, bestStart).join(":")}::${hex.slice(bestStart + bestLength).join(":")}`;
}

export type IpLiteral = { version: 4; octets: number[] } | { version: 6; groups: number[] };

/** Any canonical IP literal (v4 dotted quad, or RFC 5952 v6 without an embedded v4 part). */
export function parseCanonicalIp(text: string): IpLiteral | null {
  const octets = parseIpv4(text);
  if (octets) return { version: 4, octets };
  const groups = parseIpv6(text);
  if (groups && formatIpv6(groups) === text) return { version: 6, groups };
  return null;
}

/**
 * An address another node can reach this node at on a fabric: a canonical IP literal that is
 * not unspecified (0.0.0.0, ::), not loopback (127.0.0.0/8, ::1) and not an IPv4-compatible
 * (::/96) or IPv4-mapped (::ffff:0:0/96) IPv6 address (write those as IPv4).
 */
export function isFabricIp(text: string): boolean {
  const ip = parseCanonicalIp(text);
  if (!ip) return false;
  if (ip.version === 4) return ip.octets[0] !== 0 && ip.octets[0] !== 127;
  const [a, b, c, d, e, f] = ip.groups;
  const first80Zero = a === 0 && b === 0 && c === 0 && d === 0 && e === 0;
  return !(first80Zero && (f === 0 || f === 0xffff));
}

/** The host of a parsed http(s) URL: `localhost` or an IP literal (IPv6 stays bracketed). */
export function isUrlIpHost(hostname: string): boolean {
  if (hostname.startsWith("[") && hostname.endsWith("]"))
    return parseIpv6(hostname.slice(1, -1)) !== null;
  return parseIpv4(hostname) !== null;
}
